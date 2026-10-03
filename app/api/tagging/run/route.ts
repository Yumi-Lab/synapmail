import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { drawAudit } from '@/lib/tagging/audit'
import { pauseMailbox, resumeMailbox, startBulk, startSample } from '@/lib/tagging/runner'
import { ensureMailboxTagging, readTaggingStatus } from '@/lib/tagging/mailbox'

export const dynamic = 'force-dynamic'

/**
 * Les actions de l'écran « Tri automatique », et rien de plus : ce sont des ordres d'ÉTAT, pas
 * un tri synchrone. Le travail lui-même reste au planificateur (`lib/scheduler.ts`), qui
 * dispose d'un budget par passage et du verrou par boîte — lancer le tri ici, dans le temps
 * d'une requête HTTP, ferait un second chemin de tri à tenir d'accord avec le premier.
 * `audit` (lot T14) est l'exception qui n'en est pas une : un tirage au hasard en base, sans
 * appel moteur, qui complète `tag_audits` jusqu'à la cible et rend l'état comme les autres.
 */
const ACTIONS = ['start', 'sample', 'pause', 'resume', 'restart', 'audit'] as const
type Action = (typeof ACTIONS)[number]
const isAction = (v: unknown): v is Action => typeof v === 'string' && (ACTIONS as readonly string[]).includes(v)

/**
 * Les bornes d'un échantillon. La taille plafonne parce qu'au-delà l'« échantillon » n'en est plus
 * un — c'est le tri complet, qui a son propre bouton et son propre curseur. La graine est bornée
 * au plus grand entier qu'un `number` et un BIGINT portent tous deux sans arrondi.
 */
const SAMPLE_MAX = { size: 100_000, seed: Number.MAX_SAFE_INTEGER } as const

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const body = await req.json() as { accountId?: string; action?: unknown; sampleSize?: unknown; sampleSeed?: unknown }
    if (!body.accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    if (!isAction(body.action)) {
      return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}`, action: body.action ?? null }, { status: 400 })
    }
    const account = await getAccessibleAccount(body.accountId, gate.ctx.id, ['organize'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    // Une taille ou une graine hors du prévu est REFUSÉE, pas corrigée en silence : un
    // échantillon dont la taille n'est pas celle demandée ne dit rien de ce qu'il mesure.
    const sample: { size?: number; seed?: number } = {}
    for (const [key, raw] of [['size', body.sampleSize], ['seed', body.sampleSeed]] as const) {
      if (raw === undefined || raw === null) continue
      const n = Number(raw)
      if (!Number.isInteger(n) || n < (key === 'size' ? 1 : 0) || n > SAMPLE_MAX[key]) {
        return NextResponse.json({ error: `sample${key === 'size' ? 'Size' : 'Seed'} must be an integer in 0..${SAMPLE_MAX[key]}`, [key]: raw }, { status: 400 })
      }
      sample[key] = n
    }

    await ensureMailboxTagging(body.accountId)
    if (body.action === 'start') await startBulk(body.accountId)
    else if (body.action === 'sample') await startSample(body.accountId, sample)
    else if (body.action === 'restart') await startBulk(body.accountId, { restart: true })
    else if (body.action === 'audit') {
      return NextResponse.json({ data: { ...(await readTaggingStatus(body.accountId)), audit: await drawAudit(body.accountId) } })
    }
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
