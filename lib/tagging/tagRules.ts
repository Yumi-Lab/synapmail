/**
 * Les règles d'étiquetage SANS moteur (lot T-Q2, décision 24.1) : « si le mail vérifie ces
 * conditions, pose ces étiquettes ». Une règle est à l'utilisateur, pour toutes ses boîtes
 * (`account_id` NULL) ou pour une seule.
 *
 * Trois règles, et rien d'autre :
 *
 *  1. **Les conditions sont celles des règles de courrier** : même format que
 *     `email_rules.conditions`, évaluées par `evalCondition` de `lib/rulesEval.ts` (la fonction
 *     que `lib/rules.ts` utilise pour le courrier) — pas une copie.
 *     Ce que la lane webhooks ajoutera à cette fonction sera disponible ici sans rien écrire.
 *  2. **Une règle ne pose jamais une valeur hors liste** : chaque `{question, valeur}` passe
 *     `QuestionSet.isValidTag` à l'écriture de la règle ET à son application (le jeu a pu changer
 *     entre les deux — une valeur devenue étrangère est ignorée, pas inventée).
 *  3. **« La règle fait foi »** (`authoritative`) : la question qu'elle a tranchée n'est PAS posée
 *     au moteur pour ce mail. Sans cette option, le moteur répond aussi et l'effective reste la
 *     plus récente (décision 5) — la règle sert alors d'avis, pas de verdict.
 */
import { query } from '../db'
import { REGEX_OPERATORS, compileRulePattern, evaluateRule } from '../rulesEval'
import type { Message } from '@/types/email'
import type { ConditionLogic, RuleCondition, RuleField, RuleOperator } from '@/types/rule'
import type { MailForState } from './engine'
import { isRuleQuestionId, type QuestionSet, type TagQuestion } from './questions'
import type { TagToWrite } from './store'

export interface TagRuleAction {
  question: string
  valeur: string
}

export interface TagRule {
  id: string
  accountId: string | null
  name: string
  enabled: boolean
  priority: number
  conditionLogic: ConditionLogic
  conditions: RuleCondition[]
  actions: TagRuleAction[]
  /** Les questions tranchées ne sont pas posées au moteur pour ce mail. */
  authoritative: boolean
  createdAt: string
  updatedAt: string
}

/** Un refus de validation : la route en fait un 400 qui nomme le champ. */
export class InvalidTagRuleError extends Error {
  field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'InvalidTagRuleError'
    this.field = field
  }
}

/** Une règle absente chez cet utilisateur : la route en fait un 404. */
export class UnknownTagRuleError extends Error {
  id: string
  constructor(id: string) {
    super(`règle inconnue: ${id}`)
    this.name = 'UnknownTagRuleError'
    this.id = id
  }
}

interface Row {
  id: string
  account_id: string | null
  name: string
  enabled: boolean
  priority: number
  condition_logic: ConditionLogic
  conditions: RuleCondition[]
  actions: TagRuleAction[]
  authoritative: boolean
  created_at: Date
  updated_at: Date
}

const COLUMNS = 'id, account_id, name, enabled, priority, condition_logic, conditions, actions, authoritative, created_at, updated_at'

const toRule = (r: Row): TagRule => ({
  id: r.id, accountId: r.account_id, name: r.name, enabled: r.enabled, priority: r.priority,
  conditionLogic: r.condition_logic, conditions: r.conditions ?? [], actions: r.actions ?? [],
  authoritative: r.authoritative, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
})

/** Les règles de l'utilisateur, dans l'ordre d'application. */
export async function listTagRules(userId: string): Promise<TagRule[]> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM tag_rules WHERE user_id = $1 ORDER BY priority, created_at`, [userId])
  return rows.map(toRule)
}

/**
 * Les règles ACTIVES qui s'appliquent à une boîte : celles du propriétaire, sans boîte ou pour
 * celle-ci. Comme les questions, une boîte répond aux règles de son PROPRIÉTAIRE.
 */
export async function rulesForAccount(accountId: string): Promise<TagRule[]> {
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM tag_rules
      WHERE enabled AND (account_id = $1 OR (account_id IS NULL AND user_id = (SELECT user_id FROM email_accounts WHERE id = $1)))
      ORDER BY priority, created_at`,
    [accountId]
  )
  return rows.map(toRule)
}

/** Ce qu'une création ou une modification peut porter. Tout est optionnel en PATCH. */
export interface TagRuleInput {
  accountId?: unknown
  name?: unknown
  enabled?: unknown
  priority?: unknown
  conditionLogic?: unknown
  conditions?: unknown
  actions?: unknown
  authoritative?: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const LOGICS: readonly ConditionLogic[] = ['all', 'any']
export const RULE_FIELDS: readonly RuleField[] = ['from', 'to', 'cc', 'subject', 'body', 'has_attachments', 'list_unsubscribe', 'size', 'date_received', 'priority', 'header', 'texte_ocr']
export const RULE_OPERATORS: readonly RuleOperator[] = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'is_true', 'is_false', 'greater_than', 'less_than', 'before', 'after', 'matches', 'not_matches']

/**
 * UNE condition, sous le contrat des règles de courrier. Partagée avec les groupes de questions
 * (`questionGroups.ts`), qui admettent en plus le champ `tag` : `fields` dit lesquels sont
 * permis ici, `fail` fabrique le refus de l'appelant (chacun a sa classe d'erreur).
 */
export function validateCondition(
  c: unknown, field: string, fail: (field: string, message: string) => never, fields: readonly RuleField[] = RULE_FIELDS
): RuleCondition {
  if (!isRecord(c)) fail(field, `${field}: une condition est un objet {field, operator, value}`)
  if (!fields.includes(c.field as RuleField)) fail(`${field}.field`, `${field}.field: champ inconnu ${JSON.stringify(c.field)}`)
  if (!RULE_OPERATORS.includes(c.operator as RuleOperator)) fail(`${field}.operator`, `${field}.operator: opérateur inconnu ${JSON.stringify(c.operator)}`)
  if (c.value !== undefined && c.value !== null && typeof c.value !== 'string') fail(`${field}.value`, `${field}.value: chaîne attendue`)
  if (REGEX_OPERATORS.has(c.operator as string) && !compileRulePattern(c.value as string)) fail(`${field}.value`, `${field}.value: motif invalide ou trop long`)
  const out: RuleCondition = { id: typeof c.id === 'string' && c.id ? c.id : `${field}`, field: c.field as RuleField, operator: c.operator as RuleOperator, value: (c.value as string | undefined) ?? '' }
  if (typeof c.headerName === 'string' && c.headerName) out.headerName = c.headerName
  if (typeof c.tagQuestion === 'string' && c.tagQuestion) out.tagQuestion = c.tagQuestion
  return out
}

const failRule = (field: string, message: string): never => { throw new InvalidTagRuleError(field, message) }

function validateAction(a: unknown, field: string, set: QuestionSet): TagRuleAction {
  if (!isRecord(a)) throw new InvalidTagRuleError(field, `${field}: une action est un objet {question, valeur}`)
  if (typeof a.question !== 'string' || !set.questionById(a.question) || isRuleQuestionId(a.question)) throw new InvalidTagRuleError(`${field}.question`, `${field}.question: question inconnue ou réservée ${JSON.stringify(a.question)}`)
  if (!set.isValidTag(a.question, a.valeur)) throw new InvalidTagRuleError(`${field}.valeur`, `${field}.valeur: valeur hors liste pour ${a.question}: ${JSON.stringify(a.valeur)}`)
  return { question: a.question, valeur: a.valeur as string }
}

/**
 * Le contrat d'une règle COMPLÈTE, contre le jeu de questions de l'utilisateur. Jette
 * `InvalidTagRuleError` en nommant le champ ; rend la règle normalisée.
 */
export function validateTagRule(input: TagRuleInput, set: QuestionSet): Omit<TagRule, 'id' | 'createdAt' | 'updatedAt'> {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new InvalidTagRuleError('name', 'name: nom vide')
  if (input.accountId !== undefined && input.accountId !== null && typeof input.accountId !== 'string') throw new InvalidTagRuleError('accountId', 'accountId: identifiant de boîte ou null attendu')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new InvalidTagRuleError('enabled', 'enabled: booléen attendu')
  if (input.authoritative !== undefined && typeof input.authoritative !== 'boolean') throw new InvalidTagRuleError('authoritative', 'authoritative: booléen attendu')
  const priority = input.priority === undefined ? 0 : Number(input.priority)
  if (!Number.isInteger(priority)) throw new InvalidTagRuleError('priority', 'priority: entier attendu')
  const conditionLogic = (input.conditionLogic ?? 'all') as ConditionLogic
  if (!LOGICS.includes(conditionLogic)) throw new InvalidTagRuleError('conditionLogic', `conditionLogic: l'un de ${LOGICS.join(', ')}`)
  if (!Array.isArray(input.conditions) || !input.conditions.length) throw new InvalidTagRuleError('conditions', 'conditions: au moins une condition')
  if (!Array.isArray(input.actions) || !input.actions.length) throw new InvalidTagRuleError('actions', 'actions: au moins une étiquette à poser')
  const actions = input.actions.map((a, i) => validateAction(a, `actions[${i}]`, set))
  if (new Set(actions.map(a => a.question)).size !== actions.length) throw new InvalidTagRuleError('actions', 'actions: deux actions portent la même question')
  return {
    accountId: (input.accountId as string | null | undefined) ?? null,
    name: input.name.trim(), enabled: (input.enabled as boolean | undefined) ?? true, priority, conditionLogic,
    conditions: input.conditions.map((c, i) => validateCondition(c, `conditions[${i}]`, failRule)),
    actions, authoritative: (input.authoritative as boolean | undefined) ?? false,
  }
}

/** Une boîte nommée par une règle doit être à l'utilisateur : sinon 400 sur `accountId`. */
async function assertOwnsAccount(userId: string, accountId: string | null): Promise<void> {
  if (accountId === null) return
  const [row] = await query<{ id: string }>(`SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2`, [accountId, userId])
  if (!row) throw new InvalidTagRuleError('accountId', `accountId: boîte inconnue ${accountId}`)
}

export async function createTagRule(userId: string, input: TagRuleInput, set: QuestionSet): Promise<TagRule> {
  const r = validateTagRule(input, set)
  await assertOwnsAccount(userId, r.accountId)
  const [row] = await query<Row>(
    `INSERT INTO tag_rules (user_id, account_id, name, enabled, priority, condition_logic, conditions, actions, authoritative)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) RETURNING ${COLUMNS}`,
    [userId, r.accountId, r.name, r.enabled, r.priority, r.conditionLogic, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.authoritative]
  )
  return toRule(row)
}

/** Le corps est FUSIONNÉ avec la ligne puis revalidé en entier : un PATCH partiel ne laisse rien d'incohérent. */
export async function updateTagRule(userId: string, id: string, input: TagRuleInput, set: QuestionSet): Promise<TagRule> {
  const [current] = await query<Row>(`SELECT ${COLUMNS} FROM tag_rules WHERE user_id = $1 AND id = $2`, [userId, id])
  if (!current) throw new UnknownTagRuleError(id)
  const was = toRule(current)
  const r = validateTagRule({
    accountId: input.accountId === undefined ? was.accountId : input.accountId,
    name: input.name ?? was.name, enabled: input.enabled ?? was.enabled, priority: input.priority ?? was.priority,
    conditionLogic: input.conditionLogic ?? was.conditionLogic, conditions: input.conditions ?? was.conditions,
    actions: input.actions ?? was.actions, authoritative: input.authoritative ?? was.authoritative,
  }, set)
  await assertOwnsAccount(userId, r.accountId)
  const [row] = await query<Row>(
    `UPDATE tag_rules SET account_id = $3, name = $4, enabled = $5, priority = $6, condition_logic = $7,
            conditions = $8::jsonb, actions = $9::jsonb, authoritative = $10, updated_at = NOW()
      WHERE user_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [userId, id, r.accountId, r.name, r.enabled, r.priority, r.conditionLogic, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.authoritative]
  )
  return toRule(row)
}

export async function deleteTagRule(userId: string, id: string): Promise<void> {
  const deleted = await query<{ id: string }>(`DELETE FROM tag_rules WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, id])
  if (!deleted.length) throw new UnknownTagRuleError(id)
}

/** Ce que le trieur connaît d'un mail, en plus de l'état du moteur : de quoi évaluer `date_received` et `has_attachments`. */
export interface MailForRules extends MailForState {
  date?: Date | string | null
  hasAttachments?: boolean
  size?: number
}

/**
 * Le mail du trieur sous la forme que `evalCondition` lit. Ce que la source ne rend pas
 * (`to`, `cc`, `list_unsubscribe`, `priority`) est vide : une condition sur ces champs ne
 * matche pas, elle n'invente rien.
 */
export function messageForRules(m: MailForRules): Message {
  return {
    uid: '', messageId: '', folder: '', accountId: '',
    from: { name: m.fromName ?? '', address: m.fromAddress ?? '' }, to: [], subject: m.subject ?? '',
    date: m.date ? new Date(m.date).toISOString() : '', preview: '', isRead: false, isStarred: false, isFlagged: false,
    hasAttachments: m.hasAttachments === true, bodyPlain: m.bodyPlain, bodyHtml: m.bodyHtml,
    ...(m.size !== undefined ? { size: m.size } : {}),
    ...(m.ocrText !== undefined ? { ocrText: m.ocrText } : {}),
  }
}

/**
 * Ce que les règles décident pour UN mail : les étiquettes à écrire (source `regle`, une par
 * question — la première règle par priorité l'emporte) et les questions qu'il ne faut PLUS
 * poser au moteur (celles tranchées par une règle qui fait foi). Une action dont la valeur n'est
 * plus dans le jeu est ignorée : la porte d'entrée reste `isValidTag`, comme pour un moteur.
 */
export function applyTagRules(rules: readonly TagRule[], mail: MailForRules, set: QuestionSet): {
  tags: (TagToWrite & { rule: TagRule })[]; settled: Set<string>
} {
  const msg = messageForRules(mail)
  const tags: (TagToWrite & { rule: TagRule })[] = []
  const settled = new Set<string>()
  const taken = new Set<string>()
  for (const rule of rules) {
    if (!evaluateRule(msg, rule)) continue
    for (const a of rule.actions) {
      if (taken.has(a.question) || !set.isValidTag(a.question, a.valeur)) continue
      taken.add(a.question)
      tags.push({ question: a.question, valeur: a.valeur, rule })
      if (rule.authoritative) settled.add(a.question)
    }
  }
  return { tags, settled }
}

/** Les questions à poser au moteur une fois les règles passées : le jeu actif, moins les tranchées. */
export const remainingQuestions = (posed: readonly TagQuestion[], settled: ReadonlySet<string>): TagQuestion[] =>
  posed.filter(q => !settled.has(q.id))
