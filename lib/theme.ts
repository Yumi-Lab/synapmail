/**
 * Source unique du thème : noms, cookie, classe CSS et résolution `system`.
 * Tout ce qui touche au thème (provider, toggle, SSR) importe d'ici — aucune de
 * ces valeurs ne doit être réécrite ailleurs.
 */

export const THEMES = ['light', 'dark', 'system'] as const
export type Theme = (typeof THEMES)[number]
export type ResolvedTheme = Exclude<Theme, 'system'>

export const DEFAULT_THEME: Theme = 'system'

/** Cookie lisible par le serveur (SSR sans flash) ET par le script inline. */
export const THEME_COOKIE = 'synapmail-theme'
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** `darkMode: "class"` dans tailwind.config.ts : le seul contrat de rendu. */
export const DARK_CLASS = 'dark'
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

export function toTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME
}

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

/** Pose / retire la classe `dark` sur `<html>` — idempotent. */
export function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle(DARK_CLASS, resolved === 'dark')
}

export function themeCookieValue(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`
}

/**
 * Script inline BLOQUANT injecté dans `<head>` : il n'est utile que pour `system`,
 * où la réponse dépend du client et ne peut pas tenir dans le cookie. Pour `light`
 * et `dark`, la classe est déjà posée par le SSR et la chaîne rendue est vide.
 * Aucune donnée utilisateur n'y entre : `theme` est une des constantes de THEMES.
 */
export function themeInitScript(theme: Theme): string {
  if (theme !== 'system') return ''
  return `if(matchMedia(${JSON.stringify(DARK_MEDIA_QUERY)}).matches)document.documentElement.classList.add(${JSON.stringify(DARK_CLASS)})`
}
