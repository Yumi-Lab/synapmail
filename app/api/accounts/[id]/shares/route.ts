import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { sendMail } from '@/lib/smtp'

export const dynamic = 'force-dynamic'

type ShareRow = {
  id: string
  status: string
  can_send: boolean
  can_delete: boolean
  can_organize: boolean
  can_manage_rules: boolean
  can_manage_signatures: boolean
  expires_at: string | null
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
}

function toApi(r: ShareRow, inviteeEmail: string, inviteeName: string) {
  return {
    id: r.id,
    status: r.status,
    inviteeEmail,
    inviteeName,
    permissions: {
      canSend: r.can_send,
      canDelete: r.can_delete,
      canOrganize: r.can_organize,
      canManageRules: r.can_manage_rules,
      canManageSignatures: r.can_manage_signatures,
    },
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  }
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const owned = await query<{ id: string }>(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 LIMIT 1',
    [params.id, session.user.id]
  )
  if (!owned.length) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const rows = await query<ShareRow & { invitee_email: string; invitee_name: string }>(
      `SELECT s.id, s.status, s.can_send, s.can_delete, s.can_organize,
              s.can_manage_rules, s.can_manage_signatures,
              s.expires_at, s.accepted_at, s.revoked_at, s.created_at,
              u.email AS invitee_email, u.name AS invitee_name
       FROM account_shares s
       JOIN users u ON u.id = s.invitee_user_id
       WHERE s.account_id = $1
       ORDER BY s.created_at DESC`,
      [params.id]
    )
    return NextResponse.json({ data: rows.map(r => toApi(r, r.invitee_email, r.invitee_name)) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const {
      email, canSend = false, canDelete = false, canOrganize = false,
      canManageRules = false, canManageSignatures = false, expiresAt,
    } = body as {
      email?: string; canSend?: boolean; canDelete?: boolean; canOrganize?: boolean
      canManageRules?: boolean; canManageSignatures?: boolean; expiresAt?: string
    }

    const normalizedEmail = email?.trim().toLowerCase()
    if (!normalizedEmail) return NextResponse.json({ error: 'email is required' }, { status: 400 })
    if (normalizedEmail === session.user.email?.toLowerCase()) {
      return NextResponse.json({ error: "Cannot share an account with yourself" }, { status: 400 })
    }

    const accounts = await query<{
      id: string; email: string;
      smtp_host: string; smtp_port: number; smtp_secure: boolean;
      username: string; password_encrypted: string;
      oauth_provider: string | null; oauth_access_token: string | null;
      oauth_refresh_token: string | null; oauth_expires_at: number | null;
    }>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 LIMIT 1', [params.id, session.user.id])
    if (!accounts.length) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    const account = accounts[0]

    const expiresAtValue = expiresAt ? new Date(expiresAt) : null
    if (expiresAtValue && isNaN(expiresAtValue.getTime())) {
      return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 })
    }

    const smtpConfig = {
      id: account.id,
      smtpHost: account.smtp_host,
      smtpPort: account.smtp_port,
      smtpSecure: account.smtp_secure,
      username: account.username,
      passwordEncrypted: account.password_encrypted,
      oauthProvider: account.oauth_provider,
      oauthAccessToken: account.oauth_access_token,
      oauthRefreshToken: account.oauth_refresh_token,
      oauthExpiresAt: account.oauth_expires_at,
    }
    const ownerName = session.user.name ?? account.email

    const existingUsers = await query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE email = $1',
      [normalizedEmail]
    )

    let emailSent = false
    let share: ShareRow

    if (existingUsers.length) {
      const invitee = existingUsers[0]
      const rows = await query<ShareRow>(
        `INSERT INTO account_shares
           (account_id, invited_by, invitee_user_id, status, can_send, can_delete,
            can_organize, can_manage_rules, can_manage_signatures, expires_at, accepted_at)
         VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (account_id, invitee_user_id) WHERE status IN ('pending','active')
         DO UPDATE SET status = 'active', can_send = $4, can_delete = $5, can_organize = $6,
                        can_manage_rules = $7, can_manage_signatures = $8, expires_at = $9,
                        accepted_at = NOW(), invite_token_hash = NULL, revoked_at = NULL
         RETURNING id, status, can_send, can_delete, can_organize, can_manage_rules,
                   can_manage_signatures, expires_at, accepted_at, revoked_at, created_at`,
        [params.id, session.user.id, invitee.id, canSend, canDelete, canOrganize, canManageRules, canManageSignatures, expiresAtValue]
      )
      share = rows[0]

      try {
        await sendMail(smtpConfig, {
          from: account.email,
          to: [normalizedEmail],
          subject: `${ownerName} vous a donné accès à ${account.email}`,
          html: `<p>${ownerName} vous a donné accès à sa boîte <strong>${account.email}</strong> dans Synapmail.</p><p>Connectez-vous avec votre compte existant pour la voir apparaître dans votre barre latérale.</p>`,
        })
        emailSent = true
      } catch (err) {
        console.error('[shares] notification email failed:', err)
      }

      return NextResponse.json({ data: { ...toApi(share, normalizedEmail, invitee.name), emailSent } }, { status: 201 })
    }

    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)
    const newUsers = await query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'user', 'pending') RETURNING id`,
      [normalizedEmail.split('@')[0], normalizedEmail, placeholderHash]
    )
    const inviteeId = newUsers[0].id

    const rawToken = crypto.randomBytes(24).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

    const rows = await query<ShareRow>(
      `INSERT INTO account_shares
         (account_id, invited_by, invitee_user_id, status, invite_token_hash,
          can_send, can_delete, can_organize, can_manage_rules, can_manage_signatures, expires_at)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, status, can_send, can_delete, can_organize, can_manage_rules,
                 can_manage_signatures, expires_at, accepted_at, revoked_at, created_at`,
      [params.id, session.user.id, inviteeId, tokenHash, canSend, canDelete, canOrganize, canManageRules, canManageSignatures, expiresAtValue]
    )
    share = rows[0]

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
    const acceptUrl = `${appUrl}/invite/${rawToken}`
    try {
      await sendMail(smtpConfig, {
        from: account.email,
        to: [normalizedEmail],
        subject: `${ownerName} vous invite à accéder à ${account.email} sur Synapmail`,
        html: `<p>${ownerName} vous invite à accéder à sa boîte <strong>${account.email}</strong> dans Synapmail.</p><p><a href="${acceptUrl}">Accepter l'invitation</a></p>`,
      })
      emailSent = true
    } catch (err) {
      console.error('[shares] invite email failed:', err)
    }

    return NextResponse.json({ data: { ...toApi(share, normalizedEmail, ''), emailSent } }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
