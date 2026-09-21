import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getRulesForUser, createRule } from '@/lib/rules'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { query } from '@/lib/db'
import type { EmailRule } from '@/types/rule'

export const dynamic = 'force-dynamic'

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')

  try {
    const rules = await getRulesForUser(userId)
    const filtered = accountId ? rules.filter(r => r.accountId === accountId) : rules
    return NextResponse.json({ data: filtered })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const body = await req.json() as Partial<EmailRule> & { accountId: string }

    if (!body.accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (!body.conditions?.length) return NextResponse.json({ error: 'At least one condition required' }, { status: 400 })
    if (!body.actions?.length) return NextResponse.json({ error: 'At least one action required' }, { status: 400 })

    const account = await getAccessibleAccount(body.accountId, userId, ['manageRules'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    // Get max priority for this account
    const maxRows = await query<{ max: number | null }>(
      'SELECT MAX(priority) as max FROM email_rules WHERE account_id = $1',
      [body.accountId]
    )
    const nextPriority = (maxRows[0]?.max ?? -1) + 1

    const rule = await createRule(userId, body.accountId, {
      name: body.name.trim(),
      enabled: body.enabled ?? true,
      priority: nextPriority,
      conditionLogic: body.conditionLogic ?? 'all',
      conditions: body.conditions ?? [],
      actions: body.actions ?? [],
      stopProcessing: body.stopProcessing ?? false,
    })

    return NextResponse.json({ data: rule }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
