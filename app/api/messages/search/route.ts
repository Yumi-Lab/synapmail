import { NextResponse } from 'next/server'
import { authenticate } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { listFolderPasses, listFolders, listFoldersRanked, searchMessagesByFolder, searchMessagesIn } from '@/lib/imap'
import { accountOrderBy } from '@/lib/accountColor'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import {
  ACCOUNT_CONCURRENCY, MIN_QUERY_LENGTH, SCOPE_ACCOUNTS, SCOPE_ALL, SCOPE_PARAM, SEARCH_FIELDS,
  SEARCH_PARAM, SEARCH_RESULT_LIMIT, STREAM_PARAM, mergeGenerators, orderAccountsForSearch,
  parseQuery, readScope,
} from '@/lib/search'

export const dynamic = 'force-dynamic'

type AccountRow = {
  id: string; email: string; imap_host: string; imap_port: number; imap_secure: boolean;
  username: string; password_encrypted: string; prompt_guard: boolean;
  oauth_provider: string | null; oauth_access_token: string | null;
  oauth_refresh_token: string | null; oauth_expires_at: number | null;
}

/** La configuration IMAP d'une boîte — même forme pour les trois portées. */
function imapConfig(row: AccountRow) {
  return {
    id: row.id,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure,
    username: row.username,
    passwordEncrypted: row.password_encrypted,
    oauthProvider: row.oauth_provider,
    oauthAccessToken: row.oauth_access_token,
    oauthRefreshToken: row.oauth_refresh_token,
    oauthExpiresAt: row.oauth_expires_at,
  }
}

/**
 * Les messages d'un morceau, prêts à partir : du plus récent au plus ancien,
 * plafonnés, et portant la boîte d'où ils viennent — sans elle, la liste ne
 * saurait pas dans QUELLE boîte ouvrir un résultat.
 */
function streamedMessages<T extends { date: string }>(messages: T[], accountId: string) {
  return messages
    .slice()
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(m => ({ ...m, accountId }))
}

/**
 * Les boîtes que cet utilisateur peut RÉELLEMENT balayer : les siennes, plus
 * celles reçues en partage actif et non expiré — la même condition que
 * `getAccessibleAccount`, appliquée en une seule requête au lieu d'une par boîte.
 * Aucun identifiant venu du client n'entre ici : la liste vient de la base.
 */
async function listAccessibleAccounts(userId: string): Promise<AccountRow[]> {
  return query<AccountRow>(
    `SELECT a.* FROM email_accounts a WHERE a.user_id = $1
     UNION
     SELECT a.* FROM email_accounts a
       JOIN account_shares sh ON sh.account_id = a.id
      WHERE sh.invitee_user_id = $1 AND sh.status = 'active'
        AND (sh.expires_at IS NULL OR sh.expires_at > NOW())
     ${accountOrderBy({ isDefault: 'is_default', createdAt: 'created_at', id: 'id' })}`,
    [userId]
  )
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
    const config = imapConfig(account)

    // `scope=accounts` + `stream=1` : le même flux NDJSON, étendu à TOUTES les
    // boîtes accessibles. Une boîte est balayée en DEUX passes (réception + envoyés
    // d'abord, le reste ensuite) et au plus ACCOUNT_CONCURRENCY boîtes sont
    // ouvertes de front, pour que les résultats utiles arrivent en quelques
    // secondes même avec beaucoup de boîtes (mesuré le 20/09/2026 sur le compte de
    // test : 7 boîtes, 185 dossiers, 50,7 s boîte par boîte en série).
    if (scope === SCOPE_ACCOUNTS && searchParams.get(STREAM_PARAM)) {
      const accessible = await listAccessibleAccounts(authCtx.id)
      // L'identifiant reçu du client ne sert QU'À ordonner : il n'ouvre aucune
      // boîte par lui-même, seules celles de `listAccessibleAccounts` sont balayées.
      const order = orderAccountsForSearch(accessible, account.id)
      const byId = new Map(accessible.map(a => [a.id, a]))
      const accounts = order.map(id => byId.get(id)).filter((a): a is AccountRow => !!a)
      const machine = isMachineRequest(req)
      const encoder = new TextEncoder()
      const sweep = new AbortController()
      req.signal.addEventListener('abort', () => sweep.abort(), { once: true })

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
          // La progression est comptée pour l'ENSEMBLE des boîtes : une seule barre
          // pour l'utilisateur, alors que chaque boîte compte ses dossiers à part.
          let searched = 0
          let folders = 0
          const unreachable: string[] = []
          try {
            // Les passes d'une boîte sont calculées UNE fois : la deuxième réutilise
            // la liste de dossiers de la première, sans second LIST-STATUS.
            const passes = new Map<string, { first: string[]; rest: string[] }>()
            const sweepFolders = (row: AccountRow, list: string[]) => async function* () {
              if (!list.length) return
              const guard = { enabled: machine && row.prompt_guard }
              for await (const chunk of searchMessagesByFolder(imapConfig(row), list, terms, sweep.signal)) {
                if (sweep.signal.aborted) return
                searched += 1
                // La garde d'invite s'applique PAR BOÎTE : `prompt_guard` diffère
                // d'une boîte à l'autre, donc chaque morceau porte celle de la sienne.
                yield guardApiPayload({
                  messages: streamedMessages(chunk.messages, row.id),
                  total: chunk.total,
                  fields: SEARCH_FIELDS,
                  folder: chunk.folder,
                  accountId: row.id,
                  accountEmail: row.email,
                  searched,
                  folders,
                  // Le nombre de boîtes est connu dès le départ (celles qui sont
                  // accessibles) : le bandeau annonce « sur 8 » au premier morceau,
                  // sans attendre la fin du balayage.
                  accounts: accounts.length,
                }, guard)
              }
            }

            // PREMIÈRE PASSE : réception + envoyés de CHAQUE boîte. Sans elle, la
            // dernière boîte attend derrière les 97 dossiers d'une autre (mesuré le
            // 20/09/2026 : son premier résultat arrivait à 21,2 s).
            const firstPass = accounts.map(row => async function* () {
              let split: { first: string[]; rest: string[] }
              try {
                split = await listFolderPasses(imapConfig(row))
              } catch {
                // Une boîte injoignable n'arrête pas les autres : elle est signalée
                // en fin de flux, et son balayage est simplement sauté.
                unreachable.push(row.email)
                return
              }
              passes.set(row.id, split)
              folders += split.first.length + split.rest.length
              yield* sweepFolders(row, split.first)()
            })
            for await (const payload of mergeGenerators(firstPass, ACCOUNT_CONCURRENCY)) {
              if (sweep.signal.aborted) break
              send(payload)
            }

            // DEUXIÈME PASSE : tout le reste, dans le même ordre de boîtes.
            if (!sweep.signal.aborted) {
              const secondPass = accounts
                .filter(row => passes.get(row.id)?.rest.length)
                .map(row => sweepFolders(row, passes.get(row.id)!.rest))
              for await (const payload of mergeGenerators(secondPass, ACCOUNT_CONCURRENCY)) {
                if (sweep.signal.aborted) break
                send(payload)
              }
            }
            if (!sweep.signal.aborted && unreachable.length) send({ unreachable })
          } catch (err) {
            if (!sweep.signal.aborted) send({ error: String(err) })
          } finally {
            controller.close()
          }
        },
        cancel() { sweep.abort() },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
        },
      })
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
                messages: streamedMessages(chunk.messages, accountId),
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
