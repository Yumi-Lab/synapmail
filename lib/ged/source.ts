/**
 * La boîte GED vue par le TRIEUR (décision 6) : la même `MailSource` que pour toute boîte, sauf
 * que ce qu'elle rend est UN `SourceMail` PAR DOCUMENT océrisé, avec le texte OCR à la place du
 * corps (`ocrText`, lu par `buildState`, les détecteurs et l'extraction T11).
 *
 * Rien du trieur n'est réécrit : curseurs, verrou, plafond, pauses, saut du déjà-fait passent
 * par `runPass` tel quel. Trois choix vivent ici :
 *
 *  1. **La base dit QUOI lire, l'IMAP dit QUOI c'est.** `fetch(dossier, après, n)` cherche les
 *     documents de `ged_documents` d'UID supérieur au curseur, puis relit CES mails-là par
 *     `fetchUids` — un mail sans PDF (le mot de bienvenue de l'hébergeur) n'est jamais téléchargé
 *     ni tagué : dans une boîte GED, il n'est rien à ranger.
 *  2. **Un document en `attente` ARRÊTE le lot** avant lui : la chaîne de réception
 *     (`./intake.ts`) tourne à part, et un passage du trieur qui dépasserait un PDF pas encore
 *     océrisé ne le reverrait jamais (le curseur ne recule pas). Un `echec` d'OCR, lui, n'a rien
 *     à faire lire : il est sauté pour de bon.
 *  3. **Un document = une position taguée.** Son `Message-ID` est celui du mail, suffixé du rang
 *     de la pièce quand l'envoi porte plusieurs PDF (`<id>#p2`) ; à UN PDF (le cas du copieur),
 *     c'est le `Message-ID` du mail tel quel — étiquettes du document et du mail sont les mêmes
 *     lignes, et le même PDF relu sous un autre UID est sauté comme un mail déjà tagué.
 */
import { query } from '../db'
import type { MailSource, SourceMail } from '../tagging/runner'
import { messageIdOf } from '../tagging/store'
import { OCR_STATUS_DONE, OCR_STATUS_PENDING } from './model'

/** Le `Message-ID` d'un document : celui du mail, suffixé du rang de la pièce quand il y en a plusieurs. */
export const documentMessageId = (mailId: string, partIdx: number, parts: number): string =>
  parts > 1 ? `${mailId}#p${partIdx}` : mailId

type DocRow = { message_id: string; part_idx: number; ocr_text: string; parts: number }

/** Les mails → un `SourceMail` par document OCÉRISÉ, dans l'ordre des UID puis des pièces. */
export async function documentsAsMails(accountId: string, mails: readonly SourceMail[]): Promise<SourceMail[]> {
  const ids = Array.from(new Set(mails.map(m => messageIdOf(m))))
  if (!ids.length) return []
  const rows = await query<DocRow>(
    `SELECT message_id, part_idx, ocr_text, COUNT(*) OVER (PARTITION BY message_id)::int AS parts
       FROM ged_documents WHERE account_id = $1 AND message_id = ANY($2::text[]) AND ocr_status = $3
      ORDER BY message_id, part_idx`,
    [accountId, ids, OCR_STATUS_DONE]
  )
  const by = new Map<string, DocRow[]>()
  for (const r of rows) by.set(r.message_id, [...(by.get(r.message_id) ?? []), r])
  const out: SourceMail[] = []
  for (const mail of mails) {
    const id = messageIdOf(mail)
    for (const d of by.get(id) ?? []) out.push({ ...mail, messageId: documentMessageId(id, d.part_idx, d.parts), ocrText: d.ocr_text })
  }
  return out
}

/**
 * Les UID des mails porteurs de documents à trier dans `folder` après `afterUid`, par UID
 * croissant, bornés AVANT le premier mail qui a encore un PDF en attente d'OCR.
 */
export async function documentUids(accountId: string, folder: string, afterUid: number, limit: number): Promise<number[]> {
  const rows = await query<{ uid: number; pending: boolean }>(
    `SELECT uid, bool_or(ocr_status = $5) AS pending FROM ged_documents
      WHERE account_id = $1 AND folder = $2 AND uid > $3 AND ocr_status IN ($4, $5)
      GROUP BY uid ORDER BY uid LIMIT $6`,
    [accountId, folder, afterUid, OCR_STATUS_DONE, OCR_STATUS_PENDING, limit]
  )
  const cut = rows.findIndex(r => r.pending)
  return (cut < 0 ? rows : rows.slice(0, cut)).map(r => r.uid)
}

/** La source d'une boîte GED pour le trieur : `inner` est la vraie boîte (ou une fausse au banc). */
export function gedMailSource<S extends MailSource>(accountId: string, inner: S): S {
  return {
    ...inner,
    fetch: async (folder, afterUid, limit) => {
      const uids = await documentUids(accountId, folder, afterUid, limit)
      return uids.length ? documentsAsMails(accountId, await inner.fetchUids(folder, uids)) : []
    },
    fetchUids: async (folder, uids) => documentsAsMails(accountId, await inner.fetchUids(folder, uids)),
  }
}
