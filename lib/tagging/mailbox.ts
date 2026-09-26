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
import { estimateUsd } from './runner'
import { QUESTIONS } from './questions'
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
  /** Le nombre de questions posées à chaque mail : ce qui explique l'ordre de grandeur du coût. */
  questions: number
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
  live: boolean
  bulk_state: BulkState
  paused_reason: PauseReason | null
  paused_detail: string | null
  tagged: number
  skipped: number
  errors: number
  total: number
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
    `SELECT m.account_id, m.engine_id, m.budget_usd, m.spent_usd, m.input_tokens, m.live,
            m.bulk_state, m.paused_reason, m.paused_detail, m.tagged, m.skipped, m.errors, m.total,
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

  const inputTokens = Number(r.input_tokens)
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
      : estimateUsd({ mails: remaining, usdPerBillionInput: Number(r.engine_price), inputTokens, tagged: r.tagged }),
    questions: QUESTIONS.length,
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
