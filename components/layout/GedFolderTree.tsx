'use client'

/**
 * Les dossiers VIRTUELS d'une boîte GED dans la barre latérale (lot G6, décision 8) : « À ranger »
 * (compteur) puis l'arbre, une ligne par dossier, au MÊME motif de ligne que les dossiers IMAP
 * (colonne d'icône fixe, libellé qui se replie). Un document glissé depuis la liste se dépose ici ;
 * le clic droit (ou le menu « … » au clavier) propose : nouveau sous-dossier, renommer, FUSIONNER
 * dans un autre dossier (c'est ainsi qu'un dossier proposé rejoint un dossier existant — remarque
 * humaine du gate G3/G4), supprimer. Toute saisie de nom est EN LIGNE, jamais `window.prompt`.
 *
 * Le composant ne décide d'aucune règle : il appelle les routes `/api/documents/folders*` du lot
 * G5, dont les 404/409 s'affichent tels quels sous la liste.
 */

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import useSWR from 'swr'
import { FolderPlus, FolderTree, Inbox, Merge, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu, ContextMenuSurface, MENU_ICON, type ContextMenuAnchor } from '@/components/ui/ContextMenu'
import { folderGlyph, folderInitials } from './FolderGlyph'
import { ACCENT, UnreadBadge } from './AccountAvatar'
import { DOCUMENTS_CHANGED_EVENT, DOCUMENTS_PATH, DOCUMENT_DRAG_TYPE, DOCUMENT_FOLDERS_ENDPOINT, DOCUMENT_FOLDER_PARAM, UNFILED } from '@/lib/ged/model'
import { branchCount, flattenTree, isWithin } from '@/lib/ged/tree'
import type { GedFolder } from '@/lib/ged/documents'

/** La clé SWR de l'arbre d'une boîte — la page `/documents` et la barre la partagent, une mutation rafraîchit les deux. */
export const foldersKey = (accountId: string) => `${DOCUMENT_FOLDERS_ENDPOINT}?account=${encodeURIComponent(accountId)}`
export const documentsHref = (folder: string | null) => folder ? `${DOCUMENTS_PATH}?${DOCUMENT_FOLDER_PARAM}=${encodeURIComponent(folder)}` : DOCUMENTS_PATH

/** Ce qu'un document glissé emporte : la liste l'écrit, l'arbre le lit — une seule forme. */
export interface DocumentDrag { ids: string[]; accountId: string }
export const readDocumentDrag = (dt: DataTransfer): DocumentDrag | null => {
  const raw = dt.getData(DOCUMENT_DRAG_TYPE)
  if (!raw) return null
  try { return JSON.parse(raw) as DocumentDrag } catch { return null }
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Même géométrie de ligne que `Sidebar.tsx` (les constantes y sont privées, les variables CSS sont publiées sur la barre). */
const ROW = 'flex w-full items-center h-[var(--synap-row-h)] rounded-lg transition-colors'
const ROW_IDLE = 'text-foreground/70 hover:text-foreground hover:bg-foreground/[0.06]'
const ROW_ACTIVE = cn(ACCENT.tint, 'text-foreground font-medium')
const ROW_DRAG = cn(ACCENT.tintStrong, 'text-foreground')
const ICON_COL = 'shrink-0 flex items-center justify-center w-[var(--synap-icon-col)]'
const ROW_LABEL = 'flex-1 min-w-0 flex items-center gap-2 pr-3 text-sm whitespace-nowrap overflow-hidden transition-opacity'
/** Retrait d'un niveau de l'arbre, en pixels. */
const INDENT_PX = 14

type Naming = { action: 'createChild' | 'rename' | 'create'; folderId: string | null; value: string }
type Menu = ContextMenuAnchor & { folder: GedFolder }

export function GedFolderTree({ accountId, currentFolder, onDocuments, collapsed, canOrganize, onNavigate }: {
  accountId: string
  /** Le dossier de la page `/documents` affichée (`UNFILED`, un id, ou `null` = tous) — `undefined` si l'on n'y est pas. */
  currentFolder: string | null | undefined
  onDocuments: boolean
  collapsed: boolean
  canOrganize: boolean
  onNavigate?: () => void
}) {
  const t = useTranslations('documents')
  const { data, error, mutate } = useSWR<{ data: { folders: GedFolder[]; unfiled: number } }>(foldersKey(accountId), fetcher, { refreshInterval: 60000 })
  const folders = data?.data.folders ?? []
  const unfiled = data?.data.unfiled ?? 0
  const rows = flattenTree(folders)
  const initials = folderInitials(folders.map(f => ({ name: f.nom, path: f.id })))
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  /** Le serveur a la dernière décision : son message remplace tout optimisme de l'IHM. */
  const call = async (input: string, init: RequestInit) => {
    const res = await fetch(input, { headers: { 'Content-Type': 'application/json' }, ...init })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.error || t('actionFailed'))
    await mutate()
    return body?.data
  }
  const attempt = async (fn: () => Promise<unknown>) => {
    setFailure(null)
    try { await fn() } catch (err) { setFailure(err instanceof Error ? err.message : t('actionFailed')) }
  }

  const submitName = () => {
    if (!naming) return
    const value = naming.value.trim()
    setNaming(null)
    if (!value) return
    void attempt(() => naming.action === 'rename'
      ? call(`${DOCUMENT_FOLDERS_ENDPOINT}/${naming.folderId}`, { method: 'PATCH', body: JSON.stringify({ nom: value }) })
      : call(DOCUMENT_FOLDERS_ENDPOINT, { method: 'POST', body: JSON.stringify({ accountId, nom: value, parentId: naming.folderId }) }))
  }

  const merge = (from: GedFolder, into: GedFolder) => attempt(async () => {
    if (!confirm(t('mergeConfirm', { from: from.nom, into: into.nom, count: branchCount(folders, from.id) }))) return
    await call(`${DOCUMENT_FOLDERS_ENDPOINT}/${from.id}/merge`, { method: 'POST', body: JSON.stringify({ into: into.id }) })
  })
  const remove = (folder: GedFolder) => attempt(async () => {
    if (!confirm(t('deleteConfirm', { name: folder.nom, count: branchCount(folders, folder.id) }))) return
    await call(`${DOCUMENT_FOLDERS_ENDPOINT}/${folder.id}`, { method: 'DELETE' })
  })

  const dragProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canOrganize || !e.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(target ?? UNFILED)
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); setDragOver(null)
      const drag = readDocumentDrag(e.dataTransfer)
      if (!drag || drag.accountId !== accountId) return
      void attempt(async () => {
        for (const id of drag.ids) await call(`/api/documents/${id}/filing`, { method: 'POST', body: JSON.stringify({ folderId: target }) })
        window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED_EVENT))
      })
    },
  })

  const row = (key: string, href: string, icon: React.ComponentType<{ className?: string }>, label: string, badge: number, active: boolean, extra: Partial<React.ComponentProps<typeof Link>> = {}, depth = 0) => (
    <Link
      key={key}
      href={href}
      onClick={onNavigate}
      title={label}
      data-ged-row={key}
      className={cn(ROW, dragOver === key ? ROW_DRAG : active ? ROW_ACTIVE : ROW_IDLE)}
      {...extra}
    >
      <span className={ICON_COL}>
        <span className="relative inline-flex" style={{ marginLeft: depth * INDENT_PX }}>
          {(() => { const Icon = icon; return <Icon className={cn('w-4 h-4', active && ACCENT.ink)} data-sidebar-icon /> })()}
          <UnreadBadge count={badge} />
        </span>
      </span>
      <span className={cn(ROW_LABEL, collapsed && 'opacity-0')} aria-hidden={collapsed}>
        <span className="flex-1 truncate text-left">{label}</span>
      </span>
    </Link>
  )

  return (
    <div data-ged-tree={accountId}>
      <div className="flex items-center h-7">
        <span className={ICON_COL}><span className="w-4 border-t border-border" /></span>
        <span className={cn(ROW_LABEL, 'text-xs font-semibold text-muted-foreground uppercase tracking-widest', collapsed && 'opacity-0')} aria-hidden={collapsed}>
          <span className="flex-1 truncate">{t('title')}</span>
          {canOrganize && (
            <button type="button" title={t('newFolder')} aria-label={t('newFolder')} data-ged-new-folder
              onClick={e => { e.preventDefault(); setNaming({ action: 'create', folderId: null, value: '' }) }}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]">
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      </div>
      {row(UNFILED, documentsHref(UNFILED), Inbox, t('unfiled'), unfiled, onDocuments && currentFolder === UNFILED, dragProps(null))}
      {rows.map(({ folder, depth }) => row(
        folder.id, documentsHref(folder.id), folder.auto ? Sparkles : folderGlyph(initials.get(folder.id) ?? '?'),
        folder.nom, folder.documents, onDocuments && currentFolder === folder.id,
        { ...dragProps(folder.id), onContextMenu: (e: React.MouseEvent) => { if (!canOrganize) return; e.preventDefault(); setFailure(null); setMenu({ x: e.clientX, y: e.clientY, folder }) } },
        depth,
      ))}
      {naming && !collapsed && (
        <div className={cn(ROW, 'text-foreground')} data-ged-name-input>
          <span className={ICON_COL}><FolderPlus className="w-4 h-4" /></span>
          <span className={ROW_LABEL}>
            <input autoFocus value={naming.value} placeholder={t('folderNamePlaceholder')}
              onChange={e => setNaming({ ...naming, value: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') setNaming(null) }}
              onBlur={() => setNaming(null)}
              className="flex-1 min-w-0 bg-transparent text-sm outline-none border-b border-border focus:border-foreground" />
          </span>
        </div>
      )}
      {error && !collapsed && <p className="px-3 py-1 text-[11px] text-destructive">{t('loadFailed')}</p>}
      {failure && !collapsed && <p className="px-3 py-1 text-[11px] text-destructive" data-ged-error>{failure}</p>}

      {menu && (
        <ContextMenuSurface anchor={menu} onClose={() => setMenu(null)} data-ged-folder-menu={menu.folder.id}>
          <ContextMenuItem itemKey="createChild" icon={<FolderTree className={MENU_ICON} />} label={t('newSubfolder')} enabled onClose={() => setMenu(null)}
            onClick={() => setNaming({ action: 'createChild', folderId: menu.folder.id, value: '' })} />
          <ContextMenuItem itemKey="rename" icon={<Pencil className={MENU_ICON} />} label={t('rename')} enabled onClose={() => setMenu(null)}
            onClick={() => setNaming({ action: 'rename', folderId: menu.folder.id, value: menu.folder.nom })} />
          <ContextMenuSubmenu itemKey="merge" icon={<Merge className={MENU_ICON} />} label={t('mergeInto')} enabled={folders.length > 1}>
            {rows.filter(r => !isWithin(folders, menu.folder.id, r.folder.id)).map(r => (
              <ContextMenuItem key={r.folder.id} itemKey={`merge:${r.folder.id}`} icon={<span className={MENU_ICON} />} label={`${'\u00a0'.repeat(r.depth * 2)}${r.folder.nom}`}
                enabled onClose={() => setMenu(null)} onClick={() => void merge(menu.folder, r.folder)} />
            ))}
          </ContextMenuSubmenu>
          <ContextMenuSeparator />
          <ContextMenuItem itemKey="remove" icon={<Trash2 className={MENU_ICON} />} label={t('delete')} enabled danger onClose={() => setMenu(null)}
            onClick={() => void remove(menu.folder)} />
        </ContextMenuSurface>
      )}
    </div>
  )
}
