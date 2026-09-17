'use client'

import { cn } from '@/lib/utils'
import type { EmailAccount } from '@/types/account'

/**
 * Single palette for account bubbles — index with the account's rank in the list.
 * Shades are chosen so a white initial stays readable on every bubble: measured
 * WCAG contrast against #fff is 5.17 / 5.70 / 5.48 / 5.02 / 4.70, all above the
 * 4.5:1 floor for small bold text. The 500 shades this replaces fell as low as
 * 2.15 (amber) and 2.54 (emerald). `scripts/check-sidebar-collapse.mjs` recomputes
 * these ratios from the rendered bubbles, so the floor is enforced, not asserted.
 */
const ACCOUNT_COLORS = ['bg-blue-600', 'bg-violet-600', 'bg-emerald-700', 'bg-amber-700', 'bg-rose-600'] as const

/**
 * The bar's ONE accent, as one source. Every primary/active/selected state of the
 * sidebar is painted from here — `solid` for a filled control, `tint` for the
 * background of an active row, `ink` for the glyph that marks it. Nothing else in
 * the bar may introduce a second accent, a gradient or a decorative ring.
 */
export const ACCENT = {
  solid: 'bg-violet-600 text-white',
  solidHover: 'hover:bg-violet-700',
  tint: 'bg-violet-600/10',
  tintStrong: 'bg-violet-600/20',
  ink: 'text-violet-600 dark:text-violet-400',
  ring: 'ring-violet-600/40',
  /** Full-strength ring: marks the SELECTED item (an account bubble), never a focus hint. */
  ringSolid: 'ring-violet-600',
} as const

/** Above this the badge reads `99+`. Single source for every unread counter of the bar. */
const UNREAD_CAP = 99

const formatUnread = (count: number) => (count > UNREAD_CAP ? `${UNREAD_CAP}+` : String(count))

type AvatarSize = 'sm' | 'md'

/**
 * Bubble sizes: `sm` in the bar's rows (fits the fixed icon column), `md` in the popover
 * list. The type scale is set so TWO letters fit inside the circle without touching its
 * edge: at 10 px in the 28 px bubble and 11 px in the 32 px one, the widest pair this
 * palette can produce stays clear of the rim. `scripts/check-sidebar-collapse.mjs`
 * measures the rendered glyph box against the bubble, so the fit is enforced, not assumed.
 */
const SIZES: Record<AvatarSize, string> = {
  sm: 'w-7 h-7 text-[10px]',
  md: 'w-8 h-8 text-[11px]',
}

/** Letters kept in a bubble. Two, always — one letter reads as an accident, not an identity. */
const INITIAL_LEN = 2

/**
 * What separates two words in a display name or an email local part: whitespace and
 * ASCII punctuation. Written as the separators rather than as "everything that is not
 * a letter" — a Unicode property escape needs the `u` flag, unavailable at this
 * project's compile target, while an ASCII letter class would cut "Élodie" or "王小明"
 * in the wrong place. Punctuation must be in here: without it `Nicolas (Yumi)` renders
 * as `N(` instead of `NY`.
 */
const WORD_SPLIT = /[\s!-\/:-@[-`{-~]+/

/**
 * The bubble's letters, as ONE source for the whole bar. Always exactly two:
 * the initials of the first two words of the name when there are two ("Nicolas
 * Michaut" → "NM"), otherwise the first two letters of the single word — name
 * first, then the local part of the email ("mathilde" → "MA", "bruno" → "BR").
 * A source too short to yield two characters falls back to the other field
 * rather than rendering a lone letter.
 */
export const accountInitials = (account: Pick<EmailAccount, 'name' | 'email'>) => {
  const sources = [account.name ?? '', (account.email ?? '').split('@')[0] ?? '']
  for (const source of sources) {
    const words = source.trim().split(WORD_SPLIT).filter(Boolean)
    if (words.length >= INITIAL_LEN) return words.slice(0, INITIAL_LEN).map(w => w[0]).join('').toUpperCase()
    const single = words[0] ?? ''
    if (single.length >= INITIAL_LEN) return single.slice(0, INITIAL_LEN).toUpperCase()
  }
  return '??'
}

/**
 * Geometry of the badge, as one source. It hangs off the host's top-right CORNER
 * (Google style): small, and offset far enough that its box clears the initial
 * underneath it — measured on the SMALLEST bubble (28 px), where the letters' text
 * box sits closest to the corner. At `-9px` the widest label (`99+`) covers ~11 % of
 * that bubble and 0 % of the initial's own text box; the previous `-4px` / 16 px-tall
 * badge covered 37 % of the bubble and 40 % of the glyph, hiding the letter.
 */
const BADGE_OFFSET_PX = 9

/**
 * The bar's ONE unread counter: a badge pinned on the top-right corner of whatever it
 * marks (an account bubble, a folder icon) — never a pill to the right of a label.
 * It is absolutely positioned, so it never changes its host's box, and it stays
 * visible when the bar is collapsed and the labels have folded away.
 * Ringed with `--synap-surface` — the colour of whatever surface it is pinned on,
 * published by that surface itself, so the ring follows the theme with no second palette.
 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      aria-hidden
      style={{ top: -BADGE_OFFSET_PX, right: -BADGE_OFFSET_PX }}
      className={cn(
        'absolute min-w-[14px] h-[14px] px-[3px] rounded-full ring-[1.5px] ring-[color:var(--synap-surface)]',
        'text-[9px] font-semibold leading-none flex items-center justify-center tabular-nums',
        ACCENT.solid,
      )}
      data-unread-badge
    >
      {formatUnread(count)}
    </span>
  )
}

interface AccountAvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  account: Pick<EmailAccount, 'name' | 'email'>
  /** Rank of the account in the list — resolved against ACCOUNT_COLORS. */
  colorIndex: number
  unread?: number
  size?: AvatarSize
  /**
   * Marks the bubble as the selected one with a ring around it. A ring is a box-shadow:
   * it changes nothing in the layout, so a selected row and an idle row keep the exact
   * same geometry — the reason the popover marks its active account this way instead of
   * adding a check glyph that only the active row carries.
   */
  selected?: boolean
}

/**
 * Round bubble carrying the account's two letters, with the unread counter pinned on its
 * top-right corner — never a pill sitting to the right of the name. The badge is
 * absolutely positioned, so it can never change the bubble's box: an icon column
 * built on it keeps the exact same geometry collapsed or expanded.
 * `--synap-surface` is the colour the badge is ringed with, so it stays readable
 * even on a bubble that shares the accent colour.
 */
export function AccountAvatar({ account, colorIndex, unread = 0, size = 'sm', selected = false, ...rest }: AccountAvatarProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        {...rest}
        className={cn(
          'rounded-full flex items-center justify-center font-semibold text-white select-none tracking-[0.02em]',
          SIZES[size],
          ACCOUNT_COLORS[colorIndex % ACCOUNT_COLORS.length],
          selected && cn('ring-2 ring-offset-2 ring-offset-[color:var(--synap-surface)]', ACCENT.ringSolid),
        )}
        data-account-selected={selected ? 'true' : undefined}
      >
        <span data-account-initial>{accountInitials(account)}</span>
      </span>
      <UnreadBadge count={unread} />
    </span>
  )
}
