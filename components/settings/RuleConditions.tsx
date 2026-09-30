'use client'

/**
 * L'éditeur de CONDITIONS d'une règle — celui des règles de courrier (`RulesClient`), écrit une
 * fois et RÉUTILISÉ par les règles d'étiquetage (`TagRulesSection`, décision 24.5) : un seul
 * jeu de champs, d'opérateurs et de libellés, la même ligne à l'écran. Les conditions qu'il
 * produit sont évaluées par `lib/rulesEval.ts` des deux côtés.
 */
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { RuleCondition, RuleField, RuleOperator } from '@/types/rule'

const FIELD_LABELS: Record<RuleField, string> = {
  from:            'Expéditeur',
  to:              'Destinataire',
  cc:              'CC',
  subject:         'Objet',
  body:            'Corps du message',
  has_attachments: 'Pièces jointes',
  list_unsubscribe:'Liste de diffusion',
  size:            'Taille (Ko)',
  date_received:   'Date de réception',
  priority:        'Priorité (X-Priority)',
  header:          'En-tête personnalisé',
}

const FIELD_OPERATORS: Record<RuleField, RuleOperator[]> = {
  from:            ['contains','not_contains','equals','not_equals','starts_with','ends_with'],
  to:              ['contains','not_contains','equals','not_equals'],
  cc:              ['contains','not_contains','equals','not_equals'],
  subject:         ['contains','not_contains','equals','not_equals','starts_with','ends_with'],
  body:            ['contains','not_contains'],
  has_attachments: ['is_true','is_false'],
  list_unsubscribe:['is_true','is_false'],
  size:            ['greater_than','less_than'],
  date_received:   ['before','after'],
  priority:        ['equals','less_than','greater_than'],
  header:          ['contains','not_contains','equals'],
}

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  contains:     'contient',
  not_contains: 'ne contient pas',
  equals:       'est exactement',
  not_equals:   "n'est pas",
  starts_with:  'commence par',
  ends_with:    'se termine par',
  is_true:      'est présent(e)',
  is_false:     "n'est pas présent(e)",
  greater_than: 'supérieur à',
  less_than:    'inférieur à',
  before:       'avant le',
  after:        'après le',
}

const BOOLEAN_FIELDS: RuleField[] = ['has_attachments', 'list_unsubscribe']

const uid = () => Math.random().toString(36).slice(2)

/** Une condition vide, telle qu'un « Ajouter une condition » la pose. */
export const newCondition = (): RuleCondition => ({ id: uid(), field: 'from', operator: 'contains', value: '' })

export function conditionText(c: RuleCondition): string {
  const f = FIELD_LABELS[c.field] ?? c.field
  const o = OPERATOR_LABELS[c.operator] ?? c.operator
  if (BOOLEAN_FIELDS.includes(c.field)) return `${f} ${o}`
  if (c.field === 'date_received') return `${f} ${o} ${c.value}`
  if (c.field === 'size') return `${f} ${o} ${c.value} Ko`
  return `${f} ${o} "${c.value}"`
}

export function ConditionRow({
  cond, onChange, onRemove, canRemove,
}: {
  cond: RuleCondition
  onChange: (c: RuleCondition) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const operators = FIELD_OPERATORS[cond.field] ?? []
  const isBoolean = BOOLEAN_FIELDS.includes(cond.field)
  const isDate    = cond.field === 'date_received'
  const isPriority = cond.field === 'priority'

  const handleFieldChange = (field: RuleField) => {
    const ops = FIELD_OPERATORS[field] ?? []
    onChange({ ...cond, field, operator: ops[0], value: '' })
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={cond.field}
        onChange={e => handleFieldChange(e.target.value as RuleField)}
        className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
      >
        {(Object.keys(FIELD_LABELS) as RuleField[]).map(f => (
          <option key={f} value={f}>{FIELD_LABELS[f]}</option>
        ))}
      </select>

      <select
        value={cond.operator}
        onChange={e => onChange({ ...cond, operator: e.target.value as RuleOperator })}
        className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
      >
        {operators.map(op => (
          <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
        ))}
      </select>

      {!isBoolean && (
        isDate ? (
          <Input
            type="date"
            value={cond.value}
            onChange={e => onChange({ ...cond, value: e.target.value })}
            className="h-8 text-sm w-36"
          />
        ) : isPriority ? (
          <select
            value={cond.value}
            onChange={e => onChange({ ...cond, value: e.target.value })}
            className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
          >
            <option value="1">1 — Urgente</option>
            <option value="2">2 — Haute</option>
            <option value="3">3 — Normale</option>
            <option value="4">4 — Basse</option>
            <option value="5">5 — Très basse</option>
          </select>
        ) : (
          <Input
            value={cond.value}
            onChange={e => onChange({ ...cond, value: e.target.value })}
            placeholder={cond.field === 'size' ? 'Ko (ex: 5120 = 5 Mo)' : 'Valeur…'}
            className="h-8 text-sm flex-1 min-w-[120px]"
          />
        )
      )}

      {canRemove && (
        <button type="button" onClick={onRemove}
          className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
