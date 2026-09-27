import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { checkWebhookUrl, createWebhook, listWebhooks, WEBHOOK_NAME_MAX } from '@/lib/webhooks'

export const dynamic = 'force-dynamic'

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const accountId = new URL(req.url).searchParams.get('account')
  try {
    return NextResponse.json({ data: await listWebhooks(gate.ctx.id, accountId) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const body = await req.json() as { accountId?: string; name?: string; url?: string; enabled?: boolean }

    if (!body.accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (body.name.trim().length > WEBHOOK_NAME_MAX) {
      return NextResponse.json({ error: `name longer than ${WEBHOOK_NAME_MAX} characters` }, { status: 400 })
    }
    if (!body.url?.trim()) return NextResponse.json({ error: 'url required' }, { status: 400 })

    // Un webhook EST une règle vue de l'autre bout (décision 1) : la même permission de partage.
    const account = await getAccessibleAccount(body.accountId, userId, ['manageRules'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    // L'adresse est contrôlée ICI, avant d'écrire : une ligne enregistrée ne porte jamais une
    // URL que le serveur refusera d'appeler, et le 422 NOMME le motif du refus (décision 6).
    const verdict = await checkWebhookUrl(body.url.trim())
    if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 422 })

    const created = await createWebhook({
      userId,
      accountId: body.accountId,
      name: body.name.trim(),
      url: body.url.trim(),
      enabled: body.enabled ?? true,
      createdByApiKey: gate.ctx.apiKeyId,
    })
    // Le secret n'est rendu qu'ICI et à la régénération — comme une clé API.
    return NextResponse.json({ data: created }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
