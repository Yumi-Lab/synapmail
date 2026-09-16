/**
 * Single source of truth for the locales this app ships.
 *
 * Add a code here and a matching `locales/<code>.json`; `scripts/check-locales.mjs`
 * enforces key parity between the two. Kept free of server-only imports so both
 * `lib/i18n.ts` (server) and the appearance settings page (client) can use it.
 *
 * Labels are endonyms — a language is always listed in its own script, so a user
 * who cannot read the current interface language can still find their own.
 */
export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
] as const

export type Locale = (typeof LOCALES)[number]['code']

export const LOCALE_CODES = LOCALES.map(l => l.code) as readonly Locale[]

export const DEFAULT_LOCALE: Locale = 'en'

/** Cookie written by the appearance settings page and read by `lib/i18n.ts`. */
export const LOCALE_COOKIE = 'synapmail-locale'

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALE_CODES as readonly string[]).includes(value)
}
