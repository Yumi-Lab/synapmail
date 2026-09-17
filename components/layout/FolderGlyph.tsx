'use client'

import { cn } from '@/lib/utils'
import { WORD_SPLIT } from './AccountAvatar'

/**
 * A custom folder has no meaningful icon: collapsed, a column of identical `Folder`
 * glyphs tells the user nothing. This renders the folder's own letters in a square
 * tile the exact size of a row icon, so the row keeps its geometry (the collapse
 * contract measures `iconX/iconY/iconW/iconH`) while becoming readable folded.
 * Monochrome on purpose — the bar carries ONE accent, and it is not spent here.
 */

/** Same box as a lucide row icon (`w-4 h-4`) — the tile IS the icon of its row. */
const TILE = 'w-4 h-4 rounded-md flex items-center justify-center select-none tracking-[0.02em] text-[9px] font-semibold leading-none'
/**
 * Painted with the theme's own neutral pair rather than `bg-foreground/[0.06]`: an
 * opacity modifier on a token that resolves to a bare `var(--foreground)` does not
 * compile under Tailwind 3 (the utility needs a `<alpha-value>` placeholder), and the
 * tile shipped with NO background at all — measured on the rendered page, which is why
 * the gate reads the computed colours instead of trusting the class list.
 * `secondary` is greyscale in both themes, so the tile stays monochrome.
 */
const TILE_IDLE = 'bg-secondary text-secondary-foreground'

/** Letters shown when a single one would be ambiguous inside the same list. */
const AMBIGUOUS_LEN = 2

/** A folder's own name: the segment after the last separator of its IMAP path. */
const leafName = (folder: { name?: string; path: string }) => {
  const fromPath = folder.path.split(/[/.]/).filter(Boolean).pop() ?? ''
  return (folder.name?.trim() || fromPath).trim()
}

/**
 * Letters for every custom folder of ONE list, resolved together: a folder keeps a
 * single letter unless another folder in the same list starts with it, in which case
 * both grow to two. Computed once per list rather than per row — a per-row rule
 * cannot know about its siblings, and a fixed two letters would make short names
 * (`RH`, `OK`) read as truncations of something longer.
 */
export const folderInitials = <T extends { name?: string; path: string }>(folders: T[]) => {
  const leaves = folders.map(f => leafName(f))
  const firstCount = new Map<string, number>()
  for (const leaf of leaves) {
    const head = leaf.slice(0, 1).toUpperCase()
    firstCount.set(head, (firstCount.get(head) ?? 0) + 1)
  }
  return new Map(folders.map((folder, i) => {
    const leaf = leaves[i]
    const head = leaf.slice(0, 1).toUpperCase()
    if ((firstCount.get(head) ?? 0) <= 1) return [folder.path, head || '?']
    // Ambiguous head: the second letter is the initial of the folder's SECOND word when
    // it has one, otherwise its own second letter. On real mailboxes that is what tells
    // `Controles EDOF` (CE) from `Compta` (CO), and `Mails benjamin` (MB) from
    // `Mails inbox shopify` (MI) — a blind two-letter prefix renders all of them the same.
    const words = leaf.split(WORD_SPLIT).filter(Boolean)
    const tail = words.length > 1 ? words[1].slice(0, 1) : leaf.slice(1, AMBIGUOUS_LEN)
    return [folder.path, (head + tail).toUpperCase().slice(0, AMBIGUOUS_LEN) || '?']
  }))
}

/**
 * Component identities, kept per letter pair. `folderGlyph` binds its letters by
 * closing over them, so a fresh closure on every render would be a NEW component
 * type and React would unmount then remount the tile each time — the one thing the
 * collapse contract forbids for a row icon. Caching makes the identity stable, and
 * the cache is bounded by the number of distinct letter pairs, not by renders.
 */
const GLYPHS = new Map<string, React.ComponentType<React.HTMLAttributes<HTMLSpanElement>>>()

/**
 * The tile itself, built as a row-icon component so it drops into `RowBody`'s icon
 * slot unchanged: the caller binds the letters, `RowBody` supplies the sizing class
 * and the `data-sidebar-icon` marker every measured row carries.
 */
export const folderGlyph = (initials: string) => {
  const cached = GLYPHS.get(initials)
  if (cached) return cached
  // TILE_IDLE comes LAST so a caller's class can size or place the tile but never
  // colour it: the tile stays monochrome even on the active row, where ordinary
  // rows tint their icon with the accent.
  const Glyph = ({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...rest} className={cn(TILE, className, TILE_IDLE)} data-folder-glyph>
      {initials}
    </span>
  )
  Glyph.displayName = `FolderGlyph(${initials})`
  GLYPHS.set(initials, Glyph)
  return Glyph
}
