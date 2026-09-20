'use client'

/**
 * Les lettres d'information du tableau de bord : combien on en reçoit, de qui,
 * et un bouton pour en partir.
 *
 * Rien n'est recodé côté serveur — le lot N1 a déjà posé le contrat :
 * `GET /api/subscriptions?account=<id>` liste les groupes, `POST
 * /api/subscriptions/unsubscribe` en quitte au plus `MAX_UNSUBSCRIBE_BATCH`
 * d'un coup et rend un état par groupe, `GET /api/subscriptions/unsubscribed`
 * garde l'historique. Ici on ne fait que LIRE, sélectionner et rendre.
 *
 * Deux règles viennent d'ailleurs et ne sont pas réécrites : la sélection façon
 * explorateur (`lib/explorerSelection.ts`, la même que la liste des messages) et
 * la bulle de boîte (`AccountAvatar`, nourrie du rang, la même que la barre
 * latérale et les réglages).
 */

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { MailX, Loader2 } from 'lucide-react'
import { useTranslations, useLocale } from 'next-intl'
import { AccountAvatar } from '@/components/layout/AccountAvatar'
import {
  explorerSelect, gestureOf, isAllSelected, selectAll,
  type ExplorerSelection,
} from '@/lib/explorerSelection'
import { MAX_UNSUBSCRIBE_BATCH } from '@/lib/subscriptionsContract'
import type { DashboardAccount } from '@/types/dashboard'
// Types seulement : effacés à la compilation, ils n'entraînent AUCUN module
// serveur dans le paquet du navigateur.
import type { Subscription, UnsubscribeReport } from '@/lib/subscriptions'
import { cn } from '@/lib/utils'

/** Une ligne affichée : le groupe, et la boîte d'où il vient. */
interface Row extends Subscription {
  accountId: string
}

/** La clé d'une ligne pour la sélection : l'id du groupe porte déjà sa boîte. */
const rowKey = (r: Row) => r.id

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

  const selected = useMemo(
    () => items.filter(r => selection.selected.has(rowKey(r))),
    [items, selection],
  )
  const allSelected = isAllSelected(keys, selection.selected)
  const tooMany = selected.length > MAX_UNSUBSCRIBE_BATCH

  const click = (r: Row, e: React.MouseEvent) =>
    setSelection(curr => explorerSelect(keys, curr, rowKey(r), gestureOf(e.nativeEvent)))

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
                data-subs-selected={picked ? 'true' : 'false'}
                onClick={e => click(r, e)}
                className={cn(
                  'flex cursor-default items-center gap-3 px-2 py-2.5 first:pt-0 last:pb-0',
                  picked && 'bg-violet-500/10',
                )}
              >
                {account && <AccountAvatar account={account} colorIndex={account.rank} size="xs" />}
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
          {tooMany && (
            <span data-subs-too-many className="text-xs text-muted-foreground">
              {t('subsTooMany', { max: MAX_UNSUBSCRIBE_BATCH, count: selected.length })}
            </span>
          )}
        </div>
      </>
    )
  })()

  return <>{renderCard({
    title: <span>{t('subsTitle')} <span className="font-normal text-muted-foreground">— {t('subsCount', { count: items.length })}</span></span>,
    children: body,
  })}</>
}
