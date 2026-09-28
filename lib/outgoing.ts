/**
 * Ce qu'il faut valider AVANT qu'un message sorte — une seule fois, pour l'envoi
 * comme pour le brouillon.
 *
 * `POST /api/messages/send` faisait tout cela en ligne : lecture du corps, droit sur
 * la boîte, messages transférés, plafond annoncé par le serveur, pièces jointes,
 * total. Un brouillon a besoin EXACTEMENT du même travail — même contrat de corps,
 * mêmes refus, même plafond — et s'arrête juste avant le transport. Recopier ce bloc
 * dans une seconde route aurait fait diverger les deux en un lot : une limite
 * corrigée d'un côté, pas de l'autre.
 *
 * Ce module ne parle donc NI de SMTP NI d'IMAP : il rend le message à poster
 * (`SendMailOptions`) et la boîte qui le porte. L'appelant décide ce qu'il en fait.
 */
import { NextResponse } from 'next/server'
import { getAccessibleAccount, type AccessibleAccount } from './accountAccess'
import type { SendMailOptions } from './smtp'
import { getMessageSources } from './imap'
import { toImapConfig } from './accounts'
import { EML_CONTENT_TYPE, emlFilename } from './eml'
import {
  FORWARD_ERROR,
  FORWARD_MAX_TOTAL_BYTES,
  parseForwardedMessages,
  resolveForwardOrigin,
} from './forward'
import {
  MESSAGE_MAX_TOTAL_BYTES,
  checkTotalSize,
  parseAttachments,
  type OutgoingAttachment,
} from './attachments'
import {
  SEND_WARNING,
  exceedsRecipientWarning,
  resolveSendCeiling,
  type SendCeiling,
} from './smtpSize'

/** Le corps commun aux deux routes. Les champs propres à l'ENVOI restent dans `rest`. */
export interface OutgoingBody {
  accountId?: string
  to?: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject?: string
  html?: string
  text?: string
  inReplyTo?: string
  references?: string
  requestReadReceipt?: boolean
  forwardedMessages?: unknown
  attachments?: unknown
}

export interface PreparedOutgoing {
  account: AccessibleAccount
  mail: SendMailOptions
  /** Avertissement de taille, PAS un refus : le message part quand même. */
  warning?: { warning: string; bytes: number }
  ceiling: SendCeiling
  body: OutgoingBody
}

export type OutgoingPreparation =
  | { ok: true; value: PreparedOutgoing }
  | { ok: false; response: NextResponse }

/**
 * D'où sort le plafond qu'on vient d'opposer à l'appelant. Sans cela, « 17 Mio
 * maximum » se lit comme une limite du serveur alors que c'est notre repli
 * quand il n'a rien annoncé — et personne ne sait s'il faut réduire la pièce ou
 * réessayer la connexion de la boîte.
 */
const ceilingOrigin = (ceiling: SendCeiling) => ({
  limitSource: ceiling.source,
  announcedSize: ceiling.announced,
})

const asArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

/**
 * `userId` a déjà franchi `authorize()` : ce niveau ne vérifie pas la clé, il
 * vérifie la BOÎTE (`send`, comme l'annonce `ROUTE_ACCOUNT_PERMISSION`) et le corps.
 */
export async function prepareOutgoing(req: Request, userId: string): Promise<OutgoingPreparation> {
  const refuse = (body: Record<string, unknown>, status: number): OutgoingPreparation => ({
    ok: false,
    response: NextResponse.json(body, { status }),
  })

  const body = (await req.json()) as OutgoingBody
  const { accountId, to, cc, bcc, subject, html, text, inReplyTo, references } = body

  if (!accountId || !to || !subject) {
    return refuse({ error: 'accountId, to, and subject are required' }, 400)
  }

  const account = await getAccessibleAccount(accountId, userId, ['send'])
  if (!account) return refuse({ error: 'Account not found' }, 404)

  // Transfert de messages entiers. Le compte d'ORIGINE de la sélection n'est
  // pas celui de l'expéditeur : l'utilisateur peut changer « De » après avoir
  // coché ses messages. Relire dans la boîte de l'expéditeur joindrait les
  // messages portant les MÊMES uid dans une AUTRE boîte. L'origine est donc
  // contrôlée à part, en lecture (propriétaire ou partage actif).
  let attachments: OutgoingAttachment[] | undefined
  if (body.forwardedMessages !== undefined) {
    const parsed = parseForwardedMessages(body.forwardedMessages)
    if (!parsed.ok) return refuse({ error: parsed.code, limit: parsed.detail }, parsed.status)

    const origin = await resolveForwardOrigin(account, parsed.value.accountId, id =>
      getAccessibleAccount(id, userId)
    )
    if (!origin.ok) return refuse({ error: origin.code }, origin.status)

    const result = await getMessageSources(
      toImapConfig(origin.value),
      parsed.value.folder,
      parsed.value.uids,
      FORWARD_MAX_TOTAL_BYTES
    )
    if (result.oversized) {
      return refuse({ error: FORWARD_ERROR.tooLarge, limit: FORWARD_MAX_TOTAL_BYTES }, 413)
    }
    // Rien ne part amputé : un message disparu entre la sélection et l'envoi
    // annule l'envoi, la fenêtre reste ouverte avec son brouillon.
    if (result.missing.length) {
      return refuse({ error: FORWARD_ERROR.missing, limit: result.missing.length }, 409)
    }
    attachments = result.sources.map(m => ({
      filename: emlFilename(m.subject),
      content: m.source,
      contentType: EML_CONTENT_TYPE,
    }))
  }

  // Le plafond vient du SERVEUR (lot M10) : c'est la taille qu'il a annoncée à
  // la dernière connexion, enregistrée sur la boîte. Rien n'est écrit en dur —
  // quand il n'a rien annoncé, `resolveSendCeiling` rend le plafond prudent et
  // le DIT, pour que le refus n'ait pas l'air d'une limite du serveur.
  const ceiling = resolveSendCeiling(account.smtp_max_size, MESSAGE_MAX_TOTAL_BYTES)

  // Fichiers joints par l'appelant. Ils rejoignent le MÊME tableau que les
  // messages transférés — un seul chemin jusqu'au message, donc un seul
  // plafond de taille à tenir, celui du message entier.
  if (body.attachments !== undefined) {
    const parsed = parseAttachments(body.attachments, ceiling.limit)
    if (!parsed.ok) {
      return refuse(
        {
          error: parsed.code,
          limit: parsed.limit,
          filename: parsed.detail,
          ...(parsed.limit === undefined ? {} : ceilingOrigin(ceiling)),
        },
        parsed.status
      )
    }
    attachments = [...(attachments ?? []), ...parsed.value]
  }

  // Avertissement, PAS blocage : la limite du serveur d'ENVOI n'est pas celle du
  // DESTINATAIRE. Le message part, et l'appelant repart en sachant qu'il peut
  // revenir en rebond.
  let warning: { warning: string; bytes: number } | undefined
  if (attachments?.length) {
    const total = checkTotalSize(attachments, ceiling.limit)
    if (!total.ok) {
      return refuse({ error: total.code, limit: total.limit, ...ceilingOrigin(ceiling) }, total.status)
    }
    if (exceedsRecipientWarning(total.value)) {
      warning = { warning: SEND_WARNING.recipientMayRefuse, bytes: total.value }
    }
  }

  const ccArr = asArray(cc)
  return {
    ok: true,
    value: {
      account,
      ceiling,
      warning,
      body,
      mail: {
        from: account.email,
        to: asArray(to),
        cc: ccArr.length ? ccArr : undefined,
        bcc: bcc ? asArray(bcc) : undefined,
        subject: subject as string,
        html,
        text,
        inReplyTo,
        references,
        attachments,
      },
    },
  }
}
