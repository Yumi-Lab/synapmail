'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Cpu, Plus, Pencil, Trash2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { SettingsSection } from '@/components/settings/primitives'
import { ENGINES, ENGINE_PRESETS, type EngineKind } from '@/lib/tagging/engine'
import type { DecisionEngine } from '@/lib/tagging/engines'

/** La route des moteurs, écrite une fois : la liste, le formulaire et le test la lisent. */
export const ENGINES_ENDPOINT = '/api/decision-engines'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Le libellé d'un type vit dans les locales sous cette clé : `kindJev`, `kindOne`, `kindAutre`. */
const kindLabelKey = (kind: EngineKind) => `kind${kind[0].toUpperCase()}${kind.slice(1)}`

interface Draft {
  id: string | null
  name: string
  kind: EngineKind
  url: string
  model: string
  usdPerBillionInput: string
  apiKey: string
}

const draftOf = (engine?: DecisionEngine): Draft => engine
  ? {
    id: engine.id, name: engine.name, kind: engine.kind, url: engine.url,
    model: engine.model, usdPerBillionInput: String(engine.usdPerBillionInput), apiKey: '',
  }
  : {
    id: null, name: '', kind: ENGINES[0], url: ENGINE_PRESETS[ENGINES[0]].url,
    model: ENGINE_PRESETS[ENGINES[0]].model,
    usdPerBillionInput: String(ENGINE_PRESETS[ENGINES[0]].usdPerBillionInput), apiKey: '',
  }

/**
 * Les moteurs de décision de l'utilisateur, sous le réglage LLM et SANS le modifier (décision 13).
 * Un moteur = une ligne : nom, type, modèle, « clé enregistrée ». L'ajout et la modification
 * partagent le MÊME formulaire — deux formulaires divergeraient au premier champ ajouté.
 *
 * Le type PRÉREMPLIT l'adresse, le modèle et le tarif depuis `ENGINE_PRESETS` : ils restent
 * modifiables, car ce sont les valeurs de CE moteur, pas celles de son type.
 */
export function DecisionEnginesSection() {
  const t = useTranslations('settings.engines')
  const { data, mutate } = useSWR<{ data: DecisionEngine[] }>(ENGINES_ENDPOINT, fetcher)
  const engines = data?.data ?? []

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; text: string; ok: boolean } | null>(null)

  const pickKind = (kind: EngineKind) => setDraft(d => d && ({
    ...d, kind,
    // Un champ que l'utilisateur n'a pas encore rempli suit le préréglage ; ce qu'il a écrit reste.
    url: d.url && d.url !== ENGINE_PRESETS[d.kind].url ? d.url : ENGINE_PRESETS[kind].url,
    model: d.model && d.model !== ENGINE_PRESETS[d.kind].model ? d.model : ENGINE_PRESETS[kind].model,
    usdPerBillionInput: d.usdPerBillionInput && d.usdPerBillionInput !== String(ENGINE_PRESETS[d.kind].usdPerBillionInput)
      ? d.usdPerBillionInput
      : String(ENGINE_PRESETS[kind].usdPerBillionInput),
  }))

  async function save() {
    if (!draft) return
    setSaving(true); setError(null)
    try {
      const body: Record<string, unknown> = {
        name: draft.name, kind: draft.kind, url: draft.url, model: draft.model,
        usdPerBillionInput: Number(draft.usdPerBillionInput),
      }
      // Une clé vide en MODIFICATION ne touche pas celle qui est enregistrée : on ne l'envoie pas.
      if (draft.apiKey || !draft.id) body.apiKey = draft.apiKey
      const res = await fetch(draft.id ? `${ENGINES_ENDPOINT}/${draft.id}` : ENGINES_ENDPOINT, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? String(res.status)); return }
      setDraft(null)
      await mutate()
    } finally {
      setSaving(false)
    }
  }

  async function remove(engine: DecisionEngine) {
    if (!window.confirm(t('removeConfirm'))) return
    await fetch(`${ENGINES_ENDPOINT}/${engine.id}`, { method: 'DELETE' })
    await mutate()
  }

  async function test(engine: DecisionEngine) {
    setTesting(engine.id); setTestResult(null)
    try {
      const res = await fetch(`${ENGINES_ENDPOINT}/${engine.id}/test`, { method: 'POST' })
      const json = await res.json()
      setTestResult(res.ok
        ? { id: engine.id, ok: true, text: t('testOk', { ms: json.data.ms, tokens: json.data.inputTokens, model: json.data.model }) }
        : { id: engine.id, ok: false, text: failureText(json.failure) })
    } finally {
      setTesting(null)
    }
  }

  /** Un refus du moteur se dit en clair : « clé fausse » ne se confond pas avec « crédit épuisé ». */
  const failureText = (failure: unknown): string => {
    const key = typeof failure === 'string'
      ? { credit: 'failureCredit', auth: 'failureAuth', rate: 'failureRate', unavailable: 'failureUnavailable', rejected: 'failureRejected' }[failure]
      : undefined
    return key ? t(key) : t('testFailed')
  }

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {engines.length === 0 && !draft && (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}

      <div className="space-y-2">
        {engines.map(engine => (
          <div key={engine.id} className="rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-sm">
            <div className="flex items-center gap-3">
              <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{engine.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t(kindLabelKey(engine.kind))}
                  {engine.model && ` · ${engine.model}`}
                  {engine.hasKey && ` · ${t('keySaved')}`}
                </p>
              </div>
              <button type="button" onClick={() => test(engine)} disabled={testing === engine.id}
                className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
                {testing === engine.id ? t('testing') : t('test')}
              </button>
              <button type="button" onClick={() => { setDraft(draftOf(engine)); setError(null) }} title={t('edit')}
                className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => remove(engine)} title={t('remove')}
                className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {testResult?.id === engine.id && (
              <p className={testResult.ok
                ? 'mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400'
                : 'mt-1.5 text-xs text-red-600 dark:text-red-400'}>
                {testResult.ok && <Check className="h-3.5 w-3.5" />}
                {testResult.text}
              </p>
            )}
          </div>
        ))}
      </div>

      {draft ? (
        <div className="space-y-3 rounded-xl border border-border bg-card p-3.5 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              {t('name')}
              <Input value={draft.name} placeholder={t('namePlaceholder')}
                onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {t('kind')}
              <select value={draft.kind} onChange={e => pickKind(e.target.value as EngineKind)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                {ENGINES.map(kind => <option key={kind} value={kind}>{t(kindLabelKey(kind))}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {t('url')}
              <Input value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {t('model')}
              <Input value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {t('price')}
              <Input type="number" min={0} step="any" value={draft.usdPerBillionInput}
                onChange={e => setDraft({ ...draft, usdPerBillionInput: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {t('key')}
              <PasswordInput value={draft.apiKey} placeholder={t('keyPlaceholder')}
                onChange={e => setDraft({ ...draft, apiKey: e.target.value })} />
              {draft.id && <span className="block text-[11px]">{t('keyKept')}</span>}
            </label>
          </div>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" onClick={save} disabled={saving || !draft.name.trim()}>
              {t(draft.id ? 'edit' : 'add')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setDraft(null); setError(null) }}>{t('cancel')}</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => { setDraft(draftOf()); setError(null) }}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Plus className="h-4 w-4" />
          {t('add')}
        </button>
      )}
    </SettingsSection>
  )
}
