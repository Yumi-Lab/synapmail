/**
 * CE QUI S'EST PASSÉ pendant une requête Bearer — LA source unique du journal.
 *
 * Avant ce lot, la ligne était écrite à l'ENTRÉE de la requête et ne portait que
 * méthode, chemin, IP, heure : « on voit juste GET, on ne voit pas ce qui s'est
 * passé ». Le résultat ne POUVAIT pas y figurer, puisqu'il n'existait pas encore.
 *
 * Désormais la ligne s'ouvre à l'entrée (`openLog`, depuis `lib/apiAuth.ts`, là où
 * la clé est reconnue) et se COMPLÈTE au retour (`closeLog`, depuis `withApiLog`,
 * qui enveloppe le handler) avec le statut HTTP, la durée, la boîte visée et le
 * motif du refus. Deux écritures, jamais une de plus : l'INSERT rend l'identifiant
 * de la ligne, l'UPDATE la termine.
 *
 * Pourquoi un `WeakMap` sur la requête plutôt qu'un paramètre : `authorize()` est
 * appelée DANS le handler, qui ne rend qu'une `Response`. L'objet `Request` est la
 * seule chose que les deux moitiés partagent. `WeakMap` n'empêche aucune collecte :
 * la requête finie, l'entrée disparaît d'elle-même.
 *
 * Seules les requêtes Bearer sont journalisées — une session humaine n'entre jamais
 * ici, c'est déjà le cas depuis l'origine.
 */

import { query } from './db'

/** Pourquoi une requête a été refusée, dans le vocabulaire de la barrière elle-même. */
export type DenialReason = 'unauthenticated' | 'scope' | 'account'

/** L'état d'une ligne en cours, le temps que la requête se déroule. */
type PendingLog = {
  /** L'identifiant de la ligne, une fois l'INSERT revenu. */
  id: Promise<string | null>
  startedAt: number
  accountId: string | null
  denialReason: DenialReason | null
  denialDetail: string | null
}

const pending = new WeakMap<Request, PendingLog>()

/**
 * Ouvre la ligne à l'entrée de la requête. Rien n'est attendu : l'INSERT part et
 * la promesse de son identifiant est gardée pour l'UPDATE, qui l'attendra une fois,
 * au retour — c'est-à-dire bien plus tard. Une erreur de base ne fait pas échouer
 * la requête : un journal est un journal.
 */
export function openLog(req: Request, apiKeyId: string): void {
  const url = new URL(req.url)
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    null

  const id = query<{ id: string }>(
    `INSERT INTO api_key_requests (api_key_id, method, path, ip_address)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [apiKeyId, req.method, url.pathname, ip?.slice(0, 45) ?? null]
  )
    .then(rows => rows[0]?.id ?? null)
    .catch(() => null)

  pending.set(req, {
    id,
    startedAt: Date.now(),
    accountId: null,
    denialReason: null,
    denialDetail: null,
  })
}

/**
 * La boîte que cette requête visait, telle que la barrière l'a lue. Notée même
 * quand l'accès est ACCORDÉ : savoir sur quelle boîte une clé a travaillé est la
 * moitié de l'intérêt du journal.
 */
export function noteAccount(req: Request, accountId: string | null): void {
  const log = pending.get(req)
  if (log) log.accountId = accountId
}

/**
 * Le motif du refus, au moment où la barrière le prononce — seul endroit où il est
 * connu. `detail` porte la portée manquante ou la boîte fermée, ce que l'écran
 * affiche pour que le propriétaire sache quoi cocher.
 */
export function noteDenial(req: Request, reason: DenialReason, detail: string | null): void {
  const log = pending.get(req)
  if (log) {
    log.denialReason = reason
    log.denialDetail = detail
  }
}

/**
 * Complète la ligne au RETOUR : statut HTTP réellement rendu et durée mesurée.
 *
 * Sans ligne ouverte, il n'y a rien à compléter — c'est le cas d'une requête de
 * session humaine, qui n'est pas journalisée. Fire-and-forget : le handler a déjà
 * rendu sa réponse, l'attendre ne ferait que ralentir l'appelant.
 */
export function closeLog(req: Request, status: number): void {
  const log = pending.get(req)
  if (!log) return
  pending.delete(req)
  const durationMs = Date.now() - log.startedAt

  log.id
    .then(id => {
      if (!id) return
      return query(
        `UPDATE api_key_requests
            SET status = $2, duration_ms = $3, account_id = $4,
                denial_reason = $5, denial_detail = $6
          WHERE id = $1`,
        [id, status, durationMs, log.accountId, log.denialReason, log.denialDetail]
      )
    })
    .catch(() => { /* best-effort, comme l'INSERT */ })
}

/**
 * Enveloppe un handler de route pour que sa réponse termine la ligne du journal.
 *
 * C'est le pendant de `authorize()` : celle-ci ouvre, celui-ci ferme. Toute route
 * ouverte au Bearer DOIT être enveloppée, sinon ses lignes restent sans résultat —
 * `scripts/check-api-log-coverage.mjs` échoue si une seule y échappe.
 *
 * La signature est conservée telle quelle (`req`, puis le contexte `{ params }` de
 * Next) : envelopper ne doit RIEN changer à l'écriture d'une route.
 */
export function withApiLog<R extends Request, A extends unknown[], T extends Response>(
  handler: (req: R, ...rest: A) => Promise<T>
): (req: R, ...rest: A) => Promise<T> {
  return async (req, ...rest) => {
    try {
      const res = await handler(req, ...rest)
      closeLog(req, res.status)
      return res
    } catch (err) {
      // Une exception non rattrapée est un 500 pour l'appelant : le journal doit le
      // dire, sinon la ligne resterait ouverte pour toujours sur la panne la plus
      // intéressante à lire.
      closeLog(req, 500)
      throw err
    }
  }
}
