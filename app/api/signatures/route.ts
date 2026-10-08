import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'

export const dynamic = 'force-dynamic'

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const signatures = await query(
      `SELECT id, user_id AS "userId", account_id AS "accountId", name,
              content_html AS "contentHtml", is_default AS "isDefault"
       FROM signatures WHERE user_id = $1 ORDER BY is_default DESC, name ASC`,
      [userId]
    )
    return NextResponse.json({ data: signatures })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const body = await req.json()
    const { name, contentHtml, isDefault = false, accountId = null } = body

    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

    if (accountId) {
      const account = await getAccessibleAccount(accountId, userId, ['manageSignatures'])
      if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    if (isDefault) {
      await query(
        'UPDATE signatures SET is_default = false WHERE user_id = $1',
        [userId]
      )
    }

    const result = await query(
      `INSERT INTO signatures (user_id, account_id, name, content_html, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id AS "userId", account_id AS "accountId", name,
                 content_html AS "contentHtml", is_default AS "isDefault"`,
      [userId, accountId, name, contentHtml ?? '', isDefault]
    )

    return NextResponse.json({ data: result[0] }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
