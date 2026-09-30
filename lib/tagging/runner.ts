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
import { createHash } from 'crypto'
import type { ImapAccountRow } from '../accounts'
import { query } from '../db'
import { decrypt } from '../encrypt'
import {
  EngineError, RULE_SOURCE, askEngine, assumedInputTokensPerMail, buildState, costUsd,
  type BulkState, type EngineResult, type EngineState, type MailForState, type PauseReason, type TagSource,
} from './engine'
import { alreadyTagged, messageIdOf, writeTags, type TagAuthor } from './store'
import { questionSetForAccount } from './userQuestions'
import { applyTagRules, remainingQuestions, rulesForAccount, type TagRule } from './tagRules'
import type { QuestionSet, TagQuestion } from './questions'

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
  /**
   * Les mails de `folder` dont l'UID est dans `uids`, par UID croissant, en UNE commande. Un UID
   * disparu depuis est simplement absent du résultat. Lire une LISTE et lire une PLAGE sont deux
   * besoins distincts : l'échantillon désigne des UID épars, et les relire un par un par `fetch`
   * faisait transmettre au serveur toute la fin du dossier à chaque mail (mesuré : aucun lot de
   * 20 fini en 50 s sur 161 635 mails).
   */
  fetchUids(folder: string, uids: number[]): Promise<SourceMail[]>
  /**
   * Les UID de `folder`, SANS lire un seul mail. Nommer les mails d'un dossier et les LIRE sont
   * deux besoins distincts : le tirage n'a besoin que des numéros, et passer par `fetch` pour les
   * obtenir téléchargeait le corps de chaque mail de la boîte (mesuré : jamais fini sur 161 635
   * mails). En IMAP c'est un `UID SEARCH ALL`, une commande par dossier.
   */
  uids(folder: string): Promise<number[]>
}

/** Le moteur, réduit à ce que le trieur lui demande. `askEngine` en est l'implémentation. */
export interface TaggingEngine {
  /** UNE requête pour `posed` : le jeu actif de la boîte, résolu une fois par passage (lot T-Q). */
  ask(state: EngineState, posed: readonly TagQuestion[]): Promise<EngineResult>
  /** La source à écrire pour les étiquettes de CE moteur (`kind` du moteur, décision 13). */
  readonly source: TagSource
  /** QUI signe les étiquettes : l'id du moteur et son nom du moment (décision 23). */
  readonly auteur: TagAuthor
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

/** La taille d'un échantillon quand l'écran n'en propose pas d'autre (décision T10b). */
export const SAMPLE_SIZE_DEFAULT = 1000

/** La graine par défaut du tirage : fixe, pour que deux boîtes se comparent sur le même hasard. */
export const SAMPLE_SEED_DEFAULT = 20260926

/**
 * Le tirage d'un échantillon, et où on en est dedans. Le tirage est ENREGISTRÉ plutôt que
 * recalculé à chaque passage : il porte sur l'état de la boîte à l'instant du tirage, donc le
 * refaire donnerait une liste différente dès qu'un mail arrive — et l'échantillon ne serait plus
 * celui qu'on a annoncé.
 */
export interface SampleCursor {
  seed: number
  size: number
  /** Les mails tirés, dans l'ordre du tirage : `folder` + `uid`, rien de plus. Vide tant que `draw` dure. */
  picks: Array<{ folder: string; uid: number }>
  /** Combien de ces mails ont déjà été traités : le tirage reprend exactement là. */
  done: number
  /** Le tirage EN COURS, quand il n'a pas fini en un passage. Absent dès qu'il a fini. */
  draw?: SampleDraw | null
}

/**
 * Où en est le tirage lui-même. Il est enregistré après CHAQUE dossier, donc un passage coupé
 * (50 s) ne le fait pas repartir de zéro — c'est exactement ce qui le bloquait sur une vraie
 * boîte, où il ne finissait jamais un passage et ne gardait rien.
 */
export interface SampleDraw {
  /** Les dossiers à parcourir, figés au départ du tirage. */
  folders: string[]
  /** Combien sont déjà comptés : le tirage reprend à celui-là. */
  index: number
  /** Les `size` meilleurs rangs vus jusqu'ici. BORNÉ : c'est tout ce que le tri final garde. */
  best: Array<{ folder: string; uid: number; rank: number }>
}

/**
 * Le rang de tirage d'un mail : les 13 premiers hex du SHA-256 de `graine|dossier|uid`, lus comme
 * un nombre. C'est un hachage et non un générateur pseudo-aléatoire parce qu'il rend le tirage
 * INDÉPENDANT de l'ordre d'énumération : trier les mails par ce rang et garder les N premiers
 * donne le même échantillon quel que soit l'ordre dans lequel les dossiers ont été parcourus, et
 * le même à graine égale — c'est exactement ce que « rejouer le même tirage » demande.
 *
 * 13 hex = 52 bits, le plus grand entier qu'un `number` porte exactement : au-delà, deux rangs
 * distincts se confondraient à l'arrondi et le tri deviendrait arbitraire.
 */
const SAMPLE_RANK_HEX = 13

export const sampleRank = (seed: number, folder: string, uid: number): number =>
  parseInt(createHash('sha256').update(`${seed}|${folder}|${uid}`).digest('hex').slice(0, SAMPLE_RANK_HEX), 16)

/** Le rang départage seul ; `folder`/`uid` ne rendent qu'une égalité de rang STABLE, donc reproductible. */
const byRank = (a: SampleDraw['best'][number], b: SampleDraw['best'][number]): number =>
  a.rank - b.rank || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : a.uid - b.uid)

/**
 * Compte UN dossier dans le tirage : ses UID sont classés par rang et seuls les `size` meilleurs
 * survivent. C'est ce qui rend le tirage reprenable SANS rien perdre : « les N plus petits rangs »
 * ne dépend pas de l'ordre des dossiers (c'est la raison d'être du rang par hachage), donc un
 * tirage fait en dix passages rend exactement celui fait en un seul — et l'état gardé entre deux
 * passages pèse `size` entrées, pas la boîte entière.
 */
export function drawStep(
  best: SampleDraw['best'], seed: number, size: number, folder: string, uids: number[]
): SampleDraw['best'] {
  const merged = best.concat(uids.map(uid => ({ folder, uid, rank: sampleRank(seed, folder, uid) })))
  merged.sort(byRank)
  return merged.slice(0, Math.max(size, 0))
}

/**
 * Tire `size` mails AU HASARD parmi tous ceux que la source annonce, tous dossiers confondus.
 *
 * L'énumération ne lit AUCUN mail : `uids()` rend les numéros seuls (`UID SEARCH ALL` côté IMAP),
 * une commande par dossier. Passer par `fetch` téléchargeait le CORPS de chaque mail de la boîte
 * pour n'en garder que le numéro — sur 161 635 mails le tirage ne finissait jamais un passage.
 */
export async function drawSample(
  source: MailSource, params: { seed: number; size: number }
): Promise<SampleCursor['picks']> {
  let best: SampleDraw['best'] = []
  for (const f of await source.folders()) {
    best = drawStep(best, params.seed, params.size, f.path, await source.uids(f.path))
  }
  return best.map(m => ({ folder: m.folder, uid: m.uid }))
}

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
  sample_size: number | null
  sample_seed: string | null
  sample_cursor: SampleCursor | null
  /** BIGINT : `pg` le rend en chaîne. */
  run_started_tag_id: string | null
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
 * La borne « avant ce tri » : le dernier identifiant d'étiquette qui existe au lancement. Tout ce
 * qui sera écrit ensuite porte un identifiant plus grand — la séquence ne recule jamais, alors
 * que `NOW()` sous Docker Desktop le fait (voir `run_started_tag_id` dans `lib/db.ts`).
 */
const LAST_TAG_ID = '(SELECT COALESCE(MAX(id), 0) FROM message_tags)'

/**
 * Démarre (ou redémarre) un tri en masse. `restart` remet le curseur à zéro ; sans lui, un tri
 * `done` repart de son curseur — donc ne redemande rien, et c'est voulu : « relancer un tri
 * terminé » ne doit pas coûter un centime.
 */
export async function startBulk(accountId: string, opts: { restart?: boolean } = {}): Promise<void> {
  await query(
    `UPDATE mailbox_tagging
        SET bulk_state = 'running', ${PAUSE_IF_NO_ENGINE}, locked_until = NULL,
            sample_size = NULL, sample_seed = NULL, sample_cursor = NULL,
            bulk_cursor = CASE WHEN $2 THEN NULL ELSE bulk_cursor END,
            tagged = CASE WHEN $2 THEN 0 ELSE tagged END,
            skipped = CASE WHEN $2 THEN 0 ELSE skipped END,
            errors = CASE WHEN $2 THEN 0 ELSE errors END,
            run_started_tag_id = CASE WHEN $2 OR run_started_tag_id IS NULL THEN ${LAST_TAG_ID} ELSE run_started_tag_id END,
            updated_at = NOW()
      WHERE account_id = $1`,
    [accountId, opts.restart === true]
  )
}

/**
 * Démarre un ÉCHANTILLON : le même tri en masse, mais borné à `size` mails tirés au hasard, puis
 * arrêt. C'est un `bulk_state = 'running'` comme un autre — le planificateur, le verrou, le
 * plafond et les pauses sont exactement ceux du tri complet, il n'y a pas un second trieur à
 * tenir d'accord avec le premier. Seule la LISTE des mails change.
 *
 * Le tirage n'est pas fait ici : il demande la boîte entière, donc de l'IMAP, ce qu'une requête
 * HTTP ne doit pas porter. C'est `advanceSample` qui le fait à son premier passage, et l'écrit.
 */
export async function startSample(
  accountId: string, opts: { size?: number; seed?: number } = {}
): Promise<void> {
  await query(
    `UPDATE mailbox_tagging
        SET bulk_state = 'running', ${PAUSE_IF_NO_ENGINE}, locked_until = NULL,
            sample_size = $2, sample_seed = $3, sample_cursor = NULL, bulk_cursor = NULL,
            tagged = 0, skipped = 0, errors = 0, run_started_tag_id = ${LAST_TAG_ID}, updated_at = NOW()
      WHERE account_id = $1`,
    [accountId, Math.max(Math.trunc(opts.size ?? SAMPLE_SIZE_DEFAULT), 1), Math.trunc(opts.seed ?? SAMPLE_SEED_DEFAULT)]
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
 * Le dernier UID d'un dossier. Il sort de `uids()` — les numéros seuls, une commande — et non
 * d'un parcours par `fetch`, qui téléchargeait le corps de TOUS les mails du dossier pour n'en
 * retenir qu'un numéro. Un dossier vide rend 0 : le fil de l'eau y démarre donc au premier mail.
 */
async function lastUidOf(source: MailSource, folder: string): Promise<number> {
  const uids = await source.uids(folder)
  return uids.length ? Math.max(...uids) : 0
}

/** Le temps qu'il reste à ce passage. */
const remaining = (deadline: number): number => deadline - Date.now()

/**
 * Tague un petit lot, `CONCURRENCY` requêtes en vol. Chaque mail est traité indépendamment :
 * une erreur récupérable sur l'un ne fait pas perdre les autres. Une erreur qui ARRÊTE la
 * boîte (`credit`, `auth`) est remontée telle quelle — l'appelant pose la pause.
 */
async function tagBatch(
  params: { accountId: string; engine: TaggingEngine; mails: SourceMail[]; deadline: number; questions: QuestionSet; rules: readonly TagRule[] }
): Promise<{ tagged: number; errors: number; calls: number; inputTokens: number; stop?: EngineError }> {
  const { accountId, engine, mails, deadline, questions, rules } = params
  const posed = questions.posed()
  const queue = [...mails]
  let tagged = 0, errors = 0, calls = 0, inputTokens = 0
  let stop: EngineError | undefined

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop || remaining(deadline) <= 0) return
      const mail = queue.shift()
      if (!mail) return
      // Les règles d'étiquetage passent AVANT le moteur (décision 24.1) : leurs étiquettes sont
      // écrites en source `regle`, signées de la règle, et les questions qu'une règle « qui fait
      // foi » a tranchées ne sont plus posées — un mail entièrement tranché ne coûte rien.
      const decided = applyTagRules(rules, mail, questions)
      const position = { folder: mail.folder, uid: mail.uid, fromName: mail.fromName, fromAddress: mail.fromAddress, subject: mail.subject, date: mail.date }
      for (const rule of Array.from(new Set(decided.tags.map(t => t.rule)))) {
        await writeTags({
          accountId, messageId: messageIdOf(mail), source: RULE_SOURCE, auteur: { id: rule.id, nom: rule.name },
          tags: decided.tags.filter(t => t.rule === rule).map(({ question, valeur }) => ({ question, valeur })), questions, position,
        })
      }
      const ask = remainingQuestions(posed, decided.settled)
      if (!ask.length) { tagged += 1; continue }
      let result: EngineResult
      calls += 1
      try {
        result = await engine.ask(buildState(mail), ask)
      } catch (err) {
        if (err instanceof EngineError && (err.kind === 'credit' || err.kind === 'auth')) { stop = err; return }
        errors += 1
        continue
      }
      inputTokens += result.inputTokens
      if (!result.tags.length) { errors += 1; continue }
      await writeTags({
        accountId, messageId: messageIdOf(mail), source: engine.source, auteur: engine.auteur, modele: result.model,
        tags: result.tags, questions, position,
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
  // `input_mails` compte les mails DERRIÈRE `input_tokens` et suit la même vie : cumulé, jamais
  // remis à zéro — contrairement à `tagged`, que chaque tri repart de zéro (lot T-Q2b).
  const rows = await query<{ spent_usd: number }>(
    `UPDATE mailbox_tagging
        SET input_tokens = input_tokens + $2, spent_usd = spent_usd + $3, input_mails = input_mails + $4,
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
 *
 * `measuredMails` est `input_mails`, le compteur qui vit aussi longtemps que `input_tokens` —
 * jamais `tagged`, remis à zéro à chaque tri : le quotient de deux compteurs de durées de vie
 * différentes rendait 572,86 $ après un échantillon d'1 mail (lot T-Q2b).
 */
export function estimateUsd(params: { mails: number; questions: number; usdPerBillionInput: number; inputTokens?: number; measuredMails?: number }): number {
  const perMail = params.measuredMails && params.measuredMails > 0 && params.inputTokens
    ? params.inputTokens / params.measuredMails
    : assumedInputTokensPerMail(params.questions)
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
    // Le jeu de questions est relu UNE fois par passage : une question modifiée pendant un tri
    // s'applique au passage suivant (≤ 60 s), et tous les lots d'un passage posent le même jeu.
    const questions = await questionSetForAccount(accountId)
    // Les règles d'étiquetage, relues au même rythme : une règle ajoutée pendant un tri
    // s'applique au passage suivant.
    const rules = await rulesForAccount(accountId)

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
      // Un échantillon est un tri en masse BORNÉ : même état, même verrou, même plafond, mêmes
      // pauses — seule la liste des mails diffère, donc un seul `if` les sépare.
      const res = row.sample_size === null
        ? await advanceBulk({ row, source, engine, deadline, spent, budget: row.budget_usd, questions, rules })
        : await advanceSample({ row, source, engine, deadline, spent, budget: row.budget_usd, questions, rules })
      acc.tagged += res.tagged; acc.skipped += res.skipped; acc.errors += res.errors; acc.calls += res.calls
      spent = res.spent
      acc.spentUsd = spent
      if (res.paused) { await pauseMailbox(accountId, res.paused.reason, res.paused.detail); return { ...acc, reason: 'paused', paused: res.paused } }
      if (res.finished) await query(`UPDATE mailbox_tagging SET bulk_state = 'done', updated_at = NOW() WHERE account_id = $1`, [accountId])
    }

    if (row.live && remaining(deadline) > 0 && spent < row.budget_usd) {
      worked = true
      const res = await advanceLive({ row, source, engine, deadline, spent, budget: row.budget_usd, questions, rules })
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

/**
 * Ce que les deux modes partagent : sauter le déjà-fait, taguer, compter, enregistrer.
 *
 * « Sauté » ne compte QUE ce qui est sauté pour de bon (lot T10c) : un mail tagué AVANT ce tri,
 * ou un doublon de Message-ID dans ce lot même. Un mail tagué PAR ce tri est relu quand un lot
 * coupé au délai laisse son curseur en place — il a déjà été compté en « tagué », le compter à
 * nouveau en « sauté » gonflait les deux compteurs pour un seul mail.
 */
async function processBatch(params: {
  accountId: string; engine: TaggingEngine; mails: SourceMail[]; deadline: number; spent: number; budget: number
  sinceTagId: string | null; questions: QuestionSet; rules: readonly TagRule[]
}): Promise<Advance & { lastUid: number; complete: boolean }> {
  const { accountId, engine, mails, deadline, questions, rules } = params
  const ids = mails.map(m => messageIdOf(m))
  const seen = await alreadyTagged(accountId, { source: engine.source, auteurId: engine.auteur.id, questions }, ids, params.sinceTagId)
  // Le même mail peut être classé dans deux dossiers, ou deux fois dans le même : il porte alors
  // le MÊME Message-ID. `alreadyTagged` ne rattrape que ce qui est déjà en base, donc pas deux
  // exemplaires du même lot — d'où ce second filtre, sans quoi le mail serait payé deux fois.
  // Il compte les POSITIONS, pas les étiquettes : un exemplaire reste un doublon même quand son
  // jumeau a été tagué par un lot précédent de CE tri, sinon le compte dépendrait de l'endroit
  // où la coupure est tombée.
  const withinBatch = new Set<string>()
  let skipped = 0
  const todo = mails.filter((m, i) => {
    const duplicate = withinBatch.has(ids[i])
    withinBatch.add(ids[i])
    if (duplicate || seen.before.has(ids[i])) { skipped += 1; return false }
    return !seen.during.has(ids[i])
  })
  const lastUid = mails[mails.length - 1].uid

  if (!todo.length) {
    const spent = await chargeMailbox(accountId, 0, engine.usdPerBillionInput, { tagged: 0, skipped, errors: 0 })
    return { tagged: 0, skipped, errors: 0, calls: 0, spent, lastUid, complete: true }
  }

  const res = await tagBatch({ accountId, engine, mails: todo, deadline, questions, rules })
  // Un lot INTERROMPU (délai épuisé, refus du moteur) laisse des mails non traités : l'appelant
  // ne doit alors PAS avancer son curseur, sinon ces mails ne seraient jamais redemandés. Les
  // reprendre au passage suivant ne coûte rien — ceux qui sont faits sont sautés par leur étiquette.
  const complete = res.tagged + res.errors === todo.length
  // Les COMPTEURS suivent le curseur : un lot qui ne fait pas avancer le curseur sera relu, donc
  // ses « sautés » seraient comptés une fois de plus à chaque relecture. On ne les enregistre
  // qu'au lot MENÉ À TERME — celui-là n'est plus jamais relu. `tagged` n'a pas ce problème : un
  // mail tagué n'est pas retagué à la relecture, il tombe dans `during`.
  const charged = complete ? skipped : 0
  const spent = await chargeMailbox(accountId, res.inputTokens, engine.usdPerBillionInput,
    { tagged: res.tagged, skipped: charged, errors: res.errors })
  const out: Advance & { lastUid: number; complete: boolean } = {
    tagged: res.tagged, skipped: charged, errors: res.errors, calls: res.calls, spent, lastUid, complete }
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
  row: TaggingRow; source: MailSource; engine: TaggingEngine; deadline: number; spent: number; budget: number; questions: QuestionSet; rules: readonly TagRule[]
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

    const res = await processBatch({ accountId, engine, mails, deadline, spent: acc.spent, budget: params.budget, sinceTagId: row.run_started_tag_id, questions: params.questions, rules: params.rules })
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

/** Le curseur d'échantillon enregistré : le tirage et l'avancement dedans, en un seul écrit. */
const saveSampleCursor = (accountId: string, cursor: SampleCursor): Promise<unknown> =>
  query(`UPDATE mailbox_tagging SET sample_cursor = $2::jsonb, updated_at = NOW() WHERE account_id = $1`,
    [accountId, JSON.stringify(cursor)])

/**
 * L'échantillon : les mails TIRÉS, dans l'ordre du tirage, puis ARRÊT à la fin de la liste.
 *
 * Deux choses lui appartiennent, tout le reste est partagé avec le tri complet (`processBatch` :
 * le saut du déjà-fait, le comptage, le plafond, les pauses) :
 *
 *  1. **Le tirage est fait UNE fois**, au premier passage, et enregistré : refait à chaque
 *     passage il désignerait d'autres mails dès qu'un mail arrive dans la boîte ;
 *  2. **`total` vaut la taille du tirage**, pas celle de la boîte : l'écran doit annoncer le coût
 *     de CE qu'il va faire, et une barre d'avancement sur 161 635 mails pour un échantillon de
 *     1 000 ne bougerait jamais.
 *
 * Les mails sont relus par `fetchUids(folder, [uid, …])`, une commande par dossier et par lot :
 * c'est une lecture d'en-têtes bornée aux mails tirés, pas un appel au moteur.
 */
async function advanceSample(params: {
  row: TaggingRow; source: MailSource; engine: TaggingEngine; deadline: number; spent: number; budget: number; questions: QuestionSet; rules: readonly TagRule[]
}): Promise<Advance> {
  const { row, source, engine, deadline } = params
  const accountId = row.account_id
  const acc: Advance = { tagged: 0, skipped: 0, errors: 0, calls: 0, spent: params.spent }
  const size = row.sample_size ?? SAMPLE_SIZE_DEFAULT
  const seed = row.sample_seed === null ? SAMPLE_SEED_DEFAULT : Number(row.sample_seed)

  let cursor = row.sample_cursor
  // Un tirage qui ne correspond plus à la taille ou à la graine demandées est refait : c'est ce
  // qui fait qu'un second essai à graine différente tire bien autre chose.
  if (!cursor || cursor.seed !== seed || cursor.size !== size) {
    cursor = { seed, size, picks: [], done: 0, draw: { folders: (await source.folders()).map(f => f.path), index: 0, best: [] } }
    await saveSampleCursor(accountId, cursor)
  }

  // Le tirage, dossier par dossier, ENREGISTRÉ après chacun : un passage coupé au délai reprend
  // au dossier suivant au lieu de tout recommencer. Sans cela, sur une boîte réelle le tirage ne
  // finissait aucun passage et la boîte ne taguait jamais rien (mesuré : 6 min, tagged=0).
  if (cursor.draw) {
    let draw = cursor.draw
    while (draw.index < draw.folders.length) {
      if (remaining(deadline) <= 0) return acc
      const folder = draw.folders[draw.index]
      draw = { ...draw, best: drawStep(draw.best, seed, size, folder, await source.uids(folder)), index: draw.index + 1 }
      cursor = { ...cursor, draw }
      await saveSampleCursor(accountId, cursor)
    }
    cursor = { ...cursor, picks: draw.best.map(m => ({ folder: m.folder, uid: m.uid })), draw: null }
    await saveSampleCursor(accountId, cursor)
    await query(`UPDATE mailbox_tagging SET total = $2, updated_at = NOW() WHERE account_id = $1`,
      [accountId, cursor.picks.length])
  }

  while (cursor.done < cursor.picks.length) {
    if (remaining(deadline) <= 0) return acc
    const slice = cursor.picks.slice(cursor.done, cursor.done + BATCH_SIZE)
    // Le lot est REGROUPÉ PAR DOSSIER : une commande par dossier présent dans le lot, et non une
    // par mail. Un mail supprimé entre le tirage et maintenant manque simplement à la réponse ; il
    // est COMPTÉ comme sauté, jamais tu en silence, et le tirage avance quand même — sinon
    // l'échantillon ne finirait jamais.
    const byFolder = new Map<string, number[]>()
    for (const pick of slice) byFolder.set(pick.folder, [...(byFolder.get(pick.folder) ?? []), pick.uid])
    const mails: SourceMail[] = []
    for (const folder of Array.from(byFolder.keys())) mails.push(...await source.fetchUids(folder, byFolder.get(folder) as number[]))
    const missing = slice.length - mails.length

    if (!mails.length) {
      cursor = { ...cursor, done: cursor.done + slice.length }
      await saveSampleCursor(accountId, cursor)
      if (missing) {
        acc.skipped += missing
        acc.spent = await chargeMailbox(accountId, 0, engine.usdPerBillionInput, { tagged: 0, skipped: missing, errors: 0 })
      }
      continue
    }

    const res = await processBatch({ accountId, engine, mails, deadline, spent: acc.spent, budget: params.budget, sinceTagId: row.run_started_tag_id, questions: params.questions, rules: params.rules })
    acc.tagged += res.tagged; acc.skipped += res.skipped + missing; acc.errors += res.errors; acc.calls += res.calls
    acc.spent = res.spent
    if (missing) {
      acc.spent = await chargeMailbox(accountId, 0, engine.usdPerBillionInput, { tagged: 0, skipped: missing, errors: 0 })
    }
    if (res.complete) {
      cursor = { ...cursor, done: cursor.done + slice.length }
      await saveSampleCursor(accountId, cursor)
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
  row: TaggingRow; source: MailSource; engine: TaggingEngine; deadline: number; spent: number; budget: number; questions: QuestionSet; rules: readonly TagRule[]
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
      const res = await processBatch({ accountId, engine, mails, deadline, spent: acc.spent, budget: params.budget, sinceTagId: row.run_started_tag_id, questions: params.questions, rules: params.rules })
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
  name: string
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
    auteur: { id: row.id, nom: row.name },
    usdPerBillionInput: row.usd_per_billion_input,
    ask: (state, posed) => askEngine(cfg, state, posed),
  }
}

type MailboxToSort = ImapAccountRow & {
  account_id: string
  engine_id: string
  engine_name: string
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
           m.account_id, e.id AS engine_id, e.name AS engine_name, e.kind AS engine_kind, e.url AS engine_url,
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
