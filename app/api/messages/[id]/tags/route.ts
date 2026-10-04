import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount, type AccessibleAccount } from '@/lib/accountAccess'
import { toImapConfig } from '@/lib/accounts'
import { getMessage } from '@/lib/imap'
import { buildState, type EngineState } from '@/lib/tagging/engine'
import { authorForWriter, latestState, readTags, removeHumanTag, sourceForWriter, writeTags,
  ForbiddenSourceError, InvalidTagError,
  type TagToWrite, type TaggedMessagePosition } from '@/lib/tagging/store'

export const dynamic = 'force-dynamic'

/**
 * Les étiquettes d'UN message. `params.id` est son **Message-ID RFC** encodé
 * (`encodeURIComponent`, chevrons compris) et non son UID IMAP : un UID change dès que le
 * mail change de dossier, le Message-ID non (décision 6).
 *
 * Next.js a DÉJÀ décodé le segment : le redécoder détruirait tout Message-ID portant un `%`
 * littéral — `<a/b+c%d=e@…>` redécodé lève `URIError: URI malformed` (mesuré, lot T4), et un
 * `%41` littéral deviendrait un `A`. On prend donc le segment tel quel.
 */
const messageIdFrom = (params: { id: string }): string => params.id

/**
 * La boîte désignée par la requête, ou le refus à rendre. Elle se nomme comme la barrière par
 * clé la cherche déjà (`account` / `accountId`, `lib/apiKeyAccounts.ts`) : une route qui la
 * nommerait autrement échapperait à cette barrière.
 */
async function denyUnreachable(accountId: string | null, userId: string, required: 'organize' | null): Promise<NextResponse | AccessibleAccount> {
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, userId, required ? [required] : [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  return account
}

/**
 * L'instantané d'état que porte une étiquette écrite par cette route (décision 14) : le MÊME
 * que celui du moteur quand le mail a déjà été jugé (`latestState`) ; sinon, reconstruit avec
 * `buildState` sur le mail relu par IMAP (`folder` + `uid` du corps). Sans position, ou si le
 * mail n'est plus là, l'étiquette entre sans instantané (`state_hash` vide = « texte inconnu »)
 * plutôt que d'être refusée : la validation ne doit jamais dépendre de la boîte distante.
 */
async function stateFor(account: AccessibleAccount, messageId: string, folder: unknown, uid: unknown): Promise<EngineState | null> {
  const known = await latestState(account.id, messageId)
  if (known) return known
  if (typeof folder !== 'string' || !folder || uid === undefined || uid === null) return null
  const message = await getMessage(toImapConfig(account), folder, String(uid)).catch(() => null)
  if (!message) return null
  return buildState({ fromName: message.from.name, fromAddress: message.from.address, subject: message.subject, bodyPlain: message.bodyPlain, bodyHtml: message.bodyHtml })
}

async function getHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const accountId = new URL(req.url).searchParams.get('account')
  const denied = await denyUnreachable(accountId, gate.ctx.id, null)
  if (denied instanceof NextResponse) return denied

  try {
    const messageId = messageIdFrom(params)
    const { tags, effective } = await readTags(accountId!, messageId)
    return NextResponse.json({ data: { messageId, tags, effective } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * Écrit les étiquettes d'UNE source sur ce message. La source n'est PAS libre : elle se
 * déduit de l'appelant (`sourceForWriter`, décision 7) — une session écrit `humain`, une clé
 * écrit le type d'un moteur. L'AUTEUR non plus (`authorForWriter`, décision 23) : l'utilisateur
 * de la session, ou le moteur que la clé nomme par `engineId` (sinon la clé elle-même).
 * `valide_par` n'est renseigné que pour un humain : c'est lui qui valide.
 */
async function putHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const body = await req.json() as {
      accountId?: string; source?: unknown; model?: string | null; engineId?: unknown
      tags?: TagToWrite[]
    } & TaggedMessagePosition

    const accountId = body.accountId ?? null
    const account = await denyUnreachable(accountId, gate.ctx.id, 'organize')
    if (account instanceof NextResponse) return account
    if (!Array.isArray(body.tags) || !body.tags.length) {
      return NextResponse.json({ error: 'tags required' }, { status: 400 })
    }

    const session = gate.ctx.apiKeyId === null
    const source = sourceForWriter({ session, requested: body.source })
    const auteur = await authorForWriter({ userId: gate.ctx.id, apiKeyId: gate.ctx.apiKeyId, engineId: body.engineId })
    const messageId = messageIdFrom(params)
    const position: TaggedMessagePosition = {
      folder: body.folder, uid: body.uid, fromName: body.fromName,
      fromAddress: body.fromAddress, subject: body.subject, date: body.date,
    }
    const written = await writeTags({
      accountId: accountId!, messageId, source, auteur, tags: body.tags,
      modele: body.model ?? null,
      validePar: session ? gate.ctx.id : null,
      position: Object.values(position).some(v => v !== undefined && v !== null) ? position : null,
      state: await stateFor(account, messageId, body.folder, body.uid),
    })

    const { tags, effective } = await readTags(accountId!, messageId)
    return NextResponse.json({ data: { messageId, written, source, tags, effective } })
  } catch (err) {
    // Une valeur hors liste et une source interdite sont des refus NOMMÉS : l'appelant doit
    // savoir laquelle, sinon il ne peut rien corriger. Voir lib/tagging/store.ts.
    if (err instanceof InvalidTagError) {
      return NextResponse.json({ error: err.message, question: err.question, valeur: err.valeur }, { status: 422 })
    }
    if (err instanceof ForbiddenSourceError) {
      // Une source interdite ET un `engineId` qui n'est pas à l'appelant tombent ici : les deux
      // sont un « tu ne signes pas de ce nom-là », et la réponse nomme ce qui a été refusé.
      return NextResponse.json({ error: err.message, source: err.source }, { status: 403 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * « Défaire » (lot T15) : retire la ligne `humain` que CETTE session vient d'écrire sur UNE
 * question (`?question=`). Session seule — une clé n'écrit jamais `humain`, elle n'a donc rien à
 * défaire. La ligne d'un moteur n'est jamais touchée (décision 5) ; l'item revient dans la file.
 * Hors `withApiLog` : le journal ne concerne que les clés, et il n'en passe aucune ici.
 */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const question = searchParams.get('question')
  if (!question) return NextResponse.json({ error: 'question required' }, { status: 400 })
  const account = await denyUnreachable(searchParams.get('account'), session.user.id, 'organize')
  if (account instanceof NextResponse) return account

  try {
    const messageId = messageIdFrom(params)
    const removed = await removeHumanTag(account.id, messageId, question, session.user.id)
    const { tags, effective } = await readTags(account.id, messageId)
    return NextResponse.json({ data: { messageId, removed, tags, effective } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const PUT = withApiLog(putHandler)
