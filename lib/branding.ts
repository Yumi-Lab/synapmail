/**
 * Identité de l'instance : le nom affiché dans l'onglet et l'icône de cet onglet.
 * Source UNIQUE du nom par défaut, des limites, des codes de refus et de la
 * détection de type — importée par la route publique, par la route admin, par
 * `app/layout.tsx` et par l'écran d'administration. Aucune de ces valeurs n'est
 * réécrite ailleurs.
 *
 * Ce fichier ne lit ni base ni requête : il est PUR, donc testable seul
 * (`scripts/check-branding.mjs`). Tout ce qui touche Postgres vit dans
 * `lib/brandingStore.ts`, qui importe d'ici.
 */
/** Le nom du produit quand l'instance n'en a pas choisi un autre. */
export const DEFAULT_APP_NAME = 'Synapmail'

/** Bornes du nom saisi : ni vide, ni assez long pour déborder d'un onglet. */
export const APP_NAME_MIN = 1
export const APP_NAME_MAX = 60

/** 256 Kio : une favicon tient très largement dedans, un vrai visuel non. */
export const FAVICON_MAX_BYTES = 256 * 1024

/** Codes de refus rendus à l'écran par `locales/*.json` (clés `admin.branding.errors.*`). */
export const BRANDING_ERRORS = {
  tooLarge: 'branding_too_large',
  badType: 'branding_bad_type',
  badName: 'branding_bad_name',
} as const

export type BrandingError = (typeof BRANDING_ERRORS)[keyof typeof BRANDING_ERRORS]

/**
 * Types acceptés, décidés sur les OCTETS MAGIQUES du fichier et jamais sur son
 * extension ni sur le type déclaré par le navigateur : un SVG renommé `.png`
 * doit être refusé, et un PNG renommé `.svg` doit passer.
 *
 * Le SVG est volontairement ABSENT : servi depuis notre propre origine, il
 * exécuterait son script si on ouvrait l'URL de l'icône directement.
 */
type Signature = { type: string; match: (b: Uint8Array) => boolean }

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte)

const SIGNATURES: readonly Signature[] = [
  { type: 'image/png', match: b => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  // ICO : en-tête de ressource Windows, réservé 0x0000 puis type 1 (icône).
  { type: 'image/x-icon', match: b => startsWith(b, [0x00, 0x00, 0x01, 0x00]) },
  { type: 'image/jpeg', match: b => startsWith(b, [0xff, 0xd8, 0xff]) },
  // WebP : conteneur RIFF, la signature du format est aux octets 8..11.
  {
    type: 'image/webp',
    match: b =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      b.length >= 12 &&
      startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
]

/** Le type RÉEL du fichier, ou `null` si aucune signature connue ne correspond. */
export function detectImageType(bytes: Uint8Array): string | null {
  return SIGNATURES.find(s => s.match(bytes))?.type ?? null
}

/**
 * Nettoie le nom saisi : espaces repliés, bords rognés, caractères de contrôle
 * refusés (ils passeraient invisibles dans un titre d'onglet). Renvoie `null`
 * quand rien d'acceptable n'en sort — l'appelant répond alors `badName`.
 */
export function cleanAppName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (cleaned.length < APP_NAME_MIN || cleaned.length > APP_NAME_MAX) return null
  return cleaned
}

/** Ce que l'application entière lit : un nom effectif, et la version de l'icône. */
export type Branding = {
  appName: string
  /**
   * Horodatage de la dernière icône enregistrée, en millisecondes — sert de
   * version dans l'URL de l'icône pour que le cache long soit sans risque.
   * `null` quand aucune icône n'est définie : on sert alors les fichiers de `public/`.
   */
  faviconVersion: number | null
}

export const DEFAULT_BRANDING: Branding = { appName: DEFAULT_APP_NAME, faviconVersion: null }

/** Route publique de l'icône, avec sa version : une seule écriture de cette URL. */
export const FAVICON_PATH = '/api/branding/favicon'
export const faviconUrl = (version: number): string => `${FAVICON_PATH}?v=${version}`

/**
 * Les icônes livrées dans `public/`, servies tant que l'instance n'en a pas
 * choisi une autre. Source UNIQUE : lue par `app/layout.tsx` pour les
 * métadonnées ET par l'écran d'administration pour la remise à zéro, qui doit
 * reposer EXACTEMENT les mêmes liens sans recharger la page.
 */
export const BUNDLED_FAVICONS = [
  { url: '/favicon.ico', type: 'image/x-icon', sizes: 'any' },
  { url: '/brand/png/synapmail-favicon@64.png', type: 'image/png', sizes: '64x64' },
] as const

/** Icône apple-touch livrée : hors périmètre du réglage d'instance, jamais remplacée. */
export const BUNDLED_APPLE_ICON = { url: '/brand/png/synapmail-icone@512.png', sizes: '512x512' } as const

/**
 * Les liens `<link rel="icon">` à poser pour une identité donnée : l'icône
 * réglée quand il y en a une, sinon les fichiers livrés. Une seule règle, lue
 * par le rendu serveur comme par la mise à jour de l'onglet sans rechargement.
 */
export function faviconLinks(faviconVersion: number | null): readonly { url: string; type?: string; sizes?: string }[] {
  return faviconVersion === null ? BUNDLED_FAVICONS : [{ url: faviconUrl(faviconVersion) }]
}
