import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { schedulerEvents } from '@/lib/schedulerEvents'

export const dynamic = 'force-dynamic'

type PendingShare = {
  id: string
  account_id: string
  invitee_user_id: string
  owner_id: string
  owner_name: string
  account_email: string
  invitee_email: string
  can_send: boolean
  can_delete: boolean
  can_organize: boolean
  can_manage_rules: boolean
  can_manage_signatures: boolean
}

async function findPendingShare(token: string): Promise<PendingShare | null> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const rows = await query<PendingShare>(
    `SELECT s.id, s.account_id, s.invitee_user_id, s.can_send, s.can_delete, s.can_organize,
            s.can_manage_rules, s.can_manage_signatures,
            a.email AS account_email, owner.id AS owner_id, owner.name AS owner_name,
            invitee.email AS invitee_email
     FROM account_shares s
     JOIN email_accounts a ON a.id = s.account_id
     JOIN users owner ON owner.id = s.invited_by
     JOIN users invitee ON invitee.id = s.invitee_user_id
     WHERE s.invite_token_hash = $1 AND s.status = 'pending'
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
     LIMIT 1`,
    [tokenHash]
  )
  return rows[0] ?? null
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  try {
    const share = await findPendingShare(params.token)
    if (!share) return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 404 })
    return NextResponse.json({
      data: {
        accountEmail: share.account_email,
        ownerName: share.owner_name,
        inviteeEmail: share.invitee_email,
        permissions: {
          canSend: share.can_send,
          canDelete: share.can_delete,
          canOrganize: share.can_organize,
          canManageRules: share.can_manage_rules,
          canManageSignatures: share.can_manage_signatures,
        },
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  try {
    const { name, password } = (await req.json()) as { name?: string; password?: string }
    if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    if (!password || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    const share = await findPendingShare(params.token)
    if (!share) return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 404 })

    const hash = await bcrypt.hash(password, 12)
    await query(
      `UPDATE users SET name = $1, password_hash = $2, status = 'active' WHERE id = $3`,
      [name.trim(), hash, share.invitee_user_id]
    )
    await query(
      `UPDATE account_shares SET status = 'active', accepted_at = NOW(), invite_token_hash = NULL WHERE id = $1`,
      [share.id]
    )

    schedulerEvents.emit('account_share_accepted', {
      ownerId: share.owner_id,
      accountId: share.account_id,
      accountEmail: share.account_email,
      inviteeEmail: share.invitee_email,
    })

    return NextResponse.json({ data: { success: true } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
