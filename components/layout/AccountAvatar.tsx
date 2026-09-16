'use client'

import { cn } from '@/lib/utils'
import type { EmailAccount } from '@/types/account'

/** Single palette for account bubbles — index with the account's rank in the list. */
export const ACCOUNT_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500'] as const

/** Above this the badge reads `99+`. Single source for every unread counter of the bar. */
const UNREAD_CAP = 99

export const formatUnread = (count: number) => (count > UNREAD_CAP ? `${UNREAD_CAP}+` : String(count))

type AvatarSize = 'sm' | 'md'

/** Bubble sizes: `sm` in the bar's rows (fits the fixed icon column), `md` in the popover list. */
const SIZES: Record<AvatarSize, string> = {
  sm: 'w-7 h-7 text-[11px]',
  md: 'w-8 h-8 text-xs',
}

export const accountInitial = (account: Pick<EmailAccount, 'name' | 'email'>) =>
  ((account.name || account.email).trim().charAt(0) || '?').toUpperCase()

/**
 * The bar's ONE unread counter: a badge pinned on the top-right corner of whatever it
 * marks (an account bubble, a folder icon) — never a pill to the right of a label.
 * It is absolutely positioned, so it never changes its host's box, and it stays
 * visible when the bar is collapsed and the labels have folded away.
 * Ringed with `--synap-surface` so it reads on any bubble colour.
 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      aria-hidden
      className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-violet-500 ring-2 ring-[color:var(--synap-surface)] text-[10px] font-semibold leading-none text-white flex items-center justify-center tabular-nums"
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
}

/**
 * Round bubble carrying the account's initial, with the unread counter pinned on its
 * top-right corner — never a pill sitting to the right of the name. The badge is
 * absolutely positioned, so it can never change the bubble's box: an icon column
 * built on it keeps the exact same geometry collapsed or expanded.
 * `--synap-surface` is the colour the badge is ringed with, so it stays readable
 * even on a bubble that shares the accent colour.
 */
export function AccountAvatar({ account, colorIndex, unread = 0, size = 'sm', ...rest }: AccountAvatarProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        {...rest}
        className={cn(
          'rounded-full flex items-center justify-center font-semibold text-white select-none',
          SIZES[size],
          ACCOUNT_COLORS[colorIndex % ACCOUNT_COLORS.length],
        )}
      >
        {accountInitial(account)}
      </span>
      <UnreadBadge count={unread} />
    </span>
  )
}
