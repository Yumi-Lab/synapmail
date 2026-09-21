import { NextResponse } from 'next/server'
import { authenticate, authorize } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { ACCESSIBLE_ORDER_BY_ALIASED, ACTIVE_SHARE_SQL } from '@/lib/accountAccess'
import { encrypt } from '@/lib/encrypt'
import { DEFAULT_IMAP_PORT, DEFAULT_SMTP_PORT } from '@/lib/accountTest'
import { probeConnection } from '@/lib/accountProbe'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const authCtx = await authenticate(req)
  if (!authCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const accounts = await query(
      `SELECT a.id, a.name, a.email,
              a.imap_host AS "imapHost", a.imap_port AS "imapPort", a.imap_secure AS "imapSecure",
              a.smtp_host AS "smtpHost", a.smtp_port AS "smtpPort", a.smtp_secure AS "smtpSecure",
              a.username, a.is_default AS "isDefault",
              a.oauth_provider AS "oauthProvider", a.prompt_guard AS "promptGuard",
              a.badge_color AS "badgeColor",
              a.created_at AS "createdAt",
              -- authoritative SEARCH UNSEEN count (mailbox_stats), falling back to
              -- the cached-row count until the first background sync populates it
              COALESCE(s.unread_count, u.cnt, 0)::int AS "unreadCount",
              false AS "isShared", NULL::text AS "ownerName", NULL::timestamptz AS "expiresAt",
              NULL::uuid AS "shareId",
              true AS "canSend", true AS "canDelete", true AS "canOrganize",
              true AS "canManageRules", true AS "canManageSignatures"
       FROM email_accounts a
       LEFT JOIN mailbox_stats s ON s.account_id = a.id AND s.folder = 'INBOX'
       LEFT JOIN (
         SELECT account_id, COUNT(*)::int AS cnt
         FROM messages_cache
         WHERE is_read = false AND folder ILIKE 'INBOX'
         GROUP BY account_id
       ) u ON u.account_id = a.id
       WHERE a.user_id = $1

       UNION ALL

       SELECT a.id, a.name, a.email,
              a.imap_host AS "imapHost", a.imap_port AS "imapPort", a.imap_secure AS "imapSecure",
              a.smtp_host AS "smtpHost", a.smtp_port AS "smtpPort", a.smtp_secure AS "smtpSecure",
              a.username, false AS "isDefault",
              a.oauth_provider AS "oauthProvider", a.prompt_guard AS "promptGuard",
              a.badge_color AS "badgeColor",
              a.created_at AS "createdAt",
              COALESCE(ms.unread_count, um.cnt, 0)::int AS "unreadCount",
              true AS "isShared", owner.name AS "ownerName", sh.expires_at AS "expiresAt",
              sh.id AS "shareId",
              sh.can_send AS "canSend", sh.can_delete AS "canDelete", sh.can_organize AS "canOrganize",
              sh.can_manage_rules AS "canManageRules", sh.can_manage_signatures AS "canManageSignatures"
       FROM account_shares sh
       JOIN email_accounts a ON a.id = sh.account_id
       JOIN users owner ON owner.id = a.user_id
       LEFT JOIN mailbox_stats ms ON ms.account_id = a.id AND ms.folder = 'INBOX'
       LEFT JOIN (
         SELECT account_id, COUNT(*)::int AS cnt
         FROM messages_cache
         WHERE is_read = false AND folder ILIKE 'INBOX'
         GROUP BY account_id
       ) um ON um.account_id = a.id
       WHERE sh.invitee_user_id = $1 AND ${ACTIVE_SHARE_SQL}

       ${ACCESSIBLE_ORDER_BY_ALIASED}`,
      [authCtx.id]
    )

    const data = accounts.map((a: Record<string, unknown>) => {
      const { canSend, canDelete, canOrganize, canManageRules, canManageSignatures, ...rest } = a
      return {
        ...rest,
        permissions: { canSend, canDelete, canOrganize, canManageRules, canManageSignatures },
      }
    })
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const access = await authorize(req)
  if ('denied' in access) return access.denied
  const userId = access.ctx.id

  try {
    const body = await req.json()
    const {
      name, email, imapHost, imapPort, imapSecure,
      smtpHost, smtpPort, smtpSecure, username, password,
      isDefault = false,
    } = body

    if (!name || !email || !imapHost || !smtpHost || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // On ESSAIE la boîte avant de l'enregistrer. Sans cela, un appelant — un agent en
    // particulier — pouvait déposer des identifiants faux et obtenir un 201 : la boîte
    // apparaissait dans la barre latérale et ne chargeait jamais le moindre message, sans
    // que personne n'ait été prévenu. Un IMAP qui refuse la connexion rend la boîte
    // inutilisable, donc on ne l'enregistre pas ; un SMTP qui refuse n'empêche que l'envoi,
    // on l'enregistre et on le SIGNALE. `verify: false` reste possible pour qui enregistre
    // une boîte volontairement hors ligne.
    const connection = {
      imapHost, imapPort: imapPort ?? DEFAULT_IMAP_PORT, imapSecure: imapSecure ?? true,
      smtpHost, smtpPort: smtpPort ?? DEFAULT_SMTP_PORT, smtpSecure: smtpSecure ?? true,
      username,
    }
    let verified: Awaited<ReturnType<typeof probeConnection>> | null = null
    if (body.verify !== false) {
      verified = await probeConnection(connection, password)
      if (!verified.imap.ok) {
        return NextResponse.json(
          { error: 'imap_unreachable', imap: verified.imap, smtp: verified.smtp },
          { status: 422 }
        )
      }
    }

    const passwordEncrypted = encrypt(password)

    if (isDefault) {
      await query(
        'UPDATE email_accounts SET is_default = false WHERE user_id = $1',
        [userId]
      )
    }

    const result = await query(
      `INSERT INTO email_accounts
        (user_id, name, email, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure, username, password_encrypted, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, name, email, imap_host, imap_port, imap_secure,
                 smtp_host, smtp_port, smtp_secure, username, is_default, created_at`,
      [
        userId, name, email,
        imapHost, connection.imapPort, connection.imapSecure,
        smtpHost, connection.smtpPort, connection.smtpSecure,
        username, passwordEncrypted, isDefault,
      ]
    )

    // L'appelant repart avec le verdict : une boîte qui reçoit mais n'envoie pas est
    // utilisable, encore faut-il le savoir avant d'essayer d'écrire à quelqu'un.
    return NextResponse.json({ data: result[0], verified }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
