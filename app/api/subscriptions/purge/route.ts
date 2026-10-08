import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { imapConfigOf, purgeSubscriptionHistory } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// POST /api/subscriptions/purge
// Body: { account: string, id: string, expected: number, folder?: string }
//
// Moves a newsletter's WHOLE history to the mailbox's trash. Never a permanent
// deletion and never an expunge: a mistake stays recoverable from the trash.
//
// Bearer or session, access rule `delete` — the strictest of the two the gesture
// touches, and strictly above the `send` an unsubscribe asks for: this route
// repeats what `DELETE /api/messages/bulk` does, on messages the caller has not
// listed one by one.
//
// `expected` is the total `GET /api/subscriptions/history` answered. The purge
// refuses when the mailbox no longer holds that number: the caller only ever
// consented to what it saw.
export async function POST(req: Request) {
  // `authorize` et non `authenticate` : le refus doit NOMMER ce qui manque, la portée ou la
  // boîte. Un 401 muet laisse un agent deviner, et surtout il masque le fait que la barrière
  // par boîte s'est bien appliquée.
  const acces = await authorize(req)
  if ('denied' in acces) return acces.denied
  const authCtx = acces.ctx

  const body = (await req.json().catch(() => null)) as
    | { account?: string; id?: string; expected?: unknown; folder?: string }
    | null
  const accountId = body?.account
  const id = body?.id
  const expected = body?.expected
  const folder = body?.folder ?? 'INBOX'

  if (!accountId || !id) {
    return NextResponse.json({ error: 'account and id are required' }, { status: 400 })
  }
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return NextResponse.json(
      { error: 'expected must be the total answered by GET /api/subscriptions/history' },
      { status: 400 }
    )
  }

  const account = await getAccessibleAccount(accountId, authCtx.id, ['delete'])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const data = await purgeSubscriptionHistory({
      imap: imapConfigOf(account),
      accountId: account.id,
      folder,
      id,
      expected,
    })
    // A refusal is an ANSWER, not a server fault: the caller re-reads the count
    // and asks again. 409 says exactly that, and carries the new total.
    if ('refused' in data) return NextResponse.json({ data }, { status: 409 })
    return NextResponse.json({ data })
  } catch (err) {
    console.error('[/api/subscriptions/purge] IMAP error:', String(err))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
