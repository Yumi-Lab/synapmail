import { NextResponse } from 'next/server'
import type { MailListFilter } from '@/lib/flags'
import { authorize } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { listMessages } from '@/lib/imap'
import { FOCUS_FILTER, FOCUS_SCAN, FOCUS_THRESHOLD, PRIORITY_SORT, byPriorityThenDate, imapFilterOf, withPriority } from '@/lib/focus'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const { searchParams } = new URL(req.url)
  const folder = searchParams.get('folder') ?? 'INBOX'
  const filter = (searchParams.get('filter') ?? 'all') as MailListFilter
  const isFocus = filter === FOCUS_FILTER
  // « À traiter » (lot T12) n'est pas paginé : UNE fenêtre des derniers non-lus, scorée puis
  // filtrée ici, rendue entière — `total` est alors exact, ce qu'une page filtrée ne saurait dire.
  const page = isFocus ? 1 : parseInt(searchParams.get('page') ?? '1')
  const perPage = isFocus ? FOCUS_SCAN : parseInt(searchParams.get('perPage') ?? '30')
  const byPriority = isFocus || searchParams.get('sort') === PRIORITY_SORT
  const accountParam = searchParams.get('account')

  try {
    type AccountRow = {
      id: string; imap_host: string; imap_port: number; imap_secure: boolean;
      username: string; password_encrypted: string; prompt_guard: boolean;
      oauth_provider: string | null; oauth_access_token: string | null;
      oauth_refresh_token: string | null; oauth_expires_at: number | null;
    }

    let account: AccountRow | null
    if (accountParam) {
      account = await getAccessibleAccount(accountParam, authCtx.id, [])
    } else {
      const rows = await query<AccountRow>(
        `SELECT * FROM email_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
        [authCtx.id]
      )
      account = rows[0] ?? null
    }

    if (!account) {
      return NextResponse.json({ messages: [], total: 0, error: 'No account configured' })
    }
    const result = await listMessages(
      {
        id: account.id,
        imapHost: account.imap_host,
        imapPort: account.imap_port,
        imapSecure: account.imap_secure,
        username: account.username,
        passwordEncrypted: account.password_encrypted,
        oauthProvider: account.oauth_provider,
        oauthAccessToken: account.oauth_access_token,
        oauthRefreshToken: account.oauth_refresh_token,
        oauthExpiresAt: account.oauth_expires_at,
      },
      folder,
      page,
      perPage,
      imapFilterOf(filter),
      authCtx.id
    )

    result.messages = result.messages.map(m => ({ ...m, accountId: account.id }))

    // Hide snoozed messages until their wake time (scheduler drops expired rows).
    const snoozed = await query<{ uid: string }>(
      `SELECT uid FROM snoozed_messages
       WHERE account_id = $1 AND folder = $2 AND snooze_until > now()`,
      [account.id, folder]
    )
    if (snoozed.length) {
      const hidden = new Set(snoozed.map(s => s.uid))
      const before = result.messages.length
      result.messages = result.messages.filter(m => !hidden.has(m.uid))
      result.total = Math.max(0, result.total - (before - result.messages.length))
    }

    // La priorité : LA fonction de « à traiter » (lib/focus.ts), pas une seconde.
    if (byPriority) {
      result.messages = (await withPriority(result.messages, account.id, authCtx.id)).sort(byPriorityThenDate)
      if (isFocus) {
        result.messages = result.messages.filter(m => (m.priority?.score ?? 0) >= FOCUS_THRESHOLD)
        result.total = result.messages.length
      }
    }

    // Mail content is untrusted input: an agent reading this response is warned,
    // a browser session keeps the historical payload (see lib/promptGuard.ts).
    return NextResponse.json(guardApiPayload(result, {
      enabled: isMachineRequest(req) && account.prompt_guard,
    }))
  } catch (err) {
    console.error('[/api/messages] IMAP error:', String(err))
    return NextResponse.json({ error: String(err), messages: [], total: 0 }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
