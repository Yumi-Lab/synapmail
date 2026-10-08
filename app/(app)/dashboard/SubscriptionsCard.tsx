'use client'

/**
 * Les newsletters du tableau de bord : combien on en reçoit, de qui, et un
 * bouton pour en partir.
 *
 * Rien n'est recodé côté serveur — le lot N1 a déjà posé le contrat :
 * `GET /api/subscriptions?account=<id>` liste les groupes, `POST
 * /api/subscriptions/unsubscribe` en quitte au plus `MAX_UNSUBSCRIBE_BATCH`
 * d'un coup et rend un état par groupe, `GET /api/subscriptions/unsubscribed`
 * garde l'historique. Ici on ne fait que LIRE, sélectionner et rendre.
 *
 * Trois règles viennent d'ailleurs et ne sont pas réécrites : la sélection façon
 * explorateur (`lib/explorerSelection.ts`, la même que la liste des messages),
 * la bulle de boîte (`AccountAvatar`, nourrie du rang, la même que la barre
 * latérale et les réglages) et la case à cocher posée SUR cette bulle
 * (`SelectableBubble`, sortie de la liste des messages au lot H4d).
 */

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { MailX, Loader2, Eraser } from 'lucide-react'
import { useTranslations, useLocale } from 'next-intl'
import { AccountAvatar, BUBBLE_BOX } from '@/components/layout/AccountAvatar'
import { SelectableBubble } from '@/components/ui/SelectableBubble'
import {
  explorerSelect, gestureOf, isAllSelected, selectAll,
  type ExplorerSelection,
} from '@/lib/explorerSelection'
import { MAX_UNSUBSCRIBE_BATCH } from '@/lib/subscriptionsContract'
import type { DashboardAccount } from '@/types/dashboard'
// Types seulement : effacés à la compilation, ils n'entraînent AUCUN module
// serveur dans le paquet du navigateur.
import type {
  Subscription, UnsubscribeReport, SubscriptionHistory, PurgeReport, PurgeRefused,
} from '@/lib/subscriptions'
import { cn } from '@/lib/utils'

/** Une ligne affichée : le groupe, et la boîte d'où il vient. */
interface Row extends Subscription {
  accountId: string
}

/** La clé d'une ligne pour la sélection : l'id du groupe porte déjà sa boîte. */
const rowKey = (r: Row) => r.id

/**
 * La taille de bulle de cette liste, lue à sa source : la case à cocher doit
 * couvrir la bulle au pixel, et `xs` est la taille que `AccountAvatar` rend ici.
 */
const SUBS_BUBBLE_SIZE = BUBBLE_BOX.xs

/**
 * Un appel par boîte, puis un seul tableau trié. Une boîte qui échoue (IMAP
 * indisponible) ne fait pas disparaître les autres : elle ne rend rien.
 */
async function loadRows(accountIds: string[]): Promise<Row[]> {
  const perAccount = await Promise.all(accountIds.map(async id => {
    const res = await fetch(`/api/subscriptions?account=${encodeURIComponent(id)}`)
    const body = (await res.json().catch(() => null)) as { data?: Subscription[] } | null
    return (body?.data ?? []).map(s => ({ ...s, accountId: id }))
  }))
  return perAccount.flat().sort((a, b) => b.count - a.count)
}

/**
 * Vider l'historique d'une newsletter se fait en DEUX temps, jamais en un clic :
 * on DÉNOMBRE d'abord (`GET /api/subscriptions/history`, lent — il balaie toute
 * la boîte), on MONTRE ce nombre, et seule la confirmation appelle
 * `POST /api/subscriptions/purge`. Annuler n'envoie rien du tout.
 *
 * Chaque état porte la ligne concernée : la carte reste utilisable pendant le
 * dénombrement, donc l'écran doit savoir de QUELLE newsletter il parle quand la
 * réponse arrive.
 */
type PurgeStep =
  | { phase: 'counting'; row: Row }
  | { phase: 'confirm'; row: Row; history: SubscriptionHistory }
  | { phase: 'purging'; row: Row; history: SubscriptionHistory }
  | { phase: 'done'; row: Row; report: PurgeReport }
  | { phase: 'refused'; row: Row; refused: PurgeRefused }
  | { phase: 'error'; row: Row; message: string }

export function SubscriptionsCard({
  accounts, filterAccount, renderCard,
}: {
  accounts: DashboardAccount[]
  /** La boîte choisie en tête du tableau de bord, ou `null` pour toutes. */
  filterAccount: string | null
  /** Le cadre du tableau de bord, passé par lui : la carte n'en dessine pas un second. */
  renderCard: (opts: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) => React.ReactNode
}) {
  const t = useTranslations('dashboard')
  const locale = useLocale()

  const scoped = useMemo(
    () => (filterAccount ? accounts.filter(a => a.id === filterAccount) : accounts),
    [accounts, filterAccount],
  )
  const scopedIds = useMemo(() => scoped.map(a => a.id), [scoped])

  // Une seule clé, qui NOMME les boîtes lues : changer de portée relit, et deux
  // portées différentes ne partagent jamais le même cache.
  const { data: rows, isLoading, mutate } = useSWR<Row[]>(
    scopedIds.length ? ['subscriptions', ...scopedIds] : null,
    () => loadRows(scopedIds),
    { revalidateOnFocus: false },
  )

  const items = useMemo(() => rows ?? [], [rows])
  const keys = useMemo(() => items.map(rowKey), [items])
  const [selection, setSelection] = useState<ExplorerSelection>({ selected: new Set(), anchor: null })
  const [reports, setReports] = useState<Record<string, UnsubscribeReport>>({})
  const [sending, setSending] = useState(false)
  const [purge, setPurge] = useState<PurgeStep | null>(null)

  const selected = useMemo(
    () => items.filter(r => selection.selected.has(rowKey(r))),
    [items, selection],
  )
  const allSelected = isAllSelected(keys, selection.selected)
  const tooMany = selected.length > MAX_UNSUBSCRIBE_BATCH

  const click = (r: Row, e: React.MouseEvent) =>
    setSelection(curr => explorerSelect(keys, curr, rowKey(r), gestureOf(e.nativeEvent)))

  /**
   * Le clic sur la BULLE ajoute ou retire cette seule ligne — le geste `toggle`
   * de `explorerSelection`, exactement comme la case de la liste des messages :
   * une case à cocher ne remplace jamais la sélection en cours.
   */
  const toggle = (r: Row) =>
    setSelection(curr => explorerSelect(keys, curr, rowKey(r), 'toggle'))

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' })

  /**
   * Partir d'une liste est IRRÉVERSIBLE côté expéditeur : la confirmation NOMME
   * combien de lettres partent, et aucun chemin n'en quitte une en un seul clic.
   */
  const unsubscribe = async () => {
    if (!selected.length || tooMany) return
    if (!window.confirm(t('subsConfirm', { count: selected.length }))) return

    setSending(true)
    try {
      // Une requête par boîte : l'API décide par boîte, et un id ne vaut que là.
      const byAccount: Record<string, Row[]> = {}
      selected.forEach(r => { byAccount[r.accountId] = [...(byAccount[r.accountId] ?? []), r] })

      const answers = await Promise.all(Object.entries(byAccount).map(async ([account, group]) => {
        const res = await fetch('/api/subscriptions/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account, ids: group.map(r => r.id), folder: group[0].folder }),
        })
        const body = (await res.json().catch(() => null)) as { data?: UnsubscribeReport[] } | null
        return body?.data ?? []
      }))

      const next: Record<string, UnsubscribeReport> = {}
      answers.flat().forEach(rep => { next[rep.id] = rep })
      setReports(curr => ({ ...curr, ...next }))
      setSelection({ selected: new Set(), anchor: null })
      mutate()
    } finally {
      setSending(false)
    }
  }

  /**
   * Premier temps : le DÉNOMBREMENT. Il balaie toute la boîte et prend des
   * dizaines de secondes sur une vraie boîte, donc l'écran affiche l'attente et
   * le reste de la carte reste vivant — rien n'est bloqué, rien n'est déplacé.
   */
  const countHistory = async (r: Row) => {
    setPurge({ phase: 'counting', row: r })
    try {
      const res = await fetch(
        `/api/subscriptions/history?account=${encodeURIComponent(r.accountId)}`
        + `&id=${encodeURIComponent(r.id)}&folder=${encodeURIComponent(r.folder)}`,
      )
      const body = (await res.json().catch(() => null)) as
        | { data?: SubscriptionHistory; error?: string } | null
      if (!res.ok || !body?.data) {
        setPurge({ phase: 'error', row: r, message: body?.error ?? String(res.status) })
        return
      }
      setPurge({ phase: 'confirm', row: r, history: body.data })
    } catch (err) {
      setPurge({ phase: 'error', row: r, message: String(err) })
    }
  }

  /**
   * Second temps : la purge. `expected` est EXACTEMENT le total qui vient d'être
   * affiché — c'est le seul nombre auquel l'utilisateur a consenti. Si la boîte
   * a bougé entre-temps, le serveur répond 409 et ce refus est MONTRÉ, avec le
   * nouveau total, au lieu d'être avalé.
   */
  const runPurge = async (r: Row, history: SubscriptionHistory) => {
    setPurge({ phase: 'purging', row: r, history })
    try {
      const res = await fetch('/api/subscriptions/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: r.accountId, id: r.id, folder: r.folder, expected: history.total,
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { data?: PurgeReport | PurgeRefused; error?: string } | null
      const data = body?.data
      if (res.status === 409 && data && 'refused' in data) {
        setPurge({ phase: 'refused', row: r, refused: data })
        return
      }
      if (!res.ok || !data || !('moved' in data)) {
        setPurge({ phase: 'error', row: r, message: body?.error ?? String(res.status) })
        return
      }
      setPurge({ phase: 'done', row: r, report: data })
      // Les messages ont quitté le dossier : la liste que la carte affiche n'est
      // plus la bonne. On la relit, sans toucher à la sélection en cours.
      mutate()
    } catch (err) {
      setPurge({ phase: 'error', row: r, message: String(err) })
    }
  }

  const body = (() => {
    if (isLoading) return <p className="py-6 text-center text-sm text-muted-foreground">{t('subsLoading')}</p>
    if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">{t('subsEmpty')}</p>

    return (
      <>
        <ul className="divide-y divide-border" data-subs-list>
          {items.map(r => {
            const account = accounts.find(a => a.id === r.accountId)
            const picked = selection.selected.has(rowKey(r))
            const report = reports[r.id]
            return (
              <li
                key={r.id}
                data-subs-row={r.id}
                data-subs-count={r.count}
                data-subs-selected={picked ? 'true' : 'false'}
                onClick={e => click(r, e)}
                className={cn(
                  'flex cursor-default items-center gap-3 px-2 py-2.5 first:pt-0 last:pb-0',
                  picked && 'bg-violet-500/10',
                )}
              >
                {account && (
                  // La MÊME bulle-case que la liste des messages : au survol elle
                  // laisse la case vide, cochée elle la remplit. Pas de second
                  // sélecteur dessiné ici — le composant est partagé.
                  <SelectableBubble
                    checked={picked}
                    onToggle={e => { e.stopPropagation(); toggle(r) }}
                    className={SUBS_BUBBLE_SIZE}
                  >
                    <AccountAvatar account={account} colorIndex={account.rank} size="xs" />
                  </SelectableBubble>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {r.sender.name || r.sender.address}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t('subsMeta', { count: r.count, date: fmtDate(r.lastDate) })}
                    {' · '}{t(`subsMethod_${r.method === 'one-click' ? 'oneClick' : r.method}`)}
                    {r.unsubscribedAt && <> · {t('subsAlreadyLeft', { date: fmtDate(r.unsubscribedAt) })}</>}
                  </span>
                  {report && (
                    <span
                      data-subs-report={report.outcome}
                      className={cn(
                        'mt-0.5 block truncate text-xs',
                        report.outcome === 'done' && 'text-emerald-600 dark:text-emerald-400',
                        report.outcome === 'failed' && 'text-red-600 dark:text-red-400',
                        (report.outcome === 'manual' || report.outcome === 'not_found') && 'text-muted-foreground',
                      )}
                    >
                      {report.outcome === 'done' && t('subsResultDone')}
                      {report.outcome === 'not_found' && t('subsResultNotFound')}
                      {report.outcome === 'failed' && t('subsResultFailed', { reason: report.reason ?? '' })}
                      {/* Le lien d'une sortie manuelle est MONTRÉ, jamais ouvert tout seul. */}
                      {report.outcome === 'manual' && (
                        report.url
                          ? <>{t('subsResultManual')}{' '}
                            <a href={report.url} target="_blank" rel="noreferrer noopener" className="text-violet-500 hover:underline">{report.url}</a></>
                          : t('subsResultManual')
                      )}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-xs font-semibold text-muted-foreground tabular-nums">
                  {r.count}
                </span>
              </li>
            )
          })}
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            data-subs-select-all
            onClick={() => setSelection(selectAll(keys, allSelected))}
            className="rounded-lg border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {allSelected ? t('subsSelectNone') : t('subsSelectAll')}
          </button>
          <button
            data-subs-unsubscribe
            onClick={unsubscribe}
            disabled={!selected.length || tooMany || sending}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-600 hover:bg-violet-500/20 disabled:opacity-50 dark:text-violet-400"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MailX className="h-3.5 w-3.5" />}
            {t('subsUnsubscribe')}
            {selected.length > 0 && <span className="font-mono tabular-nums">({selected.length})</span>}
          </button>
          {/*
            Pas de poubelle sur chaque ligne : la vue par defaut reste epuree.
            L'action agit sur la SELECTION, a cote de « Se desabonner ». L'API
            vide UNE newsletter par appel, donc le bouton n'accepte qu'une seule
            ligne selectionnee et le dit plutot que de se desactiver en silence.
          */}
          <button
            data-subs-purge
            onClick={() => selected.length === 1 && countHistory(selected[0])}
            disabled={selected.length !== 1 || purge?.phase === 'counting' || purge?.phase === 'purging'}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {purge?.phase === 'counting' || purge?.phase === 'purging'
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Eraser className="h-3.5 w-3.5" />}
            {t('subsPurge')}
          </button>
          {selected.length > 1 && (
            <span data-subs-purge-one className="text-xs text-muted-foreground">
              {t('subsPurgeOnlyOne')}
            </span>
          )}
          {tooMany && (
            <span data-subs-too-many className="text-xs text-muted-foreground">
              {t('subsTooMany', { max: MAX_UNSUBSCRIBE_BATCH, count: selected.length })}
            </span>
          )}
        </div>

        {purge && <PurgePanel
          step={purge}
          onCancel={() => setPurge(null)}
          onConfirm={runPurge}
          fmtDate={fmtDate}
        />}
      </>
    )
  })()

  return <>{renderCard({
    title: <span>{t('subsTitle')} <span className="font-normal text-muted-foreground">— {t('subsCount', { count: items.length })}</span></span>,
    children: body,
  })}</>
}

/**
 * Le panneau des deux temps de la purge, sous la liste — pas une modale : la
 * carte reste utilisable pendant le denombrement, qui est LENT (une vingtaine de
 * secondes mesurees sur une boite reelle, et cela grandit avec le nombre de
 * messages).
 *
 * La confirmation REPREND le nombre affiche et dit noir sur blanc que les
 * messages partent dans la CORBEILLE, donc restent recuperables. « Annuler »
 * n'envoie rien : il ferme le panneau, point.
 */
function PurgePanel({ step, onCancel, onConfirm, fmtDate }: {
  step: PurgeStep
  onCancel: () => void
  onConfirm: (row: Row, history: SubscriptionHistory) => void
  fmtDate: (iso: string) => string
}) {
  const t = useTranslations('dashboard')
  const name = step.row.sender.name || step.row.sender.address

  const close = (
    <button
      data-subs-purge-cancel
      onClick={onCancel}
      className="rounded-lg border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {t('subsPurgeCancel')}
    </button>
  )

  return (
    <div
      data-subs-purge-panel={step.phase}
      className="mt-3 rounded-xl border border-border bg-card/60 p-3"
    >
      <p className="truncate text-sm font-semibold">{name}</p>

      {step.phase === 'counting' && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('subsPurgeCounting')}
        </p>
      )}

      {(step.phase === 'confirm' || step.phase === 'purging') && (
        <>
          {/* Le DENOMBREMENT, affiche AVANT toute confirmation : combien de
              messages, du plus ancien au plus recent, dans combien de dossiers. */}
          <p data-subs-purge-count className="mt-1 text-xs text-muted-foreground">
            {t('subsPurgeCount', {
              count: step.history.total,
              folders: step.history.folders.length,
            })}
            {step.history.oldest && step.history.newest && <>
              {' · '}
              {t('subsPurgeRange', {
                oldest: fmtDate(step.history.oldest),
                newest: fmtDate(step.history.newest),
              })}
            </>}
          </p>
          {/* La confirmation reprend CE nombre et nomme la corbeille. */}
          <p className="mt-2 text-xs text-foreground">
            {t('subsPurgeConfirm', { count: step.history.total })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              data-subs-purge-confirm
              onClick={() => onConfirm(step.row, step.history)}
              disabled={step.phase === 'purging' || step.history.total === 0}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-600 hover:bg-violet-500/20 disabled:opacity-50 dark:text-violet-400"
            >
              {step.phase === 'purging' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('subsPurgeGo', { count: step.history.total })}
            </button>
            {close}
          </div>
        </>
      )}

      {step.phase === 'done' && (
        <p data-subs-purge-moved={step.report.moved} className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
          {t('subsPurgeDone', { count: step.report.moved, trash: step.report.trash })}
        </p>
      )}

      {/* Un 409 est une REPONSE, pas une panne : on la montre, avec le nouveau
          total quand le serveur le donne, pour que l'utilisateur relance. */}
      {step.phase === 'refused' && (
        <p data-subs-purge-refused={step.refused.refused} className="mt-1 text-xs text-red-600 dark:text-red-400">
          {step.refused.refused === 'count_changed'
            ? t('subsPurgeChanged', { total: step.refused.total ?? 0 })
            : t(`subsPurgeRefused_${step.refused.refused}`)}
        </p>
      )}

      {step.phase === 'error' && (
        <p data-subs-purge-error className="mt-1 text-xs text-red-600 dark:text-red-400">
          {t('subsPurgeError', { reason: step.message })}
        </p>
      )}

      {(step.phase === 'done' || step.phase === 'refused' || step.phase === 'error'
        || step.phase === 'counting') && (
        <div className="mt-2">{close}</div>
      )}
    </div>
  )
}
