import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { toImapConfig } from '@/lib/accounts'
import { appendDraft } from '@/lib/imap'
import { composeMail } from '@/lib/smtp'
import { prepareOutgoing } from '@/lib/outgoing'
import { DRAFT_ERROR, messageIdOf } from '@/lib/draft'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

/**
 * Écrire un brouillon dans le VRAI dossier « Brouillons » de la boîte.
 *
 * Le corps est celui de `POST /api/messages/send`, à la lettre : même validation
 * partagée (`lib/outgoing.ts`), donc mêmes refus, même plafond, mêmes pièces jointes.
 * La seule différence tient au dernier geste — ici on COMPOSE le message et on
 * l'APPEND, là-bas on l'envoie. Aucun transport SMTP n'est joignable depuis ce
 * fichier : `composeMail` ne reçoit pas les identifiants de la boîte.
 *
 * Aucun rapport avec la table `drafts` de l'écran de composition (un brouillon par
 * compte, sauvegarde automatique) : ici plusieurs brouillons coexistent, un APPEND
 * chacun, et ils se retrouvent depuis n'importe quel client, téléphone compris.
 */
async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const prepared = await prepareOutgoing(req, gate.ctx.id)
    if (!prepared.ok) return prepared.response
    const { account, mail } = prepared.value

    const raw = await composeMail(mail)
    const written = await appendDraft(toImapConfig(account), raw)
    if (!written) {
      return NextResponse.json({ error: DRAFT_ERROR.noDraftsFolder }, { status: 409 })
    }

    return NextResponse.json({ data: { ...written, messageId: messageIdOf(raw) } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
