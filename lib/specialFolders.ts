/**
 * Which IMAP folder plays which special role — single source for the folders API.
 *
 * The server's RFC 6154 SPECIAL-USE flag is authoritative. Name matching is only a
 * fallback for servers that declare nothing, and it is deliberately narrow: it looks
 * at the folder's OWN name, never at its path, and only at the top level (or directly
 * under INBOX, where `INBOX.`-namespaced servers keep their system folders).
 * Matching the whole path turned every sub-folder of a special folder into a second
 * special folder: "Spam/AMELI", "Spam/Crypto"… were all shown as "Spam", and
 * "Corbeille/CONVENTIONS" as another "Corbeille".
 */
export type SpecialType = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | null

/** RFC 6154 SPECIAL-USE attribute → special type. `null` = known flag, no special row. */
export const SPECIAL_USE_MAP: Record<string, SpecialType> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
  '\\Archive': null,
  '\\Flagged': null,
  '\\All': null,
}

const NAME_PATTERNS: Array<[NonNullable<SpecialType>, RegExp]> = [
  ['sent', /\b(sent|envoy[eé]s?)\b/],
  ['drafts', /\b(drafts?|brouillons?)\b/],
  ['spam', /\b(junk|spam|pourriel|ind[eé]sirables?)\b/],
  ['trash', /\b(deleted|trash|corbeille|supprim[eé]s?)\b/],
]

export interface FolderLike {
  path: string
  name: string
  delimiter?: string
  specialUse?: string
}

const INBOX = 'inbox'

function byFlag(f: FolderLike): SpecialType | undefined {
  return f.specialUse && Object.prototype.hasOwnProperty.call(SPECIAL_USE_MAP, f.specialUse)
    ? SPECIAL_USE_MAP[f.specialUse]
    : undefined
}

/** Resolves every folder of ONE account together: a role the server declares is never guessed again. */
export function detectSpecials<T extends FolderLike>(folders: T[]): Map<string, SpecialType> {
  const declared = new Set<SpecialType>()
  for (const f of folders) {
    const flagged = byFlag(f)
    if (flagged) declared.add(flagged)
  }

  return new Map(folders.map(f => {
    const flagged = byFlag(f)
    if (flagged !== undefined) return [f.path, flagged]

    const name = f.name.toLowerCase()
    if (f.path.toLowerCase() === INBOX || name === INBOX) return [f.path, declared.has('inbox') ? null : 'inbox']

    const delimiter = f.delimiter || '/'
    const cut = f.path.lastIndexOf(delimiter)
    const parent = cut < 0 ? '' : f.path.slice(0, cut).toLowerCase()
    if (parent !== '' && parent !== INBOX) return [f.path, null] // a sub-folder keeps its own name

    const guess = NAME_PATTERNS.find(([type, re]) => !declared.has(type) && re.test(name))
    return [f.path, guess ? guess[0] : null]
  }))
}
