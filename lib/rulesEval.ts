/**
 * L'évaluation des conditions d'une règle — PURE, sans IMAP ni SMTP, pour que les règles
 * d'étiquetage (`lib/tagging/tagRules.ts`, décision 24.1) et leur banc l'importent sans
 * charger les exécuteurs d'actions. `lib/rules.ts` la ré-exporte : une seule définition.
 */
import type { Message } from '@/types/email'
import type { EmailRule, RuleCondition } from '@/types/rule'

/** Une étiquette telle qu'une condition `tag` la lit : la question et sa valeur, rien d'autre. */
export interface RuleTag { question: string; valeur: string }

const NO_TAGS: readonly RuleTag[] = []

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/**
 * UNE condition sur UN message. Exportée pour les règles d'étiquetage (`lib/tagging/tagRules.ts`,
 * décision 24.1) : elles s'évaluent avec CETTE fonction, jamais une copie.
 */
export function evalCondition(msg: Message, cond: RuleCondition, tags: readonly RuleTag[] = NO_TAGS): boolean {
  // Étiquette : la valeur résolue en amont et passée telle quelle — `evalCondition` reste
  // synchrone et pure, elle ne lit pas la base. Même contrat que la lane webhooks.
  if (cond.field === 'tag') {
    const held = tags.some(t => t.question === cond.tagQuestion && t.valeur === cond.value)
    if (cond.operator === 'equals')     return held
    if (cond.operator === 'not_equals') return !held
    return false
  }

  // Boolean fields
  if (cond.field === 'has_attachments') {
    if (cond.operator === 'is_true')  return msg.hasAttachments === true
    if (cond.operator === 'is_false') return msg.hasAttachments !== true
    return false
  }

  // Document GED (décision 6) : « porte un texte OCR » suffit à déclencher le groupe de
  // questions GED ; le lot G4 y ajoute la recherche d'un motif (`matches`).
  if (cond.field === 'texte_ocr') {
    if (cond.operator === 'is_true')  return !!msg.ocrText
    if (cond.operator === 'is_false') return !msg.ocrText
    return false
  }

  if (cond.field === 'list_unsubscribe') {
    if (cond.operator === 'is_true')  return !!msg.listUnsubscribe
    if (cond.operator === 'is_false') return !msg.listUnsubscribe
    return false
  }

  // Numeric: size (in KB for readability, stored in bytes in message)
  if (cond.field === 'size') {
    const sizeKb = (msg.size ?? 0) / 1024
    const threshold = parseFloat(cond.value) || 0
    if (cond.operator === 'greater_than') return sizeKb > threshold
    if (cond.operator === 'less_than')    return sizeKb < threshold
    return false
  }

  // Numeric: priority (X-Priority header, 1=highest … 5=lowest)
  if (cond.field === 'priority') {
    const prio = msg.xPriority ?? 3
    const threshold = parseInt(cond.value, 10) || 3
    if (cond.operator === 'equals')        return prio === threshold
    if (cond.operator === 'greater_than')  return prio > threshold   // lower number = higher importance
    if (cond.operator === 'less_than')     return prio < threshold
    return false
  }

  // Date
  if (cond.field === 'date_received') {
    const msgDate = new Date(msg.date).getTime()
    const condDate = new Date(cond.value).getTime()
    if (isNaN(msgDate) || isNaN(condDate)) return false
    if (cond.operator === 'before') return msgDate < condDate
    if (cond.operator === 'after')  return msgDate > condDate
    return false
  }

  // Text fields
  let fieldVal = ''
  switch (cond.field) {
    case 'from':    fieldVal = `${msg.from.name ?? ''} ${msg.from.address ?? ''}`.toLowerCase(); break
    case 'to':      fieldVal = (msg.to ?? []).map(a => `${a.name ?? ''} ${a.address ?? ''}`).join(' ').toLowerCase(); break
    case 'cc':      fieldVal = (msg.cc ?? []).map(a => `${a.name ?? ''} ${a.address ?? ''}`).join(' ').toLowerCase(); break
    case 'subject': fieldVal = (msg.subject ?? '').toLowerCase(); break
    case 'body':    fieldVal = (msg.bodyPlain ?? msg.bodyHtml ?? msg.preview ?? '').toLowerCase(); break
    case 'header':  return false  // would need raw headers
    default:        return false
  }

  const condVal = (cond.value ?? '').toLowerCase()
  switch (cond.operator) {
    case 'contains':     return fieldVal.includes(condVal)
    case 'not_contains': return !fieldVal.includes(condVal)
    case 'equals':       return fieldVal === condVal
    case 'not_equals':   return fieldVal !== condVal
    case 'starts_with':  return fieldVal.startsWith(condVal)
    case 'ends_with':    return fieldVal.endsWith(condVal)
    default:             return false
  }
}

export function evaluateRule(msg: Message, rule: Pick<EmailRule, 'enabled' | 'conditions' | 'conditionLogic'>, tags: readonly RuleTag[] = NO_TAGS): boolean {
  if (!rule.enabled || !rule.conditions.length) return false
  if (rule.conditionLogic === 'all') return rule.conditions.every(c => evalCondition(msg, c, tags))
  return rule.conditions.some(c => evalCondition(msg, c, tags))
}

export function testRule(messages: Message[], rule: EmailRule): Message[] {
  return messages.filter(msg => evaluateRule(msg, rule))
}
