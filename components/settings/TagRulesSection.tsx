'use client'

/**
 * Les règles d'étiquetage de l'utilisateur, à l'écran (lot T-Q2, décision 24.1). Une règle =
 * UNE ligne (nom, portée, avis / fait foi, interrupteur) ; un clic déplie l'éditeur SOUS la
 * ligne : nom, boîte, conditions (l'éditeur des règles de courrier, `RuleConditions`, pas un
 * second), étiquettes à poser (question → valeur du jeu de l'utilisateur), « la règle fait foi ».
 * La suppression vit dans le menu « … », derrière une confirmation : jamais de corbeille par ligne.
 */
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RowMenu, ContextMenuItem, MENU_ICON } from '@/components/ui/ContextMenu'
import { SettingsSection, SaveBar, Toggle } from '@/components/settings/primitives'
import { ConditionRow, newCondition, useConditionText } from '@/components/settings/RuleConditions'
import { useQuestionSet } from '@/hooks/useQuestionSet'
import { useTagLabels } from '@/hooks/useTagLabels'
import { valuesOf } from '@/lib/tagging/questions'
import { TAG_RULES_ENDPOINT } from '@/lib/tagging/view'
import type { TagRule, TagRuleAction } from '@/lib/tagging/tagRules'
import type { StoredQuestion } from '@/lib/tagging/userQuestions'
import type { ConditionLogic } from '@/types/rule'
import type { EmailAccount } from '@/types/account'
import { cn } from '@/lib/utils'

const SELECT = 'h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring'

/** Ce que l'éditeur tient en main : la règle, sans ses dates. */
type Draft = Omit<TagRule, 'id' | 'createdAt' | 'updatedAt'>

const draftOf = (r?: TagRule): Draft => r
  ? { accountId: r.accountId, name: r.name, enabled: r.enabled, priority: r.priority, conditionLogic: r.conditionLogic,
      conditions: r.conditions.map(c => ({ ...c })), actions: r.actions.map(a => ({ ...a })), authoritative: r.authoritative }
  : { accountId: null, name: '', enabled: true, priority: 0, conditionLogic: 'all', conditions: [newCondition()], actions: [], authoritative: false }

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function TagRulesSection({ accounts }: { accounts: EmailAccount[] }) {
  const t = useTranslations('settings.tagging.rules')
  const tCommon = useTranslations('settings.common')
  const tApp = useTranslations('common')
  const tRow = useTranslations('settings.rowActions')
  const conditionText = useConditionText()
  const { q: labelQ, v: labelV } = useTagLabels()
  const { set, questions } = useQuestionSet()
  const { data, mutate } = useSWR<{ data: TagRule[] }>(TAG_RULES_ENDPOINT, fetcher)
  const rules = useMemo(() => data?.data ?? [], [data])

  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = useMemo(() => rules.find(r => r.id === open) ?? null, [rules, open])
  const dirty = !!draft && !!current && JSON.stringify(draftOf(current)) !== JSON.stringify(draft)
  const complete = (d: Draft) => !!d.name.trim() && d.conditions.length > 0 && d.actions.length > 0 && d.actions.every(a => set.isValidTag(a.question, a.valeur))

  async function send(method: string, path: string, body?: unknown): Promise<{ ok: boolean; json: { error?: string; data?: unknown } }> {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: res.ok, json: await res.json().catch(() => ({})) }
  }

  async function save() {
    if (!draft) return
    setSaving(true); setSaved(false); setError(null)
    try {
      const { ok, json } = adding
        ? await send('POST', TAG_RULES_ENDPOINT, draft)
        : await send('PATCH', `${TAG_RULES_ENDPOINT}/${open}`, draft)
      if (!ok) { setError(json.error ?? t('saveFailed')); return }
      await mutate()
      if (adding) { setAdding(false); setDraft(null); setOpen(null) } else setDraft(draftOf(json.data as TagRule))
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function toggle(r: TagRule, enabled: boolean) {
    await send('PATCH', `${TAG_RULES_ENDPOINT}/${r.id}`, { enabled })
    await mutate()
  }

  async function remove(r: TagRule) {
    if (!window.confirm(t('deleteConfirm', { name: r.name }))) return
    await send('DELETE', `${TAG_RULES_ENDPOINT}/${r.id}`)
    if (open === r.id) { setOpen(null); setDraft(null) }
    await mutate()
  }

  const openRow = (r: TagRule) => {
    if (open === r.id) { setOpen(null); setDraft(null); return }
    setAdding(false); setOpen(r.id); setDraft(draftOf(r)); setError(null); setSaved(false)
  }
  const startAdd = () => { setOpen(null); setAdding(true); setDraft(draftOf()); setError(null); setSaved(false) }

  const accountName = (id: string | null) => id === null ? t('allAccounts') : (accounts.find(a => a.id === id)?.name ?? id)
  const enabledCount = rules.filter(r => r.enabled).length
  const editor = (isNew: boolean) => draft && (
    <>
      <Editor draft={draft} setDraft={setDraft} accounts={accounts} questions={questions} labelQ={labelQ} labelV={labelV} t={t} />
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {isNew ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" onClick={save} disabled={saving || !complete(draft)}>{t('add')}</Button>
          <Button type="button" variant="ghost" onClick={() => { setAdding(false); setDraft(null); setError(null) }}>{tApp('cancel')}</Button>
        </div>
      ) : (
        <SaveBar dirty={dirty && complete(draft)} saving={saving} saved={saved} onSave={save}
          labels={{ save: tCommon('save'), saving: tCommon('saving'), saved: tCommon('saved'), unsaved: tCommon('unsaved') }} />
      )}
    </>
  )

  return (
    <SettingsSection title={t('title')} description={t('description', { enabled: enabledCount, total: rules.length })}>
      <div className="space-y-1.5" data-tag-rules={rules.length}>
        {rules.length === 0 && !adding && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
        {rules.map(r => {
          const isOpen = open === r.id && !adding
          return (
            <div key={r.id} className="rounded-xl border border-border bg-card shadow-sm" data-tag-rule={r.id}>
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button type="button" onClick={() => openRow(r)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className={cn('min-w-0 flex-1 truncate text-sm', r.enabled ? 'font-medium' : 'text-muted-foreground')}>{r.name}</span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {accountName(r.accountId)} · {r.conditions.slice(0, 1).map(conditionText).join('')}{r.conditions.length > 1 ? ` +${r.conditions.length - 1}` : ''} · {r.actions.length}
                  </span>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', r.authoritative ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground')} data-authoritative={r.authoritative}>
                    {r.authoritative ? t('authoritativeBadge') : t('adviceBadge')}
                  </span>
                </button>
                <Toggle checked={r.enabled} onChange={v => toggle(r, v)} label={t('enabled')} />
                <RowMenu label={tRow('menu', { name: r.name })} itemsKey={r.id}>
                  {close => (
                    <ContextMenuItem itemKey="delete" icon={<Trash2 className={MENU_ICON} />} label={t('delete')} onClick={() => remove(r)} onClose={close} enabled danger />
                  )}
                </RowMenu>
              </div>
              {isOpen && <div className="border-t border-border px-3.5 py-3">{editor(false)}</div>}
            </div>
          )
        })}
      </div>

      {adding && draft ? (
        <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm" data-tag-rule-new>{editor(true)}</div>
      ) : (
        <button type="button" onClick={startAdd} data-tag-rule-add
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Plus className="h-4 w-4" />{t('add')}
        </button>
      )}
    </SettingsSection>
  )
}

type T = ReturnType<typeof useTranslations<'settings.tagging.rules'>>

function Editor({ draft, setDraft, accounts, questions, labelQ, labelV, t }: {
  draft: Draft; setDraft: (f: (d: Draft | null) => Draft | null) => void; accounts: EmailAccount[]
  questions: StoredQuestion[]
  labelQ: (id: string) => string; labelV: (id: string) => string; t: T
}) {
  const update = (patch: Partial<Draft>) => setDraft(d => d && { ...d, ...patch })
  const setAction = (i: number, a: TagRuleAction) => update({ actions: draft.actions.map((x, j) => (j === i ? a : x)) })
  const free = questions.filter(q => !draft.actions.some(a => a.question === q.id))
  const valuesFor = (id: string) => { const q = questions.find(x => x.id === id); return q ? valuesOf(q) : [] }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('name')}
          <Input value={draft.name} placeholder={t('namePlaceholder')} data-field="name" onChange={e => update({ name: e.target.value })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('scope')}
          <select value={draft.accountId ?? ''} data-field="accountId" onChange={e => update({ accountId: e.target.value || null })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="">{t('scopeAll')}</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.email})</option>)}
          </select>
        </label>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide">{t('conditions')}</span>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-0.5">
            {(['all', 'any'] as ConditionLogic[]).map(l => (
              <button key={l} type="button" onClick={() => update({ conditionLogic: l })} data-logic={l}
                className={cn('rounded-md px-2.5 py-1 text-xs transition-colors', draft.conditionLogic === l ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {l === 'all' ? t('logicAll') : t('logicAny')}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {draft.conditions.map((c, i) => (
            <ConditionRow key={c.id} cond={c}
              onChange={updated => update({ conditions: draft.conditions.map((x, j) => (j === i ? updated : x)) })}
              onRemove={() => update({ conditions: draft.conditions.filter((_, j) => j !== i) })}
              canRemove={draft.conditions.length > 1} />
          ))}
        </div>
        <button type="button" onClick={() => update({ conditions: [...draft.conditions, newCondition()] })} data-add-condition
          className="mt-2 flex items-center gap-1.5 text-xs text-primary transition-colors hover:text-primary/80">
          <Plus className="h-3.5 w-3.5" /> {t('addCondition')}
        </button>
      </div>

      <div>
        <span className="mb-2 block text-xs font-semibold uppercase tracking-wide">{t('actions')}</span>
        <div className="space-y-2">
          {draft.actions.map((a, i) => (
            <div key={a.question} className="flex flex-wrap items-center gap-2" data-action={a.question}>
              <select value={a.question} className={SELECT} data-field="question"
                onChange={e => setAction(i, { question: e.target.value, valeur: valuesFor(e.target.value)[0] ?? '' })}>
                <option value={a.question}>{labelQ(a.question)}</option>
                {free.map(q => <option key={q.id} value={q.id}>{labelQ(q.id)}</option>)}
              </select>
              <select value={a.valeur} className={SELECT} data-field="valeur" onChange={e => setAction(i, { ...a, valeur: e.target.value })}>
                {valuesFor(a.question).map(v => <option key={v} value={v}>{labelV(v)}</option>)}
              </select>
              <button type="button" onClick={() => update({ actions: draft.actions.filter((_, j) => j !== i) })}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        {free.length > 0 && (
          <button type="button" data-add-action
            onClick={() => update({ actions: [...draft.actions, { question: free[0].id, valeur: valuesFor(free[0].id)[0] ?? '' }] })}
            className="mt-2 flex items-center gap-1.5 text-xs text-primary transition-colors hover:text-primary/80">
            <Plus className="h-3.5 w-3.5" /> {t('addAction')}
          </button>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-2.5">
        <Toggle checked={draft.authoritative} onChange={v => update({ authoritative: v })} label={t('authoritative')} />
        <div className="min-w-0">
          <p className="text-sm">{t('authoritative')}</p>
          <p className="text-xs text-muted-foreground">{t('authoritativeHint')}</p>
        </div>
      </div>
    </div>
  )
}
