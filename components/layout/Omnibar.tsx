'use client'

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LayoutGrid, Languages, Menu, Monitor, Moon, PenSquare, Search, Sun, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UserMenu } from './UserMenu'
import { MailToolbar, MailToolbarLead } from './MailToolbar'
import { AccountAvatar, useAccountAccent } from './AccountAvatar'
import { IconTooltip } from '@/components/ui/IconTooltip'
import { SETTINGS_NAV } from '@/components/settings/SettingsSidebar'
import { useTheme } from '@/components/theme/ThemeProvider'
import { THEMES, type Theme } from '@/lib/theme'
import { LOCALES, setLocale } from '@/lib/locales'
import { OMNIBAR_SECTIONS, matchOmnibar, type OmnibarEntry, type OmnibarSection } from '@/lib/omnibarCommands'
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

/**
 * Panneau de l'omnibar (lot H3f) : une ligne, un motif. Meme surface que le menu
 * du compte (`rounded-xl`, bordure, ombre) pour que les deux deroulants du header
 * ne soient pas deux objets differents.
 */
const PANEL_ROW = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors'
const PANEL_ROW_IDLE = 'text-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground'
/** Ligne sous le curseur clavier : la MEME peinture qu'un survol, pour un seul vocabulaire. */
const PANEL_ROW_ACTIVE = 'bg-foreground/[0.06] text-foreground'
const PANEL_SECTION = 'px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70'

/** Le titre de chaque section, traduit — une cle par section, pas de `if` en cascade. */
const SECTION_LABEL: Record<OmnibarSection, 'sectionAccounts' | 'sectionActions' | 'sectionSettings'> = {
  accounts: 'sectionAccounts',
  actions: 'sectionActions',
  settings: 'sectionSettings',
}

/** L'icone d'un mode de theme, meme table que le selecteur de `ThemeToggle`. */
const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const
function ThemeGlyph({ theme }: { theme: Theme }) {
  const Icon = THEME_ICONS[theme]
  return <Icon className={ICON} />
}

/** Prefixes des identifiants d'entree : ce que le banc designe, jamais une chaine libre. */
const ENTRY = { account: 'account', action: 'action', settings: 'settings' } as const

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
    // Des le PREMIER caractere le panneau se deroule ; le curseur repart a « aucun
    // choix », pour qu'Entree reste la recherche de courrier tant qu'on n'a pas
    // descendu dans la liste (comportement par defaut inchange).
    setPanelOpen(next.length > 0)
    setPanelIndex(-1)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => submit(next, scope), SEARCH_DEBOUNCE_MS)
  }

  const clear = () => {
    if (debounce.current) clearTimeout(debounce.current)
    setQuery('')
    closePanel()
    submit('', scope)
  }

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])

  // --- Lot H3f : tout ce que l'omnibar sait proposer en plus du courrier ---
  const tOmni = useTranslations('omnibar')
  const tNav = useTranslations('settings.nav')
  const { setTheme } = useTheme()
  const { accounts, switchAccount } = useAccountAccent()
  const [panelIndex, setPanelIndex] = useState(-1)
  const [panelOpen, setPanelOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * Les entrees proposables, et ce que chacune FAIT. Une seule table : le libelle,
   * les mots-cles et l'action vivent sur la meme ligne, donc une entree ne peut pas
   * etre trouvable sans etre activable. Les reglages viennent de SETTINGS_NAV
   * (source unique partagee avec la barre des reglages), jamais d'une copie.
   */
  const commands: (OmnibarEntry & { icon: ReactNode; run: () => void })[] = [
    ...accounts.map((acc, rank) => ({
      id: `${ENTRY.account}:${acc.id}`,
      section: 'accounts' as const,
      label: acc.name || acc.email,
      hint: acc.email,
      icon: <AccountAvatar account={acc} colorIndex={rank} unread={0} />,
      run: () => { switchAccount(acc.id); if (!onMail) router.push(MAIL_PATH) },
    })),
    {
      id: `${ENTRY.action}:dashboard`,
      section: 'actions' as const,
      label: t('dashboard'),
      keywords: tOmni('dashboardKeywords'),
      icon: <LayoutGrid className={ICON} />,
      run: () => router.push('/dashboard'),
    },
    {
      id: `${ENTRY.action}:compose`,
      section: 'actions' as const,
      label: t('compose'),
      keywords: tOmni('composeKeywords'),
      icon: <PenSquare className={ICON} />,
      run: () => openCompose(pathname, router.push),
    },
    ...THEMES.map(value => ({
      id: `${ENTRY.action}:theme-${value}`,
      section: 'actions' as const,
      // `themeLight`/`themeDark`/`themeSystem` : la cle se compose a partir du nom
      // du theme, la table THEMES reste la seule liste des modes.
      label: tOmni(`theme${value.charAt(0).toUpperCase()}${value.slice(1)}` as 'themeLight'),
      keywords: tOmni('themeKeywords'),
      icon: <ThemeGlyph theme={value} />,
      run: () => setTheme(value),
    })),
    ...LOCALES.map(({ code, label }) => ({
      id: `${ENTRY.action}:language-${code}`,
      section: 'actions' as const,
      label: tOmni('languageAction', { name: label }),
      keywords: tOmni('languageKeywords'),
      icon: <Languages className={ICON} />,
      run: () => { void setLocale(code) },
    })),
    ...SETTINGS_NAV.map(({ href, key, icon: Icon }) => ({
      id: `${ENTRY.settings}:${key}`,
      section: 'settings' as const,
      label: tNav(key),
      hint: href,
      keywords: tOmni(`keywords.${key}` as 'keywords.profile'),
      icon: <Icon className={ICON} />,
      run: () => router.push(href),
    })),
  ]

  const matches = panelOpen ? matchOmnibar(query, commands) : []
  const suggestions = matches.map(m => commands.find(c => c.id === m.id)!)
  // Le panneau n'existe que s'il propose quelque chose : sans entree, la ligne de
  // repli seule ne vaut pas une surface qui recouvre le contenu.
  const showPanel = panelOpen && suggestions.length > 0
  const closePanel = useCallback(() => { setPanelOpen(false); setPanelIndex(-1) }, [])

  // Clic dehors : simple ecoute `mousedown`, pas de voile — le clic qui ferme
  // atteint aussi sa cible (meme regle que le menu du compte).
  useEffect(() => {
    if (!showPanel) return
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) closePanel()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showPanel, closePanel])

  const runSuggestion = (index: number) => {
    const picked = suggestions[index]
    if (!picked) return
    closePanel()
    setQuery('')
    inputRef.current?.blur()
    picked.run()
  }

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
        ref={panelRef}
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
            if (showPanel && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              // -1 = « aucun choix » : la liste boucle en repassant par cet etat,
              // donc on peut toujours revenir a la recherche de courrier.
              setPanelIndex(i => {
                const next = i + step
                if (next >= suggestions.length) return -1
                if (next < -1) return suggestions.length - 1
                return next
              })
              return
            }
            if (e.key === 'Enter') {
              if (debounce.current) clearTimeout(debounce.current)
              // Une entree choisie l'emporte ; sans choix, Entree cherche dans le
              // courrier exactement comme avant le lot H3f.
              if (showPanel && panelIndex >= 0) { e.preventDefault(); runSuggestion(panelIndex); return }
              closePanel()
              submit(e.currentTarget.value, scope)
              return
            }
            if (e.key !== 'Escape') return
            // Echap ferme d'abord le panneau, et seulement ensuite vide le champ.
            if (showPanel) { e.preventDefault(); closePanel(); return }
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

        {/* Lot H3f : le panneau se deroule SOUS le champ, a sa largeur exacte
            (`inset-x-0`), au-dessus du contenu. Il se ferme sans voile, donc le clic
            qui le ferme atteint aussi ce qu'il visait. */}
        {showPanel && (
          <div
            role="listbox"
            data-omnibar-panel
            className="absolute inset-x-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto
              rounded-xl border border-border bg-popover p-1 shadow-xl"
          >
            {OMNIBAR_SECTIONS.map(section => {
              const rows = suggestions.filter(entry => entry.section === section)
              if (!rows.length) return null
              return (
                <div key={section} data-omnibar-section={section}>
                  <div className={PANEL_SECTION}>{tOmni(SECTION_LABEL[section])}</div>
                  {rows.map(entry => {
                    const index = suggestions.indexOf(entry)
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        role="option"
                        aria-selected={index === panelIndex}
                        data-omnibar-entry={entry.id}
                        onMouseEnter={() => setPanelIndex(index)}
                        onClick={() => runSuggestion(index)}
                        className={cn(PANEL_ROW, index === panelIndex ? PANEL_ROW_ACTIVE : PANEL_ROW_IDLE)}
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center">{entry.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{entry.label}</span>
                          {entry.hint && (
                            <span className="block truncate text-[10px] text-muted-foreground">{entry.hint}</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {/* Ligne de repli, toujours derniere : l'action par defaut du champ. */}
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                role="option"
                aria-selected={panelIndex === -1}
                data-omnibar-entry="search"
                onClick={() => {
                  if (debounce.current) clearTimeout(debounce.current)
                  closePanel()
                  submit(query, scope)
                }}
                className={cn(PANEL_ROW, panelIndex === -1 ? PANEL_ROW_ACTIVE : PANEL_ROW_IDLE)}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                  <Search className={ICON} />
                </span>
                <span className="min-w-0 flex-1 truncate">{tOmni('searchMailFor', { query })}</span>
              </button>
            </div>
          </div>
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
