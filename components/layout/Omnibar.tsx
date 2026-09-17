'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LayoutGrid, Menu, PenSquare, Search, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { openCompose } from '@/lib/compose'

/**
 * Single source for the header's geometry. `AppShell` mounts the bar from it and
 * the gate script reads the same numbers out of this file, so the shipped height
 * and the measured height can never drift apart.
 */
export const OMNIBAR = {
  height: 44,
  /** The field is bounded: it never stretches from one edge of the window to the other. */
  searchMaxWidth: 640,
} as const

/** One motif for the three actions — monochrome icon, label on hover, no filled button. */
const ACTION = 'w-8 h-8 shrink-0 flex items-center justify-center rounded-lg ' +
  'text-foreground/70 hover:text-foreground hover:bg-foreground/[0.06] transition-colors'

const ICON = 'w-[18px] h-[18px]'

/**
 * Application header, full window width, above the sidebar and the content: global
 * search on the left, transverse actions on the right. On mobile it replaces the
 * former top bar and carries the drawer's hamburger.
 *
 * O1 ships the field, its shortcuts and its geometry; wiring the query to the
 * message list is lot O2.
 */
export function Omnibar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const t = useTranslations('mail')
  const pathname = usePathname()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  // The app-wide shortcut hook bails out on any modifier (hooks/useKeyboardShortcuts.ts),
  // so the field owns its own listener. Works from anywhere, including from another field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <header
      data-omnibar
      className="shrink-0 flex items-center gap-2 border-b border-border bg-background px-2 sm:px-3"
      style={{ height: OMNIBAR.height }}
    >
      <button
        type="button"
        onClick={onOpenDrawer}
        title={t('openMenu')}
        aria-label={t('openMenu')}
        data-omnibar-menu
        className={cn(ACTION, 'lg:hidden')}
      >
        <Menu className={ICON} />
      </button>

      <div
        className="relative flex flex-1 min-w-0 items-center"
        style={{ maxWidth: OMNIBAR.searchMaxWidth }}
      >
        <Search className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Escape') return
            setQuery('')
            e.currentTarget.blur()
          }}
          placeholder={t('searchMail')}
          aria-label={t('searchMail')}
          data-omnibar-search
          className="w-full h-8 pl-8 pr-12 text-xs rounded-lg border border-border bg-muted/50
            placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <kbd className="absolute right-2 hidden sm:block text-[10px] text-muted-foreground pointer-events-none">
          ⌘K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <Link href="/dashboard" title={t('dashboard')} aria-label={t('dashboard')} data-omnibar-action="dashboard" className={ACTION}>
          <LayoutGrid className={ICON} />
        </Link>
        <button
          type="button"
          onClick={() => openCompose(pathname, router.push)}
          title={t('compose')}
          aria-label={t('compose')}
          data-omnibar-action="compose"
          className={ACTION}
        >
          <PenSquare className={ICON} />
        </button>
        <Link href="/settings" title={t('settings')} aria-label={t('settings')} data-omnibar-action="settings" className={ACTION}>
          <Settings className={ICON} />
        </Link>
      </div>
    </header>
  )
}
