/**
 * Les groupes de questions CONDITIONNELS (lot T-Q3, décision 24.2) et le découpage d'une passe
 * (décision 24.3). Un groupe est nommé par le slug que porte déjà `tag_questions.groupe` : une
 * ligne ici donne un DÉCLENCHEUR à ce slug. Un slug sans ligne — ou une ligne sans condition —
 * est le tronc : posé à chaque mail. Les 49 questions d'origine n'ont donc aucune ligne, et rien
 * ne change tant qu'on n'en crée pas.
 *
 * Trois règles, et rien d'autre :
 *
 *  1. **Deux passes, pas plus.** Passe 1 = le tronc. Passe 2 = les groupes dont le déclencheur
 *     est vrai au vu des étiquettes DÉJÀ obtenues (règles + passe 1) et des champs du mail —
 *     UNE requête de plus, seulement pour ces mails. Un déclencheur ne voit jamais la réponse
 *     d'un autre groupe conditionnel.
 *  2. **Le déclencheur est une condition de règle** : même format, même `evaluateRule` que les
 *     règles de courrier et d'étiquetage, plus le champ `tag` (`tagQuestion` = la question,
 *     `value` = la valeur, `equals` / `not_equals`) — le contrat de la lane webhooks.
 *  3. **Jamais de 400 `max_tokens_exceeded`** : le jeu d'une passe est coupé en requêtes dont
 *     le corps `questions` estimé tient sous `PASS_TOKEN_BUDGET`, à partir de sa taille
 *     sérialisée — le seul chiffre connu AVANT d'appeler.
 */
import { query } from '../db'
import { evaluateRule, type RuleTag } from '../rulesEval'
import type { ConditionLogic, RuleCondition, RuleField } from '@/types/rule'
import { SLUG_RE, engineBodyFor, type QuestionSet, type TagQuestion } from './questions'
import { RULE_FIELDS, messageForRules, validateCondition, type MailForRules } from './tagRules'

/**
 * Le budget de jetons d'UNE requête, pour le corps `questions` seul. 24 000 laisse au mail
 * (`STATE_BODY_CHARS`, ~500 jetons) et à la réponse la marge sous le plafond de ~32 000 mesuré
 * sur JEV (GOAL.md, décision 24).
 */
export const PASS_TOKEN_BUDGET = 24_000

/**
 * Caractères par jeton, pour estimer un corps AVANT de l'envoyer. Relevé sur le gate T10b : le
 * jeu de 49 questions sérialisé pèse 19 994 caractères, et un mail a coûté 7 200 jetons
 * d'entrée en moyenne, mail compris (~1 500 caractères d'état) → 21 500 / 7 200 ≈ 3,0. Une
 * valeur BASSE surestime les jetons : la coupe tombe plus tôt, jamais trop tard.
 */
export const CHARS_PER_TOKEN = 3

export interface TagQuestionGroup {
  /** Le slug, celui de `tag_questions.groupe`. */
  id: string
  name: string
  position: number
  conditionLogic: ConditionLogic
  /** Vide = tronc (`toujours`). */
  conditions: RuleCondition[]
  createdAt: string
  updatedAt: string
}

export const isTrunkGroup = (g: Pick<TagQuestionGroup, 'conditions'>): boolean => g.conditions.length === 0

/** Un refus de validation : la route en fait un 400 qui nomme le champ. */
export class InvalidGroupError extends Error {
  field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'InvalidGroupError'
    this.field = field
  }
}

/** Un groupe absent chez cet utilisateur : la route en fait un 404. */
export class UnknownGroupError extends Error {
  id: string
  constructor(id: string) {
    super(`groupe inconnu: ${id}`)
    this.name = 'UnknownGroupError'
    this.id = id
  }
}

/** Un slug déjà pris chez cet utilisateur : la route en fait un 409. */
export class DuplicateGroupError extends Error {
  id: string
  constructor(id: string) {
    super(`groupe déjà défini: ${id}`)
    this.name = 'DuplicateGroupError'
    this.id = id
  }
}

interface Row {
  id: string
  name: string
  position: number
  condition_logic: ConditionLogic
  conditions: RuleCondition[]
  created_at: Date
  updated_at: Date
}

const COLUMNS = 'id, name, position, condition_logic, conditions, created_at, updated_at'

const toGroup = (r: Row): TagQuestionGroup => ({
  id: r.id, name: r.name, position: r.position, conditionLogic: r.condition_logic, conditions: r.conditions ?? [],
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

export async function listGroups(userId: string): Promise<TagQuestionGroup[]> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM tag_question_groups WHERE user_id = $1 ORDER BY position, id`, [userId])
  return rows.map(toGroup)
}

/** Les groupes qui s'appliquent à une boîte : ceux de son PROPRIÉTAIRE, comme les questions. */
export async function groupsForAccount(accountId: string): Promise<TagQuestionGroup[]> {
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM tag_question_groups
      WHERE user_id = (SELECT user_id FROM email_accounts WHERE id = $1)
      ORDER BY position, id`,
    [accountId]
  )
  return rows.map(toGroup)
}

export interface GroupInput {
  id?: unknown
  name?: unknown
  position?: unknown
  conditionLogic?: unknown
  conditions?: unknown
}

const LOGICS: readonly ConditionLogic[] = ['all', 'any']
/** Les champs d'un déclencheur : ceux d'une règle, plus l'étiquette déjà obtenue. */
export const GROUP_FIELDS: readonly RuleField[] = [...RULE_FIELDS, 'tag']
const TAG_OPERATORS = ['equals', 'not_equals']

const fail = (field: string, message: string): never => { throw new InvalidGroupError(field, message) }

function validateTrigger(c: unknown, field: string, set: QuestionSet): RuleCondition {
  const out = validateCondition(c, field, fail, GROUP_FIELDS)
  if (out.field !== 'tag') return out
  if (!TAG_OPERATORS.includes(out.operator)) fail(`${field}.operator`, `${field}.operator: le champ tag admet ${TAG_OPERATORS.join(' / ')}`)
  const tagQuestion = out.tagQuestion ?? ''
  if (!set.questionById(tagQuestion)) fail(`${field}.tagQuestion`, `${field}.tagQuestion: question inconnue ${JSON.stringify(out.tagQuestion)}`)
  if (!set.isValidTag(tagQuestion, out.value)) fail(`${field}.value`, `${field}.value: valeur hors liste pour ${out.tagQuestion}: ${JSON.stringify(out.value)}`)
  return out
}

/** Le contrat d'un groupe COMPLET, contre le jeu de questions de l'utilisateur. */
export function validateGroup(input: GroupInput, set: QuestionSet): Omit<TagQuestionGroup, 'createdAt' | 'updatedAt'> {
  const id = typeof input.id === 'string' && SLUG_RE.test(input.id) ? input.id : fail('id', `id: identifiant attendu [a-z0-9_]{2,40}, reçu ${JSON.stringify(input.id)}`)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id
  if (typeof input.name !== 'string' && input.name !== undefined && input.name !== null) fail('name', 'name: chaîne attendue')
  const position = input.position === undefined ? 0 : Number(input.position)
  if (!Number.isInteger(position)) fail('position', 'position: entier attendu')
  const conditionLogic = (input.conditionLogic ?? 'all') as ConditionLogic
  if (!LOGICS.includes(conditionLogic)) fail('conditionLogic', `conditionLogic: l'un de ${LOGICS.join(', ')}`)
  if (input.conditions !== undefined && !Array.isArray(input.conditions)) fail('conditions', 'conditions: liste attendue (vide = toujours)')
  const conditions = ((input.conditions as unknown[] | undefined) ?? []).map((c, i) => validateTrigger(c, `conditions[${i}]`, set))
  return { id, name, position, conditionLogic, conditions }
}

export async function createGroup(userId: string, input: GroupInput, set: QuestionSet): Promise<TagQuestionGroup> {
  const g = validateGroup(input, set)
  const rows = await query<Row>(
    `INSERT INTO tag_question_groups (user_id, id, name, position, condition_logic, conditions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (user_id, id) DO NOTHING RETURNING ${COLUMNS}`,
    [userId, g.id, g.name, g.position, g.conditionLogic, JSON.stringify(g.conditions)]
  )
  if (!rows.length) throw new DuplicateGroupError(g.id)
  return toGroup(rows[0])
}

/** Le corps est FUSIONNÉ avec la ligne puis revalidé en entier. Le slug ne change pas : c'est la clé des questions. */
export async function updateGroup(userId: string, id: string, input: GroupInput, set: QuestionSet): Promise<TagQuestionGroup> {
  const [current] = await query<Row>(`SELECT ${COLUMNS} FROM tag_question_groups WHERE user_id = $1 AND id = $2`, [userId, id])
  if (!current) throw new UnknownGroupError(id)
  const was = toGroup(current)
  const g = validateGroup({
    id, name: input.name ?? was.name, position: input.position ?? was.position,
    conditionLogic: input.conditionLogic ?? was.conditionLogic, conditions: input.conditions ?? was.conditions,
  }, set)
  const [row] = await query<Row>(
    `UPDATE tag_question_groups SET name = $3, position = $4, condition_logic = $5, conditions = $6::jsonb, updated_at = NOW()
      WHERE user_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [userId, id, g.name, g.position, g.conditionLogic, JSON.stringify(g.conditions)]
  )
  return toGroup(row)
}

/** Retire le déclencheur : les questions du slug redeviennent du tronc, aucune n'est touchée. */
export async function deleteGroup(userId: string, id: string): Promise<void> {
  const deleted = await query<{ id: string }>(`DELETE FROM tag_question_groups WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id])
  if (!deleted.length) throw new UnknownGroupError(id)
}

/** Ce qu'une passe pose : le tronc, et chaque groupe conditionnel avec ses questions ACTIVES. */
export interface PassPlan {
  trunk: TagQuestion[]
  conditional: Array<{ group: TagQuestionGroup; questions: TagQuestion[] }>
}

/**
 * Répartit le jeu actif entre le tronc et les groupes conditionnels. Un groupe sans question
 * active n'apparaît pas : il ne coûterait rien et ne se déclencherait pour rien.
 */
export function planPasses(set: QuestionSet, groups: readonly TagQuestionGroup[]): PassPlan {
  const conditional = groups
    .filter(g => !isTrunkGroup(g))
    .map(group => ({ group, questions: set.enabled.filter(q => q.group === group.id) }))
    .filter(g => g.questions.length > 0)
  const moved = new Set(conditional.map(g => g.group.id))
  return { trunk: set.enabled.filter(q => !moved.has(q.group)), conditional }
}

/** Le déclencheur d'un groupe, au vu du mail et des étiquettes DÉJÀ obtenues. */
export const triggered = (group: TagQuestionGroup, mail: MailForRules, held: readonly RuleTag[]): boolean =>
  evaluateRule(messageForRules(mail), { enabled: true, conditions: group.conditions, conditionLogic: group.conditionLogic }, held)

/** Les questions de la passe 2 pour ce mail, dans l'ordre des groupes. */
export function triggeredQuestions(plan: PassPlan, mail: MailForRules, held: readonly RuleTag[]): TagQuestion[] {
  return plan.conditional.filter(g => triggered(g.group, mail, held)).flatMap(g => g.questions)
}

/** Les jetons qu'un corps `questions` occupera, estimés de sa taille sérialisée. */
export const estimateTokens = (questions: readonly TagQuestion[]): number =>
  Math.ceil(JSON.stringify(engineBodyFor(questions)).length / CHARS_PER_TOKEN)

/**
 * Coupe une liste de questions en requêtes qui tiennent chacune sous `budget`. Une question
 * qui dépasse à elle seule part seule : on ne coupe pas une question. Une liste vide ne fait
 * aucune requête.
 */
export function chunkByBudget(questions: readonly TagQuestion[], budget = PASS_TOKEN_BUDGET): TagQuestion[][] {
  const chunks: TagQuestion[][] = []
  let current: TagQuestion[] = []
  let size = 0
  for (const q of questions) {
    const own = estimateTokens([q])
    if (current.length && size + own > budget) { chunks.push(current); current = []; size = 0 }
    current.push(q)
    size += own
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** Les comptes d'étiquettes EFFECTIVES par question puis valeur, tels que `tagDistribution` les rend. */
export type Distribution = ReadonlyArray<{ question: string; values: ReadonlyArray<{ valeur: string; count: number }> }>

/**
 * La part des mails qui déclencheraient ce groupe, lue dans la répartition d'un échantillon
 * (lot T10b). `null` quand une étiquette du déclencheur n'a encore aucune réponse.
 *
 * ponytail: les conditions sont supposées INDÉPENDANTES (produit pour `all`, complément du
 * produit pour `any`) et une condition sur un champ du mail compte pour 1 — la répartition ne
 * garde que des marges par question, pas les mails. C'est une borne haute lisible, pas une
 * probabilité jointe ; le jour où il la faut, il faut relire les mails de l'échantillon.
 */
export function triggerRate(group: TagQuestionGroup, distribution: Distribution): number | null {
  const ps: number[] = []
  for (const c of group.conditions) {
    if (c.field !== 'tag') { ps.push(1); continue }
    const q = distribution.find(d => d.question === c.tagQuestion)
    const total = q?.values.reduce((n, v) => n + v.count, 0) ?? 0
    if (!total) return null
    const p = (q!.values.find(v => v.valeur === c.value)?.count ?? 0) / total
    ps.push(c.operator === 'not_equals' ? 1 - p : p)
  }
  if (group.conditionLogic === 'all') return ps.reduce((a, b) => a * b, 1)
  return 1 - ps.reduce((a, b) => a * (1 - b), 1)
}
