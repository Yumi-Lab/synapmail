/**
 * Lecture de l'identité de l'instance en base — seule porte vers la table
 * `instance_settings`. Les règles (nom par défaut, bornes, types acceptés)
 * vivent dans `lib/branding.ts`, qui reste pur et testable sans Postgres.
 */
import { query } from '@/lib/db'
import { DEFAULT_APP_NAME, DEFAULT_BRANDING, cleanAppName, type Branding } from '@/lib/branding'

type BrandingRow = { app_name: string | null; favicon_updated_at: Date | null }

/**
 * Une base pas encore initialisée (table absente au premier démarrage) doit
 * rendre l'apparence d'origine, pas une page en erreur : l'échec retombe donc
 * sur `DEFAULT_BRANDING`.
 */
export async function readBranding(): Promise<Branding> {
  try {
    const rows = await query<BrandingRow>(
      'SELECT app_name, favicon_updated_at FROM instance_settings WHERE id = TRUE'
    )
    const row = rows[0]
    if (!row) return DEFAULT_BRANDING
    return {
      appName: cleanAppName(row.app_name) ?? DEFAULT_APP_NAME,
      faviconVersion: row.favicon_updated_at ? row.favicon_updated_at.getTime() : null,
    }
  } catch {
    return DEFAULT_BRANDING
  }
}

export type StoredFavicon = { bytes: Buffer; type: string; version: number }

/** Les octets de l'icône, ou `null` quand aucune n'est définie (la route répond 404). */
export async function readFavicon(): Promise<StoredFavicon | null> {
  try {
    const rows = await query<{ favicon: Buffer | null; favicon_type: string | null; favicon_updated_at: Date | null }>(
      'SELECT favicon, favicon_type, favicon_updated_at FROM instance_settings WHERE id = TRUE'
    )
    const row = rows[0]
    if (!row?.favicon || !row.favicon_type || !row.favicon_updated_at) return null
    return { bytes: row.favicon, type: row.favicon_type, version: row.favicon_updated_at.getTime() }
  } catch {
    return null
  }
}
