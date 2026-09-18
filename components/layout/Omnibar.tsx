'use client'

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LayoutGrid, Menu, PenSquare, Search, Settings, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAIL_PATH, openCompose } from '@/lib/compose'
import { SIDEBAR } from './Sidebar'
import {
  SCOPE_ALL, SCOPE_FOLDER, SCOPE_PARAM, SEARCH_DEBOUNCE_MS, SEARCH_FOCUS_EVENT, SEARCH_PARAM,
  buildSearchHref, readScope, type SearchScope,
} from '@/lib/search'

/**
 * Single source for the header's geometry. `AppShell` mounts the bar from it and
 * the gate script reads the same numbers out of this file, so the shipped height
 * and the measured height can never drift apart.
 */
export const OMNIBAR = {
  height: 44,
  /** The field is bounded: it never stretches from one edge of the window to the other. */
  searchMaxWidth: 640,
  /**
   * Space kept free on EACH side of the centred field, for the actions on the left
   * and the scope toggle on the right. The field is centred on the header, so it can
   * only be as wide as the header minus twice this reserve: that is what keeps a
   * mathematically centred field from ever running under either group.
   */
  sideReserve: 200,
  /**
   * Gap left between the sidebar's round collapse toggle — which straddles the
   * header's left edge, half of it overlapping the header — and the first action.
   * Derived from the button's own size, so resizing the button re-inflates the
   * inset instead of silently re-creating the overlap.
   */
  edgeClearance: SIDEBAR.edgeButtonSize / 2 + 8,
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
 * The field is the app's ONLY search input: it writes the query into the mailbox
 * URL (`/mail?q=…&scope=…`), which the message list reads back. No component
 * keeps a second copy of the query, from any page.
 */
function OmnibarInner({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const t = useTranslations('mail')
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  const urlQuery = searchParams.get(SEARCH_PARAM) ?? ''
  const scope = readScope(searchParams.get(SCOPE_PARAM))
  const [query, setQuery] = useState(urlQuery)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // L'URL reste la source : une navigation (retour arrière, lien, changement de
  // dossier) réaligne le champ, qui n'en garde jamais une version divergente.
  useEffect(() => setQuery(urlQuery), [urlQuery])

  const submit = useCallback((next: string, nextScope: SearchScope) => {
    const href = buildSearchHref(searchParams.toString(), next, nextScope)
    // Depuis la boîte, remplacer l'entrée d'historique : la frappe ne doit pas
    // empiler une entrée par caractère. Depuis ailleurs, on y navigue vraiment.
    if (pathname === MAIL_PATH) router.replace(href)
    else router.push(href)
  }, [pathname, router, searchParams])

  // Frappe → URL, débounce partagé avec l'ancien champ de la liste.
  const onQueryChange = (next: string) => {
    setQuery(next)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => submit(next, scope), SEARCH_DEBOUNCE_MS)
  }

  const clear = () => {
    if (debounce.current) clearTimeout(debounce.current)
    setQuery('')
    submit('', scope)
  }

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

  // The app-wide shortcut hook bails out on any modifier (hooks/useKeyboardShortcuts.ts),
  // so the field owns its own listener. Works from anywhere, including from another field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    const onFocusRequest = () => { inputRef.current?.focus(); inputRef.current?.select() }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(SEARCH_FOCUS_EVENT, onFocusRequest)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(SEARCH_FOCUS_EVENT, onFocusRequest)
    }
  }, [])

  return (
    <header
      data-omnibar
      className="relative shrink-0 flex items-center gap-2 border-b border-border bg-background
        px-2 sm:px-3 lg:pl-[var(--synap-omnibar-inset)]"
      style={{
        height: OMNIBAR.height,
        // Only at `lg`, where the round toggle is mounted: below it the drawer's
        // hamburger owns that spot and the plain padding is the right one.
        ['--synap-omnibar-inset' as string]: `${OMNIBAR.edgeClearance}px`,
      }}
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
      <div className="flex shrink-0 items-center gap-0.5">
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

      {/* Centred on the header itself — not on what is left between the two groups,
          which would drift with their width. Percentages resolve against the header. */}
      <div
        data-omnibar-search-field
        className="relative flex flex-1 min-w-0 items-center
          sm:absolute sm:left-1/2 sm:top-1/2 sm:flex-none sm:-translate-x-1/2 sm:-translate-y-1/2
          sm:w-[var(--synap-omnibar-field-w)]"
        style={{
          maxWidth: OMNIBAR.searchMaxWidth,
          ['--synap-omnibar-field-w' as string]:
            `min(${OMNIBAR.searchMaxWidth}px, calc(100% - ${OMNIBAR.sideReserve * 2}px))`,
        }}
      >
        <Search className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              if (debounce.current) clearTimeout(debounce.current)
              submit(e.currentTarget.value, scope)
              return
            }
            if (e.key !== 'Escape') return
            clear()
            e.currentTarget.blur()
          }}
          placeholder={t('searchMail')}
          aria-label={t('searchMail')}
          data-omnibar-search
          className="w-full h-8 pl-8 pr-12 text-xs rounded-lg border border-border bg-muted/50
            placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {query ? (
          <button
            type="button"
            onClick={clear}
            title={t('clearSearch')}
            aria-label={t('clearSearch')}
            data-omnibar-search-clear
            className="absolute right-2 text-muted-foreground hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <kbd className="absolute right-2 hidden sm:block text-[10px] text-muted-foreground pointer-events-none">
            ⌘K
          </kbd>
        )}
      </div>

      {/* Étendue de la recherche — n'apparaît que pendant une recherche, une seule ligne, deux positions */}
      {query && (
        <div className="hidden sm:flex ml-auto shrink-0 items-center rounded-lg border border-border bg-muted/50 p-0.5 text-[11px]">
          {([SCOPE_FOLDER, SCOPE_ALL] as const).map(value => (
            <button
              key={value}
              type="button"
              onClick={() => {
                if (debounce.current) clearTimeout(debounce.current)
                submit(query, value)
              }}
              data-omnibar-scope={value}
              aria-pressed={scope === value}
              className={cn(
                'px-2 h-6 rounded-md transition-colors',
                scope === value ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(value === SCOPE_ALL ? 'searchAllFolders' : 'searchThisFolder')}
            </button>
          ))}
        </div>
      )}

    </header>
  )
}

/**
 * `useSearchParams` impose une frontière Suspense (convention du dépôt) : la
 * barre est rendue derrière un repli de la bonne hauteur, jamais de saut.
 */
export function Omnibar(props: { onOpenDrawer: () => void }) {
  return (
    <Suspense fallback={<div className="shrink-0 border-b border-border bg-background" style={{ height: OMNIBAR.height }} />}>
      <OmnibarInner {...props} />
    </Suspense>
  )
}
