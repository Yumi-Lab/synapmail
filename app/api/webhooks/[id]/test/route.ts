import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { query } from '@/lib/db'
import { EVENT_TEST, getWebhook, queueWebhookDelivery } from '@/lib/webhooks'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/**
 * Un envoi d'essai SIGNÉ, inscrit au journal comme les autres et envoyé par le planificateur —
 * l'appel sortant ne part pas depuis cette requête HTTP, qui n'a pas à attendre 10 s un
 * récepteur muet. `rule_id` et `message_id` restent NULL : en SQL NULL n'égale pas NULL, donc
 * l'unicité de `webhook_deliveries` ne retient pas un essai, ce qu'on veut (il est répétable).
 */
async function postHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const hook = await getWebhook(params.id, gate.ctx.id)
    if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const [account] = await query<{ email: string }>('SELECT email FROM email_accounts WHERE id = $1', [hook.accountId])
    const deliveryId = await queueWebhookDelivery({
      webhook: { id: hook.id, accountId: hook.accountId },
      rule: null,
      account: { id: hook.accountId, email: account?.email ?? '' },
      event: EVENT_TEST,
    })
    if (!deliveryId) return NextResponse.json({ error: 'the test delivery could not be queued' }, { status: 500 })
    return NextResponse.json({ data: { deliveryId, event: EVENT_TEST } }, { status: 202 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
