'use client'

/**
 * L'écran GED (lot G6, décision 8) : à gauche la LISTE — une ligne par document (type, émetteur,
 * montant, date, pages), filtrée par le dossier virtuel de l'URL (`?folder=` : un id, `unfiled`,
 * ou rien = tous) et par la recherche dans le texte OCR (`?q=`) ; à droite le VOLET — vignettes
 * des pages + agrandissement, texte OCR repliable, valeurs, puce du dossier + « Ranger… »,
 * historique des rangements avec leur origine. Un document se glisse sur un dossier de la barre.
 *
 * Tout vient des routes du lot G5 — l'écran n'a aucune route à lui. La boîte est celle de la
 * barre (`useAccountAccent`) ; une boîte qui n'est pas une GED renvoie vers ses réglages.
 */

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { ArrowLeft, ChevronDown, Download, FileText, FolderInput, Search, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountAccent } from '@/components/layout/AccountAvatar'
import { ThinScroll } from '@/components/layout/ThinScroll'
import { ContextMenuItem, ContextMenuSurface, MENU_ICON, type ContextMenuAnchor } from '@/components/ui/ContextMenu'
import { foldersKey, type DocumentDrag } from '@/components/layout/GedFolderTree'
import { useTagLabels } from '@/hooks/useTagLabels'
import { formatRowDate } from '@/lib/dates'
import { HUMAN_SOURCE } from '@/lib/tagging/engine'
import { DOCUMENTS_CHANGED_EVENT, DOCUMENTS_ENDPOINT, DOCUMENT_DRAG_TYPE, DOCUMENT_FOLDER_PARAM, DOCUMENT_ID_PARAM, DOCUMENT_QUERY_PARAM, DOCUMENTS_PATH, UNFILED } from '@/lib/ged/model'
import { flattenTree, folderPath } from '@/lib/ged/tree'
import type { GedDocumentDetail, GedDocumentSummary, GedFilingView, GedFolder } from '@/lib/ged/documents'
import type { Suggestion } from '@/lib/ged/filing'
import type { StoredField, StoredTag } from '@/lib/tagging/store'
import { TAGGING_SETTINGS_HREF } from '@/components/settings/SettingsSidebar'

type ListResponse = { data: { documents: GedDocumentSummary[]; total: number; unfiled: number; tags: Record<string, StoredTag[]>; fields: Record<string, StoredField[]> } }
type DetailResponse = { data: GedDocumentDetail & { tags: StoredTag[]; fields: StoredField[]; suggestions: Suggestion[] } }
type FoldersResponse = { data: { folders: GedFolder[]; unfiled: number } }

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body
}

/** Les deux questions GED qu'une ligne porte en clair, et le champ qu'elle chiffre. */
const LINE_TYPE = 'type_document'
const LINE_SENDER = 'emetteur_document'
const LINE_AMOUNT = 'montant'
const LINE_CURRENCY = 'devise'
/** Vignettes : la route rend à la demande, une résolution pour la liste, une pour l'agrandissement. */
const THUMB_DPI = 40
const ZOOM_DPI = 150

const pageUrl = (id: string, n: number, dpi: number) => `${DOCUMENTS_ENDPOINT}/${id}/pages/${n}?dpi=${dpi}`

export function DocumentsClient() {
  const t = useTranslations('documents')
  const tTags = useTranslations('tags')
  const locale = useLocale()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { activeAccount } = useAccountAccent()
  const accountId = activeAccount?.id ?? null
  const canOrganize = activeAccount?.permissions?.canOrganize ?? true

  const folder = searchParams.get(DOCUMENT_FOLDER_PARAM)
  const q = searchParams.get(DOCUMENT_QUERY_PARAM) ?? ''
  const selectedId = searchParams.get(DOCUMENT_ID_PARAM)
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    const qs = next.toString()
    router.push(qs ? `${DOCUMENTS_PATH}?${qs}` : DOCUMENTS_PATH)
  }, [router, searchParams])

  const listKey = accountId
    ? `${DOCUMENTS_ENDPOINT}?account=${encodeURIComponent(accountId)}${folder ? `&${DOCUMENT_FOLDER_PARAM}=${encodeURIComponent(folder)}` : ''}${q ? `&${DOCUMENT_QUERY_PARAM}=${encodeURIComponent(q)}` : ''}`
    : null
  const { data: list, error: listError, isLoading } = useSWR<ListResponse>(listKey, fetcher, { refreshInterval: 60000, keepPreviousData: true })
  const { data: foldersData } = useSWR<FoldersResponse>(accountId ? foldersKey(accountId) : null, fetcher)
  const folders = useMemo(() => foldersData?.data.folders ?? [], [foldersData])

  // Un rangement (dépôt sur la barre, « Ranger… », fusion) rafraîchit liste, arbre et volet.
  useEffect(() => {
    const refresh = () => { if (listKey) void globalMutate(listKey); if (accountId) { void globalMutate(foldersKey(accountId)); if (selectedId) void globalMutate(`${DOCUMENTS_ENDPOINT}/${selectedId}`) } }
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(DOCUMENTS_CHANGED_EVENT, refresh)
  }, [listKey, accountId, selectedId])

  const documents = list?.data.documents ?? []
  const title = folder === UNFILED ? t('unfiled') : folder ? folderPath(folders, folder) || t('title') : t('all')

  if (activeAccount && !activeAccount.isGed) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground" data-documents-not-ged>
        <p>{t('notGed', { account: activeAccount.name || activeAccount.email })}{' '}<Link href={TAGGING_SETTINGS_HREF} className="underline hover:text-foreground">{t('openSettings')}</Link></p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0" data-documents-page>
      <div className={cn(selectedId ? 'hidden lg:flex' : 'flex', 'w-full lg:w-[380px] shrink-0 flex-col border-r border-border bg-background')}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" data-documents-title>{title}</h1>
          <span className="text-xs tabular-nums text-muted-foreground" data-documents-total>{list ? list.data.total : ''}</span>
        </div>
        <form className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0" onSubmit={e => { e.preventDefault(); setParams({ [DOCUMENT_QUERY_PARAM]: draft.trim() || null, [DOCUMENT_ID_PARAM]: null }) }}>
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={t('searchPlaceholder')} data-documents-search
            className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
          {q && (
            <button type="button" onClick={() => setParams({ [DOCUMENT_QUERY_PARAM]: null })} title={t('clearSearch')} aria-label={t('clearSearch')}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
          )}
        </form>
        <ThinScroll className="flex-1" viewportClassName="overscroll-contain">
          {listError && <p className="px-3 py-4 text-xs text-destructive">{String(listError.message)}</p>}
          {!listError && !isLoading && documents.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground" data-documents-empty>{q ? t('noMatch') : t('empty')}</p>}
          {documents.map(doc => (
            <DocumentRow key={doc.id} doc={doc} accountId={accountId!} tags={list?.data.tags[doc.tagMessageId] ?? []} fields={list?.data.fields[doc.tagMessageId] ?? []}
              folders={folders} locale={locale} selected={doc.id === selectedId} canOrganize={canOrganize} todayLabel={tTags.has('today') ? tTags('today') : t('today')}
              onOpen={() => setParams({ [DOCUMENT_ID_PARAM]: doc.id })} />
          ))}
        </ThinScroll>
      </div>

      <div className={cn(selectedId ? 'flex' : 'hidden lg:flex', 'flex-col flex-1 overflow-hidden min-w-0 bg-background')}>
        {selectedId ? (
          <DocumentPane id={selectedId} folders={folders} canOrganize={canOrganize} onBack={() => setParams({ [DOCUMENT_ID_PARAM]: null })} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><FileText className="w-5 h-5 mr-2 opacity-50" />{t('pickOne')}</div>
        )}
      </div>
    </div>
  )
}

/** Une ligne = un document : type · émetteur | montant · date · pages. Glissable vers un dossier de la barre. */
function DocumentRow({ doc, accountId, tags, fields, folders, locale, selected, canOrganize, todayLabel, onOpen }: {
  doc: GedDocumentSummary; accountId: string; tags: StoredTag[]; fields: StoredField[]; folders: GedFolder[]; locale: string
  selected: boolean; canOrganize: boolean; todayLabel: string; onOpen: () => void
}) {
  const t = useTranslations('documents')
  const { v, f } = useTagLabels()
  const type = tags.find(x => x.question === LINE_TYPE)?.valeur
  const sender = tags.find(x => x.question === LINE_SENDER)?.valeur
  const amount = fields.find(f => f.question === LINE_AMOUNT)?.valeur
  const currency = fields.find(f => f.question === LINE_CURRENCY)?.valeur
  const where = doc.folderId ? folderPath(folders, doc.folderId) : null
  const pending = doc.ocrStatus !== 'fait'
  return (
    <div
      role="button" tabIndex={0}
      draggable={canOrganize}
      onDragStart={e => { const drag: DocumentDrag = { ids: [doc.id], accountId }; e.dataTransfer.setData(DOCUMENT_DRAG_TYPE, JSON.stringify(drag)); e.dataTransfer.effectAllowed = 'move' }}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      data-document-row={doc.id}
      data-document-folder={doc.folderId ?? UNFILED}
      className={cn('grid grid-cols-[1fr_auto] gap-x-3 px-3 py-2 border-b border-border/60 cursor-pointer transition-colors', selected ? 'bg-primary/10' : 'hover:bg-muted/50')}
    >
      <div className="min-w-0 flex items-center gap-1.5 text-sm">
        <span className={cn('truncate', pending ? 'text-muted-foreground italic' : 'font-medium text-foreground')}>
          {pending ? t(doc.ocrStatus === 'echec' ? 'ocrFailed' : 'ocrPending') : type ? v(type) : doc.filename}
        </span>
        {sender && <span className="shrink-0 rounded border border-border bg-muted/60 px-1 text-[10px] leading-4 text-muted-foreground">{v(sender)}</span>}
      </div>
      <span className="text-sm tabular-nums text-foreground/80 text-right">{amount ? `${amount}${currency ? ` ${currency}` : ''}` : ''}</span>
      <div className="min-w-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {where ? <span className="truncate" title={where}>{where}</span> : <span className="truncate text-amber-600 dark:text-amber-400">{t('unfiled')}</span>}
        {doc.filingSource && doc.filingSource !== HUMAN_SOURCE && <Sparkles className="w-3 h-3 shrink-0 opacity-60" aria-label={f(doc.filingSource)} />}
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground text-right whitespace-nowrap">
        {doc.recuLe ? formatRowDate(String(doc.recuLe), locale, todayLabel) : ''} · {t('pages', { count: doc.pages })}
      </span>
    </div>
  )
}

/** Le volet : vignettes, texte OCR repliable, valeurs et étiquettes, dossier + « Ranger… », historique. */
function DocumentPane({ id, folders, canOrganize, onBack }: { id: string; folders: GedFolder[]; canOrganize: boolean; onBack: () => void }) {
  const t = useTranslations('documents')
  const format = useFormatter()
  const { q: ql, v, f: fl, source: sl } = useTagLabels()
  const key = `${DOCUMENTS_ENDPOINT}/${id}`
  const { data, error, mutate } = useSWR<DetailResponse>(key, fetcher)
  const doc = data?.data
  const [zoom, setZoom] = useState<number | null>(null)
  const zoomRef = useRef<HTMLDivElement>(null)
  // Light-dismiss de l'agrandissement : un clic hors de la page agrandie la replie, et ce clic atteint sa cible.
  useEffect(() => {
    if (zoom === null) return
    const onDown = (e: MouseEvent) => { if (!zoomRef.current?.contains(e.target as Node)) setZoom(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [zoom])
  const [menu, setMenu] = useState<ContextMenuAnchor | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => { setZoom(null); setFailure(null) }, [id])

  const file = async (folderId: string | null) => {
    setBusy(true); setFailure(null)
    try {
      const res = await fetch(`${key}/filing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || t('actionFailed'))
      await mutate()
      window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED_EVENT))
    } catch (err) { setFailure(err instanceof Error ? err.message : t('actionFailed')) } finally { setBusy(false) }
  }

  if (error) return <div className="p-6 text-sm text-destructive">{String(error.message)}</div>
  if (!doc) return <div className="p-6 text-sm text-muted-foreground">{t('loading')}</div>

  const where = doc.folderId ? folderPath(folders, doc.folderId) : null
  const pageNumbers = Array.from({ length: doc.pages }, (_, i) => i + 1)
  const rows = flattenTree(folders)
  const label = (row: GedFilingView) =>
    `${sl(row.source)}${row.auteurNom && row.auteurNom !== row.source ? ` · ${row.auteurNom}` : ''} · ${format.dateTime(new Date(row.creeLe), { dateStyle: 'short', timeStyle: 'short' })}`
  /** Où la ligne a rangé : le chemin actuel, sinon le nom figé d'un dossier disparu (jamais une clé brute). */
  const placeOf = (row: GedFilingView) =>
    row.folderId ? folderPath(folders, row.folderId) || row.dossierNom : row.dossierNom ? t('deletedFolder', { name: row.dossierNom }) : t('unfiled')

  return (
    <ThinScroll className="h-full" viewportClassName="overscroll-contain">
      <div className="lg:hidden flex items-center gap-2 px-4 py-2 border-b border-border">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" />{t('back')}</button>
      </div>
      <header className="px-5 pt-4 pb-3 border-b border-border" data-document-pane={doc.id}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{doc.tags.find(x => x.question === LINE_TYPE)?.valeur ? v(doc.tags.find(x => x.question === LINE_TYPE)!.valeur) : doc.filename}</h2>
            <p className="truncate text-xs text-muted-foreground">{doc.filename} · {t('pages', { count: doc.pages })}{doc.confiance !== null ? ` · ${t('confidence', { percent: Math.round(doc.confiance) })}` : ''}{doc.recuLe ? ` · ${format.dateTime(new Date(doc.recuLe), { dateStyle: 'medium' })}` : ''}</p>
          </div>
          <a href={`${key}/pdf?download=true`} title={t('download')} aria-label={t('download')} className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"><Download className="w-4 h-4" /></a>
        </div>
        {/* La puce du dossier + « Ranger… » : UN bouton, un menu de dossiers (light-dismiss, clavier). */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', where ? 'border-border bg-muted/60 text-foreground' : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300')} data-document-where>
            {where ?? t('unfiled')}
          </span>
          {canOrganize && (
            <button type="button" disabled={busy} data-document-file
              onClick={e => { const b = e.currentTarget.getBoundingClientRect(); setMenu({ x: b.left, y: b.bottom + 4 }) }}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50">
              <FolderInput className="w-3 h-3" />{t('fileInto')}<ChevronDown className="w-3 h-3" />
            </button>
          )}
          {doc.suggestions.map(s => {
            const f = folders.find(x => x.id === s.folderId)
            return f ? (
              <button key={s.folderId} type="button" disabled={busy || !canOrganize} onClick={() => void file(s.folderId)} data-document-suggestion={s.folderId}
                title={t('suggestionHint', { genres: s.genres.join(', ') })}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-violet-500/50 px-2 py-0.5 text-violet-700 hover:bg-violet-500/10 dark:text-violet-300 disabled:opacity-50">
                <Sparkles className="w-3 h-3" />{t('suggestion', { name: f.nom })}
              </button>
            ) : null
          })}
        </div>
        {failure && <p className="mt-1 text-[11px] text-destructive" role="alert" data-document-error>{failure}</p>}
      </header>

      {/* Vignettes : une par page, cliquer agrandit en dessous (pas de modale, pas de lib). */}
      <section className="px-5 py-3 border-b border-border" data-document-pages={doc.pages}>
        <div className="flex flex-wrap gap-2">
          {pageNumbers.map(n => (
            <button key={n} type="button" onClick={() => setZoom(zoom === n ? null : n)} title={t('page', { n })} aria-pressed={zoom === n}
              className={cn('rounded border bg-white overflow-hidden transition-shadow hover:shadow-md', zoom === n ? 'border-primary ring-2 ring-primary/30' : 'border-border')}>
              {/* eslint-disable-next-line @next/next/no-img-element -- rendu à la demande par la route, jamais optimisé par Next */}
              <img src={pageUrl(doc.id, n, THUMB_DPI)} alt={t('page', { n })} width={116} height={164} loading="lazy" className="block h-[164px] w-[116px] object-contain" />
            </button>
          ))}
        </div>
        {zoom && (
          <div ref={zoomRef} className="mt-3 rounded-lg border border-border bg-white p-1 overflow-auto" data-document-zoom={zoom}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pageUrl(doc.id, zoom, ZOOM_DPI)} alt={t('page', { n: zoom })} className="block max-w-full mx-auto" />
          </div>
        )}
      </section>

      {(doc.tags.length > 0 || doc.fields.length > 0) && (
        <section className="px-5 py-3 border-b border-border text-xs" data-document-values>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">{t('values')}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
            {doc.fields.map(f => (
              <div key={f.question} className="contents">
                <dt className="text-muted-foreground">{fl(f.question)}</dt>
                <dd className="tabular-nums text-foreground" data-field-value={f.question}>{f.valeur}</dd>
              </div>
            ))}
            {doc.tags.map(tag => (
              <div key={tag.question} className="contents">
                <dt className="text-muted-foreground">{ql(tag.question)}</dt>
                <dd className="text-foreground" data-tag-value={tag.question}>{v(tag.valeur)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <details className="group border-b border-border" data-document-ocr>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-2 text-xs text-muted-foreground hover:bg-muted/50">
          <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
          <span className="font-medium">{t('ocrText')}</span>
          <span className="tabular-nums text-muted-foreground/70">{doc.ocrText.length}</span>
        </summary>
        <pre className="px-5 pb-4 text-xs whitespace-pre-wrap break-words text-foreground/80 max-h-[60vh] overflow-auto">{doc.ocrText || t('ocrEmpty')}</pre>
      </details>

      <section className="px-5 py-3 text-xs" data-document-history={doc.filings.length}>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">{t('history')}</p>
        {doc.filings.length === 0 ? <p className="text-muted-foreground/70">{t('historyEmpty')}</p> : (
          <ol className="space-y-0.5">
            {doc.filings.map((f, i) => (
              <li key={f.id} className={cn('flex items-center gap-2', i > 0 && 'text-muted-foreground')} data-filing={f.source}>
                <span className="min-w-0 flex-1 truncate">{placeOf(f)}</span>
                <span className="shrink-0 truncate text-muted-foreground">{label(f)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {menu && (
        <ContextMenuSurface anchor={menu} onClose={() => setMenu(null)} data-document-file-menu>
          {rows.map(r => (
            <ContextMenuItem key={r.folder.id} itemKey={`file:${r.folder.id}`} icon={r.folder.auto ? <Sparkles className={MENU_ICON} /> : <span className={MENU_ICON} />}
              label={`${'\u00a0'.repeat(r.depth * 2)}${r.folder.nom}`} enabled={r.folder.id !== doc.folderId} onClose={() => setMenu(null)} onClick={() => void file(r.folder.id)} />
          ))}
          {doc.folderId && <ContextMenuItem itemKey="file:none" icon={<X className={MENU_ICON} />} label={t('takeOut')} enabled onClose={() => setMenu(null)} onClick={() => void file(null)} />}
          {rows.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{t('noFolderYet')}</p>}
        </ContextMenuSurface>
      )}
    </ThinScroll>
  )
}
