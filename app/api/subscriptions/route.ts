import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { imapConfigOf, listSubscriptions } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// GET /api/subscriptions?account=<id>[&folder=INBOX]
// Lists the newsletters of a mailbox, grouped per list, most frequent first.
// Bearer or session, SAME access rule as GET /api/messages (read access is an
// active share or ownership — `getAccessibleAccount` with no extra permission).
export async function GET(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')
  const folder = searchParams.get('folder') ?? 'INBOX'
  if (!accountId) return NextResponse.json({ error: 'account is required' }, { status: 400 })

  const account = await getAccessibleAccount(accountId, authCtx.id, [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const data = await listSubscriptions(imapConfigOf(account), account.id, folder)
    // A sender's name and a subject are content written by a third party: an
    // agent reading this list is warned exactly as on the message routes.
    return NextResponse.json(guardApiPayload({ data }, {
      enabled: isMachineRequest(req) && account.prompt_guard,
    }))
  } catch (err) {
    console.error('[/api/subscriptions] IMAP error:', String(err))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
