'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Tags, Play, Pause, RotateCcw, FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountAvatar } from '@/components/layout/AccountAvatar'
import {
  SettingsPage, SettingsHeader, SettingsSection, SettingsRow, SettingsDivider, Toggle, SaveBar,
} from '@/components/settings/primitives'
import { ENGINES_ENDPOINT } from '@/components/settings/DecisionEnginesSection'
import { TagQuestionsSection } from '@/components/settings/TagQuestionsSection'
import { TagGroupsSection } from '@/components/settings/TagGroupsSection'
import { TagRulesSection } from '@/components/settings/TagRulesSection'
import { useTagLabels } from '@/hooks/useTagLabels'
import type { PassEstimate, TaggingStatus } from '@/lib/tagging/mailbox'
import { TAGGING_SETTINGS_ENDPOINT } from '@/lib/tagging/view'
import type { tagDistribution } from '@/lib/tagging/store'
import type { DecisionEngine } from '@/lib/tagging/engines'
import type { EmailAccount } from '@/types/account'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** La forme de la répartition est celle que le produit rend : elle n'est pas réécrite ici. */
type TagDistribution = Awaited<ReturnType<typeof tagDistribution>>

/** Les routes de l'écran, écrites une fois. */
const SETTINGS_ENDPOINT = TAGGING_SETTINGS_ENDPOINT
const RUN_ENDPOINT = '/api/tagging/run'
const STATUS_ENDPOINT = '/api/tagging/status'

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
  const locale = useLocale()
  const tCommon = useTranslations('settings.common')
  const { g: labelG } = useTagLabels()

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

  async function run(action: 'start' | 'sample' | 'pause' | 'resume' | 'restart') {
    if (!accountId) return
    if (action === 'restart' && !window.confirm(t('restartConfirm'))) return
    if (action === 'sample' && !window.confirm(t('sampleConfirm', { size: count(sampleSize) }))) return
    setBusy(true); setRunError(null)
    try {
      // Un refus du serveur se DIT : sans cela, un bouton pressé qui ne change rien se lit
      // comme un bouton cassé, et l'utilisateur recommence au lieu de lire la cause.
      const res = await fetch(RUN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // La taille et la graine ne sont pas écrites ici : elles viennent du serveur
        // (`sampleDefaults`), qui est le seul à les nommer — cf. lib/tagging/runner.ts.
        body: JSON.stringify(action === 'sample'
          ? { accountId, action, sampleSize: sampleSize, sampleSeed: status?.sampleDefaults.seed }
          : { accountId, action }),
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
  const sampleSize = status?.sampleDefaults.size ?? 0
  // Une TAILLE est une quantité : elle se lit « 1 000 » en français, « 1,000 » en anglais. La
  // GRAINE n'en est pas une (c'est un numéro à recopier pour rejouer le tirage) : elle reste brute.
  const count = (n: number) => n.toLocaleString(locale)

  // La répartition ne se demande QUE quand il y a un échantillon tagué à lire : c'est un GROUP BY
  // sur toutes les étiquettes de la boîte, et elle n'a rien à dire avant le premier mail trié.
  // Elle est hors du rafraîchissement de l'état (20 s pendant un tri) pour cette raison.
  const showDistribution = !!status?.sample && status.tagged > 0
  const { data: distData } = useSWR<{ data: TaggingStatus & { distribution?: TagDistribution } }>(
    showDistribution && accountId ? `${STATUS_ENDPOINT}?account=${accountId}&distribution=1` : null,
    fetcher,
  )
  const distribution = distData?.data?.distribution ?? []

  // Les « anciennes versions » par question (lot T-Q) : un GROUP BY sur les étiquettes de la
  // boîte, demandé une fois par boîte affichée, hors du rafraîchissement de l'état.
  const { data: staleData } = useSWR<{ data: TaggingStatus & { staleCounts?: Record<string, number> } }>(
    accountId ? `${STATUS_ENDPOINT}?account=${accountId}&stale=1` : null,
    fetcher,
  )

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
                    : t('estimateDesc', { mails: count(remaining), questions: status.questions, version: status.taxonomyVersion })}
                >
                  <span className="text-sm tabular-nums">
                    {status.estimateUsd === null ? '—' : status.estimateUsd === 0 ? t('free') : usd(status.estimateUsd)}
                  </span>
                </SettingsRow>

                {/*
                  Le coût AVANT de lancer, selon les groupes (décision 24.4) : tronc seul, avec les
                  groupes pondérés par la part des mails qui les déclenchent (répartition de
                  l'échantillon), et le nombre de requêtes par mail. Lu tel quel dans `passes`.
                */}
                <PassCost passes={status.passes} remaining={remaining} count={count} labelG={labelG} />

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

                {/*
                  L'échantillon d'abord : on essaie sur 1 000 mails, on LIT la répartition, puis on
                  décide de payer le reste. Le prix est annoncé SUR le bouton — c'est ce qu'il va
                  coûter, pas une estimation à chercher ailleurs.
                */}
                <SettingsRow
                  title={t('sample', { size: count(sampleSize) })}
                  description={status.sampleEstimateUsd === null
                    ? t('sampleDescUnknown', { size: count(sampleSize) })
                    : t('sampleDesc', { size: count(sampleSize), cost: usd(status.sampleEstimateUsd) })}
                >
                  <Button
                    type="button" variant="ghost"
                    // Un tri EN PAUSE laisse `bulkState` à « running » : le désactiver là empêchait
                    // de tester un échantillon sur une boîte mise en pause, alors que l'échantillon
                    // remet justement les compteurs à zéro. Même condition que le bouton Lecture.
                    disabled={busy || (status.bulkState === 'running' && !status.pausedReason)}
                    onClick={() => run('sample')}
                  >
                    <FlaskConical className="mr-1.5 h-4 w-4" />{t('sampleAction')}
                  </Button>
                </SettingsRow>

                {status.sample && (
                  <p className="text-xs text-muted-foreground">
                    {t('sampleState', { size: count(status.sample.size), done: count(status.sample.done), seed: status.sample.seed })}
                  </p>
                )}

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

                {showDistribution && (
                  <>
                    <SettingsDivider />
                    <p className="text-sm font-medium">{t('distribution')}</p>
                    <p className="text-xs text-muted-foreground">{t('distributionDesc')}</p>
                    {distribution.length === 0
                      ? <p className="text-xs text-muted-foreground">{t('distributionEmpty')}</p>
                      : <Distribution distribution={distribution} />}
                  </>
                )}
              </SettingsSection>
            </>
          )}
        </div>
      )}

      {/* Les questions sont celles de l'UTILISATEUR, pas d'une boîte : la section se rend même sans boîte. */}
      <div className="mt-5">
        <TagQuestionsSection accountId={accountId} staleCounts={staleData?.data?.staleCounts ?? {}} />
      </div>
      <div className="mt-5">
        <TagGroupsSection />
      </div>
      <div className="mt-5">
        <TagRulesSection accounts={accounts} />
      </div>
    </SettingsPage>
  )
}

/**
 * Les requêtes et le coût PAR MAIL selon les groupes actifs (lot T-Q3). Deux lignes : le tronc
 * seul (passe 1, sûr), et « avec les groupes » — `null` tant qu'aucun échantillon n'a mesuré
 * la part des mails qui déclenchent chaque groupe : on le DIT plutôt que d'inventer un chiffre.
 * Sans groupe conditionnel, la ligne « avec les groupes » n'a rien à dire et ne s'affiche pas.
 */
function PassCost({ passes, remaining, count, labelG }: {
  passes: PassEstimate; remaining: number; count: (n: number) => string; labelG: (id: string) => string
}) {
  const t = useTranslations('settings.tagging.cost')
  const usdOrTokens = (usd: number | null, tokens: number) => (usd === null ? `${count(Math.round(tokens))} tokens` : usd === 0 ? '' : usdOf(usd))
  const usdOf = (v: number) => `$${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`
  const line = (label: string, tokens: number | null, perMail: number | null | undefined, total: number | null | undefined, requests: string) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5" data-pass-cost={label}>
      <span className="text-sm">{label}</span>
      <span className="text-xs text-muted-foreground">{requests}</span>
      <span className="ml-auto text-sm tabular-nums">
        {tokens === null ? t('withGroupsUnknown') : (
          <>
            {t('perMail', { cost: usdOrTokens(perMail ?? null, tokens) })}
            {total !== null && total !== undefined && <span className="text-xs text-muted-foreground"> · {t('remaining', { cost: usdOf(total), mails: count(remaining) })}</span>}
          </>
        )}
      </span>
    </div>
  )
  return (
    <SettingsRow title={t('passes')} description={t('passesDesc')}>
      <div className="w-full space-y-1.5 sm:max-w-md" data-passes>
        {line(t('trunk'), passes.tokensPerMail.trunk, passes.usdPerMail?.trunk, passes.usdRemaining?.trunk, t('requests', { count: passes.requestsPerMail.trunk }))}
        {passes.groups.length > 0 && line(t('withGroups'), passes.tokensPerMail.withGroups, passes.usdPerMail?.withGroups, passes.usdRemaining?.withGroups,
          t('requestsRange', { trunk: passes.requestsPerMail.trunk, max: passes.requestsPerMail.max }))}
        {passes.groups.map(g => (
          <p key={g.id} className="text-xs text-muted-foreground" data-pass-group={g.id} data-measured-on={g.measuredOn}
            title={g.rate === null ? undefined : t('groupRateHint', { mails: count(g.measuredOn) })}>
            {g.rate === null
              ? t('groupRateUnknown', { name: labelG(g.id), questions: g.questions })
              : t('groupRate', { name: labelG(g.id), questions: g.questions, rate: `${Math.round(g.rate * 100)} %` })}
          </p>
        ))}
      </div>
    </SettingsRow>
  )
}

/**
 * La répartition des valeurs, PAR QUESTION : ce qu'on lit après un échantillon pour décider de
 * lancer le reste. Une barre proportionnelle plutôt qu'un camembert — on compare des longueurs,
 * ce qu'un œil fait bien, et c'est du CSS, pas une bibliothèque de graphiques.
 *
 * Les libellés viennent de `tags.q.<question>` et `tags.v.<valeur>`, les mêmes que les pastilles
 * du courrier (`components/mail/MessageTags.tsx`) : aucune chaîne n'est écrite ici.
 */
function Distribution({ distribution }: { distribution: TagDistribution }) {
  const t = useTranslations('tags')
  return (
    <dl className="space-y-3">
      {distribution.map(q => {
        const total = q.values.reduce((n, v) => n + v.count, 0)
        return (
          <div key={q.question} data-distribution-question={q.question}>
            <dt className="text-xs font-medium">{t(`q.${q.question}`)}</dt>
            <dd className="mt-1 space-y-1">
              {q.values.map(v => (
                <div key={v.valeur} className="flex items-center gap-2" data-distribution-value={v.valeur}>
                  <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">{t(`v.${v.valeur}`)}</span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-violet-500"
                      style={{ width: `${total ? Math.round((v.count / total) * 100) : 0}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {v.count} · {total ? Math.round((v.count / total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </dd>
          </div>
        )
      })}
    </dl>
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
