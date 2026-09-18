/** Parse une date ISO venue de l'API ; null si absente ou invalide (jamais « Invalid Date » à l'écran). */
export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Date COMPLÈTE + heure d'une ligne de la liste (lot M3b) — source unique.
 *
 * Nicolas, 19/09/2026 : « à la place tu mets la date complète et l'heure ».
 * `Intl` porte le format, jamais une chaîne recopiée : la langue de l'interface
 * décide de l'ordre et du séparateur (fr « 18 sept. 2026, 10:41 », en « Sep 18,
 * 2026, 10:41 AM », zh « 2026年9月18日 10:41 »). Le jour même, la date cède la
 * place au libellé « Aujourd'hui » — celui des en-têtes de groupe, passé par
 * l'appelant pour que cette fonction reste sans i18n.
 */
export function formatRowDate(iso: string, locale: string, todayLabel: string): string {
  const d = parseDate(iso)
  if (!d) return ''
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(d)
  if (d.toDateString() === new Date().toDateString()) return `${todayLabel}, ${time}`
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}
