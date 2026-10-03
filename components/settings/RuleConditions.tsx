'use client'

/**
 * L'éditeur de CONDITIONS d'une règle — celui des règles de courrier (`RulesClient`), écrit une
 * fois et RÉUTILISÉ par les règles d'étiquetage (`TagRulesSection`, décision 24.5) : un seul
 * jeu de champs, d'opérateurs et de libellés, la même ligne à l'écran. Les conditions qu'il
 * produit sont évaluées par `lib/rulesEval.ts` des deux côtés.
 */
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { useQuestionSet } from '@/hooks/useQuestionSet'
import { useTagLabels } from '@/hooks/useTagLabels'
import { valuesOf } from '@/lib/tagging/questions'
import type { StoredQuestion } from '@/lib/tagging/userQuestions'
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
  tag:             ['equals','not_equals'],
  texte_ocr:       ['is_true','is_false'],
}

/** Les champs d'une règle. `tag` (une étiquette déjà obtenue) n'est offert qu'aux déclencheurs de groupe (lot T-Q3). */
export const RULE_FIELDS = (Object.keys(FIELD_OPERATORS) as RuleField[]).filter(f => f !== 'tag')
export const GROUP_FIELDS = Object.keys(FIELD_OPERATORS) as RuleField[]
const PRIORITIES = ['1', '2', '3', '4', '5'] as const

/** Les libellés vivent dans `settings.rules.conditions` (fr/en/zh), partagés par les deux écrans. */
const useConditionLabels = () => useTranslations('settings.rules.conditions')

const BOOLEAN_FIELDS: RuleField[] = ['has_attachments', 'list_unsubscribe', 'texte_ocr']

const uid = () => Math.random().toString(36).slice(2)

/** Une condition vide, telle qu'un « Ajouter une condition » la pose. */
export const newCondition = (): RuleCondition => ({ id: uid(), field: 'from', operator: 'contains', value: '' })

/** La condition en une phrase, dans la langue de l'écran : « Objet contient "facture" », « Étiquette intention est exactement réclamation ». */
export function useConditionText(): (c: RuleCondition) => string {
  const t = useConditionLabels()
  const { q: labelQ, v: labelV } = useTagLabels()
  return c => {
    const f = t(`field_${c.field}`)
    const o = t(`op_${c.operator}`)
    if (c.field === 'tag') return `${labelQ(c.tagQuestion ?? '')} ${o} ${labelV(c.value)}`
    if (BOOLEAN_FIELDS.includes(c.field)) return `${f} ${o}`
    if (c.field === 'date_received') return `${f} ${o} ${c.value}`
    if (c.field === 'size') return `${f} ${o} ${c.value} ${t('sizeUnit')}`
    return `${f} ${o} "${c.value}"`
  }
}

export function ConditionRow({
  cond, onChange, onRemove, canRemove, fields = RULE_FIELDS, tagQuestions,
}: {
  cond: RuleCondition
  onChange: (c: RuleCondition) => void
  onRemove: () => void
  canRemove: boolean
  /** Les champs offerts : ceux d'une règle par défaut, `GROUP_FIELDS` pour un déclencheur. */
  fields?: readonly RuleField[]
  /** Les questions qu'une condition « Étiquette » peut lire : tout le jeu par défaut. */
  tagQuestions?: StoredQuestion[]
}) {
  const t = useConditionLabels()
  const operators = FIELD_OPERATORS[cond.field] ?? []
  const isBoolean = BOOLEAN_FIELDS.includes(cond.field)
  const isDate    = cond.field === 'date_received'
  const isPriority = cond.field === 'priority'
  const isTag     = cond.field === 'tag'

  const handleFieldChange = (field: RuleField) => {
    const ops = FIELD_OPERATORS[field] ?? []
    onChange({ ...cond, field, operator: ops[0], value: '', tagQuestion: undefined })
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={cond.field}
        onChange={e => handleFieldChange(e.target.value as RuleField)}
        className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
      >
        {fields.map(f => (
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

      {isTag && <TagPicker cond={cond} onChange={onChange} questions={tagQuestions} />}

      {!isBoolean && !isTag && (
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

/**
 * La question et sa valeur d'une condition `tag`, lues dans le jeu de l'utilisateur (jamais
 * recopiées). Un composant à part pour que le jeu ne soit demandé que quand une ligne en a besoin.
 */
function TagPicker({ cond, onChange, questions: offered }: { cond: RuleCondition; onChange: (c: RuleCondition) => void; questions?: StoredQuestion[] }) {
  const { questions: all } = useQuestionSet()
  const questions = offered ?? all
  const { q: labelQ, v: labelV } = useTagLabels()
  const question = questions.find(q => q.id === cond.tagQuestion) ?? questions[0]
  const stale = !!question && (cond.tagQuestion !== question.id || !valuesOf(question).includes(cond.value))
  // Une ligne fraîche n'a pas encore de question : la première du jeu s'y pose, avec sa première valeur.
  useEffect(() => {
    if (stale) onChange({ ...cond, tagQuestion: question.id, value: valuesOf(question)[0] })
  }, [stale]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!question) return null
  return (
    <>
      <select
        value={question.id} data-field="tagQuestion"
        onChange={e => { const q = questions.find(x => x.id === e.target.value) ?? question; onChange({ ...cond, tagQuestion: q.id, value: valuesOf(q)[0] }) }}
        className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
      >
        {questions.map(q => <option key={q.id} value={q.id}>{labelQ(q.id)}</option>)}
      </select>
      <select
        value={cond.value} data-field="tagValue"
        onChange={e => onChange({ ...cond, value: e.target.value })}
        className="h-8 rounded-lg border border-border bg-background text-sm px-2 text-foreground focus:ring-1 focus:ring-ring outline-none"
      >
        {valuesOf(question).map(v => <option key={v} value={v}>{labelV(v)}</option>)}
      </select>
    </>
  )
}
