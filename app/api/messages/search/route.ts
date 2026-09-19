import { NextResponse } from 'next/server'
import { authenticate } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { listFolders, listFoldersRanked, searchMessagesByFolder, searchMessagesIn } from '@/lib/imap'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { MIN_QUERY_LENGTH, SCOPE_ALL, SCOPE_PARAM, SEARCH_FIELDS, SEARCH_PARAM, SEARCH_RESULT_LIMIT, STREAM_PARAM, parseQuery, readScope } from '@/lib/search'

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

    // `scope=all` + `stream=1` : la réponse part dossier par dossier (NDJSON), dans
    // l'ordre d'utilité rendu par listFoldersRanked — les premiers résultats
    // s'affichent en une seconde au lieu d'attendre la couverture complète (mesuré
    // sur la plus grosse boîte de test : 101 dossiers, ~300 ms l'un).
    if (scope === SCOPE_ALL && searchParams.get(STREAM_PARAM)) {
      const ranked = await listFoldersRanked(config)
      const guard = { enabled: isMachineRequest(req) && account.prompt_guard }
      const accountId = account.id
      const encoder = new TextEncoder()
      // Un seul signal d'abandon pour les DEUX façons dont une recherche s'arrête :
      // la requête coupée (`req.signal`) et le flux abandonné par le client, qui
      // n'est annoncé QUE par `cancel()`. Sans lui, quitter la recherche laissait
      // les ouvriers IMAP ouvrir les 1 226 dossiers restants pour personne.
      const sweep = new AbortController()
      req.signal.addEventListener('abort', () => sweep.abort(), { once: true })
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of searchMessagesByFolder(config, ranked, terms, sweep.signal)) {
              if (sweep.signal.aborted) break
              const payload = guardApiPayload({
                messages: chunk.messages
                  .slice()
                  .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
                  .slice(0, SEARCH_RESULT_LIMIT)
                  .map(m => ({ ...m, accountId })),
                total: chunk.total,
                fields: SEARCH_FIELDS,
                folder: chunk.folder,
                searched: chunk.searched,
                folders: chunk.folders,
              }, guard)
              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
            }
          } catch (err) {
            // Un flux déjà abandonné n'a plus de destinataire : signaler l'erreur
            // sur un contrôleur fermé lèverait une seconde panne, sans lecteur.
            if (!sweep.signal.aborted) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ error: String(err) })}\n`))
            }
          } finally {
            controller.close()
          }
        },
        // Le client s'est détourné (requête changée, page quittée, bouton Arrêter) :
        // les dossiers restants ne sont pas ouverts et les connexions IMAP se ferment.
        cancel() { sweep.abort() },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
        },
      })
    }

    // Réponse d'un seul tenant : la portée « ce dossier » (un seul dossier, donc
    // rien à étaler) et tout appel machine, dont le contrat ne change pas.
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
