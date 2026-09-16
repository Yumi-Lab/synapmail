import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { searchParams } = new URL(req.url)
    const emailsParam = searchParams.get('emails')

    if (emailsParam) {
      const emails = emailsParam.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
      if (!emails.length) return NextResponse.json({ data: [] })
      const keys = await query(
        `SELECT id, user_id AS "userId", email, name, fingerprint,
                armored_key AS "armoredKey", created_at AS "createdAt"
         FROM pgp_public_keys WHERE user_id = $1 AND LOWER(email) = ANY($2::text[])`,
        [session.user?.id, emails]
      )
      return NextResponse.json({ data: keys })
    }

    const keys = await query(
      `SELECT id, user_id AS "userId", email, name, fingerprint,
              armored_key AS "armoredKey", created_at AS "createdAt"
       FROM pgp_public_keys WHERE user_id = $1 ORDER BY email ASC`,
      [session.user?.id]
    )
    return NextResponse.json({ data: keys })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { email, name, armoredKey, fingerprint } = body

    if (!email?.trim() || !armoredKey?.trim() || !fingerprint?.trim()) {
      return NextResponse.json({ error: 'email, armoredKey and fingerprint are required' }, { status: 400 })
    }
    if (!armoredKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
      return NextResponse.json({ error: 'Invalid PGP public key block' }, { status: 400 })
    }

    const result = await query(
      `INSERT INTO pgp_public_keys (user_id, email, name, fingerprint, armored_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, email) DO UPDATE
         SET name = EXCLUDED.name, fingerprint = EXCLUDED.fingerprint, armored_key = EXCLUDED.armored_key
       RETURNING id, user_id AS "userId", email, name, fingerprint,
                 armored_key AS "armoredKey", created_at AS "createdAt"`,
      [session.user?.id, email.trim().toLowerCase(), name?.trim() || null, fingerprint.trim(), armoredKey.trim()]
    )

    return NextResponse.json({ data: result[0] }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
