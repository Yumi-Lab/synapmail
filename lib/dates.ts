/** Parse une date ISO venue de l'API ; null si absente ou invalide (jamais « Invalid Date » à l'écran). */
export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}
