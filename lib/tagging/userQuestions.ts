/**
 * Les questions de tri d'UN utilisateur (lot T-Q, décision 22) : la table `tag_questions` est
 * la source unique, `questions.ts` n'en est que le défaut.
 *
 * Trois règles, et rien d'autre :
 *
 *  1. **Un utilisateur sans ligne reçoit le jeu par défaut**, inséré une fois, au premier
 *     `loadQuestionSet` (`ON CONFLICT DO NOTHING` : deux lectures concurrentes n'écrivent pas
 *     deux fois). Ensuite la base commande, y compris un jeu vidé à la main.
 *  2. **Rien n'entre sans passer le contrat JEV** (`validateQuestion`) : slug `[a-z0-9_]{2,40}`,
 *     `choice` = 1 à 255 options, `score` = 2 à 10 niveaux ordonnés, `noul` = pas de critères ;
 *     un id RÉSERVÉ aux détecteurs par programme est refusé en le nommant. La route en fait un
 *     400 qui NOMME le champ.
 *  3. **Changer la consigne ou les critères change la version** ; activer, déplacer ou renommer
 *     le groupe ne la change pas — les étiquettes déjà posées répondent toujours à la même
 *     question.
 */
import { query } from '../db'
import {
  CHOICE_MAX_OPTIONS, defaultQuestionColumns, GED_GROUP, RESERVED_ID_CODE, RESERVED_QUESTION_IDS, SCORE_LEVELS, SLUG_RE, engineBodyOf, questionSet,
  type QuestionSet, type QuestionType, type TagOption, type TagQuestion,
} from './questions'

const TYPES: readonly QuestionType[] = ['choice', 'score', 'noul']

/** Un refus de validation : la route en fait un 400 qui nomme le champ. */
export class InvalidQuestionError extends Error {
  field: string
  /** Un code stable quand l'écran doit TRADUIRE le refus (`reserved_id` porte aussi `id`). */
  code?: string
  id?: string
  constructor(field: string, message: string, extra?: { code: string; id: string }) {
    super(message)
    this.name = 'InvalidQuestionError'
    this.field = field
    if (extra) { this.code = extra.code; this.id = extra.id }
  }
}

/** Une question absente du jeu de l'utilisateur : la route en fait un 404. */
export class UnknownQuestionError extends Error {
  id: string
  constructor(id: string) {
    super(`question inconnue: ${id}`)
    this.name = 'UnknownQuestionError'
    this.id = id
  }
}

interface Row {
  id: string
  type: QuestionType
  instructions: string
  criteria: TagOption[] | null
  list_badge: true | string | null
  groupe: string
  enabled: boolean
  position: number
  version: number
  updated_at: Date
}

const COLUMNS = 'id, type, instructions, criteria, list_badge, groupe, enabled, position, version, updated_at'

const toQuestion = (r: Row): TagQuestion => ({
  id: r.id, type: r.type, instructions: r.instructions, group: r.groupe,
  ...(r.criteria ? { options: r.criteria } : {}),
  ...(r.list_badge !== null && r.list_badge !== undefined ? { listBadge: r.list_badge } : {}),
  enabled: r.enabled, version: r.version,
})

/** Ce que le client reçoit : la question, plus la date de sa dernière modification. */
export type StoredQuestion = TagQuestion & { updatedAt: string }

const toStored = (r: Row): StoredQuestion => ({ ...toQuestion(r), updatedAt: r.updated_at.toISOString() })

/**
 * Le jeu de l'utilisateur, défauts insérés au besoin. `ORDER BY position, id` : une position
 * partagée (deux insertions concurrentes) reste déterministe.
 */
async function rows(userId: string): Promise<Row[]> {
  const found = await query<Row>(`SELECT ${COLUMNS} FROM tag_questions WHERE user_id = $1 ORDER BY position, id`, [userId])
  if (found.length) return found
  await insertDefaults(userId)
  return query<Row>(`SELECT ${COLUMNS} FROM tag_questions WHERE user_id = $1 ORDER BY position, id`, [userId])
}

async function insertDefaults(userId: string): Promise<void> {
  const d = defaultQuestionColumns()
  await query(
    `INSERT INTO tag_questions (user_id, id, type, instructions, criteria, list_badge, groupe, enabled, position, version)
     SELECT $1, q.id, q.type, q.instructions, q.criteria, q.list_badge, q.groupe, true, q.position, 1
       FROM unnest($2::text[], $3::text[], $4::text[], $5::jsonb[], $6::jsonb[], $7::text[], $8::int[])
              AS q(id, type, instructions, criteria, list_badge, groupe, position)
     ON CONFLICT (user_id, id) DO NOTHING`,
    [userId, d.ids, d.types, d.instructions, d.criteria, d.listBadges, d.groups, d.positions]
  )
  // Le déclencheur du groupe GED arrive avec les défauts : sans lui, ses questions seraient du tronc.
  await query(
    `INSERT INTO tag_question_groups (user_id, id, name, condition_logic, conditions)
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING`,
    [userId, GED_GROUP.id, GED_GROUP.name, GED_GROUP.conditionLogic, JSON.stringify(GED_GROUP.conditions)]
  )
}

/** Le jeu de l'utilisateur, prêt pour le trieur, le stockage et l'affichage. */
export async function loadQuestionSet(userId: string): Promise<QuestionSet> {
  return questionSet((await rows(userId)).map(toQuestion))
}

/** Le jeu tel que l'écran le lit : chaque question avec sa date de modification. */
export async function listQuestions(userId: string): Promise<StoredQuestion[]> {
  return (await rows(userId)).map(toStored)
}

/**
 * Le jeu d'un utilisateur DÉSIGNÉ PAR SA BOÎTE : le trieur, les routes de lecture et un délégué
 * travaillent tous sur les questions du PROPRIÉTAIRE de la boîte — les étiquettes d'une boîte
 * répondent à un seul jeu, pas à celui de chaque main qui la regarde.
 */
export async function questionSetForAccount(accountId: string): Promise<QuestionSet> {
  const [row] = await query<{ user_id: string }>(`SELECT user_id FROM email_accounts WHERE id = $1`, [accountId])
  if (!row) throw new Error(`boîte inconnue: ${accountId}`)
  return loadQuestionSet(row.user_id)
}

/** Ce qu'une création ou une modification peut porter. Tout est optionnel en PATCH. */
export interface QuestionInput {
  id?: unknown
  type?: unknown
  instructions?: unknown
  options?: unknown
  listBadge?: unknown
  group?: unknown
  enabled?: unknown
  position?: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function validateOption(o: unknown, field: string): TagOption {
  if (!isRecord(o)) throw new InvalidQuestionError(field, `${field}: une option est un objet {value, definition, notFor?, examples?}`)
  if (typeof o.value !== 'string' || !SLUG_RE.test(o.value)) throw new InvalidQuestionError(`${field}.value`, `${field}.value: identifiant attendu [a-z0-9_]{2,40}, reçu ${JSON.stringify(o.value)}`)
  if (typeof o.definition !== 'string' || !o.definition.trim()) throw new InvalidQuestionError(`${field}.definition`, `${field}.definition: définition vide`)
  if (o.notFor !== undefined && o.notFor !== null && typeof o.notFor !== 'string') throw new InvalidQuestionError(`${field}.notFor`, `${field}.notFor: chaîne attendue`)
  if (o.examples !== undefined && o.examples !== null && (!Array.isArray(o.examples) || !o.examples.every(e => typeof e === 'string'))) {
    throw new InvalidQuestionError(`${field}.examples`, `${field}.examples: liste de chaînes attendue`)
  }
  const out: TagOption = { value: o.value, definition: o.definition.trim() }
  if (typeof o.notFor === 'string' && o.notFor.trim()) out.notFor = o.notFor.trim()
  if (Array.isArray(o.examples) && o.examples.length) out.examples = o.examples.map(e => String(e).trim()).filter(Boolean)
  return out
}

/**
 * Le contrat JEV, appliqué à une question COMPLÈTE. Jette `InvalidQuestionError` en nommant le
 * champ ; rend la question normalisée (chaînes rognées, champs vides retirés).
 */
export function validateQuestion(input: QuestionInput): TagQuestion {
  if (typeof input.id !== 'string' || !SLUG_RE.test(input.id)) throw new InvalidQuestionError('id', `id: identifiant attendu [a-z0-9_]{2,40}, reçu ${JSON.stringify(input.id)}`)
  if (RESERVED_QUESTION_IDS.includes(input.id)) throw new InvalidQuestionError('id', `id: identifiant réservé ${input.id}`, { code: RESERVED_ID_CODE, id: input.id })
  if (!TYPES.includes(input.type as QuestionType)) throw new InvalidQuestionError('type', `type: l'un de ${TYPES.join(', ')}, reçu ${JSON.stringify(input.type)}`)
  const type = input.type as QuestionType
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) throw new InvalidQuestionError('instructions', 'instructions: consigne vide')
  if (input.group !== undefined && (typeof input.group !== 'string' || !SLUG_RE.test(input.group))) throw new InvalidQuestionError('group', `group: identifiant attendu [a-z0-9_]{2,40}, reçu ${JSON.stringify(input.group)}`)
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new InvalidQuestionError('enabled', 'enabled: booléen attendu')

  const q: TagQuestion = { id: input.id, type, instructions: input.instructions.trim(), group: (input.group as string | undefined) ?? 'general' }
  if (input.enabled !== undefined) q.enabled = input.enabled as boolean

  if (type === 'noul') {
    if (input.options !== undefined && input.options !== null && !(Array.isArray(input.options) && input.options.length === 0)) {
      throw new InvalidQuestionError('options', 'options: un noul ne porte pas de critères')
    }
  } else {
    if (!Array.isArray(input.options)) throw new InvalidQuestionError('options', `options: liste attendue pour un ${type}`)
    const options = input.options.map((o, i) => validateOption(o, `options[${i}]`))
    const values = new Set(options.map(o => o.value))
    if (values.size !== options.length) throw new InvalidQuestionError('options', 'options: deux options portent la même valeur')
    if (type === 'choice' && (options.length < 1 || options.length > CHOICE_MAX_OPTIONS)) {
      throw new InvalidQuestionError('options', `options: un choice compte de 1 à ${CHOICE_MAX_OPTIONS} options, reçu ${options.length}`)
    }
    if (type === 'score' && (options.length < SCORE_LEVELS.min || options.length > SCORE_LEVELS.max)) {
      throw new InvalidQuestionError('options', `options: un score compte de ${SCORE_LEVELS.min} à ${SCORE_LEVELS.max} niveaux, reçu ${options.length}`)
    }
    q.options = options
  }

  if (input.listBadge !== undefined && input.listBadge !== null && input.listBadge !== false) {
    if (input.listBadge === true) {
      if (type === 'score') throw new InvalidQuestionError('listBadge', 'listBadge: un score nomme le niveau à partir duquel la pastille apparaît')
      q.listBadge = true
    } else if (typeof input.listBadge === 'string') {
      if (type !== 'score' || !q.options!.some(o => o.value === input.listBadge)) {
        throw new InvalidQuestionError('listBadge', `listBadge: niveau inconnu ${JSON.stringify(input.listBadge)}`)
      }
      q.listBadge = input.listBadge
    } else {
      throw new InvalidQuestionError('listBadge', 'listBadge: true, un niveau de score, ou absent')
    }
  }
  return q
}

const criteriaJson = (q: TagQuestion) => (q.options ? JSON.stringify(q.options) : null)
const badgeJson = (q: TagQuestion) => (q.listBadge === undefined ? null : JSON.stringify(q.listBadge))

/** Crée une question à la fin du jeu. Un id déjà pris est un 409 (la route le rend). */
export async function createQuestion(userId: string, input: QuestionInput): Promise<StoredQuestion> {
  const q = validateQuestion(input)
  await rows(userId)
  const inserted = await query<Row>(
    `INSERT INTO tag_questions (user_id, id, type, instructions, criteria, list_badge, groupe, enabled, position, version)
     SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, COALESCE(MAX(position), -1) + 1, 1 FROM tag_questions WHERE user_id = $1
     ON CONFLICT (user_id, id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [userId, q.id, q.type, q.instructions, criteriaJson(q), badgeJson(q), q.group, q.enabled ?? true]
  )
  if (!inserted.length) throw new DuplicateQuestionError(q.id)
  return toStored(inserted[0])
}

/** Un id déjà pris par une autre question du même utilisateur : la route en fait un 409. */
export class DuplicateQuestionError extends Error {
  id: string
  constructor(id: string) {
    super(`question déjà définie: ${id}`)
    this.name = 'DuplicateQuestionError'
    this.id = id
  }
}

/**
 * Modifie une question. Le corps est FUSIONNÉ avec la ligne existante puis revalidé en entier :
 * un PATCH partiel ne peut pas laisser une question incohérente. `version` avance seulement si la
 * consigne ou les critères (le corps envoyé au moteur) ont changé — c'est ce que compare la
 * sérialisation `engineBodyOf`, la même que celle de la requête.
 */
export async function updateQuestion(userId: string, id: string, input: QuestionInput): Promise<StoredQuestion> {
  const [current] = await query<Row>(`SELECT ${COLUMNS} FROM tag_questions WHERE user_id = $1 AND id = $2`, [userId, id])
  if (!current) throw new UnknownQuestionError(id)
  if (input.id !== undefined && input.id !== id) throw new InvalidQuestionError('id', "id: l'identifiant d'une question ne se change pas")
  const was = toQuestion(current)
  const q = validateQuestion({
    id, type: input.type ?? was.type, instructions: input.instructions ?? was.instructions,
    options: input.options ?? was.options, listBadge: input.listBadge === undefined ? was.listBadge : input.listBadge,
    group: input.group ?? was.group, enabled: input.enabled ?? was.enabled,
  })
  const bumps = JSON.stringify(engineBodyOf(q)) !== JSON.stringify(engineBodyOf(was))
  const position = input.position === undefined ? current.position : Number(input.position)
  if (!Number.isInteger(position) || position < 0) throw new InvalidQuestionError('position', 'position: entier positif attendu')
  const [updated] = await query<Row>(
    `UPDATE tag_questions
        SET type = $3, instructions = $4, criteria = $5::jsonb, list_badge = $6::jsonb, groupe = $7, enabled = $8,
            position = $9, version = version + $10, updated_at = NOW()
      WHERE user_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [userId, id, q.type, q.instructions, criteriaJson(q), badgeJson(q), q.group, q.enabled ?? true, position, bumps ? 1 : 0]
  )
  return toStored(updated)
}

export async function deleteQuestion(userId: string, id: string): Promise<void> {
  const deleted = await query<{ id: string }>(`DELETE FROM tag_questions WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id])
  if (!deleted.length) throw new UnknownQuestionError(id)
}

/** Retour aux défauts de `questions.ts` : tout le jeu de l'utilisateur est remplacé. */
export async function resetQuestions(userId: string): Promise<StoredQuestion[]> {
  await query(`DELETE FROM tag_questions WHERE user_id = $1`, [userId])
  return listQuestions(userId)
}

/**
 * Combien de mails de la boîte portent, pour chaque question, une étiquette d'une AUTRE version
 * que la version courante (le hachage du corps envoyé, `questionVersion`) : c'est le « N mails
 * tagués avec une ancienne version » de l'écran. Les lignes `humain` ne comptent pas — une
 * correction reste vraie quelle que soit la définition.
 */
export async function staleCounts(accountId: string, set: QuestionSet, versionOf: (q: TagQuestion) => string): Promise<Record<string, number>> {
  const rows = await query<{ question: string; n: string }>(
    `SELECT m.question, COUNT(DISTINCT m.message_id) AS n
       FROM message_tags m
       JOIN unnest($2::text[], $3::text[]) AS v(question, version) ON v.question = m.question
      WHERE m.account_id = $1 AND m.source <> 'humain' AND m.question_version <> v.version
      GROUP BY m.question`,
    [accountId, set.all.map(q => q.id), set.all.map(versionOf)]
  )
  return Object.fromEntries(rows.map(r => [r.question, Number(r.n)]))
}
