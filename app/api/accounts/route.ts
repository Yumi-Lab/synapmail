import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { authenticate } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { encrypt } from '@/lib/encrypt'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const authCtx = await authenticate(req)
  if (!authCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const accounts = await query(
      `SELECT a.id, a.name, a.email,
              a.imap_host AS "imapHost", a.imap_port AS "imapPort", a.imap_secure AS "imapSecure",
              a.smtp_host AS "smtpHost", a.smtp_port AS "smtpPort", a.smtp_secure AS "smtpSecure",
              a.username, a.is_default AS "isDefault", a.color,
              a.oauth_provider AS "oauthProvider", a.created_at AS "createdAt",
              -- authoritative SEARCH UNSEEN count (mailbox_stats), falling back to
              -- the cached-row count until the first background sync populates it
              COALESCE(s.unread_count, u.cnt, 0)::int AS "unreadCount"
       FROM email_accounts a
       LEFT JOIN mailbox_stats s ON s.account_id = a.id AND s.folder = 'INBOX'
       LEFT JOIN (
         SELECT account_id, COUNT(*)::int AS cnt
         FROM messages_cache
         WHERE is_read = false AND folder ILIKE 'INBOX'
         GROUP BY account_id
       ) u ON u.account_id = a.id
       WHERE a.user_id = $1
       ORDER BY a.is_default DESC, a.created_at ASC`,
      [authCtx.id]
    )
    return NextResponse.json({ data: accounts })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const {
      name, email, imapHost, imapPort, imapSecure,
      smtpHost, smtpPort, smtpSecure, username, password,
      isDefault = false, color = '#6366f1',
    } = body

    if (!name || !email || !imapHost || !smtpHost || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const passwordEncrypted = encrypt(password)

    if (isDefault) {
      await query(
        'UPDATE email_accounts SET is_default = false WHERE user_id = $1',
        [session.user?.id]
      )
    }

    const result = await query(
      `INSERT INTO email_accounts
        (user_id, name, email, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure, username, password_encrypted, is_default, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, name, email, imap_host, imap_port, imap_secure,
                 smtp_host, smtp_port, smtp_secure, username, is_default, color, created_at`,
      [
        session.user?.id, name, email,
        imapHost, imapPort ?? 993, imapSecure ?? true,
        smtpHost, smtpPort ?? 587, smtpSecure ?? false,
        username, passwordEncrypted, isDefault, color,
      ]
    )

    return NextResponse.json({ data: result[0] }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
