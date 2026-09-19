import { NextResponse } from 'next/server'
import { authenticate } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { markFolderRead, emptyFolder, folderMessageCount } from '@/lib/imap'
import { resolveFolder } from '@/lib/folderResolve'

export const dynamic = 'force-dynamic'

/**
 * Actions qui touchent au CONTENU d'un dossier, pas à sa structure (lot H3e) :
 * « tout marquer comme lu » et « vider ». Le droit se décide dans
 * `lib/folderActions.ts` via `resolveFolder` — « vider » n'existe que pour la
 * corbeille et les indésirables, quoi que le client demande.
 */
const ACTIONS = ['markRead', 'empty', 'count'] as const
type Action = (typeof ACTIONS)[number]

/** La permission qu'exige chaque action — même vocabulaire que `lib/accountAccess.ts`. */
const REQUIRED = { markRead: 'organize', empty: 'delete', count: undefined } as const

export async function POST(req: Request) {
  const authCtx = await authenticate(req)
  if (!authCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch { /* corps absent ou illisible — traité comme une action inconnue */ }

  const action = body.action as Action
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

  const accountId = typeof body.accountId === 'string' ? body.accountId : null
  const path = typeof body.path === 'string' ? body.path : null

  try {
    const needed = REQUIRED[action]
    const ctx = await resolveFolder(accountId, authCtx.id, path, needed ? [needed] : [])
    if (!ctx?.folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })

    if (action === 'count') {
      return NextResponse.json({ data: { count: await folderMessageCount(ctx.config, ctx.folder.path) } })
    }

    if (!ctx.can[action]) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (action === 'markRead') {
      await markFolderRead(ctx.config, ctx.folder.path)
      await query('UPDATE messages_cache SET is_read = true WHERE account_id = $1 AND folder = $2', [ctx.account.id, ctx.folder.path])
      await query('UPDATE mailbox_stats SET unread_count = 0 WHERE account_id = $1 AND folder = $2', [ctx.account.id, ctx.folder.path])
      return NextResponse.json({ data: { path: ctx.folder.path, unreadCount: 0 } })
    }

    const removed = await emptyFolder(ctx.config, ctx.folder.path)
    await query('DELETE FROM messages_cache WHERE account_id = $1 AND folder = $2', [ctx.account.id, ctx.folder.path])
    await query('UPDATE mailbox_stats SET unread_count = 0 WHERE account_id = $1 AND folder = $2', [ctx.account.id, ctx.folder.path])
    return NextResponse.json({ data: { path: ctx.folder.path, removed } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
