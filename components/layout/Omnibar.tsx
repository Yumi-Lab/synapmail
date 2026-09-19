'use client'

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LayoutGrid, Menu, PenSquare, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UserMenu } from './UserMenu'
import { MailToolbar, MailToolbarLead } from './MailToolbar'
import { IconTooltip } from '@/components/ui/IconTooltip'
import { MAIL_PATH, openCompose } from '@/lib/compose'
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
   * Floor the field never goes under. Since lot H3 the field shares the row with the
   * mail toolbar instead of being centred on the header: it takes the space left, so
   * it needs a floor rather than a reserve — below it, the toolbar folds groups into
   * its « … » menu (it measures, it does not guess a breakpoint).
   *
   * Mesuré à 390 px (gate H3 du 19/09) : à 200 px ce plancher ne laissait que 14 px
   * à la barre d'outils, dont le bouton « … » fait 32 px — il débordait sous le
   * champ. À 140 px la barre reçoit la place de son bouton, le champ reste saisissable.
   */
  searchMinWidth: 140,
  /**
   * Écart fixe entre la dernière icône de la barre d'outils et le champ (px).
   * Lot H3c : le champ ne se centre plus dans la place restante — il se colle à la
   * barre, et l'espace libre part à sa DROITE, avant la bulle du compte.
   */
  searchGap: 12,
  /**
   * Width at and above which the bar is a column of its own rather than a drawer —
   * Tailwind's default `lg`, the same breakpoint `AppShell` folds the <aside> on
   * (`hidden lg:flex`). The header's single menu button reads it to know whether a
   * click folds the bar or opens the drawer.
   */
  desktopQuery: '(min-width: 1024px)',
} as const

/** One motif for the three actions — monochrome icon, label on hover, no filled button. */
const ACTION = 'w-8 h-8 shrink-0 flex items-center justify-center rounded-lg ' +
  'text-foreground/70 hover:text-foreground hover:bg-foreground/[0.06] transition-colors'

const ICON = 'w-[18px] h-[18px]'

/** Raccourci affiché dans l'infobulle de « Nouveau message » — la touche que `useKeyboardShortcuts` écoute. */
const COMPOSE_SHORTCUT = 'C'
/** Raccourci du champ de recherche, déjà rendu dans le champ lui-même. */
const SEARCH_SHORTCUT = '⌘K'

/**
 * Application header, above the content column only — the bar owns the full height
 * and the header starts at its right edge. Menu button then transverse actions on
 * the left, global search centred. The menu button is the app's ONLY bar control:
 * it folds the bar on the desktop and opens the drawer on mobile.
 *
 * The field is the app's ONLY search input: it writes the query into the mailbox
 * URL (`/mail?q=…&scope=…`), which the message list reads back. No component
 * keeps a second copy of the query, from any page.
 */
type OmnibarProps = {
  /** Folds the bar at `lg` and above, opens the drawer below it — `AppShell` picks. */
  onMenu: () => void
  menuLabel: string
  /** Whether the thing the button controls (bar or drawer) is currently open. */
  menuExpanded: boolean
}

function OmnibarInner({ onMenu, menuLabel, menuExpanded }: OmnibarProps) {
  const t = useTranslations('mail')
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  const urlQuery = searchParams.get(SEARCH_PARAM) ?? ''
  const scope = readScope(searchParams.get(SCOPE_PARAM))
  const [query, setQuery] = useState(urlQuery)
  const onMail = pathname === MAIL_PATH
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
      className="relative shrink-0 flex items-center border-b border-border bg-background px-2 sm:px-3"
      style={{ height: OMNIBAR.height }}
    >
      {/* gap-1 : deux boîtes cliquables voisines gardent 4 px d'écart, le plancher
          que le gate mesure — rien ne se touche ni ne se recouvre, même à 390 px. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconTooltip label={menuLabel} align="start">
          <button
            type="button"
            onClick={onMenu}
            aria-label={menuLabel}
            aria-expanded={menuExpanded}
            data-omnibar-menu
            className={ACTION}
          >
            <Menu className={ICON} />
          </button>
        </IconTooltip>
        <IconTooltip label={t('dashboard')} align="start">
          <Link href="/dashboard" aria-label={t('dashboard')} data-omnibar-action="dashboard" className={ACTION}>
            <LayoutGrid className={ICON} />
          </Link>
        </IconTooltip>
        {/* Lot H3c : « Relever » passe AVANT « Nouveau message » (demande de Nicolas).
            Sa définition reste celle de MAIL_TOOLBAR_GROUPS — seul l'endroit où le
            header la rend change ; le menu « … » la garde en tête. */}
        {onMail && <MailToolbarLead />}
        <IconTooltip label={t('compose')} shortcut={COMPOSE_SHORTCUT}>
          <button
            type="button"
            onClick={() => openCompose(pathname, router.push)}
            aria-label={t('compose')}
            data-omnibar-action="compose"
            className={ACTION}
          >
            <PenSquare className={ICON} />
          </button>
        </IconTooltip>
      </div>

      {/* Lot H3c : barre d'outils et champ partagent UNE rangée qui porte le `flex-1`.
          La barre y garde sa largeur naturelle (`shrink-0`) et le champ prend ce qui
          reste, borné : le champ se colle donc à la dernière icône, et la place en
          trop tombe APRÈS lui — plus jamais entre la barre et le champ. */}
      <div className="flex min-w-0 flex-1 items-center">
        {/* Hors de la boîte, rien à griser : le groupe courrier n'existe pas. */}
        {onMail && <MailToolbar />}

      <div
        data-omnibar-search-field
        className="relative flex min-w-0 flex-1 items-center"
        style={{
          maxWidth: OMNIBAR.searchMaxWidth,
          minWidth: OMNIBAR.searchMinWidth,
          marginLeft: OMNIBAR.searchGap,
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
          <IconTooltip label={t('clearSearch')} align="end">
            <button
              type="button"
              onClick={clear}
              aria-label={t('clearSearch')}
              data-omnibar-search-clear
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </IconTooltip>
        ) : (
          <kbd className="absolute right-2 top-1/2 hidden -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none sm:block">
            {SEARCH_SHORTCUT}
          </kbd>
        )}
      </div>
      </div>

      {/* Right-hand group: the scope toggle only while searching, then the signed-in
          user. One group, so the field's side reserve has a single thing to clear. */}
      {/* `ml-auto` depuis le lot H3c : le champ ne porte plus de marges automatiques,
          c'est donc CE groupe qui absorbe l'espace libre et reste collé au bord droit. */}
      <div data-omnibar-right className="ml-auto flex shrink-0 items-center gap-2 pl-2">
      {/* Étendue de la recherche — n'apparaît que pendant une recherche, une seule ligne, deux positions */}
      {query && (
        <div className="hidden sm:flex shrink-0 items-center rounded-lg border border-border bg-muted/50 p-0.5 text-[11px]">
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

        <UserMenu />
      </div>
    </header>
  )
}

/**
 * `useSearchParams` impose une frontière Suspense (convention du dépôt) : la
 * barre est rendue derrière un repli de la bonne hauteur, jamais de saut.
 */
export function Omnibar(props: OmnibarProps) {
  return (
    <Suspense fallback={<div className="shrink-0 border-b border-border bg-background" style={{ height: OMNIBAR.height }} />}>
      <OmnibarInner {...props} />
    </Suspense>
  )
}
