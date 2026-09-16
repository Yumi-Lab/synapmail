import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await query(
      `SELECT user_id AS "userId", fingerprint, armored_public_key AS "armoredPublicKey",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM user_pgp_identity WHERE user_id = $1`,
      [session.user?.id]
    )
    return NextResponse.json({ data: result[0] ?? null })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { fingerprint, armoredPublicKey } = body

    if (!fingerprint?.trim() || !armoredPublicKey?.trim()) {
      return NextResponse.json({ error: 'fingerprint and armoredPublicKey are required' }, { status: 400 })
    }

    const result = await query(
      `INSERT INTO user_pgp_identity (user_id, fingerprint, armored_public_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET fingerprint = EXCLUDED.fingerprint, armored_public_key = EXCLUDED.armored_public_key, updated_at = NOW()
       RETURNING user_id AS "userId", fingerprint, armored_public_key AS "armoredPublicKey",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [session.user?.id, fingerprint.trim(), armoredPublicKey.trim()]
    )

    return NextResponse.json({ data: result[0] })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
