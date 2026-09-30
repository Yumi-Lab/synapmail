'use client'

/**
 * Les groupes de questions, à l'écran (lot T-Q3, décision 24.2). Un groupe = UNE ligne (nom,
 * nombre de questions, « toujours » ou « conditionnel ») ; un clic déplie SOUS la ligne le
 * déclencheur : l'éditeur de conditions des règles de courrier (`RuleConditions`, pas un
 * second), avec en plus le champ « Étiquette ». Les groupes viennent des questions elles-mêmes
 * (`tag_questions.groupe`) : on ne crée pas un groupe ici, on lui donne un déclencheur. Le menu
 * « … » le retire, derrière une confirmation.
 */
import { useMemo, useState } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RowMenu, ContextMenuItem, MENU_ICON } from '@/components/ui/ContextMenu'
import { SettingsSection, SaveBar } from '@/components/settings/primitives'
import { ConditionRow, GROUP_FIELDS, newCondition, useConditionText } from '@/components/settings/RuleConditions'
import { useQuestionSet } from '@/hooks/useQuestionSet'
import { useTagLabels } from '@/hooks/useTagLabels'
import { isEnabled } from '@/lib/tagging/questions'
import { TAG_GROUPS_ENDPOINT, TAGGING_SETTINGS_ENDPOINT } from '@/lib/tagging/view'
import type { TagQuestionGroup } from '@/lib/tagging/questionGroups'
import type { StoredQuestion } from '@/lib/tagging/userQuestions'
import type { ConditionLogic } from '@/types/rule'
import { cn } from '@/lib/utils'

/** Ce que l'éditeur tient en main : le groupe, sans ses dates. */
type Draft = Omit<TagQuestionGroup, 'createdAt' | 'updatedAt'>

const draftOf = (g: TagQuestionGroup): Draft =>
  ({ id: g.id, name: g.name, position: g.position, conditionLogic: g.conditionLogic, conditions: g.conditions.map(c => ({ ...c })) })
/** Un déclencheur neuf part sur une étiquette : c'est ce qu'un groupe conditionnel lit le plus souvent. */
const freshDraft = (id: string, name: string): Draft =>
  ({ id, name, position: 0, conditionLogic: 'all', conditions: [{ ...newCondition(), field: 'tag', operator: 'equals' }] })

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function TagGroupsSection() {
  const t = useTranslations('settings.tagging.groups')
  const tCommon = useTranslations('settings.common')
  const tApp = useTranslations('common')
  const tRow = useTranslations('settings.rowActions')
  const conditionText = useConditionText()
  const { g: labelG } = useTagLabels()
  const { questions } = useQuestionSet()
  const { data, mutate } = useSWR<{ data: TagQuestionGroup[] }>(TAG_GROUPS_ENDPOINT, fetcher)
  const stored = useMemo(() => data?.data ?? [], [data])

  // Les slugs viennent des questions ACTIVES : chaque slug est une ligne, avec ou sans déclencheur.
  // Un slug sans question active n'a pas de ligne : il ne coûte rien et ne se déclenche pour rien
  // (`planPasses` l'ignore de la même façon).
  const slugs = useMemo(() => {
    const counts = new Map<string, number>()
    for (const q of questions) if (isEnabled(q)) counts.set(q.group, (counts.get(q.group) ?? 0) + 1)
    return Array.from(counts, ([id, count]) => ({ id, count, group: stored.find(g => g.id === id) ?? null }))
  }, [questions, stored])
  const free = slugs.filter(s => !s.group)
  // Un déclencheur ne lit que la passe 1 : les questions des groupes conditionnels (le sien compris)
  // n'y sont jamais, elles ne sont donc pas proposées au choix « Étiquette ».
  const conditional = useMemo(() => new Set(stored.filter(g => g.conditions.length).map(g => g.id)), [stored])

  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = useMemo(() => stored.find(g => g.id === open) ?? null, [stored, open])
  const dirty = !!draft && !!current && JSON.stringify(draftOf(current)) !== JSON.stringify(draft)
  const complete = (d: Draft) => d.conditions.length > 0

  // Un déclencheur change le coût AVANT de lancer, qui vit dans le statut de la boîte affichée :
  // la clé du statut est revalidée avec la liste, sinon la ligne « avec groupes » n'apparaît pas.
  const refresh = () => Promise.all([
    mutate(),
    globalMutate((key: unknown) => typeof key === 'string' && key.startsWith(TAGGING_SETTINGS_ENDPOINT)),
  ])

  async function send(method: string, path: string, body?: unknown): Promise<{ ok: boolean; json: { error?: string; data?: unknown } }> {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: res.ok, json: await res.json().catch(() => ({})) }
  }

  async function save() {
    if (!draft) return
    setSaving(true); setSaved(false); setError(null)
    try {
      const { ok, json } = adding
        ? await send('POST', TAG_GROUPS_ENDPOINT, draft)
        : await send('PATCH', `${TAG_GROUPS_ENDPOINT}/${open}`, draft)
      if (!ok) { setError(json.error ?? t('saveFailed')); return }
      await refresh()
      if (adding) { setAdding(false); setDraft(null); setOpen(null) } else setDraft(draftOf(json.data as TagQuestionGroup))
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function remove(g: TagQuestionGroup) {
    if (!window.confirm(t('deleteConfirm', { name: labelG(g.id) }))) return
    await send('DELETE', `${TAG_GROUPS_ENDPOINT}/${g.id}`)
    if (open === g.id) { setOpen(null); setDraft(null) }
    await refresh()
  }

  const openRow = (g: TagQuestionGroup) => {
    if (open === g.id) { setOpen(null); setDraft(null); return }
    setAdding(false); setOpen(g.id); setDraft(draftOf(g)); setError(null); setSaved(false)
  }
  const startAdd = () => {
    if (!free.length) return
    setOpen(null); setAdding(true); setDraft(freshDraft(free[0].id, labelG(free[0].id))); setError(null); setSaved(false)
  }

  const editor = (isNew: boolean) => draft && (
    <>
      <Editor draft={draft} setDraft={setDraft} free={free.map(s => s.id)} labelG={labelG} t={t} isNew={isNew}
        tagQuestions={questions.filter(q => q.group !== draft.id && !conditional.has(q.group))} />
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {isNew ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => { setAdding(false); setDraft(null) }}>{tApp('cancel')}</Button>
          <Button type="button" onClick={save} disabled={saving || !complete(draft)}>{saving ? tCommon('saving') : tCommon('save')}</Button>
        </div>
      ) : (
        <SaveBar dirty={dirty && complete(draft)} saving={saving} saved={saved} onSave={save}
          labels={{ save: tCommon('save'), saving: tCommon('saving'), saved: tCommon('saved'), unsaved: tCommon('unsaved') }} />
      )}
    </>
  )

  return (
    <SettingsSection title={t('title')} description={t('description', { conditional: stored.filter(g => g.conditions.length).length, total: slugs.length })}>
      <div className="space-y-1.5" data-tag-groups={slugs.length}>
        {stored.length === 0 && !adding && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
        {slugs.map(({ id, count, group }) => {
          const isOpen = !!group && open === id && !adding
          return (
            <div key={id} className="rounded-xl border border-border bg-card shadow-sm" data-tag-group={id} data-conditional={!!group?.conditions.length}>
              <div className="flex min-h-12 items-center gap-2 px-2.5 py-2">
                <button type="button" onClick={() => group && openRow(group)} disabled={!group} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default" aria-expanded={isOpen}>
                  {group ? (isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />) : <span className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{labelG(id)}</span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {t('questions', { count })}{group?.conditions.length ? ` · ${conditionText(group.conditions[0])}${group.conditions.length > 1 ? ` +${group.conditions.length - 1}` : ''}` : ''}
                  </span>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', group?.conditions.length ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground')}>
                    {group?.conditions.length ? t('conditional') : t('always')}
                  </span>
                </button>
                {group && (
                  <RowMenu label={tRow('menu', { name: labelG(id) })} itemsKey={id}>
                    {close => (
                      <ContextMenuItem itemKey="delete" icon={<Trash2 className={MENU_ICON} />} label={t('delete')} onClick={() => remove(group)} onClose={close} enabled danger />
                    )}
                  </RowMenu>
                )}
              </div>
              {isOpen && <div className="border-t border-border px-3.5 py-3">{editor(false)}</div>}
            </div>
          )
        })}
      </div>

      {adding && draft ? (
        <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm" data-tag-group-new>{editor(true)}</div>
      ) : free.length > 0 ? (
        <button type="button" onClick={startAdd} data-tag-group-add
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Plus className="h-4 w-4" />{t('add')}
        </button>
      ) : (
        <p className="text-xs text-muted-foreground">{t('noFreeGroup')}</p>
      )}
    </SettingsSection>
  )
}

type T = ReturnType<typeof useTranslations<'settings.tagging.groups'>>

function Editor({ draft, setDraft, free, labelG, t, isNew, tagQuestions }: {
  draft: Draft; setDraft: (f: (d: Draft | null) => Draft | null) => void
  free: string[]; labelG: (id: string) => string; t: T; isNew: boolean
  tagQuestions: StoredQuestion[]
}) {
  const update = (patch: Partial<Draft>) => setDraft(d => d && { ...d, ...patch })

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('group')}
          {isNew ? (
            <select value={draft.id} data-field="id" onChange={e => update({ id: e.target.value, name: labelG(e.target.value) })}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              {free.map(id => <option key={id} value={id}>{labelG(id)}</option>)}
            </select>
          ) : (
            <Input value={labelG(draft.id)} readOnly />
          )}
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('name')}
          <Input value={draft.name} data-field="name" onChange={e => update({ name: e.target.value })} />
        </label>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide">{t('trigger')}</span>
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
            <ConditionRow key={c.id} cond={c} fields={GROUP_FIELDS} tagQuestions={tagQuestions}
              onChange={updated => update({ conditions: draft.conditions.map((x, j) => (j === i ? updated : x)) })}
              onRemove={() => update({ conditions: draft.conditions.filter((_, j) => j !== i) })}
              canRemove={draft.conditions.length > 1} />
          ))}
        </div>
        <button type="button" onClick={() => update({ conditions: [...draft.conditions, { ...newCondition(), field: 'tag', operator: 'equals' }] })} data-add-condition
          className="mt-2 flex items-center gap-1.5 text-xs text-primary transition-colors hover:text-primary/80">
          <Plus className="h-3.5 w-3.5" /> {t('addCondition')}
        </button>
        <p className="mt-2 text-xs text-muted-foreground">{t('triggerHint')}</p>
      </div>
    </div>
  )
}
