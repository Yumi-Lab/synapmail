'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Tags, Play, Pause, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountAvatar } from '@/components/layout/AccountAvatar'
import {
  SettingsPage, SettingsHeader, SettingsSection, SettingsRow, SettingsDivider, Toggle, SaveBar,
} from '@/components/settings/primitives'
import { ENGINES_ENDPOINT } from '@/components/settings/DecisionEnginesSection'
import type { TaggingStatus } from '@/lib/tagging/mailbox'
import type { DecisionEngine } from '@/lib/tagging/engines'
import type { EmailAccount } from '@/types/account'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Les routes de l'écran, écrites une fois. */
const SETTINGS_ENDPOINT = '/api/tagging/settings'
const RUN_ENDPOINT = '/api/tagging/run'

/**
 * Pendant un tri, l'état vient du planificateur, pas de cet écran : on le redemande. Le pas est
 * celui du planificateur (60 s) divisé en trois, pour que les compteurs bougent visiblement sans
 * interroger la base pour rien.
 */
const LIVE_REFRESH_MS = 20_000

/** Le nombre de décimales d'une dépense : un tri coûte des centièmes, pas des dollars ronds. */
const usd = (v: number) => `$${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`

export default function TaggingSettingsPage() {
  const t = useTranslations('settings.tagging')
  const tCommon = useTranslations('settings.common')

  const { data: accountsData } = useSWR<{ data: EmailAccount[] }>('/api/accounts', fetcher)
  // Les boîtes PARTAGÉES sont écartées, comme dans l'écran Comptes : ces réglages désignent un
  // moteur, donc une clé, et `/api/tagging/settings` est propriétaire seul (décision 9). Les
  // lister ici ne donnerait qu'un 404 muet au premier clic.
  const accounts = useMemo(() => (accountsData?.data ?? []).filter(a => !a.isShared), [accountsData])
  const [accountId, setAccountId] = useState<string | null>(null)

  // La première boîte sert de défaut, une fois : sans cela, l'écran s'ouvre vide alors qu'il a
  // déjà de quoi montrer quelque chose.
  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const { data: engineData } = useSWR<{ data: DecisionEngine[] }>(ENGINES_ENDPOINT, fetcher)
  const engines = engineData?.data ?? []

  // Le rafraîchissement ne tourne QUE pendant un tri : une boîte à l'arrêt n'a rien de nouveau
  // à dire, et une page de réglages ouverte toute la journée ne doit pas interroger la base.
  const { data: statusData, mutate: refreshStatus } = useSWR<{ data: TaggingStatus }>(
    accountId ? `${SETTINGS_ENDPOINT}?account=${accountId}` : null,
    fetcher,
    { refreshInterval: latest => (latest?.data?.bulkState === 'running' && !latest.data.pausedReason ? LIVE_REFRESH_MS : 0) },
  )
  const status = statusData?.data ?? null
  const pace = usePace(status)

  const [engineId, setEngineId] = useState<string | null>(null)
  const [budget, setBudget] = useState('')
  const [live, setLive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const loadedFor = useRef<string | null>(null)

  // Les champs suivent la boîte affichée, et ne sont repris qu'au CHANGEMENT de boîte : un
  // rafraîchissement pendant un tri écraserait sinon ce que l'utilisateur est en train de taper.
  useEffect(() => {
    if (!status || loadedFor.current === status.accountId) return
    loadedFor.current = status.accountId
    setRunError(null)
    setEngineId(status.engineId)
    setBudget(String(status.budgetUsd))
    setLive(status.live)
  }, [status])

  const dirty = !!status && (
    engineId !== status.engineId || Number(budget) !== status.budgetUsd || live !== status.live
  )

  async function save() {
    if (!accountId) return
    setSaving(true); setSaved(false)
    try {
      await fetch(SETTINGS_ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, engineId, budgetUsd: Number(budget), live }),
      })
      await refreshStatus()
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function run(action: 'start' | 'pause' | 'resume' | 'restart') {
    if (!accountId) return
    if (action === 'restart' && !window.confirm(t('restartConfirm'))) return
    setBusy(true); setRunError(null)
    try {
      // Un refus du serveur se DIT : sans cela, un bouton pressé qui ne change rien se lit
      // comme un bouton cassé, et l'utilisateur recommence au lieu de lire la cause.
      const res = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, action }),
      })
      const json = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) setRunError(json?.error ?? String(res.status))
      await refreshStatus()
    } finally {
      setBusy(false)
    }
  }

  const engine = status?.engine ?? null
  const remaining = status ? Math.max(status.total - status.tagged - status.skipped, 0) : 0

  return (
    <SettingsPage>
      <SettingsHeader icon={<Tags className="h-5 w-5" />} title={t('title')} description={t('description')} />

      {accounts.length === 0 ? (
        <SettingsSection><p className="text-sm text-muted-foreground">{t('noMailbox')}</p></SettingsSection>
      ) : (
        <div className="space-y-5">
          <SettingsSection title={t('mailbox')} description={t('mailboxDesc')}>
            <div className="space-y-1.5">
              {accounts.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAccountId(a.id)}
                  className={[
                    'flex w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left transition-colors',
                    a.id === accountId ? 'border-violet-500 bg-violet-500/5' : 'border-border hover:bg-accent/40',
                  ].join(' ')}
                >
                  <AccountAvatar account={a} colorIndex={i} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{a.name || a.email}</span>
                    <span className="block truncate text-xs text-muted-foreground">{a.email}</span>
                  </span>
                </button>
              ))}
            </div>
          </SettingsSection>

          {status && (
            <>
              <SettingsSection title={t('engine')} description={t('engineDesc')}>
                <select
                  value={engineId ?? ''}
                  onChange={e => setEngineId(e.target.value || null)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('noEngine')}</option>
                  {engines.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">
                  {engine ? (engine.hasKey ? t('keySaved') : t('keyMissing')) : t('noEngineHint')}
                </p>

                <SettingsDivider />

                <SettingsRow title={t('budget')} description={t('budgetDesc')}>
                  <Input
                    type="number" min={0} step="any" value={budget}
                    onChange={e => setBudget(e.target.value)}
                    className="w-28 text-right"
                  />
                </SettingsRow>

                <SettingsRow title={t('spent')}>
                  <span className="text-sm tabular-nums">{usd(status.spentUsd)} / {usd(status.budgetUsd)}</span>
                </SettingsRow>

                <SettingsRow
                  title={t('estimate')}
                  description={status.estimateUsd === null
                    ? t('estimateUnknown')
                    : t('estimateDesc', { mails: remaining, questions: status.questions })}
                >
                  <span className="text-sm tabular-nums">
                    {status.estimateUsd === null ? '—' : status.estimateUsd === 0 ? t('free') : usd(status.estimateUsd)}
                  </span>
                </SettingsRow>

                <SettingsDivider />

                <SettingsRow title={t('live')} description={t('liveDesc')}>
                  <Toggle checked={live} onChange={setLive} label={t('live')} />
                </SettingsRow>

                <SaveBar
                  dirty={dirty} saving={saving} saved={saved} onSave={save}
                  labels={{ save: tCommon('save'), saving: tCommon('saving'), saved: tCommon('saved'), unsaved: tCommon('unsaved') }}
                />
              </SettingsSection>

              <SettingsSection title={t('progress')}>
                <SettingsRow title={stateLabel(status, t)} description={pauseLabel(status, t)}>
                  <div className="flex gap-2">
                    {status.bulkState === 'running' && !status.pausedReason ? (
                      <Button type="button" variant="ghost" onClick={() => run('pause')} disabled={busy}>
                        <Pause className="mr-1.5 h-4 w-4" />{t('pause')}
                      </Button>
                    ) : (
                      <Button type="button" onClick={() => run(status.pausedReason ? 'resume' : 'start')} disabled={busy}>
                        <Play className="mr-1.5 h-4 w-4" />{status.pausedReason ? t('resume') : t('start')}
                      </Button>
                    )}
                    <Button type="button" variant="ghost" onClick={() => run('restart')} disabled={busy} title={t('restartDesc')}>
                      <RotateCcw className="mr-1.5 h-4 w-4" />{t('restart')}
                    </Button>
                  </div>
                </SettingsRow>

                {runError && <p className="text-xs text-red-600 dark:text-red-400">{runError}</p>}

                <SettingsDivider />

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    [t('tagged'), status.tagged],
                    [t('skipped'), status.skipped],
                    [t('errors'), status.errors],
                    [t('total'), status.total],
                    [t('rate'), pace ? t('ratePerMin', { count: pace.perMinute }) : '—'],
                    [t('remaining'), pace ? minutesLabel(Math.ceil(remaining / pace.perMinute)) : t('remainingUnknown')],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-sm font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
              </SettingsSection>
            </>
          )}
        </div>
      )}
    </SettingsPage>
  )
}

/**
 * Le DÉBIT se MESURE ici, il n'est pas stocké : deux relevés successifs de `tagged` et le temps
 * écoulé entre eux suffisent, et rien en base n'a à porter une vitesse qui ne vaut que pendant
 * le tri en cours. Tant qu'un seul relevé existe, il n'y a pas de débit à annoncer — on le dit
 * plutôt que d'inventer une moyenne.
 *
 * ponytail: la mesure repart de zéro à chaque ouverture de l'écran et à chaque changement de
 * boîte. Si un débit lissé sur tout un tri devient utile, il se calculera côté trieur, qui est
 * le seul à voir le tri en entier.
 */
function usePace(status: TaggingStatus | null): { perMinute: number } | null {
  const sample = useRef<{ at: number; tagged: number; accountId: string } | null>(null)
  const [pace, setPace] = useState<{ perMinute: number } | null>(null)

  useEffect(() => {
    if (!status) return
    const now = Date.now()
    const previous = sample.current
    if (!previous || previous.accountId !== status.accountId) {
      sample.current = { at: now, tagged: status.tagged, accountId: status.accountId }
      setPace(null)
      return
    }
    const done = status.tagged - previous.tagged
    const minutes = (now - previous.at) / 60_000
    if (done <= 0 || minutes <= 0) return
    sample.current = { at: now, tagged: status.tagged, accountId: status.accountId }
    setPace({ perMinute: Math.max(Math.round(done / minutes), 1) })
  }, [status])

  return pace
}

/** Un temps restant se lit en minutes tant qu'il en tient, en heures et minutes au-delà. */
const minutesLabel = (minutes: number): string =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`

/** L'état du tri, en un mot. Une pause l'emporte sur l'état de fond : c'est ce qui se passe. */
const stateLabel = (status: TaggingStatus, t: (k: string) => string): string =>
  status.pausedReason ? t('statePaused')
    : status.bulkState === 'running' ? t('stateRunning')
      : status.bulkState === 'done' ? t('stateDone')
        : t('stateIdle')

/** Et POURQUOI la pause, en clair : un plafond ne se règle pas comme un crédit épuisé. */
const pauseLabel = (status: TaggingStatus, t: (k: string) => string): string | undefined =>
  status.pausedReason
    ? t({ user: 'pausedUser', budget: 'pausedBudget', credit: 'pausedCredit', auth: 'pausedAuth', no_engine: 'pausedNoEngine' }[status.pausedReason])
    : undefined
