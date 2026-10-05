import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getAccountById } from '@/lib/accounts'
import { readTaggingStatus, UnknownEngineError, writeTaggingSettings } from '@/lib/tagging/mailbox'

export const dynamic = 'force-dynamic'

/**
 * Les réglages de tri d'une boîte — **session seule, propriétaire seul**, comme les identifiants
 * de la boîte (décision 9). Ils désignent un moteur, donc une clé : un délégué ne les règle pas,
 * et aucune clé API ne les lit (ces routes ne figurent pas dans `ROUTE_SCOPES`). Ce que la clé
 * API peut faire, c'est piloter le tri (`/api/tagging/run`) et lire son état
 * (`/api/tagging/status`) — jamais changer de moteur.
 *
 * `getAccountById` est la lecture PROPRIÉTAIRE : `getAccessibleAccount` accepterait un partage.
 */
async function owned(req: Request, fromBody?: string | null) {
  const session = await auth()
  if (!session?.user?.id) return { denied: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const accountId = fromBody ?? new URL(req.url).searchParams.get('account')
  if (!accountId) return { denied: NextResponse.json({ error: 'account required' }, { status: 400 }) }
  if (!(await getAccountById(accountId, session.user.id))) {
    return { denied: NextResponse.json({ error: 'Account not found' }, { status: 404 }) }
  }
  return { accountId, userId: session.user.id }
}

export async function GET(req: Request) {
  const gate = await owned(req)
  if ('denied' in gate) return gate.denied
  try {
    return NextResponse.json({ data: await readTaggingStatus(gate.accountId) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { accountId?: string; engineId?: string | null; budgetUsd?: unknown; live?: unknown; ged?: unknown }
    const gate = await owned(req, body.accountId ?? null)
    if ('denied' in gate) return gate.denied

    const budgetUsd = body.budgetUsd === undefined ? undefined : Number(body.budgetUsd)
    if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      return NextResponse.json({ error: 'budgetUsd must be a positive number' }, { status: 400 })
    }
    if (body.live !== undefined && typeof body.live !== 'boolean') {
      return NextResponse.json({ error: 'live must be a boolean' }, { status: 400 })
    }
    if (body.ged !== undefined && typeof body.ged !== 'boolean') {
      return NextResponse.json({ error: 'ged must be a boolean' }, { status: 400 })
    }

    const status = await writeTaggingSettings(gate.accountId, gate.userId, {
      engineId: body.engineId,
      budgetUsd,
      live: body.live as boolean | undefined,
      ged: body.ged as boolean | undefined,
    })
    return NextResponse.json({ data: status })
  } catch (err) {
    if (err instanceof UnknownEngineError) {
      return NextResponse.json({ error: err.message, engineId: err.engineId }, { status: 404 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
