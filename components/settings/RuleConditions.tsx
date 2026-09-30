'use client'

/**
 * L'éditeur de CONDITIONS d'une règle — celui des règles de courrier (`RulesClient`), écrit une
 * fois et RÉUTILISÉ par les règles d'étiquetage (`TagRulesSection`, décision 24.5) : un seul
 * jeu de champs, d'opérateurs et de libellés, la même ligne à l'écran. Les conditions qu'il
 * produit sont évaluées par `lib/rulesEval.ts` des deux côtés.
 */
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import type { RuleCondition, RuleField, RuleOperator } from '@/types/rule'

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

const FIELDS = Object.keys(FIELD_OPERATORS) as RuleField[]
const PRIORITIES = ['1', '2', '3', '4', '5'] as const

/** Les libellés vivent dans `settings.rules.conditions` (fr/en/zh), partagés par les deux écrans. */
const useConditionLabels = () => useTranslations('settings.rules.conditions')

const BOOLEAN_FIELDS: RuleField[] = ['has_attachments', 'list_unsubscribe']

const uid = () => Math.random().toString(36).slice(2)

/** Une condition vide, telle qu'un « Ajouter une condition » la pose. */
export const newCondition = (): RuleCondition => ({ id: uid(), field: 'from', operator: 'contains', value: '' })

/** La condition en une phrase, dans la langue de l'écran : « Objet contient "facture" ». */
export function useConditionText(): (c: RuleCondition) => string {
  const t = useConditionLabels()
  return c => {
    const f = t(`field_${c.field}`)
    const o = t(`op_${c.operator}`)
    if (BOOLEAN_FIELDS.includes(c.field)) return `${f} ${o}`
    if (c.field === 'date_received') return `${f} ${o} ${c.value}`
    if (c.field === 'size') return `${f} ${o} ${c.value} ${t('sizeUnit')}`
    return `${f} ${o} "${c.value}"`
  }
}

export function ConditionRow({
  cond, onChange, onRemove, canRemove,
}: {
  cond: RuleCondition
  onChange: (c: RuleCondition) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const t = useConditionLabels()
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
        {FIELDS.map(f => (
          <option key={f} value={f}>{t(`field_${f}`)}</option>
        ))}
      </select>

      <select
        value={cond.operator}
        onChange={e => onChange({ ...cond, operator: e.target.value as RuleOperator })}
        className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
      >
        {operators.map(op => (
          <option key={op} value={op}>{t(`op_${op}`)}</option>
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
            {PRIORITIES.map(n => <option key={n} value={n}>{t(`priority_${n}`)}</option>)}
          </select>
        ) : (
          <Input
            value={cond.value}
            onChange={e => onChange({ ...cond, value: e.target.value })}
            placeholder={cond.field === 'size' ? t('sizePlaceholder') : t('valuePlaceholder')}
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
