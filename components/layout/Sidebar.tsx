'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Mail, Send, FileText, AlertTriangle, Trash2,
  Settings, PenSquare, Folder, Archive, Menu, ChevronDown, RefreshCw,
  LayoutDashboard, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import useSWR from 'swr'
import { useState, useEffect, useRef, useCallback } from 'react'
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
} as const

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

const dispatchCompose = () => window.dispatchEvent(new CustomEvent('synapmail:compose'))

const ACCOUNT_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500']

// One row pattern for every entry of the bar (folder, link, account, action).
const ROW = 'flex w-full items-center h-9 rounded-lg transition-colors'
const ROW_IDLE = 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]'
const ROW_ACTIVE = 'bg-violet-500/15 text-white ring-1 ring-inset ring-violet-500/20'
const ROW_DRAG = 'bg-violet-500/25 ring-1 ring-inset ring-violet-400/50 text-white'
// Fixed-width column: never shrinks, so collapsing the bar cannot move an icon.
const ICON_COL = 'shrink-0 flex items-center justify-center w-[var(--synap-icon-col)]'
// Collapsible half of a row: folds to zero width, clipped by its own overflow.
const ROW_LABEL = 'flex-1 min-w-0 flex items-center gap-2 pr-3 text-sm whitespace-nowrap overflow-hidden transition-opacity'

interface SidebarProps {
  onClose?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

/** Icon column + collapsible label — shared by every row so all rows stay aligned. */
function RowBody({
  icon: Icon, iconClassName, label, trailing, collapsed,
}: {
  icon: React.ComponentType<{ className?: string }>
  iconClassName?: string
  label: React.ReactNode
  trailing?: React.ReactNode
  collapsed: boolean
}) {
  return (
    <>
      <span className={ICON_COL}>
        <Icon className={cn('w-4 h-4', iconClassName)} />
      </span>
      <span
        className={cn(ROW_LABEL, collapsed && 'opacity-0')}
        style={{ transitionDuration: `${SIDEBAR.transitionMs}ms` }}
        aria-hidden={collapsed}
      >
        <span className="flex-1 truncate text-left">{label}</span>
        {trailing}
      </span>
    </>
  )
}

export function Sidebar({ onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
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
  // Populated from /api/settings after mount (see effect below) rather than in the
  // initializer, so the server and first client render match (no hydration mismatch).
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)

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

  const { data: settingsData } = useSWR<{ data: { active_account_id: string | null } }>('/api/settings', fetcher)
  useEffect(() => {
    if (settingsData?.data?.active_account_id) setActiveAccountId(settingsData.data.active_account_id)
  }, [settingsData])

  useEffect(() => {
    const handler = (e: Event) => {
      setActiveAccountId((e as CustomEvent<string>).detail)
    }
    window.addEventListener('synapmail:account-change', handler)
    return () => window.removeEventListener('synapmail:account-change', handler)
  }, [])

  // refreshInterval keeps the per-account unread counts fresh even while the
  // switcher is closed (counts come from messages_cache — see GET /api/accounts).
  const { data: accountsData } = useSWR<{ data: EmailAccount[] }>(
    '/api/accounts',
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 60000 }
  )

  const accounts = accountsData?.data ?? []
  const hasMultipleAccounts = accounts.length > 1
  const activeAccount = accounts.find(a => a.id === activeAccountId) ?? accounts.find(a => a.isDefault) ?? accounts[0]
  const resolvedAccountId = activeAccount?.id ?? null
  const accountColorIdx = activeAccount ? accounts.indexOf(activeAccount) % ACCOUNT_COLORS.length : 0

  const totalUnread = accounts.reduce((sum, a) => sum + (a.unreadCount ?? 0), 0)
  const otherUnread = totalUnread - (activeAccount?.unreadCount ?? 0)
  const filteredAccounts = accounts.filter(acc => {
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

  const folderRow = (folder: FolderItem, icon: React.ComponentType<{ className?: string }>, label: string) => {
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
        title={label}
        data-sidebar-row={`folder:${folder.path}`}
        className={cn(ROW, isDragOver ? ROW_DRAG : isActive ? ROW_ACTIVE : ROW_IDLE)}
      >
        <RowBody
          icon={icon}
          iconClassName={isActive ? 'text-violet-300' : undefined}
          label={label}
          collapsed={collapsed}
          trailing={unread > 0 ? (
            <span className={cn(
              'shrink-0 text-[11px] font-semibold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center',
              isActive ? 'bg-white/20 text-white' : 'bg-violet-500/20 text-violet-300'
            )}>
              {unread > 99 ? '99+' : unread}
            </span>
          ) : undefined}
        />
      </Link>
    )
  }

  return (
    <div
      className="relative flex flex-col h-full bg-gradient-to-b from-zinc-900 via-zinc-950 to-black"
      style={{ ['--synap-icon-col' as string]: `${SIDEBAR.collapsedWidth}px` }}
      data-sidebar
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {/* Hamburger — collapses the bar on desktop, closes the drawer on mobile */}
      <div className="py-2">
        <button
          onClick={onClose ?? onToggleCollapse}
          title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          data-sidebar-row="toggle"
          className={cn(ROW, ROW_IDLE)}
        >
          <span className={ICON_COL}>
            <Menu className="w-4 h-4" />
          </span>
        </button>
      </div>

      {/* Account switcher */}
      {hasMultipleAccounts && activeAccount && (
        <div ref={accountBoxRef} className="relative">
          <button
            ref={accountButtonRef}
            onClick={openAccountMenu}
            title={otherUnread > 0 ? t('unreadOtherAccounts', { count: otherUnread }) : activeAccount.email}
            data-sidebar-row="account"
            className={cn(ROW, ROW_IDLE)}
          >
            <span className={ICON_COL}>
              <span className={cn('w-7 h-7 rounded-full', ACCOUNT_COLORS[accountColorIdx])} />
            </span>
            <span
              className={cn(ROW_LABEL, collapsed && 'opacity-0')}
              style={{ transitionDuration: `${SIDEBAR.transitionMs}ms` }}
              aria-hidden={collapsed}
            >
              <span className="flex-1 min-w-0 text-left">
                <span className="block text-sm font-medium text-zinc-100 truncate leading-tight">
                  {activeAccount.name || activeAccount.email}
                </span>
                {activeAccount.name && (
                  <span className="block text-[11px] text-zinc-500 truncate leading-tight">{activeAccount.email}</span>
                )}
              </span>
              {otherUnread > 0 && (
                <span className="shrink-0 text-[11px] font-semibold min-w-[20px] h-5 px-1.5 rounded-full bg-violet-500/20 text-violet-300 flex items-center justify-center">
                  {otherUnread > 99 ? '99+' : otherUnread}
                </span>
              )}
              <ChevronDown className={cn('w-3.5 h-3.5 text-zinc-500 transition-transform shrink-0', accountOpen && 'rotate-180')} />
            </span>
          </button>
          {accountOpen && popoverPos && (
            <div
              className="fixed z-50 flex flex-col rounded-xl border border-white/10 bg-zinc-900 shadow-xl shadow-black/60 overflow-hidden"
              style={{ top: popoverPos.top, left: popoverPos.left, width: SIDEBAR.expandedWidth }}
            >
              {accounts.length > 8 && (
                <div className="p-1.5 border-b border-white/10">
                  <input
                    autoFocus
                    value={accountFilter}
                    onChange={e => setAccountFilter(e.target.value)}
                    placeholder={t('searchAccounts')}
                    className="w-full px-2.5 py-1.5 rounded-md bg-white/[0.06] text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:ring-1 focus:ring-violet-500/50"
                  />
                </div>
              )}
              <div className="max-h-[min(60vh,22rem)] overflow-y-auto overscroll-contain py-1">
                {filteredAccounts.length === 0 && (
                  <p className="px-3 py-4 text-xs text-zinc-500 text-center">{t('noAccountMatch')}</p>
                )}
                {filteredAccounts.map(acc => {
                  const active = acc.id === activeAccount?.id
                  const unread = acc.unreadCount ?? 0
                  return (
                    <button
                      key={acc.id}
                      onClick={() => switchAccount(acc.id)}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                        active ? 'bg-violet-500/10 text-white' : 'text-zinc-400 hover:text-zinc-100 hover:bg-violet-500/10'
                      )}
                    >
                      <span className={cn('w-8 h-8 rounded-full shrink-0', ACCOUNT_COLORS[accounts.indexOf(acc) % ACCOUNT_COLORS.length])} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate leading-tight">{acc.name || acc.email}</span>
                        {acc.name && (
                          <span className="block text-[11px] text-zinc-500 truncate leading-tight">{acc.email}</span>
                        )}
                      </span>
                      {unread > 0 && (
                        <span className="shrink-0 text-[11px] font-semibold min-w-[20px] h-5 px-1.5 rounded-full bg-violet-500/20 text-violet-300 flex items-center justify-center">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                      {active && <Check className="w-3.5 h-3.5 shrink-0 text-violet-400" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Compose */}
      <div className="py-2">
        <button
          onClick={dispatchCompose}
          title={t('compose')}
          data-sidebar-row="compose"
          className={cn(ROW, 'bg-violet-500 text-white font-semibold hover:bg-violet-400')}
        >
          <RowBody icon={PenSquare} label={t('compose')} collapsed={collapsed} />
        </button>
      </div>

      {/* Dashboard */}
      <Link
        href="/dashboard"
        onClick={() => handleFolderClick()}
        title={t('dashboard')}
        data-sidebar-row="dashboard"
        className={cn(ROW, pathname.startsWith('/dashboard') ? ROW_ACTIVE : ROW_IDLE)}
      >
        <RowBody
          icon={LayoutDashboard}
          iconClassName={pathname.startsWith('/dashboard') ? 'text-violet-300' : undefined}
          label={t('dashboard')}
          collapsed={collapsed}
        />
      </Link>

      {/* Folders */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden mt-1">
        {foldersLoading && [1, 2, 3, 4, 5].map(i => (
          <div key={i} className={ROW}>
            <span className={ICON_COL}><span className="w-4 h-4 rounded bg-muted/40 animate-pulse" /></span>
            <span className={cn(ROW_LABEL, collapsed && 'opacity-0')}>
              <span className="h-3 flex-1 rounded bg-muted/40 animate-pulse" />
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
              <span className={ICON_COL}><span className="w-4 border-t border-white/10" /></span>
              <span
                className={cn(ROW_LABEL, 'text-xs font-semibold text-zinc-500 uppercase tracking-widest', collapsed && 'opacity-0')}
                style={{ transitionDuration: `${SIDEBAR.transitionMs}ms` }}
                aria-hidden={collapsed}
              >
                <span className="flex-1 truncate">{t('folders')}</span>
              </span>
            </div>
            {customFolders.map(folder => folderRow(folder, Folder, folder.name))}
          </>
        )}
      </nav>

      {/* Footer — the theme toggle slot goes here at integration time */}
      <div className="border-t border-white/10 py-1">
        <Link
          href="/settings"
          onClick={() => handleFolderClick()}
          title={t('settings')}
          data-sidebar-row="settings"
          className={cn(ROW, ROW_IDLE)}
        >
          <RowBody icon={Settings} label={t('settings')} collapsed={collapsed} />
        </Link>
      </div>
    </div>
  )
}
