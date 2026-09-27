/**
 * Le trieur : il parcourt une boîte, demande au moteur ce qu'il pense de chaque mail, et
 * range les étiquettes. Il est fait pour être COUPÉ à tout moment — délai épuisé, plafond
 * atteint, crédit épuisé — et pour reprendre exactement où il s'était arrêté.
 *
 * Trois choix commandent ce fichier :
 *
 *  1. **La source de mails et le moteur sont INJECTÉS** (`MailSource`, `TaggingEngine`) :
 *     le trieur ne sait ni ouvrir une connexion IMAP ni parler HTTP. C'est ce qui permet au
 *     banc de le mesurer avec une fausse source et un faux moteur qui COMPTE ses appels,
 *     sans toucher une vraie boîte ni dépenser un crédit. L'implémentation IMAP vit à côté
 *     (`imapSource.ts`) et réutilise `createClient`/`toImapConfig`/`detectSpecials`.
 *  2. **Le curseur est enregistré après CHAQUE petit lot**, pas à la fin : une coupure entre
 *     deux lots ne perd donc qu'un lot au pire, et jamais un mail déjà payé (le saut par
 *     `alreadyTagged` le rattrape de toute façon).
 *  3. **Le plafond se vérifie AVANT de payer** : `spent_usd >= budget_usd` met la boîte en
 *     pause `budget` sans appeler le moteur une fois de plus. Un 402 fait de même en
 *     `credit`, curseur intact, donc la reprise ne redemande rien de déjà fait.
 *
 * Le verrou (`locked_until`) garantit qu'un seul passage travaille une boîte : deux tics du
 * planificateur qui se chevauchent ne peuvent pas payer deux fois le même mail.
 */
import type { ImapAccountRow } from '../accounts'
import { query } from '../db'
import { decrypt } from '../encrypt'
import {
  ASSUMED_INPUT_TOKENS_PER_MAIL, EngineError, askEngine, buildState, costUsd,
  type BulkState, type EngineResult, type EngineState, type MailForState, type PauseReason, type TagSource,
} from './engine'
import { alreadyTagged, messageIdOf, writeTags } from './store'

/** Un mail tel que la source le rend : de quoi bâtir l'état ET le situer. */
export interface SourceMail extends MailForState {
  /** `Message-ID` RFC, absent sur certains mails : `messageIdOf` en dérive alors un stable. */
  messageId?: string | null
  folder: string
  uid: number
  date?: Date | string | null
}

/**
 * D'où viennent les mails. Deux méthodes seulement : quels dossiers trier, et le lot suivant
 * d'un dossier après un UID donné. Le trieur n'en demande pas plus — c'est ce qui rend la
 * fausse source du banc aussi crédible que la vraie.
 */
export interface MailSource {
  /** Les dossiers à trier, corbeille / brouillons / envoyés déjà écartés, avec leur `uidValidity`. */
  folders(): Promise<Array<{ path: string; uidValidity: string; total: number }>>
  /** Les `limit` mails de `folder` d'UID strictement supérieur à `afterUid`, par UID croissant. */
  fetch(folder: string, afterUid: number, limit: number): Promise<SourceMail[]>
}

/** Le moteur, réduit à ce que le trieur lui demande. `askEngine` en est l'implémentation. */
export interface TaggingEngine {
  ask(state: EngineState): Promise<EngineResult>
  /** La source à écrire pour les étiquettes de CE moteur (`kind` du moteur, décision 13). */
  readonly source: TagSource
  /** Le tarif du moteur, en dollars par milliard de jetons d'entrée (0 pour Yumi One). */
  readonly usdPerBillionInput: number
}

/**
 * Le petit lot : 20 mails entre deux enregistrements du curseur. Assez petit pour qu'une
 * coupure ne coûte presque rien, assez grand pour que l'écriture du curseur reste
 * négligeable devant les appels au moteur (~1 s chacun).
 */
export const BATCH_SIZE = 20

/**
 * Deux requêtes en vol, pas plus.
 * ponytail: le débit du moteur plafonne à ~1,8 requête/s même en parallèle (mesuré sur JEV,
 * cf. GOAL) — au-delà de 2 on ne gagne rien et on ne récolte que des 429. Plafond connu, pas
 * une file d'attente à écrire : le jour où le moteur accélère, ce nombre monte, rien d'autre.
 */
export const CONCURRENCY = 2

/** Le temps qu'un passage s'accorde : le planificateur le rappelle toutes les 60 s. */
export const PASS_BUDGET_MS = 50_000

/**
 * La durée du verrou. Elle couvre un passage complet plus une marge : un processus tué au
 * milieu ne bloque donc pas la boîte plus longtemps, sans qu'il faille libérer à la main.
 */
export const LOCK_MS = 2 * PASS_BUDGET_MS

/** Où en est le tri en masse : le dossier courant, et jusqu'où il est allé. */
export interface BulkCursor {
  folders: string[]
  index: number
  lastUid: number
  uidValidity: string
}

/** Où en est le tri au fil de l'eau : le dernier UID vu dans chaque dossier suivi. */
export type LiveCursor = Record<string, { lastUid: number; uidValidity: string }>

/** La ligne `mailbox_tagging` d'une boîte, telle que le trieur la lit. */
interface TaggingRow {
  account_id: string
  engine_id: string | null
  budget_usd: number
  spent_usd: number
  input_tokens: string
  live: boolean
  live_cursor: LiveCursor | null
  bulk_state: BulkState
  bulk_cursor: BulkCursor | null
  tagged: number
  skipped: number
  errors: number
  total: number
  paused_reason: PauseReason | null
}

/** Ce qu'un passage a fait. Rendu au planificateur, et lisible par le banc. */
export interface PassOutcome {
  /** Le passage n'a rien tenté : verrou pris, pause en cours, ou rien à trier. */
  reason: 'locked' | 'paused' | 'no_engine' | 'idle' | 'done' | 'worked'
  tagged: number
  skipped: number
  errors: number
  calls: number
  spentUsd: number
  /** La pause POSÉE par ce passage, quand il en a posé une. */
  paused?: { reason: PauseReason; detail: string }
}

const EMPTY: Omit<PassOutcome, 'reason'> = { tagged: 0, skipped: 0, errors: 0, calls: 0, spentUsd: 0 }

/**
 * Prend le verrou de la boîte, ou rend `null`. Un seul `UPDATE … RETURNING` : le gagnant est
 * décidé par la base, donc deux passages simultanés ne peuvent pas tous deux croire l'avoir
 * pris (ce que ferait un `SELECT` suivi d'un `UPDATE`).
 */
async function claim(accountId: string): Promise<TaggingRow | null> {
  const rows = await query<TaggingRow>(
    `UPDATE mailbox_tagging SET locked_until = NOW() + ($2 || ' milliseconds')::interval, updated_at = NOW()
      WHERE account_id = $1 AND (locked_until IS NULL OR locked_until < NOW())
      RETURNING *`,
    [accountId, String(LOCK_MS)]
  )
  return rows[0] ?? null
}

const release = (accountId: string): Promise<unknown> =>
  query(`UPDATE mailbox_tagging SET locked_until = NULL, updated_at = NOW() WHERE account_id = $1`, [accountId])

/**
 * La pause « sans moteur », écrite UNE fois : le trieur, le démarrage et la reprise la posent
 * tous les trois, et trois libellés différents pour un même état se liraient comme trois états.
 */
export const NO_ENGINE_DETAIL = 'aucun moteur de décision choisi pour cette boîte'

/**
 * Ce que TOUTE remise en marche doit écrire : sans moteur, la boîte se met en pause `no_engine`
 * au lieu de passer « en cours ». Le planificateur ne réveille QUE les boîtes qui ont un moteur
 * (`mailboxesToSort`), donc une boîte lancée sans moteur resterait « en cours » pour toujours
 * sans rien faire — la pause doit être posée ici, au moment de l'ordre, pas plus tard.
 */
const PAUSE_IF_NO_ENGINE = `paused_reason = CASE WHEN engine_id IS NULL THEN 'no_engine' ELSE NULL END,
            paused_detail = CASE WHEN engine_id IS NULL THEN '${NO_ENGINE_DETAIL.replace(/'/g, "''")}' ELSE NULL END`

/**
 * Met la boîte en pause en NOMMANT la raison. Le curseur n'est jamais touché ici : c'est ce
 * qui fait qu'une reprise après `credit` ou `budget` ne redemande pas les mails déjà faits.
 */
export async function pauseMailbox(accountId: string, reason: PauseReason, detail: string): Promise<void> {
  await query(
    `UPDATE mailbox_tagging SET paused_reason = $2, paused_detail = $3, locked_until = NULL, updated_at = NOW()
      WHERE account_id = $1`,
    [accountId, reason, detail.slice(0, 500)]
  )
}

/**
 * Lève la pause. Le curseur reste où il était : la reprise continue, elle ne recommence pas.
 * Reprendre une boîte SANS moteur ne la remet pas en marche : elle retombe en pause `no_engine`.
 */
export async function resumeMailbox(accountId: string): Promise<void> {
  await query(
    `UPDATE mailbox_tagging SET ${PAUSE_IF_NO_ENGINE}, locked_until = NULL, updated_at = NOW()
      WHERE account_id = $1`,
    [accountId]
  )
}

/**
 * Démarre (ou redémarre) un tri en masse. `restart` remet le curseur à zéro ; sans lui, un tri
 * `done` repart de son curseur — donc ne redemande rien, et c'est voulu : « relancer un tri
 * terminé » ne doit pas coûter un centime.
 */
export async function startBulk(accountId: string, opts: { restart?: boolean } = {}): Promise<void> {
  await query(
    `UPDATE mailbox_tagging
        SET bulk_state = 'running', ${PAUSE_IF_NO_ENGINE}, locked_until = NULL,
            bulk_cursor = CASE WHEN $2 THEN NULL ELSE bulk_cursor END,
            tagged = CASE WHEN $2 THEN 0 ELSE tagged END,
            skipped = CASE WHEN $2 THEN 0 ELSE skipped END,
            errors = CASE WHEN $2 THEN 0 ELSE errors END,
            updated_at = NOW()
      WHERE account_id = $1`,
    [accountId, opts.restart === true]
  )
}

/**
 * Active le tri au fil de l'eau. Le curseur part du DERNIER UID connu de chaque dossier : on
 * ne retague pas l'historique à l'activation (c'est le rôle du tri en masse), on ne prend que
 * ce qui arrive ENSUITE.
 */
export async function enableLive(accountId: string, source: MailSource): Promise<LiveCursor> {
  const cursor: LiveCursor = {}
  for (const f of await source.folders()) {
    cursor[f.path] = { lastUid: await lastUidOf(source, f.path), uidValidity: f.uidValidity }
  }
  await query(
    `UPDATE mailbox_tagging SET live = true, live_cursor = $2::jsonb, updated_at = NOW() WHERE account_id = $1`,
    [accountId, JSON.stringify(cursor)]
  )
  return cursor
}

/**
 * Le dernier UID d'un dossier, demandé à la source elle-même. Un `fetch` sans limite utile
 * suffit : la source rend les mails par UID croissant, le dernier du dernier lot est le plus
 * récent. Il n'y a pas de méthode dédiée dans `MailSource` pour ne pas l'alourdir d'une
 * troisième opération que seul ce cas utiliserait.
 */
async function lastUidOf(source: MailSource, folder: string): Promise<number> {
  let after = 0
  for (;;) {
    const batch = await source.fetch(folder, after, BATCH_SIZE)
    if (!batch.length) return after
    after = batch[batch.length - 1].uid
  }
}

/** Le temps qu'il reste à ce passage. */
const remaining = (deadline: number): number => deadline - Date.now()

/**
 * Tague un petit lot, `CONCURRENCY` requêtes en vol. Chaque mail est traité indépendamment :
 * une erreur récupérable sur l'un ne fait pas perdre les autres. Une erreur qui ARRÊTE la
 * boîte (`credit`, `auth`) est remontée telle quelle — l'appelant pose la pause.
 */
async function tagBatch(
  params: { accountId: string; engine: TaggingEngine; mails: SourceMail[]; deadline: number }
): Promise<{ tagged: number; errors: number; calls: number; inputTokens: number; stop?: EngineError }> {
  const { accountId, engine, mails, deadline } = params
  const queue = [...mails]
  let tagged = 0, errors = 0, calls = 0, inputTokens = 0
  let stop: EngineError | undefined

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop || remaining(deadline) <= 0) return
      const mail = queue.shift()
      if (!mail) return
      let result: EngineResult
      calls += 1
      try {
        result = await engine.ask(buildState(mail))
      } catch (err) {
        if (err instanceof EngineError && (err.kind === 'credit' || err.kind === 'auth')) { stop = err; return }
        errors += 1
        continue
      }
      inputTokens += result.inputTokens
      if (!result.tags.length) { errors += 1; continue }
      await writeTags({
        accountId, messageId: messageIdOf(mail), source: engine.source, modele: result.model,
        tags: result.tags,
        position: { folder: mail.folder, uid: mail.uid, fromName: mail.fromName, fromAddress: mail.fromAddress, subject: mail.subject, date: mail.date },
      })
      tagged += 1
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, mails.length) }, worker))
  return { tagged, errors, calls, inputTokens, stop }
}

/** La dépense enregistrée après un lot. Un seul endroit l'écrit, pour qu'elle ne dérive pas. */
async function chargeMailbox(accountId: string, inputTokens: number, usdPerBillionInput: number,
  counters: { tagged: number; skipped: number; errors: number }): Promise<number> {
  const rows = await query<{ spent_usd: number }>(
    `UPDATE mailbox_tagging
        SET input_tokens = input_tokens + $2, spent_usd = spent_usd + $3,
            tagged = tagged + $4, skipped = skipped + $5, errors = errors + $6, updated_at = NOW()
      WHERE account_id = $1 RETURNING spent_usd`,
    [accountId, inputTokens, costUsd(usdPerBillionInput, inputTokens),
      counters.tagged, counters.skipped, counters.errors]
  )
  return Number(rows[0]?.spent_usd ?? 0)
}

const saveBulkCursor = (accountId: string, cursor: BulkCursor): Promise<unknown> =>
  query(`UPDATE mailbox_tagging SET bulk_cursor = $2::jsonb, updated_at = NOW() WHERE account_id = $1`,
    [accountId, JSON.stringify(cursor)])

const saveLiveCursor = (accountId: string, cursor: LiveCursor): Promise<unknown> =>
  query(`UPDATE mailbox_tagging SET live_cursor = $2::jsonb, updated_at = NOW() WHERE account_id = $1`,
    [accountId, JSON.stringify(cursor)])

/**
 * L'estimation de ce que coûterait le tri d'une boîte : la moyenne MESURÉE de ses jetons
 * d'entrée si elle en a une, sinon la constante documentée. Rendu par l'écran de réglages
 * (lot T5) et par `GET /api/tagging/status`.
 */
export function estimateUsd(params: { mails: number; usdPerBillionInput: number; inputTokens?: number; tagged?: number }): number {
  const perMail = params.tagged && params.tagged > 0 && params.inputTokens
    ? params.inputTokens / params.tagged
    : ASSUMED_INPUT_TOKENS_PER_MAIL
  return costUsd(params.usdPerBillionInput, perMail * params.mails)
}

/**
 * UN passage sur UNE boîte : prend le verrou, avance le tri en masse s'il tourne, puis le tri
 * au fil de l'eau s'il est actif, et rend le verrou. Appelé par le planificateur toutes les
 * 60 s avec `PASS_BUDGET_MS` de budget.
 */
export async function runPass(params: {
  accountId: string
  source: MailSource
  engine: TaggingEngine
  budgetMs?: number
  now?: number
}): Promise<PassOutcome> {
  const { accountId, source, engine } = params
  const deadline = (params.now ?? Date.now()) + (params.budgetMs ?? PASS_BUDGET_MS)

  const row = await claim(accountId)
  if (!row) return { reason: 'locked', ...EMPTY }

  try {
    if (row.paused_reason) return { reason: 'paused', ...EMPTY }
    if (!row.engine_id) {
      await pauseMailbox(accountId, 'no_engine', NO_ENGINE_DETAIL)
      return { reason: 'no_engine', ...EMPTY, paused: { reason: 'no_engine', detail: NO_ENGINE_DETAIL } }
    }

    const acc: PassOutcome = { reason: 'worked', ...EMPTY }
    let spent = row.spent_usd

    // Le plafond se vérifie AVANT tout appel : une boîte déjà au plafond ne paie pas un mail
    // de plus pour l'apprendre.
    if (spent >= row.budget_usd) {
      const detail = `plafond de ${row.budget_usd} $ atteint (dépensé ${spent.toFixed(4)} $)`
      await pauseMailbox(accountId, 'budget', detail)
      return { ...acc, reason: 'paused', paused: { reason: 'budget', detail } }
    }

    let worked = false

    if (row.bulk_state === 'running') {
      worked = true
      const res = await advanceBulk({ row, source, engine, deadline, spent, budget: row.budget_usd })
      acc.tagged += res.tagged; acc.skipped += res.skipped; acc.errors += res.errors; acc.calls += res.calls
      spent = res.spent
      acc.spentUsd = spent
      if (res.paused) { await pauseMailbox(accountId, res.paused.reason, res.paused.detail); return { ...acc, reason: 'paused', paused: res.paused } }
      if (res.finished) await query(`UPDATE mailbox_tagging SET bulk_state = 'done', updated_at = NOW() WHERE account_id = $1`, [accountId])
    }

    if (row.live && remaining(deadline) > 0 && spent < row.budget_usd) {
      worked = true
      const res = await advanceLive({ row, source, engine, deadline, spent, budget: row.budget_usd })
      acc.tagged += res.tagged; acc.skipped += res.skipped; acc.errors += res.errors; acc.calls += res.calls
      spent = res.spent
      acc.spentUsd = spent
      if (res.paused) { await pauseMailbox(accountId, res.paused.reason, res.paused.detail); return { ...acc, reason: 'paused', paused: res.paused } }
    }

    if (!worked) return { reason: row.bulk_state === 'done' ? 'done' : 'idle', ...EMPTY }
    return acc
  } finally {
    await release(accountId).catch(() => {})
  }
}

type Advance = {
  tagged: number; skipped: number; errors: number; calls: number; spent: number
  paused?: { reason: PauseReason; detail: string }; finished?: boolean
}

/** Ce que les deux modes partagent : sauter le déjà-fait, taguer, compter, enregistrer. */
async function processBatch(params: {
  accountId: string; engine: TaggingEngine; mails: SourceMail[]; deadline: number; spent: number; budget: number
}): Promise<Advance & { lastUid: number; complete: boolean }> {
  const { accountId, engine, mails, deadline } = params
  const ids = mails.map(m => messageIdOf(m))
  const seen = await alreadyTagged(accountId, engine.source, ids)
  // Le même mail peut être classé dans deux dossiers, ou deux fois dans le même : il porte alors
  // le MÊME Message-ID. `alreadyTagged` ne rattrape que ce qui est déjà en base, donc pas deux
  // exemplaires du même lot — d'où ce second filtre, sans quoi le mail serait payé deux fois.
  const withinBatch = new Set<string>()
  const todo = mails.filter((m, i) => {
    if (seen.has(ids[i]) || withinBatch.has(ids[i])) return false
    withinBatch.add(ids[i])
    return true
  })
  const skipped = mails.length - todo.length
  const lastUid = mails[mails.length - 1].uid

  if (!todo.length) {
    const spent = await chargeMailbox(accountId, 0, engine.usdPerBillionInput, { tagged: 0, skipped, errors: 0 })
    return { tagged: 0, skipped, errors: 0, calls: 0, spent, lastUid, complete: true }
  }

  const res = await tagBatch({ accountId, engine, mails: todo, deadline })
  const spent = await chargeMailbox(accountId, res.inputTokens, engine.usdPerBillionInput,
    { tagged: res.tagged, skipped, errors: res.errors })
  // Un lot INTERROMPU (délai épuisé, refus du moteur) laisse des mails non traités : l'appelant
  // ne doit alors PAS avancer son curseur, sinon ces mails ne seraient jamais redemandés. Les
  // reprendre au passage suivant ne coûte rien — ceux qui sont faits sont sautés par leur étiquette.
  const complete = res.tagged + res.errors === todo.length
  const out: Advance & { lastUid: number; complete: boolean } = {
    tagged: res.tagged, skipped, errors: res.errors, calls: res.calls, spent, lastUid, complete }
  if (res.stop) out.paused = { reason: res.stop.kind === 'credit' ? 'credit' : 'auth', detail: res.stop.message }
  else if (spent >= params.budget) out.paused = { reason: 'budget', detail: `plafond de ${params.budget} $ atteint (dépensé ${spent.toFixed(4)} $)` }
  return out
}

/**
 * Le tri en masse. Le curseur avance dossier par dossier, et il est ENREGISTRÉ après chaque
 * petit lot : une coupure ici ne perd que le lot en cours. Un `uidValidity` changé fait
 * repartir ce dossier de zéro — sans surcoût, puisque le saut par `alreadyTagged` rattrape
 * tout ce qui a déjà été payé.
 */
async function advanceBulk(params: {
  row: TaggingRow; source: MailSource; engine: TaggingEngine; deadline: number; spent: number; budget: number
}): Promise<Advance> {
  const { row, source, engine, deadline } = params
  const accountId = row.account_id
  const acc: Advance = { tagged: 0, skipped: 0, errors: 0, calls: 0, spent: params.spent }

  const folders = await source.folders()
  const validity = new Map(folders.map(f => [f.path, f.uidValidity]))
  let cursor: BulkCursor = row.bulk_cursor ?? {
    folders: folders.map(f => f.path), index: 0, lastUid: 0,
    uidValidity: folders[0]?.uidValidity ?? '',
  }
  if (!row.bulk_cursor) {
    await query(`UPDATE mailbox_tagging SET total = $2, updated_at = NOW() WHERE account_id = $1`,
      [accountId, folders.reduce((n, f) => n + f.total, 0)])
    await saveBulkCursor(accountId, cursor)
  }

  while (cursor.index < cursor.folders.length) {
    if (remaining(deadline) <= 0) return acc
    const folder = cursor.folders[cursor.index]
    const live = validity.get(folder)
    if (live === undefined) {
      // Le dossier a disparu entre deux passages : on passe au suivant plutôt que d'échouer.
      cursor = { ...cursor, index: cursor.index + 1, lastUid: 0, uidValidity: '' }
      await saveBulkCursor(accountId, cursor)
      continue
    }
    if (cursor.uidValidity && cursor.uidValidity !== live) {
      // Les UID de ce dossier ne désignent plus les mêmes mails : le curseur ne veut plus rien
      // dire, on le remet à zéro pour CE dossier.
      cursor = { ...cursor, lastUid: 0, uidValidity: live }
      await saveBulkCursor(accountId, cursor)
    } else if (!cursor.uidValidity) {
      cursor = { ...cursor, uidValidity: live }
    }

    const mails = await source.fetch(folder, cursor.lastUid, BATCH_SIZE)
    if (!mails.length) {
      cursor = { ...cursor, index: cursor.index + 1, lastUid: 0, uidValidity: validity.get(cursor.folders[cursor.index + 1]) ?? '' }
      await saveBulkCursor(accountId, cursor)
      continue
    }

    const res = await processBatch({ accountId, engine, mails, deadline, spent: acc.spent, budget: params.budget })
    acc.tagged += res.tagged; acc.skipped += res.skipped; acc.errors += res.errors; acc.calls += res.calls
    acc.spent = res.spent
    if (res.complete) {
      cursor = { ...cursor, lastUid: res.lastUid }
      await saveBulkCursor(accountId, cursor)
    }
    if (res.paused) return { ...acc, paused: res.paused }
    if (!res.complete) return acc
  }

  return { ...acc, finished: true }
}

/**
 * Le tri au fil de l'eau : uniquement ce qui est arrivé APRÈS l'activation. Le curseur par
 * dossier vient de `enableLive`, jamais de zéro — sans quoi activer le fil de l'eau
 * déclencherait un tri de tout l'historique, aux frais de l'utilisateur.
 */
async function advanceLive(params: {
  row: TaggingRow; source: MailSource; engine: TaggingEngine; deadline: number; spent: number; budget: number
}): Promise<Advance> {
  const { row, source, engine, deadline } = params
  const accountId = row.account_id
  const acc: Advance = { tagged: 0, skipped: 0, errors: 0, calls: 0, spent: params.spent }
  const cursor: LiveCursor = { ...(row.live_cursor ?? {}) }

  for (const f of await source.folders()) {
    const known = cursor[f.path]
    // Un dossier apparu APRÈS l'activation démarre à son UID courant : le fil de l'eau ne
    // rattrape jamais un historique, même celui d'un dossier nouveau.
    if (!known) {
      cursor[f.path] = { lastUid: await lastUidOf(source, f.path), uidValidity: f.uidValidity }
      await saveLiveCursor(accountId, cursor)
      continue
    }
    let after = known.uidValidity === f.uidValidity ? known.lastUid : await lastUidOf(source, f.path)
    for (;;) {
      if (remaining(deadline) <= 0 || acc.spent >= params.budget) return acc
      const mails = await source.fetch(f.path, after, BATCH_SIZE)
      if (!mails.length) break
      const res = await processBatch({ accountId, engine, mails, deadline, spent: acc.spent, budget: params.budget })
      acc.tagged += res.tagged; acc.skipped += res.skipped; acc.errors += res.errors; acc.calls += res.calls
      acc.spent = res.spent
      if (res.complete) {
        after = res.lastUid
        cursor[f.path] = { lastUid: after, uidValidity: f.uidValidity }
        await saveLiveCursor(accountId, cursor)
      }
      if (res.paused) return { ...acc, paused: res.paused }
      if (!res.complete) return acc
    }
  }
  return acc
}

/** Une ligne `decision_engines`, telle que le trieur a besoin de la lire. */
export interface DecisionEngineRow {
  id: string
  kind: TagSource
  url: string
  key_encrypted: string | null
  model: string
  usd_per_billion_input: number
}

/**
 * Une ligne `decision_engines` → le moteur que le trieur sait interroger. La clé est déchiffrée
 * ICI et ne sort pas : elle ne traverse ni un état, ni un journal, ni une réponse d'API. Le tarif
 * vient du MOTEUR (décision 13), jamais du type : deux moteurs `jev` peuvent être facturés
 * différemment, et le préréglage ne sert qu'à préremplir le formulaire.
 *
 * La `source` des étiquettes est le `kind` du moteur — donc jamais `humain` ni `dossier`, que
 * `sourceForWriter` réserve à ce qu'une main a écrit.
 */
export function engineFromRow(row: DecisionEngineRow): TaggingEngine {
  const cfg = { url: row.url, apiKey: row.key_encrypted ? decrypt(row.key_encrypted) : '', model: row.model }
  return {
    source: row.kind,
    usdPerBillionInput: row.usd_per_billion_input,
    ask: state => askEngine(cfg, state),
  }
}

type MailboxToSort = ImapAccountRow & {
  account_id: string
  engine_id: string
  engine_kind: TagSource
  engine_url: string
  engine_key: string | null
  engine_model: string
  engine_price: number
}

/**
 * Les boîtes qu'un passage doit travailler, en UNE requête : identifiants IMAP et moteur choisi
 * ensemble, plutôt qu'une requête par boîte. Elle vit ICI et non dans le planificateur pour être
 * MESURABLE — le banc l'appelle directement et vérifie qu'une boîte en pause, sans moteur ou
 * verrouillée n'y figure pas, sans ouvrir la moindre connexion IMAP.
 *
 * Une boîte en pause n'est JAMAIS réveillée par cette sélection : il faut un `resume` explicite,
 * sinon un plafond atteint ou un crédit épuisé se remettrait à cogner une porte fermée.
 */
export async function mailboxesToSort(): Promise<MailboxToSort[]> {
  return query<MailboxToSort>(`
    SELECT a.id, a.imap_host, a.imap_port, a.imap_secure, a.username, a.password_encrypted,
           a.oauth_provider, a.oauth_access_token, a.oauth_refresh_token, a.oauth_expires_at,
           m.account_id, e.id AS engine_id, e.kind AS engine_kind, e.url AS engine_url,
           e.key_encrypted AS engine_key, e.model AS engine_model,
           e.usd_per_billion_input AS engine_price
      FROM mailbox_tagging m
      JOIN email_accounts a ON a.id = m.account_id
      JOIN decision_engines e ON e.id = m.engine_id
     WHERE m.paused_reason IS NULL
       AND (m.bulk_state = 'running' OR m.live)
       AND (m.locked_until IS NULL OR m.locked_until < NOW())
  `)
}
