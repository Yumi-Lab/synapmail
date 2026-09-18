'use client'

import { cn } from '@/lib/utils'
import { twoLetters } from './AccountAvatar'

/**
 * A custom folder has no meaningful icon: collapsed, a column of identical `Folder`
 * glyphs tells the user nothing. This renders the folder's own letters in a square
 * tile the exact size of a row icon, so the row keeps its geometry (the collapse
 * contract measures `iconX/iconY/iconW/iconH`) while becoming readable folded.
 * Monochrome on purpose — the bar carries ONE accent, and it is not spent here.
 */

/**
 * Same box as a lucide row icon (`w-4 h-4`) — the tile IS the icon of its row, so the
 * collapse contract keeps measuring one geometry. Letters at 10 px with a touch of
 * tracking: at 9 px and no tracking the pair read as one smudge inside a 16 px plate.
 */
const TILE = 'w-4 h-4 flex items-center justify-center select-none tracking-[0.3px] text-[10px] font-semibold leading-none'
/**
 * A CASE, not a bubble. `rounded-md` resolves to `calc(var(--radius) - 2px)` = 8 px in
 * this theme, which on a 16 px box is a perfect circle: the human gate of 19/09/2026
 * read a folder tile as an account bubble, two kinds of object wearing one shape. The
 * radius is therefore stated here in pixels and NEVER derived from `--radius`, whose
 * job is the app's cards. Softly rounded corners, still unmistakably square.
 */
const TILE_RADIUS_PX = 3
/**
 * The plate must READ as a plate. `bg-secondary` (the theme's neutral pair) computes to
 * oklch(0.97) on a bar at oklch(0.985) in light — a measured 1.03:1, which the human gate
 * saw as letters floating with no tile at all. `color-mix` composites the theme's own
 * foreground into the surface at a fixed ratio, so ONE value serves both themes and the
 * tile stays greyscale (both operands are achromatic in this palette).
 * Calibration bench: `scripts/check-sidebar-collapse.mjs`, headless Chrome, the bar's
 * light `--sidebar` oklch(0.985) and dark oklch(0.205) — 24 % yields 1.90:1 light and
 * 1.88:1 dark against the bar, both clear of the 1.5:1 floor the gate enforces, while
 * keeping the letters themselves at ~10:1 on the plate.
 */
const TILE_INK_MIX = '24%'
const TILE_IDLE = 'text-foreground'
const TILE_FILL = {
  backgroundColor: `color-mix(in oklab, var(--foreground) ${TILE_INK_MIX}, var(--sidebar))`,
  borderRadius: `${TILE_RADIUS_PX}px`,
}

/** Letters kept in a tile. Two, always — the same floor the account bubbles hold to. */
const GLYPH_LEN = 2
/** Ceiling when two folders of one list would otherwise spell the same pair. */
const GLYPH_LEN_MAX = 3

/** Whitespace and punctuation inside a name, removed when a tie-break reads a name flat. */
const WORD_GAP = /[\s!-\/:-@[-`{-~]+/g

/** A folder's own name: the segment after the last separator of its IMAP path. */
const leafName = (folder: { name?: string; path: string }) => {
  const fromPath = folder.path.split(/[/.]/).filter(Boolean).pop() ?? ''
  return (folder.name?.trim() || fromPath).trim()
}

/**
 * Letters for every custom folder of ONE list, resolved together. Always at least two
 * (`twoLetters`, the same rule the account bubbles use — one letter reads as an
 * accident), and a third only to break a tie: two folders of one list that spell the
 * same pair would be indistinguishable folded, which is the exact thing this tile
 * exists to prevent. Computed per LIST rather than per row because a row cannot know
 * about its siblings.
 */
export const folderInitials = <T extends { name?: string; path: string }>(folders: T[]) => {
  const leaves = folders.map(f => leafName(f))
  const taken = new Set<string>()
  return new Map(folders.map((folder, i) => {
    const leaf = leaves[i]
    const base = twoLetters(leaf)
    if (!base) return [folder.path, (leaf.slice(0, GLYPH_LEN).toUpperCase() || '?')]
    if (!taken.has(base)) {
      taken.add(base)
      return [folder.path, base]
    }
    // Tie-break by lengthening, never by shortening: `Mail alpha`/`Mail apple` both
    // spell `MA`, so the loser grows a third letter taken from its own name.
    const flat = leaf.replace(WORD_GAP, '').toUpperCase()
    for (let len = GLYPH_LEN + 1; len <= GLYPH_LEN_MAX; len++) {
      const longer = flat.slice(0, len)
      if (longer.length === len && !taken.has(longer)) {
        taken.add(longer)
        return [folder.path, longer]
      }
    }
    // Every variant within the letter budget is spoken for: keep the pair rather than
    // invent a glyph the user cannot map back to a name. The full path stays on hover.
    return [folder.path, base]
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
  const Glyph = ({ className, style, ...rest }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...rest} style={{ ...TILE_FILL, ...style }} className={cn(TILE, className, TILE_IDLE)} data-folder-glyph>
      {initials}
    </span>
  )
  Glyph.displayName = `FolderGlyph(${initials})`
  GLYPHS.set(initials, Glyph)
  return Glyph
}
