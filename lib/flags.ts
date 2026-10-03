/**
 * Colour flags, following the Apple Mail convention — SINGLE source.
 *
 * Measured against a real test account: the mailbox advertises `\*` in its
 * `permanentFlags` and a `STORE +FLAGS ($MailFlagBit0)` survives a reconnect.
 * Apple's keywords are therefore written AS IS into IMAP: a flag set here is the
 * one a desktop mail client displays, and vice versa. No colour is stored in the
 * database.
 *
 * Apple's encoding: `\Flagged` carries the fact of being marked, and the colour
 * INDEX (0..6) is written in binary across three keywords `$MailFlagBit0/1/2`,
 * bit 0 being the least significant. Red (index 0) therefore has NO bit: it is the
 * colour of a bare `\Flagged`, which keeps the legacy star compatible.
 */

export const FLAG_IMAP_FLAG = '\\Flagged'

/** Keywords carrying the colour bits, from least to most significant. */
export const FLAG_BIT_KEYWORDS = ['$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2'] as const

export interface MailFlag {
  /** Stable key, used by the API and the interface. */
  key: string
  /** Apple's index (0..6), encoded across the bits. */
  index: number
  /**
   * The flag's colour — the ONLY colour in this interface. It is a CSS VALUE, not a
   * utility class: Tailwind does not scan `lib/`, so a class named here would never
   * be generated. The variable is declared in `app/globals.css` (light + `.dark`),
   * to be applied as `style={{ color }}`.
   */
  color: string
  /** i18n key, under the `mail.flags` namespace. */
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

/** Colour of a `\Flagged` without bits — and colour of the legacy `isStarred: true`. */
export const DEFAULT_FLAG_KEY = MAIL_FLAGS[0].key

export function flagByKey(key: string | null | undefined): MailFlag | null {
  if (!key) return null
  return MAIL_FLAGS.find(f => f.key === key) ?? null
}

/** IMAP keywords to SET for this colour (bits equal to 1 only). */
export function keywordsForFlag(key: string): string[] {
  const flag = flagByKey(key)
  if (!flag) return []
  return FLAG_BIT_KEYWORDS.filter((_, bit) => (flag.index >> bit) & 1)
}

/** Colour carried by a set of IMAP keywords, or `null` when the message is not marked. */
export function flagFromKeywords(flags: Iterable<string> | null | undefined): string | null {
  if (!flags) return null
  const set = flags instanceof Set ? (flags as Set<string>) : new Set(flags)
  if (!set.has(FLAG_IMAP_FLAG)) return null
  let index = 0
  FLAG_BIT_KEYWORDS.forEach((kw, bit) => { if (set.has(kw)) index |= 1 << bit })
  return flagByKey(MAIL_FLAGS.find(f => f.index === index)?.key ?? null)?.key ?? DEFAULT_FLAG_KEY
}

/**
 * List filters. The value IS the i18n key (`mail.<value>`) and the value sent to the
 * API: a filter added here has nothing else to update.
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
