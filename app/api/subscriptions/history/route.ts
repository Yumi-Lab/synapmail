import { NextResponse } from 'next/server'
import { authenticate } from '@/lib/apiAuth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { countSubscriptionHistory, imapConfigOf } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// GET /api/subscriptions/history?account=<id>&id=<subscription>[&folder=INBOX]
// Counts, across the WHOLE mailbox, the messages of one newsletter — including
// the ones the list never sees, since it only reads the most recent messages of
// a single folder. READ ONLY: nothing is moved, nothing is deleted.
//
// Bearer or session, SAME access rule as `GET /api/subscriptions`: counting is
// reading. The purge below asks for more.
export async function GET(req: Request) {
  const authCtx = await authenticate(req)
  if (!authCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')
  const id = searchParams.get('id')
  const folder = searchParams.get('folder') ?? 'INBOX'
  if (!accountId || !id) {
    return NextResponse.json({ error: 'account and id are required' }, { status: 400 })
  }

  const account = await getAccessibleAccount(accountId, authCtx.id, [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const data = await countSubscriptionHistory({
      imap: imapConfigOf(account),
      accountId: account.id,
      folder,
      id,
    })
    if (!data) return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    // A sender's name is content written by a third party, exactly as on the list.
    return NextResponse.json(guardApiPayload({ data }, {
      enabled: isMachineRequest(req) && account.prompt_guard,
    }))
  } catch (err) {
    console.error('[/api/subscriptions/history] IMAP error:', String(err))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
