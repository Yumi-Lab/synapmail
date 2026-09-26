import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { pauseMailbox, resumeMailbox, startBulk } from '@/lib/tagging/runner'
import { ensureMailboxTagging, readTaggingStatus } from '@/lib/tagging/mailbox'

export const dynamic = 'force-dynamic'

/**
 * Les actions de l'écran « Tri automatique », et rien de plus : ce sont des ordres d'ÉTAT, pas
 * un tri synchrone. Le travail lui-même reste au planificateur (`lib/scheduler.ts`), qui
 * dispose d'un budget par passage et du verrou par boîte — lancer le tri ici, dans le temps
 * d'une requête HTTP, ferait un second chemin de tri à tenir d'accord avec le premier.
 */
const ACTIONS = ['start', 'pause', 'resume', 'restart'] as const
type Action = (typeof ACTIONS)[number]
const isAction = (v: unknown): v is Action => typeof v === 'string' && (ACTIONS as readonly string[]).includes(v)

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const body = await req.json() as { accountId?: string; action?: unknown }
    if (!body.accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    if (!isAction(body.action)) {
      return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}`, action: body.action ?? null }, { status: 400 })
    }
    const account = await getAccessibleAccount(body.accountId, gate.ctx.id, ['organize'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    await ensureMailboxTagging(body.accountId)
    if (body.action === 'start') await startBulk(body.accountId)
    else if (body.action === 'restart') await startBulk(body.accountId, { restart: true })
    // La pause demandée par la main porte la raison `user` : c'est ce qui la distingue d'un
    // plafond ou d'un crédit épuisé à l'écran, et d'une reprise automatique.
    else if (body.action === 'pause') await pauseMailbox(body.accountId, 'user', 'mise en pause depuis l’écran de tri')
    else await resumeMailbox(body.accountId)

    return NextResponse.json({ data: await readTaggingStatus(body.accountId) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
