import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { markReadBulk, deleteMessagesBulk, moveMessagesBulk, setFlagBulk } from '@/lib/imap'
import { applyReadChange } from '@/lib/unreadCount'
import { flagByKey } from '@/lib/flags'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

type AccountRow = {
  id: string; imap_host: string; imap_port: number; imap_secure: boolean;
  username: string; password_encrypted: string;
  oauth_provider: string | null; oauth_access_token: string | null;
  oauth_refresh_token: string | null; oauth_expires_at: number | null;
}

function accountConfig(a: AccountRow) {
  return {
    id: a.id,
    imapHost: a.imap_host,
    imapPort: a.imap_port,
    imapSecure: a.imap_secure,
    username: a.username,
    passwordEncrypted: a.password_encrypted,
    oauthProvider: a.oauth_provider,
    oauthAccessToken: a.oauth_access_token,
    oauthRefreshToken: a.oauth_refresh_token,
    oauthExpiresAt: a.oauth_expires_at,
  }
}

// PATCH — mark read/unread or move
async function patchHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const body = await req.json()
  const { uids, action, accountId, folder, destination, flag } = body as {
    uids: string[]
    action: 'read' | 'unread' | 'move' | 'flag'
    accountId: string
    folder: string
    destination?: string
    /** Couleur de lib/flags.ts, ou `null` pour retirer le drapeau. */
    flag?: string | null
  }

  if (!uids?.length || !accountId || !folder || !action) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  try {
    const account = await getAccessibleAccount(accountId, authCtx.id, ['organize'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const config = accountConfig(account)

    if (action === 'read' || action === 'unread') {
      const read = action === 'read'
      await markReadBulk(config, folder, uids, read)
      // Même règle que pour un message seul : le compteur bouge avec l'action.
      await applyReadChange(account.id, folder, uids, read)
    } else if (action === 'flag') {
      if (flag === undefined) return NextResponse.json({ error: 'flag required for flag' }, { status: 400 })
      if (flag !== null && !flagByKey(flag)) return NextResponse.json({ error: 'Unknown flag' }, { status: 400 })
      await setFlagBulk(config, folder, uids, flag)
    } else if (action === 'move') {
      if (!destination) return NextResponse.json({ error: 'destination required for move' }, { status: 400 })
      await moveMessagesBulk(config, folder, uids, destination)
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// DELETE — delete multiple messages
async function deleteHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const body = await req.json()
  const { uids, accountId, folder } = body as {
    uids: string[]
    accountId: string
    folder: string
  }

  if (!uids?.length || !accountId || !folder) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  try {
    const account = await getAccessibleAccount(accountId, authCtx.id, ['delete'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    await deleteMessagesBulk(accountConfig(account), folder, uids)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const DELETE = withApiLog(deleteHandler)
export const PATCH = withApiLog(patchHandler)
