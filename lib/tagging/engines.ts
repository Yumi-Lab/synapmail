/**
 * Les moteurs de décision d'un utilisateur (décision 13) : des OUTILS qu'on ajoute, à côté des
 * LLM, et que chaque boîte choisit ensuite dans l'écran « Tri automatique ».
 *
 * UN endroit façonne la ligne vue du dehors, pour que la liste, la création, la modification et
 * le test rendent le même objet. Ce module ne rend JAMAIS la clé — ni en clair ni chiffrée :
 * seulement `hasKey`, comme `lib/tagging/mailbox.ts` pour la boîte. La clé ne se déchiffre qu'au
 * moment d'interroger le moteur (`engineFromRow`, côté trieur, et `testEngine` ci-dessous).
 */

import { query } from '../db'
import { encrypt, decrypt } from '../encrypt'
import { askEngine, ENGINE_PRESETS, isEngineKind, type EngineKind } from './engine'
import { UnknownEngineError } from './mailbox'
import { loadQuestionSet } from './userQuestions'

/** Un moteur vu de l'écran : tout sauf la clé. */
export interface DecisionEngine {
  id: string
  name: string
  kind: EngineKind
  url: string
  model: string
  usdPerBillionInput: number
  hasKey: boolean
  createdAt: string
}

interface EngineRow {
  id: string
  name: string
  kind: EngineKind
  url: string
  model: string
  usd_per_billion_input: number
  has_key: boolean
  created_at: string
}

/** La projection SANS la clé, écrite une fois : toute requête de ce module la réutilise. */
const PUBLIC_COLUMNS = `id, name, kind, url, model, usd_per_billion_input,
  (key_encrypted IS NOT NULL AND key_encrypted <> '') AS has_key, created_at`

const toEngine = (r: EngineRow): DecisionEngine => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.url,
  model: r.model,
  usdPerBillionInput: Number(r.usd_per_billion_input),
  hasKey: r.has_key === true,
  createdAt: r.created_at,
})

export async function listEngines(userId: string): Promise<DecisionEngine[]> {
  const rows = await query<EngineRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM decision_engines WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  )
  return rows.map(toEngine)
}

/** Ce qu'une route accepte d'écrire. `apiKey` entre en clair et ne ressort jamais. */
export interface EngineInput {
  name?: unknown
  kind?: unknown
  url?: unknown
  model?: unknown
  usdPerBillionInput?: unknown
  apiKey?: unknown
}

/** Un champ refusé, nommé : la route en fait un 400 qui dit lequel. */
export class InvalidEngineError extends Error {
  field: string
  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`)
    this.name = 'InvalidEngineError'
    this.field = field
  }
}

const NAME_MAX = 80
const MODEL_MAX = 100

/**
 * La validation des champs communs à la création et à la modification. Elle vit ICI et pas dans
 * les routes : sinon `POST` et `PATCH` divergeraient au premier changement, et la base serait
 * la seule à dire non — par une erreur que personne ne sait lire.
 */
function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (!name) throw new InvalidEngineError('name', 'un nom est requis')
  if (name.length > NAME_MAX) throw new InvalidEngineError('name', `au plus ${NAME_MAX} caractères`)
  return name
}

function cleanUrl(v: unknown): string {
  const url = typeof v === 'string' ? v.trim() : ''
  if (!url) return ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidEngineError('url', 'adresse illisible')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidEngineError('url', 'seuls http et https sont acceptés')
  }
  return url
}

function cleanPrice(v: unknown): number {
  const price = Number(v)
  if (!Number.isFinite(price) || price < 0) throw new InvalidEngineError('usdPerBillionInput', 'tarif négatif ou illisible')
  return price
}

function cleanModel(v: unknown): string {
  const model = typeof v === 'string' ? v.trim() : ''
  if (model.length > MODEL_MAX) throw new InvalidEngineError('model', `au plus ${MODEL_MAX} caractères`)
  return model
}

/**
 * Crée un moteur. Les champs absents prennent le PRÉRÉGLAGE de leur type (décision 13) : le
 * formulaire les préremplit déjà, cette reprise ne sert qu'à ce qu'un appel qui ne donne que le
 * nom et le type produise une ligne utilisable plutôt qu'une ligne vide.
 */
export async function createEngine(userId: string, input: EngineInput): Promise<DecisionEngine> {
  if (!isEngineKind(input.kind)) throw new InvalidEngineError('kind', 'type de moteur inconnu')
  const preset = ENGINE_PRESETS[input.kind]
  const name = cleanName(input.name)
  const url = input.url === undefined ? preset.url : cleanUrl(input.url)
  const model = input.model === undefined ? preset.model : cleanModel(input.model)
  const price = input.usdPerBillionInput === undefined ? preset.usdPerBillionInput : cleanPrice(input.usdPerBillionInput)
  const key = typeof input.apiKey === 'string' && input.apiKey.trim() ? encrypt(input.apiKey.trim()) : null

  const rows = await query<EngineRow>(
    `INSERT INTO decision_engines (user_id, name, kind, url, key_encrypted, model, usd_per_billion_input)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PUBLIC_COLUMNS}`,
    [userId, name, input.kind, url, key, model, price]
  )
  return toEngine(rows[0])
}

/**
 * Modifie un moteur en place. Un champ absent du corps n'est PAS touché — et une clé absente
 * n'efface pas celle qui est enregistrée : sans cela, changer le modèle d'un moteur obligerait
 * à retaper une clé qu'on ne peut plus lire. Pour retirer la clé, on envoie `apiKey: ''`.
 *
 * `user_id` est dans le WHERE : un identifiant deviné ne modifie pas le moteur d'autrui.
 */
export async function updateEngine(userId: string, id: string, input: EngineInput): Promise<DecisionEngine> {
  const sets: string[] = []
  const values: unknown[] = [id, userId]
  const push = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`) }

  if (input.name !== undefined) push('name', cleanName(input.name))
  if (input.kind !== undefined) {
    if (!isEngineKind(input.kind)) throw new InvalidEngineError('kind', 'type de moteur inconnu')
    push('kind', input.kind)
  }
  if (input.url !== undefined) push('url', cleanUrl(input.url))
  if (input.model !== undefined) push('model', cleanModel(input.model))
  if (input.usdPerBillionInput !== undefined) push('usd_per_billion_input', cleanPrice(input.usdPerBillionInput))
  if (typeof input.apiKey === 'string') push('key_encrypted', input.apiKey.trim() ? encrypt(input.apiKey.trim()) : null)

  if (!sets.length) {
    const rows = await query<EngineRow>(`SELECT ${PUBLIC_COLUMNS} FROM decision_engines WHERE id = $1 AND user_id = $2`, [id, userId])
    if (!rows.length) throw new UnknownEngineError(id)
    return toEngine(rows[0])
  }

  const rows = await query<EngineRow>(
    `UPDATE decision_engines SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
    values
  )
  if (!rows.length) throw new UnknownEngineError(id)
  return toEngine(rows[0])
}

/**
 * Supprime un moteur. Les boîtes qui l'avaient choisi gardent leur ligne de tri : la clé
 * étrangère est `ON DELETE SET NULL`, et le trieur lit alors une boîte sans moteur — pause
 * `no_engine`, dite en clair à l'écran, plutôt qu'un tri qui échoue en silence.
 */
export async function deleteEngine(userId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>(`DELETE FROM decision_engines WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId])
  if (!rows.length) throw new UnknownEngineError(id)
}

/** Ce qu'un test rapporte : de quoi dire « la clé marche » sans rien révéler d'elle. */
export interface EngineTestResult {
  ms: number
  inputTokens: number
  model: string
}

/**
 * UNE requête minimale pour vérifier une clé avant de s'en servir (décision 13) : un état
 * factice et UNE question, pas les 41 — c'est un test de porte, pas un tri, et il se paie.
 * La question posée est la PREMIÈRE du jeu actif de l'utilisateur : aucune liste séparée à tenir
 * d'accord (un jeu sans question active pose la première question du jeu, active ou non).
 *
 * La clé se déchiffre ici et n'en sort pas : ni la réponse, ni l'erreur recopiée ne la portent.
 */
export async function testEngine(userId: string, id: string): Promise<EngineTestResult> {
  const rows = await query<{ url: string; key_encrypted: string | null; model: string }>(
    `SELECT url, key_encrypted, model FROM decision_engines WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  if (!rows.length) throw new UnknownEngineError(id)
  const row = rows[0]

  const set = await loadQuestionSet(userId)
  const first = set.enabled[0] ?? set.all[0]
  if (!first) throw new Error('aucune question définie : rien à poser au moteur')
  const started = Date.now()
  const result = await askEngine(
    { url: row.url, apiKey: row.key_encrypted ? decrypt(row.key_encrypted) : '', model: row.model },
    { expediteur: { nom: 'Test', adresse: 'test@synapmail.local' }, objet: 'test', corps: 'test' },
    [first]
  )
  return { ms: Date.now() - started, inputTokens: result.inputTokens, model: result.model }
}
