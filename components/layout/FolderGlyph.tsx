'use client'

import { cn } from '@/lib/utils'

/**
 * A custom folder has no meaningful icon: collapsed, a column of identical `Folder`
 * glyphs tells the user nothing. This renders the folder's own letters in a square
 * tile the exact size of a row icon, so the row keeps its geometry (the collapse
 * contract measures `iconX/iconY/iconW/iconH`) while becoming readable folded.
 * Monochrome on purpose — the bar carries ONE accent, and it is not spent here.
 */

/** Same box as a lucide row icon (`w-4 h-4`) — the tile IS the icon of its row. */
const TILE = 'w-4 h-4 rounded-md flex items-center justify-center select-none tracking-[0.02em] text-[9px] font-semibold leading-none'
const TILE_IDLE = 'bg-foreground/[0.06] text-foreground/80'

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
    const len = (firstCount.get(head) ?? 0) > 1 ? AMBIGUOUS_LEN : 1
    return [folder.path, leaf.slice(0, len).toUpperCase() || '?']
  }))
}

/**
 * The tile itself, built as a row-icon component so it drops into `RowBody`'s icon
 * slot unchanged: the caller binds the letters, `RowBody` supplies the sizing class
 * and the `data-sidebar-icon` marker every measured row carries.
 */
export const folderGlyph = (initials: string) =>
  function FolderGlyph({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
    // TILE_IDLE comes LAST so a caller's class can size or place the tile but never
    // colour it: the tile stays monochrome even on the active row, where ordinary
    // rows tint their icon with the accent.
    return (
      <span {...rest} className={cn(TILE, className, TILE_IDLE)} data-folder-glyph>
        {initials}
      </span>
    )
  }
