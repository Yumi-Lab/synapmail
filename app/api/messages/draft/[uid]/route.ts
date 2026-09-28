import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { toImapConfig } from '@/lib/accounts'
import { appendDraft, deleteMessagesBulk, messageExists } from '@/lib/imap'
import { composeMail } from '@/lib/smtp'
import { prepareOutgoing } from '@/lib/outgoing'
import { DRAFT_ERROR, isValidUid, messageIdOf } from '@/lib/draft'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

/** La boîte et le dossier viennent de l'URL : c'est ce que la barrière a contrôlé. */
function target(req: Request) {
  const { searchParams } = new URL(req.url)
  return { accountId: searchParams.get('account'), folder: searchParams.get('folder') }
}

/**
 * Remplacer un brouillon : IMAP ne sait pas récrire un message, il faut en écrire un
 * nouveau et retirer l'ancien.
 *
 * L'ORDRE est la seule chose qui compte ici : l'APPEND d'abord, la suppression
 * SEULEMENT s'il a réussi. Dans l'autre sens, un serveur qui refuse l'écriture
 * laisserait l'agent sans son ancien texte ni le nouveau — une correction qui efface
 * ce qu'elle devait corriger. Un échec entre les deux laisse DEUX brouillons, ce qui
 * se voit et se répare ; une perte, non.
 */
async function putHandler(req: Request, { params }: { params: { uid: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const { accountId, folder } = target(req)
  if (!accountId || !folder) {
    return NextResponse.json({ error: 'account and folder params are required' }, { status: 400 })
  }
  if (!isValidUid(params.uid)) {
    return NextResponse.json({ error: DRAFT_ERROR.invalidUid }, { status: 400 })
  }

  try {
    const prepared = await prepareOutgoing(req, gate.ctx.id, accountId)
    if (!prepared.ok) return prepared.response
    const { account, mail } = prepared.value
    const config = toImapConfig(account)

    // Le brouillon visé doit exister AVANT qu'on en écrive un second : sinon un uid
    // périmé ferait naître un doublon que personne n'a demandé.
    if (!(await messageExists(config, folder, params.uid))) {
      return NextResponse.json({ error: DRAFT_ERROR.notFound }, { status: 404 })
    }

    const raw = await composeMail(mail)
    const written = await appendDraft(config, raw)
    if (!written) {
      return NextResponse.json({ error: DRAFT_ERROR.noDraftsFolder }, { status: 409 })
    }

    await deleteMessagesBulk(config, folder, [params.uid])

    return NextResponse.json({ data: { ...written, messageId: messageIdOf(raw), replaced: params.uid } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function deleteHandler(req: Request, { params }: { params: { uid: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const { accountId, folder } = target(req)
  if (!accountId || !folder) {
    return NextResponse.json({ error: 'account and folder params are required' }, { status: 400 })
  }
  if (!isValidUid(params.uid)) {
    return NextResponse.json({ error: DRAFT_ERROR.invalidUid }, { status: 400 })
  }

  try {
    const account = await getAccessibleAccount(accountId, gate.ctx.id, ['send'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    const config = toImapConfig(account)

    // Un uid déjà absent rend 404 plutôt que « supprimé » : l'appelant saurait
    // autrement qu'il a effacé quelque chose qui n'existait pas.
    if (!(await messageExists(config, folder, params.uid))) {
      return NextResponse.json({ error: DRAFT_ERROR.notFound }, { status: 404 })
    }
    await deleteMessagesBulk(config, folder, [params.uid])

    return NextResponse.json({ data: { folder, uid: params.uid, deleted: true } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const PUT = withApiLog(putHandler)
export const DELETE = withApiLog(deleteHandler)
