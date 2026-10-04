'use client'

/**
 * L'écran « À valider » (décision 17, lot T15) : la file de validation AU CLAVIER.
 *
 * Un item = UNE ligne : le mail (expéditeur, objet), la question, la proposition du moteur et
 * sa confiance — et la raison d'être là (audit, désaccord, confiance basse) en pastille. La
 * ligne COURANTE se déplie seule : le texte jugé (`tag_states`, exactement ce que le moteur a
 * lu, jamais le mail entier) et les valeurs numérotées de la question.
 *
 * Clavier : `Entrée` confirme la proposition, un chiffre (1-9, puis `0` = 10, `a`-`z` au-delà)
 * choisit une autre valeur, `s` passe, `↑`/`↓` se déplacent, `z` défait la dernière écriture
 * (`DELETE …/tags?question=` retire la ligne `humain` qu'on vient d'écrire — jamais celle du
 * moteur, décision 5 — et l'item revient à sa place). Chaque geste écrit une ligne `humain` par
 * `PUT /api/messages/[id]/tags` — la même route que le panneau du mail. Objectif : 100 étiquettes
 * en moins de 5 minutes.
 *
 * La file se lit par `GET /api/tags?queue=1` (lib/tagging/audit.ts `validationQueue`) et ne se
 * RECHARGE pas sous les doigts : un item jugé disparaît de la liste locale, un item passé aussi
 * (il revient dans un second tour, une fois tout le reste jugé). La page suivante se demande
 * quand UN GESTE vide la liste locale (`juger`/`passer` lèvent `exhausted`) — jamais sur
 * l'identité de l'objet SWR, qui ne change pas quand le serveur rend la même page (gate T15,
 * bloquant 1). Le serveur ne rend plus ce qui est jugé, donc la première page est toujours
 * « ce qui reste » ; les compteurs affichés (restants, par raison) partent de la DERNIÈRE réponse
 * du serveur et se décrémentent à chaque geste jusqu'à la suivante.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { ClipboardCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AccountAvatar, useAccountAccent } from '@/components/layout/AccountAvatar'
import { useQuestionSet } from '@/hooks/useQuestionSet'
import { useTagLabels } from '@/hooks/useTagLabels'
import { valuesOf } from '@/lib/tagging/questions'
import { TAGS_CHANGED_EVENT, TAGS_ENDPOINT, VALIDATE_ACCOUNT_PARAM } from '@/lib/tagging/view'
import type { QueueItem, QueueReason, ValidationQueue } from '@/lib/tagging/audit'

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * La touche d'une valeur, par rang : `1`-`9`, `0` pour la dixième, puis `a`-`z`. ponytail: `s` et
 * `z` sont prises par « passer » et « défaire » (testées avant), donc la 29ᵉ et la 36ᵉ valeur
 * d'une question ne se choisissent qu'à la souris — la plus longue du jeu en compte 11.
 */
const KEYS = '1234567890abcdefghijklmnopqrstuvwxyz'
const keyOf = (rank: number): string | null => KEYS[rank] ?? null

/** Les touches de l'écran, écrites UNE fois : le gestionnaire et la légende les lisent ici. */
const SHORTCUTS = { confirm: 'Enter', skip: 's', undo: 'z', down: 'ArrowDown', up: 'ArrowUp' } as const

/** L'identité d'un item : un mail × une question. */
const keyFor = (i: Pick<QueueItem, 'messageId' | 'question'>) => `${i.messageId}\u0000${i.question}`

const REASON_CLASS: Record<QueueReason, string> = {
  audit: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  disagreement: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  confidence: 'bg-muted text-muted-foreground',
}

export function ValidateClient() {
  const t = useTranslations('tags.validate')
  const format = useFormatter()
  const { q, v } = useTagLabels()
  const { set } = useQuestionSet()
  const { accounts, activeAccount, colorIndex, switchAccount } = useAccountAccent()
  const accountId = activeAccount?.id ?? null
  const canOrganize = activeAccount?.permissions?.canOrganize ?? true

  // La boîte vient de l'URL quand l'écran est ouvert depuis « Fiabilité » (`?account=`) ; sinon
  // c'est la boîte active. Lu une fois au montage (pas de `useSearchParams` : voir CLAUDE.md).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get(VALIDATE_ACCOUNT_PARAM)
    if (wanted && wanted !== accountId && accounts.some(a => a.id === wanted)) switchAccount(wanted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length])

  const key = accountId ? `${TAGS_ENDPOINT}?account=${encodeURIComponent(accountId)}&queue=1` : null
  // La liste LOCALE : ce que le serveur a rendu, moins ce que la main a jugé ou passé — et les
  // compteurs tels que le serveur les a rendus, décrémentés à chaque geste (`judged`).
  const [items, setItems] = useState<QueueItem[]>([])
  const skipped = useRef(new Set<string>())
  const judged = useRef<Record<QueueReason, number>>({ audit: 0, disagreement: 0, confidence: 0 })
  const onPage = useCallback((page: ValidationQueue) => {
    judged.current = { audit: 0, disagreement: 0, confidence: 0 }
    setItems(prev => {
      const seen = new Set(prev.map(keyFor))
      const fresh = page.items.filter(i => !seen.has(keyFor(i)) && !skipped.current.has(keyFor(i)))
      // Plus rien de neuf mais des items passés : second tour, ils reviennent.
      if (!fresh.length && !prev.length && skipped.current.size) {
        skipped.current.clear()
        return page.items
      }
      return [...prev, ...fresh]
    })
  }, [])
  const { data, error, mutate, isValidating } = useSWR<{ data: ValidationQueue }>(key, fetcher, { revalidateOnFocus: false, onSuccess: r => onPage(r.data) })
  // Une page déjà en cache SWR (retour sur l'écran) ne repasse pas par `onSuccess` : on la pose une fois.
  const seeded = useRef(false)
  useEffect(() => { if (data && !seeded.current) { seeded.current = true; onPage(data.data) } }, [data, onPage])
  const [done, setDone] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [last, setLast] = useState<{ item: QueueItem; index: number } | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Levé par un GESTE qui vide la liste locale : c'est lui, et lui seul, qui demande la suite.
  const [exhausted, setExhausted] = useState(false)

  useEffect(() => { setItems([]); skipped.current.clear(); seeded.current = false; setDone(0); setCursor(0); setLast(null); setStartedAt(null); setElapsed(0); setExhausted(false) }, [accountId])
  useEffect(() => {
    if (!exhausted) return
    setExhausted(false)
    void mutate()
  }, [exhausted, mutate])
  // Le chronomètre de l'objectif (100 en 5 min) : UN chrono de session, parti au premier geste,
  // arrêté quand la file est vide.
  const hasItems = items.length > 0
  useEffect(() => {
    if (startedAt === null || !hasItems) return
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000))
    const id = window.setInterval(tick, 1000)
    return () => { window.clearInterval(id); tick() }
  }, [startedAt, hasItems])

  const current = items[Math.min(cursor, items.length - 1)] ?? null
  const question = current ? set.questionById(current.question) : undefined
  const values = useMemo(() => (question ? valuesOf(question) : []), [question])

  const write = useCallback(async (item: QueueItem, valeur: string) => {
    if (!accountId || busy) return
    setBusy(true); setFailed(null)
    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(item.messageId)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId, tags: [{ question: item.question, valeur }],
          folder: item.folder, uid: item.uid, fromName: item.fromName, fromAddress: item.fromAddress,
          subject: item.subject, date: item.date,
        }),
      })
      if (!res.ok) { setFailed(t('writeFailed', { status: res.status })); return false }
      window.dispatchEvent(new CustomEvent(TAGS_CHANGED_EVENT))
      return true
    } finally { setBusy(false) }
  }, [accountId, busy, t])

  // Retire la ligne courante de la liste locale ; si c'était la dernière, demande la suite.
  const drop = useCallback((item: QueueItem) => {
    const index = items.indexOf(item)
    const rest = items.filter(i => i !== item)
    setItems(rest)
    setCursor(Math.min(index, Math.max(rest.length - 1, 0)))
    if (!rest.length) setExhausted(true)
  }, [items])

  const judge = useCallback(async (valeur: string) => {
    if (!current) return
    setStartedAt(t => t ?? Date.now())
    const index = items.indexOf(current)
    if (!(await write(current, valeur))) return
    setLast({ item: current, index })
    judged.current[current.reason] += 1
    setDone(n => n + 1)
    drop(current)
  }, [current, items, write, drop])

  // Passer = retirer la ligne de ce tour sans rien écrire ; elle revient quand tout le reste est jugé.
  const skip = useCallback(() => {
    if (!current) return
    skipped.current.add(keyFor(current))
    drop(current)
  }, [current, drop])

  // Défaire = SUPPRIMER la ligne `humain` qu'on vient d'écrire (la ligne du moteur n'est jamais
  // touchée) et remettre la ligne à sa place pour la rejuger.
  const undo = useCallback(async () => {
    if (!last || !accountId || busy) return
    setBusy(true); setFailed(null)
    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(last.item.messageId)}/tags?account=${encodeURIComponent(accountId)}&question=${encodeURIComponent(last.item.question)}`, { method: 'DELETE' })
      if (!res.ok) { setFailed(t('writeFailed', { status: res.status })); return }
      window.dispatchEvent(new CustomEvent(TAGS_CHANGED_EVENT))
    } finally { setBusy(false) }
    setItems(prev => { const next = [...prev]; next.splice(Math.min(last.index, next.length), 0, last.item); return next })
    setCursor(Math.min(last.index, items.length))
    judged.current[last.item.reason] -= 1
    setDone(n => Math.max(n - 1, 0))
    setLast(null)
  }, [last, accountId, busy, t, items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return
      if (!canOrganize) return
      if (e.key === SHORTCUTS.confirm) { e.preventDefault(); void judge(current?.valeur ?? ''); return }
      if (e.key === SHORTCUTS.skip) { e.preventDefault(); skip(); return }
      if (e.key === SHORTCUTS.undo) { e.preventDefault(); void undo(); return }
      if (e.key === SHORTCUTS.down) { e.preventDefault(); setCursor(c => Math.min(c + 1, items.length - 1)); return }
      if (e.key === SHORTCUTS.up) { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); return }
      const rank = KEYS.indexOf(e.key.toLowerCase())
      if (rank >= 0 && rank < values.length) { e.preventDefault(); void judge(values[rank]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [judge, skip, undo, current, values, items.length, canOrganize])

  // La ligne courante reste visible quand le curseur descend au clavier.
  const rowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => { rowRef.current?.scrollIntoView({ block: 'nearest' }) }, [cursor, current])

  // Le serveur a rendu « ce qui reste » à sa dernière réponse ; on en retranche ce qui a été
  // jugé depuis (jamais `total − done` : après une relance, `done` serait soustrait deux fois).
  const counts = data?.data.counts
  const countOf = (r: QueueReason) => Math.max((counts?.[r] ?? 0) - judged.current[r], 0)
  const remaining = (Object.keys(REASON_CLASS) as QueueReason[]).reduce((n, r) => n + countOf(r), 0)
  const pct = (n: number) => format.number(n, { style: 'percent', maximumFractionDigits: 0 })
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div className="relative flex-1 overflow-y-auto" data-validate-screen>
      <div className="px-5 py-6 sm:px-6">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-300">
            <ClipboardCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{t('title')}</h1>
            <p className="text-xs text-muted-foreground">{t('description')}</p>
          </div>
          {activeAccount && (
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" data-validate-account={activeAccount.id}>
              <AccountAvatar account={activeAccount} colorIndex={colorIndex} size="xs" />
              <span className="truncate">{activeAccount.name || activeAccount.email}</span>
            </span>
          )}
        </header>

        {/* Le compteur de l'objectif : jugés, restants, par raison, et le temps depuis le premier geste. */}
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums" data-validate-progress={done}>
          <span data-validate-remaining={remaining}>{t('remaining', { count: remaining })}</span>
          <span data-validate-done={done}>{t('done', { count: done })}</span>
          {done > 0 && <span data-validate-clock={elapsed}>{clock}</span>}
          {data && (
            <span className="flex gap-2">
              {(Object.keys(REASON_CLASS) as QueueReason[]).map(r => countOf(r) > 0 && (
                <span key={r} className={cn('rounded-full px-2 py-0.5 text-[11px]', REASON_CLASS[r])} data-validate-reason-count={r} data-validate-reason-n={countOf(r)}>
                  {t(`reason_${r}`)} · {countOf(r)}
                </span>
              ))}
            </span>
          )}
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">{t('loadError')}</p>
        ) : !data || (!items.length && (isValidating || exhausted)) ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : !items.length ? (
          <p className="text-sm text-muted-foreground" data-validate-empty>{done ? t('allDone', { count: done }) : t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card/80 shadow-sm" role="listbox" aria-label={t('title')} data-validate-list={items.length}>
            {items.map((item, i) => {
              const active = item === current
              const itemValues = active ? values : []
              return (
                <li
                  key={keyFor(item)}
                  ref={active ? rowRef : undefined}
                  role="option"
                  aria-selected={active}
                  onClick={() => setCursor(i)}
                  data-validate-item={item.question}
                  data-validate-active={active || undefined}
                  className={cn('cursor-default px-3 py-1.5 text-xs', active && 'bg-violet-500/10')}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={item.fromAddress ?? ''}>
                      <span className="font-medium">{item.fromName || item.fromAddress || '—'}</span>
                      <span className="text-muted-foreground"> · {item.subject || '—'}</span>
                    </span>
                    <span className="hidden shrink-0 text-muted-foreground sm:inline">{q(item.question)}</span>
                    <span className="shrink-0 font-semibold" data-validate-value={item.valeur}>{v(item.valeur)}</span>
                    <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums" data-validate-confidence={item.confiance ?? ''}>
                      {item.confiance !== null ? pct(item.confiance) : '—'}
                    </span>
                    <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px]', REASON_CLASS[item.reason])} data-validate-reason={item.reason}>
                      {t(`reason_${item.reason}`)}
                    </span>
                  </div>
                  {active && (
                    <div className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)]" data-validate-detail>
                      <div className="min-w-0">
                        <p className="text-muted-foreground sm:hidden">{q(item.question)}</p>
                        <p className="font-medium">{question?.instructions}</p>
                        {item.state ? (
                          <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 font-sans text-[11px] leading-snug text-foreground/90" data-validate-state>
                            {item.state.corps}
                          </pre>
                        ) : (
                          <p className="mt-1 text-[11px] text-muted-foreground" data-validate-nostate>{t('noState')}</p>
                        )}
                        {item.valeurs.length > 1 && (
                          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400" data-validate-disagreement>
                            {t('enginesSaid', { values: item.valeurs.map(v).join(' / ') })}
                          </p>
                        )}
                      </div>
                      <ol className="space-y-0.5" data-validate-choices={itemValues.length}>
                        {itemValues.map((value, rank) => (
                          <li key={value}>
                            <button
                              type="button"
                              disabled={busy || !canOrganize}
                              onClick={() => void judge(value)}
                              data-validate-choice={value}
                              className={cn('flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-accent disabled:opacity-50',
                                value === item.valeur && 'font-semibold')}
                            >
                              <kbd className="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground">{keyOf(rank) ?? '·'}</kbd>
                              <span className="truncate">{v(value)}</span>
                              {value === item.valeur && <kbd className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">↵</kbd>}
                            </button>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {failed && <p className="mt-2 text-xs text-destructive" role="alert" data-validate-failed>{failed}</p>}
        {!canOrganize && <p className="mt-2 text-xs text-muted-foreground">{t('readOnly')}</p>}

        {/* La légende des touches, statique : la main apprend en lisant une fois. */}
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground" data-validate-legend>
          <span><kbd className="font-mono font-bold text-foreground/60">↵</kbd> {t('keyConfirm')}</span>
          <span><kbd className="font-mono font-bold text-foreground/60">1-9</kbd> {t('keyChoose')}</span>
          <span><kbd className="font-mono font-bold text-foreground/60">{SHORTCUTS.skip}</kbd> {t('keySkip')}</span>
          <span><kbd className="font-mono font-bold text-foreground/60">{SHORTCUTS.undo}</kbd> {t('keyUndo')}</span>
          <span><kbd className="font-mono font-bold text-foreground/60">↑↓</kbd> {t('keyMove')}</span>
        </p>
      </div>
    </div>
  )
}
