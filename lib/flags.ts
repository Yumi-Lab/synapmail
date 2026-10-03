/**
 * Drapeaux de couleur, convention Apple Mail — source UNIQUE.
 *
 * Mesuré sur le compte de test IONOS (imap.ionos.fr, 18/09/2026) : la boîte
 * annonce `\*` dans ses `permanentFlags` et un `STORE +FLAGS ($MailFlagBit0)`
 * survit à une reconnexion. Les mots-clés d'Apple sont donc écrits TELS QUELS
 * dans IMAP : un drapeau posé ici est celui que Mail sur Mac affiche, et
 * réciproquement. Aucune couleur n'est mémorisée en base.
 *
 * Codage d'Apple : `\Flagged` porte le fait d'être marqué, et l'INDEX de la
 * couleur (0..6) est écrit en binaire sur trois mots-clés `$MailFlagBit0/1/2`,
 * bit 0 étant le poids faible. Rouge (index 0) n'a donc AUCUN bit : c'est la
 * couleur d'un `\Flagged` nu, ce qui rend l'ancienne étoile compatible.
 */

export const FLAG_IMAP_FLAG = '\\Flagged'

/** Mots-clés portant les bits de couleur, du poids faible au poids fort. */
export const FLAG_BIT_KEYWORDS = ['$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2'] as const

export interface MailFlag {
  /** Clé stable, utilisée par l'API et l'interface. */
  key: string
  /** Index d'Apple (0..6), encodé sur les bits. */
  index: number
  /**
   * Couleur du drapeau — la SEULE couleur de cette interface. C'est une VALEUR
   * CSS, pas une classe utilitaire : Tailwind ne scanne pas `lib/`, donc une
   * classe nommée ici ne serait jamais générée. La variable est déclarée dans
   * `app/globals.css` (clair + `.dark`), à poser en `style={{ color }}`.
   */
  color: string
  /** Clé i18n, sous l'espace `mail.flags`. */
  labelKey: string
}

export const MAIL_FLAGS: readonly MailFlag[] = [
  { key: 'red',    index: 0, color: 'var(--flag-red)',    labelKey: 'red' },
  { key: 'orange', index: 1, color: 'var(--flag-orange)', labelKey: 'orange' },
  { key: 'yellow', index: 2, color: 'var(--flag-yellow)', labelKey: 'yellow' },
  { key: 'green',  index: 3, color: 'var(--flag-green)',  labelKey: 'green' },
  { key: 'blue',   index: 4, color: 'var(--flag-blue)',   labelKey: 'blue' },
  { key: 'purple', index: 5, color: 'var(--flag-purple)', labelKey: 'purple' },
  { key: 'gray',   index: 6, color: 'var(--flag-gray)',   labelKey: 'gray' },
] as const

/** Couleur d'un `\Flagged` sans bit — et couleur de l'ancien `isStarred: true`. */
export const DEFAULT_FLAG_KEY = MAIL_FLAGS[0].key

export function flagByKey(key: string | null | undefined): MailFlag | null {
  if (!key) return null
  return MAIL_FLAGS.find(f => f.key === key) ?? null
}

/** Mots-clés IMAP à POSER pour cette couleur (bits à 1 seulement). */
export function keywordsForFlag(key: string): string[] {
  const flag = flagByKey(key)
  if (!flag) return []
  return FLAG_BIT_KEYWORDS.filter((_, bit) => (flag.index >> bit) & 1)
}

/** Couleur portée par un jeu de mots-clés IMAP, ou `null` si le message n'est pas marqué. */
export function flagFromKeywords(flags: Iterable<string> | null | undefined): string | null {
  if (!flags) return null
  const set = flags instanceof Set ? (flags as Set<string>) : new Set(flags)
  if (!set.has(FLAG_IMAP_FLAG)) return null
  let index = 0
  FLAG_BIT_KEYWORDS.forEach((kw, bit) => { if (set.has(kw)) index |= 1 << bit })
  return flagByKey(MAIL_FLAGS.find(f => f.index === index)?.key ?? null)?.key ?? DEFAULT_FLAG_KEY
}

/**
 * Filtres de la liste. La valeur EST la clé i18n (`mail.<valeur>`) et la valeur
 * envoyée à l'API : un filtre ajouté ici n'a rien d'autre à mettre à jour.
 */
export const MAIL_LIST_FILTERS = ['all', 'unread', 'flagged', 'focus'] as const
export type MailListFilter = (typeof MAIL_LIST_FILTERS)[number]

/**
 * Le tri par priorité (lot T12), côté CLIENT comme serveur. Le score lui-même est calculé
 * dans `lib/focus.ts` (serveur : il lit la base) ; ce qui doit être partagé avec la liste
 * vit ici, dans un module sans dépendance serveur — un composant client qui importerait
 * `lib/focus.ts` embarquerait `pg` dans le navigateur.
 */
/** Le filtre de liste « à traiter » : les derniers non-lus dont la priorité atteint le seuil. */
export const FOCUS_FILTER = 'focus' satisfies MailListFilter
/** La valeur du paramètre `sort` de `/api/messages`, écrite une fois. */
export const PRIORITY_SORT = 'priority'
/**
 * À partir de ce score un mail est « à traiter » — et porte une pastille dans la liste. Un signal
 * faible seul (pièce jointe 1, « Re : » 2, contact fréquent 2) n'y suffit pas ; un signal fort
 * (facture 3, échéance 4, drapeau 5, toute étiquette pesée ≥ 3) y suffit. Ici, et non dans
 * `lib/focus.ts`, parce que la liste (client) le lit pour décider d'afficher la pastille.
 */
export const FOCUS_THRESHOLD = 3
/** Colonne `user_settings` qui retient le tri choisi (`true` = par priorité), lue et écrite sous ce nom. */
export const SORT_SETTING = 'mail_sort_priority'
export const byPriorityThenDate = (a: { priority?: { score: number }; date: string }, b: { priority?: { score: number }; date: string }) =>
  (b.priority?.score ?? 0) - (a.priority?.score ?? 0) || +new Date(b.date) - +new Date(a.date)
