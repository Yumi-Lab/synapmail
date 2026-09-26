import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { readTags, sourceForWriter, writeTags,
  ForbiddenSourceError, InvalidTagError,
  type TagToWrite, type TaggedMessagePosition } from '@/lib/tagging/store'

export const dynamic = 'force-dynamic'

/**
 * Les étiquettes d'UN message. `params.id` est son **Message-ID RFC** encodé
 * (`encodeURIComponent`, chevrons compris) et non son UID IMAP : un UID change dès que le
 * mail change de dossier, le Message-ID non (décision 6). Next.js le décode déjà ; le
 * réencodage n'a pas lieu ici.
 */
const messageIdFrom = (params: { id: string }): string => decodeURIComponent(params.id)

/**
 * La boîte désignée par la requête, ou le refus à rendre. Elle se nomme comme la barrière par
 * clé la cherche déjà (`account` / `accountId`, `lib/apiKeyAccounts.ts`) : une route qui la
 * nommerait autrement échapperait à cette barrière.
 */
async function denyUnreachable(accountId: string | null, userId: string, required: 'organize' | null): Promise<NextResponse | null> {
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, userId, required ? [required] : [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  return null
}

async function getHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const accountId = new URL(req.url).searchParams.get('account')
  const denied = await denyUnreachable(accountId, gate.ctx.id, null)
  if (denied) return denied

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
 * écrit le type d'un moteur. `valide_par` n'est renseigné que pour un humain : c'est lui qui
 * valide.
 */
async function putHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const body = await req.json() as {
      accountId?: string; source?: unknown; model?: string | null
      tags?: TagToWrite[]
    } & TaggedMessagePosition

    const accountId = body.accountId ?? null
    const denied = await denyUnreachable(accountId, gate.ctx.id, 'organize')
    if (denied) return denied
    if (!Array.isArray(body.tags) || !body.tags.length) {
      return NextResponse.json({ error: 'tags required' }, { status: 400 })
    }

    const session = gate.ctx.apiKeyId === null
    const source = sourceForWriter({ session, requested: body.source })
    const messageId = messageIdFrom(params)
    const position: TaggedMessagePosition = {
      folder: body.folder, uid: body.uid, fromName: body.fromName,
      fromAddress: body.fromAddress, subject: body.subject, date: body.date,
    }
    const written = await writeTags({
      accountId: accountId!, messageId, source, tags: body.tags,
      modele: body.model ?? null,
      validePar: session ? gate.ctx.id : null,
      position: Object.values(position).some(v => v !== undefined && v !== null) ? position : null,
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
      return NextResponse.json({ error: err.message, source: err.source }, { status: 403 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const PUT = withApiLog(putHandler)
