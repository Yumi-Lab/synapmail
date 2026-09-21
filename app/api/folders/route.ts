import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { listFolders, createFolder, renameFolder, deleteFolder } from '@/lib/imap'
import { sanitizeFolderName, joinFolderPath, renamedPath, rewritePath, samePath, isDescendant, refuse } from '@/lib/folderActions'
import { resolveFolder } from '@/lib/folderResolve'
import { detectSpecials } from '@/lib/specialFolders'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')

  try {
    type AccountRow = {
      id: string; imap_host: string; imap_port: number; imap_secure: boolean;
      username: string; password_encrypted: string;
      oauth_provider: string | null; oauth_access_token: string | null;
      oauth_refresh_token: string | null; oauth_expires_at: number | null;
    }

    let account: AccountRow | null
    if (accountId) {
      account = await getAccessibleAccount(accountId, authCtx.id, [])
    } else {
      const rows = await query<AccountRow>(
        'SELECT * FROM email_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
        [authCtx.id]
      )
      account = rows[0] ?? null
    }

    if (!account) return NextResponse.json({ data: [] })
    const folders = await listFolders({
      id: account.id,
      imapHost: account.imap_host,
      imapPort: account.imap_port,
      imapSecure: account.imap_secure,
      username: account.username,
      passwordEncrypted: account.password_encrypted,
      oauthProvider: account.oauth_provider,
      oauthAccessToken: account.oauth_access_token,
      oauthRefreshToken: account.oauth_refresh_token,
      oauthExpiresAt: account.oauth_expires_at,
    })

    // Filter out Outlook system/technical folders
    const SYSTEM_KEYWORDS = [
      'sync issues', 'problèmes de synchronisation', 'synchronisation',
      'server failures', 'défaillances du serveur',
      'local failures', 'défaillances locales',
      'conflicts', 'conflits',
      'partages compte', 'sharing',
      'outbox',
      'calendar', 'contacts', 'tasks', 'journal', 'notes',
      'conversation history', 'quick step',
      'clutter', 'rss', 'social updates',
    ]

    const isSystemFolder = (path: string, name: string) => {
      const p = path.toLowerCase()
      const n = name.toLowerCase()
      return SYSTEM_KEYWORDS.some(kw => p.includes(kw) || n.includes(kw))
    }

    const specials = detectSpecials(folders)
    const normalized = folders
      .filter(f => !isSystemFolder(f.path, f.name))
      .map(f => ({
        name: f.name,
        path: f.path,
        // Le délimiteur du serveur : sans lui le client ne peut pas savoir quel dossier
        // est rangé SOUS quel autre — et « supprimer » doit se refuser sur un parent.
        delimiter: f.delimiter ?? '/',
        special: specials.get(f.path) ?? null,
      }))

    // Sort: special folders first (in order), then alphabetical
    const specialOrder = ['inbox', 'sent', 'drafts', 'spam', 'trash']
    normalized.sort((a, b) => {
      const ai = a.special ? specialOrder.indexOf(a.special) : 999
      const bi = b.special ? specialOrder.indexOf(b.special) : 999
      if (ai !== bi) return ai - bi
      return a.name.localeCompare(b.name)
    })

    // Unread counts — prefer the authoritative SEARCH UNSEEN value in
    // mailbox_stats (not capped by page size), fall back to counting cached rows
    // for folders that have not been synced through listMessages yet.
    const statsRows = await query<{ folder: string; unread_count: number }>(
      `SELECT folder, unread_count FROM mailbox_stats WHERE account_id = $1`,
      [account.id]
    )
    const statsMap = Object.fromEntries(statsRows.map(r => [r.folder, r.unread_count]))

    const unreadRows = await query<{ folder: string; unread_count: string }>(
      `SELECT folder, COUNT(*) as unread_count FROM messages_cache WHERE account_id = $1 AND is_read = false GROUP BY folder`,
      [account.id]
    )
    const unreadMap = Object.fromEntries(unreadRows.map(r => [r.folder, parseInt(r.unread_count)]))

    const withCounts = normalized.map(f => ({
      ...f,
      unreadCount: statsMap[f.path] ?? unreadMap[f.path] ?? 0,
    }))

    return NextResponse.json({ data: withCounts })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * Mutations de dossier (lot H3e). Le DROIT de faire ne se décide pas ici : `resolveFolder`
 * évalue `lib/folderActions.ts` sur les faits du serveur IMAP, la route ne fait que
 * refuser (403) ce qu'il a refusé et exécuter le reste. Un chemin que le serveur ne
 * connaît pas n'atteint jamais IMAP.
 */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const asString = (v: unknown) => (typeof v === 'string' && v ? v : null)

// POST — crée un dossier à la racine, ou sous `parent` quand il est fourni.
async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const body = await readBody(req)
  const parent = asString(body.parent)

  try {
    const ctx = await resolveFolder(asString(body.accountId), authCtx.id, parent, ['organize'])
    if (!ctx) return refuse('notFound')
    if (!(parent ? ctx.can.createChild : ctx.can.create)) return refuse('forbidden')

    const name = sanitizeFolderName(body.name, ctx.delimiter)
    if (!name) return refuse('badName')
    const path = joinFolderPath(parent ?? '', name, ctx.delimiter)
    if (ctx.folders.some(f => samePath(f.path, path))) return refuse('exists')

    await createFolder(ctx.config, path)
    return NextResponse.json({ data: { path, name } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// PATCH — renomme un dossier sur place (il reste chez son parent).
async function patchHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const body = await readBody(req)

  try {
    const ctx = await resolveFolder(asString(body.accountId), authCtx.id, asString(body.path), ['organize'])
    if (!ctx?.folder) return refuse('notFound')
    if (!ctx.can.rename) return refuse('forbidden')

    const name = sanitizeFolderName(body.name, ctx.delimiter)
    if (!name) return refuse('badName')
    const from = ctx.folder.path
    const path = renamedPath(from, name, ctx.delimiter)
    if (path === from) return NextResponse.json({ data: { path, name } })
    if (ctx.folders.some(f => samePath(f.path, path))) return refuse('exists')

    await renameFolder(ctx.config, from, path)
    // IMAP renomme TOUT le sous-arbre : le cache suit le même chemin, sinon les lignes
    // des sous-dossiers restent orphelines sous l'ancien préfixe (non-lus faux).
    for (const moved of ctx.folders.filter(f => f.path === from || isDescendant(f.path, from, ctx.delimiter))) {
      const to = rewritePath(moved.path, from, path, ctx.delimiter)
      await query('UPDATE messages_cache SET folder = $1 WHERE account_id = $2 AND folder = $3', [to, ctx.account.id, moved.path])
      await query('UPDATE mailbox_stats SET folder = $1 WHERE account_id = $2 AND folder = $3', [to, ctx.account.id, moved.path])
    }
    return NextResponse.json({ data: { path, name } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// DELETE — supprime un dossier (jamais un spécial, jamais un parent).
async function deleteHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  const { searchParams } = new URL(req.url)

  try {
    const ctx = await resolveFolder(searchParams.get('account'), authCtx.id, searchParams.get('path'), ['delete'])
    if (!ctx?.folder) return refuse('notFound')
    if (!ctx.can.remove) return refuse('forbidden')

    await deleteFolder(ctx.config, ctx.folder.path)
    await query('DELETE FROM messages_cache WHERE account_id = $1 AND folder = $2', [ctx.account.id, ctx.folder.path])
    await query('DELETE FROM mailbox_stats WHERE account_id = $1 AND folder = $2', [ctx.account.id, ctx.folder.path])
    return NextResponse.json({ data: { path: ctx.folder.path } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const DELETE = withApiLog(deleteHandler)
export const GET = withApiLog(getHandler)
export const PATCH = withApiLog(patchHandler)
export const POST = withApiLog(postHandler)
