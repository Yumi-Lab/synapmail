/**
 * Un bot écrit le motif d'une condition regex, le serveur l'exécute : les trois bornes
 * ci-dessous sont ce qui tient un `(a+)+$` à distance d'une boucle d'évaluation. Elles
 * vivent ICI, dans un module sans dépendance, parce que les DEUX côtés les lisent :
 * l'éditeur de règles borne sa saisie, le moteur borne ce qu'il compile et confronte.
 *
 * ponytail: le moteur regex de V8 revient en arrière, un motif pathologique reste
 * quadratique DANS ces bornes (200 car. de motif sur 10 000 car. de texte). Le plafond est
 * donc le temps que coûtent 200x10 000, pas zéro. Chemin de sortie si une mesure le
 * réclame : un moteur sans retour arrière (RE2), c'est-à-dire une dépendance nouvelle,
 * interdite ici tant que rien ne l'a mesurée.
 */
export const REGEX_PATTERN_MAX = 200
/** Objet, adresses : le texte confronté au motif est tronqué là. */
export const REGEX_TEXT_MAX = 1000
/** Corps : plus long, mais borné lui aussi. */
export const REGEX_BODY_MAX = 10000

export type RuleField =
  | 'from'
  | 'to'
  | 'cc'
  | 'subject'
  | 'body'
  | 'has_attachments'
  | 'list_unsubscribe'
  | 'size'
  | 'date_received'
  | 'priority'
  | 'header'
  | 'tag'

export type RuleOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'ends_with'
  | 'is_true'
  | 'is_false'
  | 'greater_than'
  | 'less_than'
  | 'before'
  | 'after'
  | 'matches'
  | 'not_matches'

export type RuleActionType =
  | 'move'
  | 'mark_read'
  | 'mark_unread'
  | 'mark_starred'
  | 'mark_unstarred'
  | 'delete'
  | 'forward'
  | 'webhook'

export type ConditionLogic = 'all' | 'any'

export interface RuleCondition {
  id: string
  field: RuleField
  operator: RuleOperator
  value: string
  headerName?: string  // for 'header' field
  /** Pour le champ 'tag' : l'identifiant de la question (lib/tagging/questions.ts). */
  tagQuestion?: string
}

export interface RuleAction {
  id: string
  type: RuleActionType
  value?: string
}

export interface RuleStats {
  lastRunAt: string | null
  totalProcessed: number
  totalMatched: number
}

export interface EmailRule {
  id: string
  userId: string
  accountId: string
  name: string
  enabled: boolean
  priority: number
  conditionLogic: ConditionLogic
  conditions: RuleCondition[]
  actions: RuleAction[]
  stopProcessing: boolean
  createdAt: string
  updatedAt: string
  // Stats (populated from DB)
  lastRunAt?: string | null
  totalProcessed?: number
  totalMatched?: number
}

// Template for quick rule creation
export interface RuleTemplate {
  id: string
  name: string
  description: string
  icon: string
  conditionLogic: ConditionLogic
  conditions: Omit<RuleCondition, 'id'>[]
  actions: Omit<RuleAction, 'id'>[]
}
