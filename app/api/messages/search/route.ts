import { NextResponse } from 'next/server'
import { authenticate } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { listFolders, searchMessagesIn } from '@/lib/imap'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { MIN_QUERY_LENGTH, SCOPE_ALL, SCOPE_PARAM, SEARCH_FIELDS, SEARCH_PARAM, SEARCH_RESULT_LIMIT, parseQuery, readScope } from '@/lib/search'

export const dynamic = 'force-dynamic'

type AccountRow = {
  id: string; imap_host: string; imap_port: number; imap_secure: boolean;
  username: string; password_encrypted: string; prompt_guard: boolean;
  oauth_provider: string | null; oauth_access_token: string | null;
  oauth_refresh_token: string | null; oauth_expires_at: number | null;
}

export async function GET(req: Request) {
  const authCtx = await authenticate(req)
  if (!authCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = searchParams.get(SEARCH_PARAM)?.trim()
  const folder = searchParams.get('folder') ?? 'INBOX'
  const accountParam = searchParams.get('account')
  const scope = readScope(searchParams.get(SCOPE_PARAM))

  // Une requête n'a de sens que par ses TERMES : « a b » n'en porte aucun d'assez
  // long, et chercher « a b » tel quel ramènerait la boîte entière.
  const terms = parseQuery(q)
  if (!q || q.length < MIN_QUERY_LENGTH || terms.length === 0) {
    return NextResponse.json({ messages: [], total: 0, fields: SEARCH_FIELDS })
  }

  try {
    let account: AccountRow | null
    if (accountParam) {
      account = await getAccessibleAccount(accountParam, authCtx.id, [])
    } else {
      const rows = await query<AccountRow>(
        `SELECT * FROM email_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
        [authCtx.id]
      )
      account = rows[0] ?? null
    }
    if (!account) {
      return NextResponse.json({ messages: [], total: 0, fields: SEARCH_FIELDS, error: 'No account configured' })
    }
    const config = {
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
    }

    // `scope=all` élargit au compte entier : tous les dossiers sont interrogés sur
    // UNE connexion (cf. searchMessagesIn), les résultats fusionnés par date
    // décroissante. Un dossier illisible ne fait pas échouer la recherche entière.
    const folders = scope === SCOPE_ALL
      ? (await listFolders(config)).map(f => f.path)
      : [folder]
    const { messages, total } = await searchMessagesIn(config, folders, terms)
    messages.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))

    // `total` = correspondances RÉELLES (compte des identifiants), `messages` = ce
    // qui a été rendu. L'interface dit « les 200 premiers sur 1 340 » à partir des deux.
    return NextResponse.json(guardApiPayload({
      messages: messages.slice(0, SEARCH_RESULT_LIMIT).map(m => ({ ...m, accountId: account.id })),
      total,
      fields: SEARCH_FIELDS,
    }, { enabled: isMachineRequest(req) && account.prompt_guard }))
  } catch (err) {
    return NextResponse.json({ error: String(err), messages: [], total: 0, fields: SEARCH_FIELDS }, { status: 500 })
  }
}
