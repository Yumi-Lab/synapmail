import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { searchMessages } from '@/lib/imap'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

type AccountRow = {
  id: string; imap_host: string; imap_port: number; imap_secure: boolean;
  username: string; password_encrypted: string; prompt_guard: boolean;
  oauth_provider: string | null; oauth_access_token: string | null;
  oauth_refresh_token: string | null; oauth_expires_at: number | null;
}

// Strip Re:/Fwd:/etc. prefixes recursively
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(Re|Rép|Fwd|Fw|TR|AW|SV|VS):\s*/gi, '')
    .trim()
}

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const { searchParams } = new URL(req.url)
  const rawSubject = searchParams.get('subject')
  const folder = searchParams.get('folder') ?? 'INBOX'
  const accountParam = searchParams.get('account')

  if (!rawSubject) {
    return NextResponse.json({ messages: [] })
  }

  const normalizedSubject = normalizeSubject(rawSubject)

  if (!normalizedSubject || normalizedSubject.length < 2) {
    return NextResponse.json({ messages: [] })
  }

  try {
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
      return NextResponse.json({ messages: [], error: 'No account configured' })
    }

    // Search IMAP for messages matching the normalized subject
    const messages = await searchMessages(
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
      normalizedSubject
    )

    // Filter to only messages that have the same normalized subject
    const filtered = messages.filter(m =>
      normalizeSubject(m.subject).toLowerCase() === normalizedSubject.toLowerCase()
    )

    // Sort oldest first
    filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    return NextResponse.json(guardApiPayload({
      messages: filtered.map(m => ({ ...m, accountId: account.id }))
    }, { enabled: isMachineRequest(req) && account.prompt_guard }))
  } catch (err) {
    return NextResponse.json({ error: String(err), messages: [] }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
