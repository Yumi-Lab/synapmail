import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface DraftRow {
  to_addresses: string[]
  cc_addresses: string[]
  bcc_addresses: string[]
  subject: string
  body_html: string
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ error: 'accountId is required' }, { status: 400 })

  try {
    const rows = await query<DraftRow>(
      `SELECT to_addresses, cc_addresses, bcc_addresses, subject, body_html
       FROM drafts WHERE user_id = $1 AND account_id = $2`,
      [session.user.id, accountId]
    )
    return NextResponse.json({ data: rows[0] ?? null })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { accountId, to, cc, bcc, subject, content } = body
    if (!accountId) return NextResponse.json({ error: 'accountId is required' }, { status: 400 })

    await query(
      `INSERT INTO drafts (user_id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_html, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, account_id) DO UPDATE
       SET to_addresses = $3, cc_addresses = $4, bcc_addresses = $5, subject = $6, body_html = $7, updated_at = NOW()`,
      [session.user.id, accountId, to ?? [], cc ?? [], bcc ?? [], subject ?? '', content ?? '']
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ error: 'accountId is required' }, { status: 400 })

  try {
    await query('DELETE FROM drafts WHERE user_id = $1 AND account_id = $2', [session.user.id, accountId])
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
