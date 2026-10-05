'use client'

/**
 * Les questions de tri de l'utilisateur, à l'écran (lot T-Q, décision 22). Une question = UNE
 * ligne (nom, type, groupe, interrupteur) ; un clic déplie l'éditeur SOUS la ligne : consigne,
 * type, critères selon le type (options avec définition / frontière / exemples pour un `choice`,
 * niveaux réordonnables au glisser pour un `score`, rien pour un `noul`), « Tester sur un mail ».
 * La suppression vit dans le menu « … », derrière une confirmation : jamais de corbeille par ligne.
 *
 * Le jeu vient du SWR partagé `useQuestionSet` ; chaque écriture passe par l'API puis `mutate` :
 * la liste des mails et le panneau voient la nouvelle taxonomie sans recharger.
 */
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, FlaskConical, GripVertical, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RowMenu, ContextMenuItem, MENU_ICON } from '@/components/ui/ContextMenu'
import { SettingsSection, SaveBar, Toggle } from '@/components/settings/primitives'
import { useQuestionSet } from '@/hooks/useQuestionSet'
import { useTagLabels } from '@/hooks/useTagLabels'
import { CONFIDENCE_THRESHOLD_DEFAULT, RESERVED_ID_CODE, SCORE_LEVELS, SLUG_RE, engineBodyOf, type QuestionType, type TagOption, type TagQuestion } from '@/lib/tagging/questions'
import { QUESTIONS_ENDPOINT, TAGGING_RUN_ENDPOINT } from '@/lib/tagging/view'
import type { StoredQuestion } from '@/lib/tagging/userQuestions'
import type { Message } from '@/types/email'
import { cn } from '@/lib/utils'

const TYPES: QuestionType[] = ['choice', 'score', 'noul']

/** Ce que l'éditeur tient en main : la question, sans sa date. */
type Draft = Omit<StoredQuestion, 'updatedAt'>

const draftOf = (q?: StoredQuestion): Draft => q
  ? { id: q.id, type: q.type, instructions: q.instructions, group: q.group, options: q.options ? q.options.map(o => ({ ...o, examples: o.examples ? [...o.examples] : undefined })) : undefined, listBadge: q.listBadge, enabled: q.enabled, version: q.version, confidenceThreshold: q.confidenceThreshold }
  : { id: '', type: 'noul', instructions: '', group: 'general', enabled: true, version: 1 }

const emptyOption = (): TagOption => ({ value: '', definition: '' })

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function TagQuestionsSection({ accountId, staleCounts }: {
  /** La boîte affichée par l'écran : celle dont le moteur teste une question et dont on compte les anciennes versions. */
  accountId: string | null
  staleCounts: Record<string, number>
}) {
  const t = useTranslations('settings.tagging.questions')
  const tCommon = useTranslations('settings.common')
  const tApp = useTranslations('common')
  const tRow = useTranslations('settings.rowActions')
  const { q: labelQ, g: labelG } = useTagLabels()
  const { questions, loaded, mutate } = useQuestionSet()

  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = useMemo(() => questions.find(q => q.id === open) ?? null, [questions, open])
  const dirty = !!draft && !!current && JSON.stringify(draftOf(current)) !== JSON.stringify(draft)

  async function send(method: string, path: string, body?: unknown): Promise<{ ok: boolean; json: { error?: string; code?: string; id?: string; data?: unknown } }> {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: res.ok, json: await res.json().catch(() => ({})) }
  }

  async function save() {
    if (!draft) return
    setSaving(true); setSaved(false); setError(null)
    try {
      // Un seuil effacé part en `null` (= retour au défaut) : `undefined` disparaîtrait du JSON et garderait l'ancien.
      const body = { ...draft, confidenceThreshold: draft.confidenceThreshold ?? null }
      const { ok, json } = adding
        ? await send('POST', QUESTIONS_ENDPOINT, body)
        : await send('PATCH', `${QUESTIONS_ENDPOINT}/${encodeURIComponent(draft.id)}`, body)
      if (!ok) { setError(json.code === RESERVED_ID_CODE ? t('reservedId', { id: json.id ?? draft.id }) : json.error ?? t('saveFailed')); return }
      await mutate()
      // La question rendue porte sa nouvelle version : le brouillon se réaligne dessus, sinon
      // `dirty` resterait vrai (v1 en main, v2 à l'écran) et le bouton actif après l'enregistrement.
      if (adding) { setAdding(false); setDraft(null); setOpen(null) } else setDraft(draftOf(json.data as StoredQuestion))
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function toggle(q: StoredQuestion, enabled: boolean) {
    await send('PATCH', `${QUESTIONS_ENDPOINT}/${encodeURIComponent(q.id)}`, { enabled })
    await mutate()
  }

  async function remove(q: StoredQuestion) {
    if (!window.confirm(t('deleteConfirm', { name: labelQ(q.id) }))) return
    await send('DELETE', `${QUESTIONS_ENDPOINT}/${encodeURIComponent(q.id)}`)
    if (open === q.id) { setOpen(null); setDraft(null) }
    await mutate()
  }

  async function reset() {
    if (!window.confirm(t('resetConfirm'))) return
    await send('POST', `${QUESTIONS_ENDPOINT}/reset`)
    setOpen(null); setDraft(null); setAdding(false)
    await mutate()
  }

  const openRow = (q: StoredQuestion) => {
    if (open === q.id) { setOpen(null); setDraft(null); return }
    setAdding(false); setOpen(q.id); setDraft(draftOf(q)); setError(null); setSaved(false)
  }

  const startAdd = () => { setOpen(null); setAdding(true); setDraft(draftOf()); setError(null); setSaved(false) }

  const enabledCount = questions.filter(q => q.enabled !== false).length

  return (
    <SettingsSection title={t('title')} description={t('description', { enabled: enabledCount, total: questions.length })}>
      {!loaded && <p className="text-sm text-muted-foreground">{tApp('loading')}</p>}

      <div className="space-y-1.5" data-tag-questions={questions.length}>
        {questions.map(q => {
          const isOpen = open === q.id && !adding
          const stale = staleCounts[q.id] ?? 0
          return (
            <div key={q.id} className="rounded-xl border border-border bg-card shadow-sm" data-tag-question={q.id}>
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button type="button" onClick={() => openRow(q)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className={cn('min-w-0 flex-1 truncate text-sm', q.enabled === false ? 'text-muted-foreground' : 'font-medium')}>{labelQ(q.id)}</span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t(`type_${q.type}`)} · {labelG(q.group)} · v{q.version ?? 1}</span>
                  {stale > 0 && (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400" title={t('staleHint')} data-stale={stale}>
                      {t('stale', { count: stale })}
                    </span>
                  )}
                </button>
                <Toggle checked={q.enabled !== false} onChange={v => toggle(q, v)} label={t('enabled')} />
                <RowMenu label={tRow('menu', { name: labelQ(q.id) })} itemsKey={q.id}>
                  {close => (
                    <ContextMenuItem itemKey="delete" icon={<Trash2 className={MENU_ICON} />} label={t('delete')} onClick={() => remove(q)} onClose={close} enabled danger />
                  )}
                </RowMenu>
              </div>
              {isOpen && draft && (
                <div className="border-t border-border px-3.5 py-3">
                  <Editor draft={draft} setDraft={setDraft} isNew={false} accountId={accountId} stale={stale} t={t} />
                  {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
                  <SaveBar dirty={dirty} saving={saving} saved={saved} onSave={save}
                    labels={{ save: tCommon('save'), saving: tCommon('saving'), saved: tCommon('saved'), unsaved: tCommon('unsaved') }} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {adding && draft ? (
        <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm" data-tag-question-new>
          <Editor draft={draft} setDraft={setDraft} isNew accountId={accountId} stale={0} t={t} />
          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="mt-3 flex gap-2">
            <Button type="button" onClick={save} disabled={saving || !SLUG_RE.test(draft.id) || !draft.instructions.trim()}>{t('add')}</Button>
            <Button type="button" variant="ghost" onClick={() => { setAdding(false); setDraft(null); setError(null) }}>{tApp('cancel')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={startAdd} data-tag-question-add
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Plus className="h-4 w-4" />{t('add')}
          </button>
          <button type="button" onClick={reset} data-tag-question-reset
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <RotateCcw className="h-3.5 w-3.5" />{t('reset')}
          </button>
        </div>
      )}
    </SettingsSection>
  )
}

type T = ReturnType<typeof useTranslations<'settings.tagging.questions'>>

/**
 * L'éditeur, écrit UNE fois : l'ajout le pose sous la liste, la modification le déplie sous la
 * ligne. Le type commande la forme des critères ; en changer vide les options (un niveau de score
 * n'est pas une option de choix, et un noul n'en a pas).
 */
function Editor({ draft, setDraft, isNew, accountId, stale, t }: {
  draft: Draft; setDraft: (f: (d: Draft | null) => Draft | null) => void; isNew: boolean; accountId: string | null; stale: number; t: T
}) {
  const format = useFormatter()
  const update = (patch: Partial<Draft>) => setDraft(d => d && { ...d, ...patch })
  const setType = (type: QuestionType) => update({ type, options: type === 'noul' ? undefined : (draft.type === 'noul' ? [emptyOption(), emptyOption()] : draft.options), listBadge: undefined })
  const options = draft.options ?? []
  const setOption = (i: number, patch: Partial<TagOption>) => update({ options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const move = (from: number, to: number) => {
    if (from === to) return
    const next = [...options]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    update({ options: next })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('id')}
          <Input value={draft.id} disabled={!isNew} placeholder={t('idPlaceholder')} data-field="id"
            onChange={e => update({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('type')}
          <select value={draft.type} onChange={e => setType(e.target.value as QuestionType)} data-field="type"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            {TYPES.map(k => <option key={k} value={k}>{t(`type_${k}`)}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('group')}
          <Input value={draft.group} data-field="group" onChange={e => update({ group: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        {t('instructions')}
        <textarea value={draft.instructions} rows={2} data-field="instructions"
          onChange={e => update({ instructions: e.target.value })}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </label>
      <p className="text-[11px] text-muted-foreground">{t(`typeHint_${draft.type}`)}</p>

      {draft.type !== 'noul' && (
        <div className="space-y-2" data-field="options">
          <p className="text-xs font-medium">{t(draft.type === 'score' ? 'levels' : 'options')}</p>
          {options.map((o, i) => (
            <div key={i} draggable={draft.type === 'score'}
              onDragStart={() => setDragFrom(i)} onDragOver={e => { if (dragFrom !== null) e.preventDefault() }}
              onDrop={() => { if (dragFrom !== null) move(dragFrom, i); setDragFrom(null) }}
              className="flex items-start gap-2 rounded-lg border border-border/60 p-2" data-option={i}>
              {draft.type === 'score' && <GripVertical className="mt-2.5 h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />}
              <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[10rem_1fr]">
                <Input value={o.value} placeholder={t('optionValue')} data-option-value
                  onChange={e => setOption(i, { value: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
                <Input value={o.definition} placeholder={t('optionDefinition')} data-option-definition onChange={e => setOption(i, { definition: e.target.value })} />
                {draft.type === 'choice' && (<>
                  <Input value={o.notFor ?? ''} placeholder={t('optionNotFor')} className="sm:col-start-2" onChange={e => setOption(i, { notFor: e.target.value || undefined })} />
                  <Input value={(o.examples ?? []).join(' | ')} placeholder={t('optionExamples')} className="sm:col-start-2"
                    onChange={e => setOption(i, { examples: e.target.value ? e.target.value.split('|').map(s => s.trim()) : undefined })} />
                </>)}
              </div>
              <button type="button" aria-label={t('removeOption')} onClick={() => update({ options: options.filter((_, j) => j !== i) })}
                className="mt-2 shrink-0 text-muted-foreground hover:text-foreground">×</button>
            </div>
          ))}
          <button type="button" onClick={() => update({ options: [...options, emptyOption()] })}
            disabled={draft.type === 'score' && options.length >= SCORE_LEVELS.max}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" />{t(draft.type === 'score' ? 'addLevel' : 'addOption')}
          </button>
        </div>
      )}

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {t('listBadge')}
        {draft.type === 'score' ? (
          <select value={typeof draft.listBadge === 'string' ? draft.listBadge : ''} data-field="listBadge"
            onChange={e => update({ listBadge: e.target.value || undefined })}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs">
            <option value="">{t('listBadgeNever')}</option>
            {options.filter(o => o.value).map(o => <option key={o.value} value={o.value}>{t('listBadgeFrom', { level: o.value })}</option>)}
          </select>
        ) : (
          <Toggle checked={draft.listBadge === true} onChange={v => update({ listBadge: v ? true : undefined })} label={t('listBadge')} />
        )}
      </label>

      {/* Vide = le défaut (`CONFIDENCE_THRESHOLD_DEFAULT`) : `undefined` dans le brouillon, `null` en base.
          Une saisie partielle (« 0. », champ vidé) n'est jamais lue comme 0 : seul un nombre fini entre. Le 0 reste
          permis PENDANT la frappe (« 0 » puis « .5 »), mais un 0 laissé en quittant le champ (le « 0 » d'un Retour
          arrière sur « 0. ») redevient vide : un seuil nul n'alimenterait jamais la file, rien à enregistrer. */}
      <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {t('confidenceThreshold')}
        <input type="number" min={0} max={1} step={0.05} data-field="confidenceThreshold"
          value={draft.confidenceThreshold ?? ''} placeholder={format.number(CONFIDENCE_THRESHOLD_DEFAULT)}
          onChange={e => { const n = e.target.valueAsNumber; update({ confidenceThreshold: Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : undefined }) }}
          onBlur={() => { if (draft.confidenceThreshold === 0) update({ confidenceThreshold: undefined }) }}
          className="h-8 w-20 rounded-md border border-input bg-background px-2 text-xs tabular-nums" />
        <span className="text-[11px]">{t('confidenceThresholdHint', { value: CONFIDENCE_THRESHOLD_DEFAULT })}</span>
      </label>

      {!isNew && <TestOnMail question={draft} accountId={accountId} stale={stale} t={t} />}
    </div>
  )
}

/**
 * « Tester sur un mail » : les 30 derniers mails de la boîte affichée (la liste que le courrier
 * charge déjà, `/api/messages`), un clic = UNE requête au moteur pour CETTE question, réponse brute
 * affichée. Et, quand des mails portent une ANCIENNE version, « Retaguer cette question » relance
 * le tri de la boîte : le trieur repose le jeu courant et saute ce qui est à jour.
 */
function TestOnMail({ question, accountId, stale, t }: { question: Draft; accountId: string | null; stale: number; t: T }) {
  const tApp = useTranslations('common')
  const [uid, setUid] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const { data, isLoading } = useSWR<{ messages: Message[] }>(accountId ? `/api/messages?account=${accountId}&folder=INBOX&perPage=30` : null, fetcher)
  const messages = data?.messages ?? []
  useEffect(() => { if (!uid && messages.length) setUid(messages[0].uid) }, [messages, uid])

  async function test() {
    if (!accountId || !uid) return
    setBusy(true); setResult(null)
    try {
      const res = await fetch(`${QUESTIONS_ENDPOINT}/${encodeURIComponent(question.id)}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, folder: 'INBOX', uid }),
      })
      const json = await res.json().catch(() => ({})) as { error?: string; data?: { answer: { valeur: string; confiance: number | null } | null; model: string; ms: number; inputTokens: number } }
      if (!res.ok || !json.data) { setResult(json.error ?? String(res.status)); return }
      const a = json.data.answer
      setResult(a
        ? t('testResult', { value: a.valeur, confidence: a.confiance === null ? '?' : String(Math.round(a.confiance * 100)), model: json.data.model, ms: json.data.ms, tokens: json.data.inputTokens })
        : t('testRejected', { model: json.data.model }))
    } finally {
      setBusy(false)
    }
  }

  async function retag() {
    if (!accountId || !window.confirm(t('retagConfirm', { count: stale }))) return
    await fetch(TAGGING_RUN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, action: 'start' }) })
    setResult(t('retagStarted'))
  }

  // La version affichée à côté du test est celle que porteraient les étiquettes : le hachage du
  // corps envoyé, pour que « ancienne version » à l'écran désigne la même chose qu'en base.
  const body = useMemo(() => JSON.stringify(engineBodyOf(question as TagQuestion)), [question])

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-2.5" data-tag-question-test>
      <div className="flex flex-wrap items-center gap-2">
        <select value={uid} onChange={e => setUid(e.target.value)} disabled={!messages.length} data-test-uid
          className="h-8 min-w-0 max-w-[24rem] flex-1 truncate rounded-md border border-input bg-background px-2 text-xs">
          {!messages.length && <option value="">{isLoading ? tApp('loading') : t('noMail')}</option>}
          {messages.map(m => <option key={m.uid} value={m.uid}>{m.subject || m.from.address}</option>)}
        </select>
        <Button type="button" variant="ghost" size="sm" onClick={test} disabled={busy || !uid || !accountId} data-test-run>
          <FlaskConical className="mr-1.5 h-3.5 w-3.5" />{busy ? t('testing') : t('test')}
        </Button>
        {stale > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={retag} data-retag>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />{t('retag')}
          </Button>
        )}
      </div>
      {result && <p className="text-xs" data-test-result>{result}</p>}
      <p className="truncate text-[10px] text-muted-foreground/70" title={body}>{t('bodyPreview', { chars: body.length })}</p>
    </div>
  )
}
