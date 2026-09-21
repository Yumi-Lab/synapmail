import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { encrypt } from '@/lib/encrypt'
import { isBadgeColor } from '@/lib/accountColor'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

async function patchHandler(
  req: Request,
  { params }: { params: { id: string } }
) {
  const access = await authorize(req)
  if ('denied' in access) return access.denied
  const userId = access.ctx.id

  try {
    const body = await req.json()
    const {
      name, email, imapHost, imapPort, imapSecure,
      smtpHost, smtpPort, smtpSecure, username, password,
      isDefault, promptGuard, badgeColor,
    } = body

    // The colour is the only field the user types by hand, so it is the only one the
    // server re-validates: `null` puts the mailbox back on the automatic palette.
    if (badgeColor !== undefined && badgeColor !== null && !isBadgeColor(badgeColor)) {
      return NextResponse.json({ error: 'Invalid badgeColor' }, { status: 400 })
    }

    // Verify ownership
    const existing = await query(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [params.id, userId]
    )
    if (!existing.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (isDefault) {
      await query(
        'UPDATE email_accounts SET is_default = false WHERE user_id = $1',
        [userId]
      )
    }

    const fields: string[] = []
    const values: unknown[] = []
    let idx = 1

    const set = (col: string, val: unknown) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`)
        values.push(val)
      }
    }

    set('name', name)
    set('email', email)
    set('imap_host', imapHost)
    set('imap_port', imapPort)
    set('imap_secure', imapSecure)
    set('smtp_host', smtpHost)
    set('smtp_port', smtpPort)
    set('smtp_secure', smtpSecure)
    set('username', username)
    set('is_default', isDefault)
    set('prompt_guard', promptGuard)
    set('badge_color', badgeColor)
    if (password) {
      fields.push(`password_encrypted = $${idx++}`)
      values.push(encrypt(password))
    }

    if (!fields.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    values.push(params.id)
    const result = await query(
      `UPDATE email_accounts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, email, is_default, prompt_guard AS "promptGuard", badge_color AS "badgeColor"`,
      values
    )

    return NextResponse.json({ data: result[0] })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function deleteHandler(
  req: Request,
  { params }: { params: { id: string } }
) {
  const access = await authorize(req)
  if ('denied' in access) return access.denied
  const userId = access.ctx.id

  try {
    const result = await query(
      'DELETE FROM email_accounts WHERE id = $1 AND user_id = $2 RETURNING id',
      [params.id, userId]
    )
    if (!result.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const DELETE = withApiLog(deleteHandler)
export const PATCH = withApiLog(patchHandler)
