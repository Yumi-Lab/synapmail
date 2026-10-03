/**
 * La ligne `mailbox_tagging` d'une boîte vue du dehors : ce que l'écran « Tri automatique » lit
 * et écrit. UN endroit la façonne, pour que `GET /api/tagging/status`, `POST /api/tagging/run` et
 * `PUT /api/tagging/settings` rendent exactement le même objet — sinon l'écran verrait trois
 * formes de la même chose selon le bouton pressé.
 *
 * Ce module ne rend JAMAIS la clé d'un moteur, ni en clair ni chiffrée : seulement `hasKey`
 * (décision 13). La clé ne sort qu'une fois déchiffrée dans `engineFromRow`, côté trieur, et n'y
 * traverse ni journal ni réponse.
 */

import { query } from '../db'
import { costUsd, assumedInputTokensPerMail } from './engine'
import { chunkByBudget, groupsForAccount, planPasses, triggerRate, type Distribution, type PassPlan } from './questionGroups'
import { estimateUsd, SAMPLE_SEED_DEFAULT, SAMPLE_SIZE_DEFAULT } from './runner'
import { tagDistribution, taxonomyVersion } from './store'
import { questionSetForAccount } from './userQuestions'
import type { BulkState, EngineKind, PauseReason } from './engine'

/** Ce qu'une boîte expose de son tri. Lu par l'écran, jamais écrit tel quel. */
export interface TaggingStatus {
  accountId: string
  engineId: string | null
  engine: { id: string; name: string; kind: EngineKind; model: string; hasKey: boolean; usdPerBillionInput: number } | null
  budgetUsd: number
  spentUsd: number
  inputTokens: number
  live: boolean
  bulkState: BulkState
  pausedReason: PauseReason | null
  pausedDetail: string | null
  tagged: number
  skipped: number
  errors: number
  total: number
  /** Le coût estimé du tri de ce qui RESTE, au tarif du moteur choisi. `null` sans moteur. */
  estimateUsd: number | null
  /** Le nombre de questions ACTIVES posées à chaque mail : ce qui explique l'ordre de grandeur du coût. */
  questions: number
  /**
   * La version du JEU de questions actives du propriétaire (`taxonomyVersion`). Affichée parce
   * qu'elle explique une relance : un tri « terminé » repart de zéro quand cette chaîne a changé.
   */
  taxonomyVersion: string
  /**
   * L'échantillon en cours (lot T10b), ou `null` quand le tri porte sur la boîte entière : la
   * taille demandée, la graine du tirage, et combien de mails tirés restent à faire. C'est ce
   * qui permet à l'écran de dire « échantillon de 1 000 » au lieu de « tri en cours ».
   */
  sample: { size: number; seed: number; drawn: number; done: number } | null
  /** Le coût estimé d'un échantillon de la taille par défaut, pour l'annoncer AVANT de le lancer. */
  sampleEstimateUsd: number | null
  /** La taille et la graine proposées par défaut à l'écran, nommées en UN endroit. */
  sampleDefaults: { size: number; seed: number }
  /** Ce que coûtent les passes (lot T-Q3) : par mail, tronc seul et avec les groupes, et le nombre de requêtes. */
  passes: PassEstimate
}

/**
 * Le coût des passes AVANT de lancer (décision 24.4). `trunk` = la passe 1 seule ; `withGroups`
 * = passe 1 + les groupes conditionnels pondérés par leur taux de déclenchement lu dans la
 * répartition de l'échantillon (T10b) — `null` tant qu'aucune étiquette ne renseigne un
 * déclencheur. Les jetons par question sont ceux de la boîte (`input_tokens / input_mails`
 * ramenés à sa passe de tronc) quand elle en a, sinon la constante.
 */
export interface PassEstimate {
  /** Les requêtes par mail : celles du tronc pour tous, celles des groupes quand ils se déclenchent. */
  requestsPerMail: { trunk: number; max: number }
  /** Jetons d'entrée par mail : tronc seul, et avec les groupes pondérés. */
  tokensPerMail: { trunk: number; withGroups: number | null }
  /** En dollars, au tarif du moteur ; `null` sans moteur. Par mail et pour ce qui RESTE de la boîte. */
  usdPerMail: { trunk: number; withGroups: number | null } | null
  usdRemaining: { trunk: number; withGroups: number | null } | null
  /**
   * Par groupe conditionnel : ses questions, ses requêtes, son taux de déclenchement estimé, et
   * sur combien de mails ce taux est lu (`measuredOn`) — les mails déjà étiquetés sous la
   * définition courante des questions que lit le déclencheur, pas la boîte entière.
   */
  groups: Array<{ id: string; name: string; questions: number; requests: number; rate: number | null; measuredOn: number }>
}

/**
 * Les jetons d'une passe, ramenés à ce que la boîte a MESURÉ : la moyenne mesurée est par mail
 * pour le jeu ACTIF, donc `mesuré / questions actives` par question — le même quotient que
 * `estimateUsd`. Sans mesure, la constante par question.
 */
function passEstimate(plan: PassPlan, enabled: number, distribution: Distribution | null, measured: { inputTokens: number; mails: number }, price: number | null, remaining: number): PassEstimate {
  const perQuestion = measured.mails > 0 && measured.inputTokens > 0 && enabled > 0
    ? measured.inputTokens / measured.mails / enabled
    : assumedInputTokensPerMail(1)
  const trunkTokens = perQuestion * plan.trunk.length
  const mailsAnswering = (question: string) => distribution?.find(d => d.question === question)?.values.reduce((n, v) => n + v.count, 0) ?? 0
  const groups = plan.conditional.map(({ group, questions }) => {
    const read = group.conditions.filter(c => c.field === 'tag').map(c => mailsAnswering(c.tagQuestion ?? ''))
    return {
      id: group.id, name: group.name, questions: questions.length, requests: chunkByBudget(questions).length,
      rate: distribution ? triggerRate(group, distribution) : null,
      measuredOn: read.length ? Math.min(...read) : 0,
    }
  })
  const known = groups.every(g => g.rate !== null)
  const withGroups = known
    ? trunkTokens + plan.conditional.reduce((n, g, i) => n + perQuestion * g.questions.length * (groups[i].rate ?? 0), 0)
    : null
  const usd = (tokens: number | null) => (tokens === null || price === null ? null : costUsd(price, tokens))
  return {
    requestsPerMail: { trunk: chunkByBudget(plan.trunk).length, max: chunkByBudget(plan.trunk).length + groups.reduce((n, g) => n + g.requests, 0) },
    tokensPerMail: { trunk: trunkTokens, withGroups },
    usdPerMail: price === null ? null : { trunk: usd(trunkTokens)!, withGroups: usd(withGroups) },
    usdRemaining: price === null ? null : { trunk: usd(trunkTokens * remaining)!, withGroups: usd(withGroups === null ? null : withGroups * remaining) },
    groups,
  }
}

interface StatusRow {
  account_id: string
  engine_id: string | null
  engine_name: string | null
  engine_kind: EngineKind | null
  engine_model: string | null
  engine_has_key: boolean | null
  engine_price: number | null
  budget_usd: number
  spent_usd: number
  input_tokens: string
  input_mails: string
  live: boolean
  bulk_state: BulkState
  paused_reason: PauseReason | null
  paused_detail: string | null
  tagged: number
  skipped: number
  errors: number
  total: number
  sample_size: number | null
  sample_seed: string | null
  sample_drawn: number | null
  sample_done: number | null
}

/**
 * La boîte a une ligne de tri, quoi qu'il arrive. Une boîte jamais réglée n'en a pas : sans
 * cela, chaque route devrait distinguer « pas encore réglée » de « réglée et à zéro », et la
 * première lecture de l'écran tomberait sur un 404 qui n'apprend rien.
 */
export async function ensureMailboxTagging(accountId: string): Promise<void> {
  await query(
    `INSERT INTO mailbox_tagging (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId]
  )
}

/** L'état du tri d'une boîte, moteur compris — sans sa clé. */
export async function readTaggingStatus(accountId: string): Promise<TaggingStatus> {
  await ensureMailboxTagging(accountId)
  const rows = await query<StatusRow>(
    `SELECT m.account_id, m.engine_id, m.budget_usd, m.spent_usd, m.input_tokens, m.input_mails, m.live,
            m.bulk_state, m.paused_reason, m.paused_detail, m.tagged, m.skipped, m.errors, m.total,
            m.sample_size, m.sample_seed,
            jsonb_array_length(COALESCE(m.sample_cursor -> 'picks', '[]'::jsonb)) AS sample_drawn,
            (m.sample_cursor -> 'done')::int AS sample_done,
            e.name AS engine_name, e.kind AS engine_kind, e.model AS engine_model,
            e.usd_per_billion_input AS engine_price,
            (e.key_encrypted IS NOT NULL AND e.key_encrypted <> '') AS engine_has_key
       FROM mailbox_tagging m
       LEFT JOIN decision_engines e ON e.id = m.engine_id
      WHERE m.account_id = $1`,
    [accountId]
  )
  const r = rows[0]
  if (!r) throw new Error(`mailbox_tagging manquante pour ${accountId}`)
  const set = await questionSetForAccount(accountId)
  const questions = set.enabled.length
  const plan = planPasses(set, await groupsForAccount(accountId))
  // La répartition ne se lit que s'il y a un groupe à pondérer : c'est un GROUP BY sur toutes
  // les étiquettes de la boîte, et l'écran redemande cet état toutes les 20 s pendant un tri.
  const distribution = plan.conditional.length ? await tagDistribution(accountId) : null

  const inputTokens = Number(r.input_tokens)
  const measuredMails = Number(r.input_mails)
  const remaining = Math.max(r.total - r.tagged - r.skipped, 0)
  return {
    accountId: r.account_id,
    engineId: r.engine_id,
    engine: r.engine_id && r.engine_kind
      ? {
        id: r.engine_id, name: r.engine_name ?? '', kind: r.engine_kind,
        model: r.engine_model ?? '', hasKey: r.engine_has_key === true,
        usdPerBillionInput: Number(r.engine_price ?? 0),
      }
      : null,
    budgetUsd: Number(r.budget_usd),
    spentUsd: Number(r.spent_usd),
    inputTokens,
    live: r.live,
    bulkState: r.bulk_state,
    pausedReason: r.paused_reason,
    pausedDetail: r.paused_detail,
    tagged: r.tagged,
    skipped: r.skipped,
    errors: r.errors,
    total: r.total,
    estimateUsd: r.engine_price === null || r.engine_price === undefined
      ? null
      : estimateUsd({ mails: remaining, questions, usdPerBillionInput: Number(r.engine_price), inputTokens, measuredMails }),
    questions,
    taxonomyVersion: taxonomyVersion(set),
    sample: r.sample_size === null ? null : {
      size: r.sample_size,
      seed: r.sample_seed === null ? SAMPLE_SEED_DEFAULT : Number(r.sample_seed),
      drawn: r.sample_drawn ?? 0,
      done: r.sample_done ?? 0,
    },
    // L'estimation d'un échantillon se lit AVANT de le lancer : elle porte donc sur la taille par
    // défaut, pas sur le reste d'un tirage en cours — c'est le prix du bouton, pas de l'état.
    sampleEstimateUsd: r.engine_price === null || r.engine_price === undefined
      ? null
      : estimateUsd({ mails: SAMPLE_SIZE_DEFAULT, questions, usdPerBillionInput: Number(r.engine_price), inputTokens, measuredMails }),
    sampleDefaults: { size: SAMPLE_SIZE_DEFAULT, seed: SAMPLE_SEED_DEFAULT },
    passes: passEstimate(plan, questions, distribution, { inputTokens, mails: measuredMails }, r.engine_price === null || r.engine_price === undefined ? null : Number(r.engine_price), remaining),
  }
}

/** Ce que l'écran a le droit de régler. Le reste de la ligne appartient au trieur. */
export interface TaggingSettingsPatch {
  engineId?: string | null
  budgetUsd?: number
  live?: boolean
}

/**
 * Écrit les réglages d'une boîte. Le moteur doit appartenir à l'utilisateur qui l'attribue :
 * la clause `EXISTS` le vérifie DANS l'UPDATE, donc un identifiant deviné ne se glisse pas
 * dans la boîte de quelqu'un d'autre le temps d'une course entre deux requêtes.
 *
 * `live` est écrit ici SANS curseur : c'est le trieur qui posera le curseur du fil de l'eau à
 * son premier passage (`advanceLive` traite un dossier inconnu en partant de son UID courant),
 * donc activer le fil de l'eau ne rattrape jamais l'historique — et n'ouvre aucune connexion
 * IMAP dans le temps d'une requête HTTP.
 */
export async function writeTaggingSettings(accountId: string, userId: string, patch: TaggingSettingsPatch): Promise<TaggingStatus> {
  await ensureMailboxTagging(accountId)
  if (patch.engineId !== undefined) {
    const rows = await query<{ id: string }>(
      `UPDATE mailbox_tagging SET engine_id = $2, updated_at = NOW()
        WHERE account_id = $1
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM decision_engines WHERE id = $2 AND user_id = $3))
        RETURNING account_id AS id`,
      [accountId, patch.engineId, userId]
    )
    if (!rows.length) throw new UnknownEngineError(patch.engineId)
  }
  if (patch.budgetUsd !== undefined) {
    await query(`UPDATE mailbox_tagging SET budget_usd = $2, updated_at = NOW() WHERE account_id = $1`,
      [accountId, patch.budgetUsd])
  }
  if (patch.live !== undefined) {
    await query(`UPDATE mailbox_tagging SET live = $2, updated_at = NOW() WHERE account_id = $1`,
      [accountId, patch.live])
  }
  return readTaggingStatus(accountId)
}

/** Un moteur qui n'existe pas, ou qui n'est pas le sien : la route en fait un 404. */
export class UnknownEngineError extends Error {
  engineId: unknown
  constructor(engineId: unknown) {
    super(`moteur de décision introuvable: ${JSON.stringify(engineId)}`)
    this.name = 'UnknownEngineError'
    this.engineId = engineId
  }
}
