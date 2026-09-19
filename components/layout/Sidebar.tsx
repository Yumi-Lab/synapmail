'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Mail, Send, FileText, AlertTriangle, Trash2,
  Folder, Archive, ChevronDown, RefreshCw, Share2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import useSWR from 'swr'
import { useState, useEffect, useRef, useCallback } from 'react'
import { ACCENT, AccountAvatar, UnreadBadge, useAccountAccent } from './AccountAvatar'
import { folderGlyph, folderInitials } from './FolderGlyph'
import { ThinScroll } from './ThinScroll'
import { ACCOUNTS_SETTINGS_HREF } from '@/components/settings/SettingsSidebar'
import type { EmailAccount } from '@/types/account'

/**
 * Single source for the bar's geometry. `AppShell` sizes the <aside> from it and
 * the bar exposes `collapsedWidth` as the CSS var consumed by every icon column,
 * so an icon sits at the exact same x in both states.
 */
export const SIDEBAR = {
  expandedWidth: 256,
  collapsedWidth: 56,
  transitionMs: 180,
  /** Height of one row, published as `--synap-row-h` and consumed by the `ROW` class. */
  rowHeight: 36,
  /** Vertical padding above and below the header row carrying the account. */
  headerPadY: 8,
} as const

/** The bar's surface, as a CSS value: the theme's own sidebar token, so the bar
 *  follows light/dark instead of forcing a dark background. Published on the root
 *  as `--synap-surface` so a badge pinned on an avatar rings itself with the
 *  surface actually behind it, in either theme. */
const SURFACE = 'var(--sidebar)'

const fetcher = (url: string) => fetch(url).then(r => r.json())

type SpecialKey = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive' | null

const SPECIAL_ICONS: Record<NonNullable<SpecialKey>, React.ComponentType<{ className?: string }>> = {
  inbox: Mail,
  sent: Send,
  drafts: FileText,
  spam: AlertTriangle,
  trash: Trash2,
  archive: Archive,
}

const SPECIAL_LABELS: Record<NonNullable<SpecialKey>, string> = {
  inbox: 'inbox',
  sent: 'sent',
  drafts: 'drafts',
  spam: 'spam',
  trash: 'trash',
  archive: 'archive',
}

type FolderItem = { name: string; path: string; special: SpecialKey; unreadCount?: number }


/** Rows drawn while the folder list loads — static placeholders, never a pulse. */
const FOLDER_PLACEHOLDERS = [0, 1, 2, 3, 4]

// One row pattern for every entry of the bar (folder, link, account, action).
const ROW = 'flex w-full items-center h-[var(--synap-row-h)] rounded-lg transition-colors'
// Idle ink is derived from the theme's own foreground rather than the muted token:
// muted-foreground on the light sidebar measures ~3.2:1, under the 4.5:1 floor for
// body text. At 70% opacity the same ink measures 5.8:1 light / 7.0:1 dark — the
// gate recomputes both from the rendered rows, so the floor is enforced, not asserted.
const ROW_IDLE = 'text-foreground/70 hover:text-foreground hover:bg-foreground/[0.06]'
const ROW_ACTIVE = cn(ACCENT.tint, 'text-foreground font-medium')
// Drop target: the same accent, one step stronger — not a second colour.
const ROW_DRAG = cn(ACCENT.tintStrong, 'text-foreground')
// Fixed-width column: never shrinks, so collapsing the bar cannot move an icon.
const ICON_COL = 'shrink-0 flex items-center justify-center w-[var(--synap-icon-col)]'
// Collapsible half of a row: folds to zero width, clipped by its own overflow.
const ROW_LABEL = 'flex-1 min-w-0 flex items-center gap-2 pr-3 text-sm whitespace-nowrap overflow-hidden transition-opacity'
// Right-hand controls of an account row, in pixels — the ONE source both the chevron
// and the share mark are laid out from. The chevron sits INSIDE the row (last child of
// its label) while the mark is an absolute sibling, because a link cannot nest in a
// button: two different flows, so their boxes are only disjoint if they are derived
// from the same numbers rather than hand-tuned apart.
const ACCOUNT_ROW_RIGHT = {
  /** Clearance every row keeps between its content and the bar's right edge. */
  edge: 12,
  /** Box of the fold chevron — present only when there are several accounts. */
  chevron: 28,
  /** Box of the share mark — present only on a shared account's row. */
  mark: 28,
  /** Clearance kept between the two boxes, and between the mark and the text. */
  gap: 8,
} as const

// Columns of an account row, read from its RIGHT edge inwards: chevron, then mark, then
// the text. Every offset below is derived from that single order, so the two boxes cannot
// drift onto each other the way they did when each was padded on its own.

/** Right offset of the share mark: past the edge, and past the chevron when there is one. */
function markRight(withChevron: boolean) {
  const { edge, chevron, gap } = ACCOUNT_ROW_RIGHT
  return edge + (withChevron ? chevron + gap : 0)
}

/** Distance from the row's right edge at which a shared row's text has to stop. */
function textStop(withChevron: boolean) {
  const { mark, gap } = ACCOUNT_ROW_RIGHT
  return markRight(withChevron) + mark + gap
}

/**
 * Right margin the TEXT of a SHARED row gives up, counted from where the row's IN-FLOW
 * content already ends — the edge clearance, plus the chevron column when the row has
 * one. The chevron pushes the text by itself; only the absolute mark has to be reserved
 * for. Padding the whole label for the mark instead would push the chevron out with it,
 * which is exactly how the two controls came to sit on the same 28 px.
 */
function textInset(withChevron: boolean) {
  const { edge, chevron } = ACCOUNT_ROW_RIGHT
  return textStop(withChevron) - edge - (withChevron ? chevron : 0)
}

/**
 * The ONLY sign that an inbox is shared: one monochrome glyph, in a fixed column
 * at the right of the row. It carries its own box, so the name and the email of a
 * shared account start at the exact same x as any other account's. Clicking it
 * goes to where a share is removed, without switching the active account.
 */
function SharedMark({ account, label, withChevron = false, hidden = false }: {
  account: EmailAccount
  label: string
  /** The row also carries a fold chevron: the mark steps one column left of it. */
  withChevron?: boolean
  hidden?: boolean
}) {
  if (!account.isShared) return null
  return (
    <Link
      href={ACCOUNTS_SETTINGS_HREF}
      title={label}
      aria-label={label}
      data-account-shared-mark
      style={{ right: markRight(withChevron), width: ACCOUNT_ROW_RIGHT.mark }}
      className={cn(
        'absolute top-0 h-full flex items-center justify-center',
        'text-muted-foreground hover:text-foreground transition-colors',
        hidden && 'hidden',
      )}
    >
      <Share2 className="w-3.5 h-3.5" />
    </Link>
  )
}

interface SidebarProps {
  /** Mobile drawer only: closes the drawer after a navigation. */
  onClose?: () => void
  collapsed?: boolean
}

/** Icon column + collapsible label — shared by every row so all rows stay aligned. */
function RowBody({
  icon: Icon, iconClassName, label, badge = 0, collapsed,
}: {
  icon: React.ComponentType<{ className?: string }>
  iconClassName?: string
  label: React.ReactNode
  /** Unread count — rendered ON the icon, never as a pill to the right of the label. */
  badge?: number
  collapsed: boolean
}) {
  return (
    <>
      <span className={ICON_COL}>
        <span className="relative inline-flex">
          <Icon className={cn('w-4 h-4', iconClassName)} data-sidebar-icon />
          <UnreadBadge count={badge} />
        </span>
      </span>
      <span
        className={cn(ROW_LABEL, collapsed && 'opacity-0')}
        style={{ transitionDuration: `${SIDEBAR.transitionMs}ms` }}
        aria-hidden={collapsed}
      >
        <span className="flex-1 truncate text-left">{label}</span>
      </span>
    </>
  )
}

export function Sidebar({ onClose, collapsed = false }: SidebarProps) {
  const t = useTranslations('mail')
  const pathname = usePathname()
  const [currentFolder, setCurrentFolder] = useState('INBOX')
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountFilter, setAccountFilter] = useState('')
  const accountBoxRef = useRef<HTMLDivElement>(null)
  const accountButtonRef = useRef<HTMLButtonElement>(null)
  // The popover is fixed-positioned so it escapes the bar when collapsed (56 px).
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      setCurrentFolder(params.get('folder') ?? 'INBOX')
    }
  }, [pathname])

  // Close the account dropdown on outside click / Escape
  useEffect(() => {
    if (!accountOpen) return
    const onDown = (e: MouseEvent) => {
      if (accountBoxRef.current && !accountBoxRef.current.contains(e.target as Node)) setAccountOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAccountOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [accountOpen])

  useEffect(() => {
    if (!accountOpen) setAccountFilter('')
  }, [accountOpen])

  const openAccountMenu = useCallback(() => {
    const rect = accountButtonRef.current?.getBoundingClientRect()
    if (rect) setPopoverPos({ top: rect.bottom + 4, left: rect.left })
    setAccountOpen(o => !o)
  }, [])

  // Active account + the accent it publishes — the same hook the shell's edge toggle
  // subscribes to, so the bar and the button straddling its edge can never disagree.
  const { accounts, activeAccount, colorIndex: accountColorIdx, vars: accentStyle, setActiveAccountId } = useAccountAccent()
  const hasMultipleAccounts = accounts.length > 1
  const resolvedAccountId = activeAccount?.id ?? null

  const totalUnread = accounts.reduce((sum, a) => sum + (a.unreadCount ?? 0), 0)
  const otherUnread = totalUnread - (activeAccount?.unreadCount ?? 0)
  // The list offers the OTHER accounts only: the active one already heads the bar,
  // repeating it as a row would be a line that does nothing.
  const otherAccounts = accounts.filter(acc => acc.id !== activeAccount?.id)
  const filteredAccounts = otherAccounts.filter(acc => {
    const q = accountFilter.trim().toLowerCase()
    return !q || acc.email.toLowerCase().includes(q) || (acc.name ?? '').toLowerCase().includes(q)
  })

  const { data: foldersData, error: foldersError, mutate: mutateFolders } = useSWR<{ data: FolderItem[] }>(
    resolvedAccountId ? `/api/folders?account=${resolvedAccountId}` : '/api/folders',
    fetcher,
    { revalidateOnFocus: false }
  )

  const foldersLoading = !foldersData && !foldersError
  const folders: FolderItem[] = foldersData?.data ?? []
  const specialFolders = folders.filter(f => f.special)
  const customFolders = folders.filter(f => !f.special)
  // Resolved once per list: a folder grows to two letters only when a sibling shares its first.
  const customInitials = folderInitials(customFolders)

  const switchAccount = (id: string) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('synapmail:account-change', { detail: id }))
    }
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active_account_id: id }),
    })
    setActiveAccountId(id)
    setAccountOpen(false)
  }

  const handleFolderClick = (path?: string) => {
    if (path) setCurrentFolder(path)
    onClose?.()
  }

  const handleDragOver = (e: React.DragEvent, path: string) => {
    if (!e.dataTransfer.types.includes('application/synapmail')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverPath(path)
  }

  const handleDragLeave = () => setDragOverPath(null)

  const handleDrop = async (e: React.DragEvent, destinationPath: string) => {
    e.preventDefault()
    setDragOverPath(null)
    const raw = e.dataTransfer.getData('application/synapmail')
    if (!raw) return
    const { uids, accountId, folder } = JSON.parse(raw) as { uids: string[]; accountId: string; folder: string }
    if (!uids?.length || destinationPath === folder) return
    await fetch('/api/messages/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uids, action: 'move', accountId, folder, destination: destinationPath }),
    })
  }

  const folderRow = (
    folder: FolderItem,
    icon: React.ComponentType<{ className?: string }>,
    label: string,
    /** Custom folders hover their full IMAP path — the tile only shows its letters. */
    title: string = label,
  ) => {
    const isActive = pathname.startsWith('/mail') && currentFolder === folder.path
    const isDragOver = dragOverPath === folder.path
    const unread = folder.unreadCount ?? 0
    return (
      <Link
        key={folder.path}
        href={`/mail?folder=${encodeURIComponent(folder.path)}`}
        onClick={() => handleFolderClick(folder.path)}
        onDragOver={e => handleDragOver(e, folder.path)}
        onDragLeave={handleDragLeave}
        onDrop={e => handleDrop(e, folder.path)}
        title={title}
        data-sidebar-row={`folder:${folder.path}`}
        className={cn(ROW, isDragOver ? ROW_DRAG : isActive ? ROW_ACTIVE : ROW_IDLE)}
      >
        <RowBody
          icon={icon}
          iconClassName={isActive ? ACCENT.ink : undefined}
          label={label}
          badge={unread}
          collapsed={collapsed}
        />
      </Link>
    )
  }

  return (
    <div
      className="relative flex flex-col h-full bg-sidebar text-sidebar-foreground"
      style={{
        ['--synap-icon-col' as string]: `${SIDEBAR.collapsedWidth}px`,
        ['--synap-row-h' as string]: `${SIDEBAR.rowHeight}px`,
        ['--synap-surface' as string]: SURFACE,
        ...accentStyle,
      }}
      data-sidebar
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {/* Header — line 1 of the bar: the account. The bar folds from the menu button
          of the application header, not from a control of its own. */}
      {activeAccount && (
        <div
          ref={accountBoxRef}
          className="relative shrink-0"
          style={{ paddingTop: SIDEBAR.headerPadY, paddingBottom: SIDEBAR.headerPadY }}
        >
          <button
            ref={accountButtonRef}
            onClick={hasMultipleAccounts ? openAccountMenu : undefined}
            disabled={!hasMultipleAccounts}
            title={otherUnread > 0 ? t('unreadOtherAccounts', { count: otherUnread }) : t('switchAccount')}
            aria-haspopup={hasMultipleAccounts ? 'menu' : undefined}
            aria-expanded={hasMultipleAccounts ? accountOpen : undefined}
            data-sidebar-row="account"
            className={cn(ROW, ROW_IDLE, !hasMultipleAccounts && 'cursor-default hover:bg-transparent')}
          >
            <span className={ICON_COL}>
              <AccountAvatar
                account={activeAccount}
                colorIndex={accountColorIdx}
                unread={activeAccount.unreadCount ?? 0}
                data-sidebar-icon
              />
            </span>
            <span
              className={cn(ROW_LABEL, collapsed && 'opacity-0')}
              // The label's padding places the CHEVRON, so it stays at the edge clearance
              // whatever else the row carries; the mark's room is taken by the text below.
              style={{
                transitionDuration: `${SIDEBAR.transitionMs}ms`,
                paddingRight: ACCOUNT_ROW_RIGHT.edge,
              }}
              aria-hidden={collapsed}
            >
              <span
                className="flex-1 min-w-0 text-left"
                style={activeAccount.isShared ? { marginRight: textInset(hasMultipleAccounts) } : undefined}
              >
                <span className="block text-sm font-medium text-foreground truncate leading-tight">
                  {activeAccount.name || activeAccount.email}
                </span>
                {activeAccount.name && (
                  <span className="block text-[11px] text-muted-foreground truncate leading-tight">{activeAccount.email}</span>
                )}
              </span>
              {hasMultipleAccounts && (
                <span
                  className="shrink-0 flex items-center justify-center"
                  style={{ width: ACCOUNT_ROW_RIGHT.chevron }}
                  data-account-chevron
                >
                  <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', accountOpen && 'rotate-180')} />
                </span>
              )}
            </span>
          </button>
          <SharedMark
            account={activeAccount}
            label={t('sharedBy', { name: activeAccount.ownerName ?? activeAccount.email })}
            withChevron={hasMultipleAccounts}
            // A collapsed bar shows the bubble alone: nothing may be painted beside it.
            hidden={collapsed}
          />
          {accountOpen && popoverPos && (
            <div
              className={cn(
                'fixed z-50 flex flex-col rounded-xl border border-border overflow-hidden',
                'bg-popover text-popover-foreground', ACCENT.shadow,
              )}
              style={{
                top: popoverPos.top,
                left: popoverPos.left,
                width: SIDEBAR.expandedWidth,
                // The popover is its own surface: republishing the variable here makes the
                // badge's ring take the colour of what is ACTUALLY behind it, instead of
                // the bar's, with no second palette.
                ['--synap-surface' as string]: 'var(--popover)',
                // Fixed positioning takes the popover out of the bar's box, so the
                // accent it inherits would be the page's, not the bar's: republish.
                ...accentStyle,
              }}
              data-account-popover
            >
              {otherAccounts.length > 8 && (
                <div className="p-1.5 border-b border-border">
                  <input
                    autoFocus
                    value={accountFilter}
                    onChange={e => setAccountFilter(e.target.value)}
                    placeholder={t('searchAccounts')}
                    className={cn(
                      'w-full px-2.5 py-1.5 rounded-md bg-foreground/[0.06] text-sm text-foreground',
                      'placeholder:text-muted-foreground outline-none focus:ring-1', ACCENT.ring,
                    )}
                  />
                </div>
              )}
              <ThinScroll className="max-h-[min(60vh,22rem)]" viewportClassName="overscroll-contain py-1">
                {filteredAccounts.length === 0 && (
                  <p className="px-3 py-4 text-xs text-muted-foreground text-center">{t('noAccountMatch')}</p>
                )}
                {filteredAccounts.map(acc => {
                  const unread = acc.unreadCount ?? 0
                  return (
                    // The row is a button, the shared mark is a link: a link nested in a
                    // button is invalid HTML, so they are siblings and the mark sits in
                    // the gutter the row reserves for it (textInset). A list row never
                    // carries a chevron, so it reserves for the mark alone.
                    <div key={acc.id} className="relative">
                      <button
                        onClick={() => switchAccount(acc.id)}
                        // Every row has the same box: a fixed bubble, one gap, then the text —
                        // so all names and emails of the list start at the exact same x.
                        className={cn(ROW, ROW_IDLE, 'gap-2.5 px-3 rounded-none text-left')}
                        style={acc.isShared ? { paddingRight: ACCOUNT_ROW_RIGHT.edge + textInset(false) } : undefined}
                      >
                        <AccountAvatar
                          account={acc}
                          colorIndex={accounts.indexOf(acc)}
                          unread={unread}
                          size="md"
                        />
                        <span className="flex-1 min-w-0 text-left">
                          <span className="block text-sm font-medium truncate leading-tight">{acc.name || acc.email}</span>
                          {acc.name && (
                            <span className="block text-[11px] text-muted-foreground truncate leading-tight">{acc.email}</span>
                          )}
                        </span>
                      </button>
                      <SharedMark account={acc} label={t('sharedBy', { name: acc.ownerName ?? acc.email })} />
                    </div>
                  )
                })}
              </ThinScroll>
            </div>
          )}
        </div>
      )}

      {/* Folders */}
      <ThinScroll className="flex-1 mt-1" viewportClassName="overscroll-contain">
        <nav>
        {foldersLoading && FOLDER_PLACEHOLDERS.map(i => (
          <div key={i} className={ROW} aria-hidden>
            <span className={ICON_COL}><span className="w-4 h-4 rounded bg-foreground/[0.08]" /></span>
            <span className={cn(ROW_LABEL, collapsed && 'opacity-0')}>
              <span className="h-3 flex-1 rounded bg-foreground/[0.08]" />
            </span>
          </div>
        ))}
        {foldersError && (
          <button
            onClick={() => mutateFolders()}
            title={t('retry')}
            data-sidebar-row="folders-error"
            className={cn(ROW, 'text-destructive/70 hover:text-destructive hover:bg-destructive/10')}
          >
            <RowBody icon={RefreshCw} label={t('foldersError')} collapsed={collapsed} />
          </button>
        )}
        {!foldersLoading && !foldersError && specialFolders.map(folder =>
          folderRow(folder, SPECIAL_ICONS[folder.special!] ?? Folder, t(SPECIAL_LABELS[folder.special!]))
        )}

        {customFolders.length > 0 && (
          <>
            <div className="flex items-center h-7">
              <span className={ICON_COL}><span className="w-4 border-t border-border" /></span>
              <span
                className={cn(ROW_LABEL, 'text-xs font-semibold text-muted-foreground uppercase tracking-widest', collapsed && 'opacity-0')}
                style={{ transitionDuration: `${SIDEBAR.transitionMs}ms` }}
                aria-hidden={collapsed}
              >
                <span className="flex-1 truncate">{t('folders')}</span>
              </span>
            </div>
            {customFolders.map(folder =>
              folderRow(folder, folderGlyph(customInitials.get(folder.path) ?? '?'), folder.name, folder.path)
            )}
          </>
        )}
        </nav>
      </ThinScroll>

    </div>
  )
}
