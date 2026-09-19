'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Palette } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ACCOUNT_PALETTE, BADGE_COLOR_PATTERN, accountColor, readableInk } from '@/lib/accountColor'

interface Props {
  /** Colour currently stored for the mailbox — `null` means automatic. */
  value: string | null
  /** Rank of the mailbox in the list, which decides its automatic colour. */
  rank: number
  /** Fires on every live change (open panel, dragged wheel): repaint, do not save. */
  onPreview: (value: string | null) => void
  /** Fires when the choice settles (released wheel, validated field, clicked swatch): save. */
  onCommit: (value: string | null) => void
}

/**
 * A mailbox's colour, chosen from the system's own wheel. `<input type="color">` IS the
 * native picker — a colour wheel on macOS, the platform's dialog everywhere else — so no
 * dependency is added for it. The hex field is the same value typed rather than pointed at.
 *
 * Two callbacks, not one, because a colour wheel emits a change per pixel dragged: `onPreview`
 * repaints the badge and the bar live, `onCommit` is the only one that writes.
 */
export function AccountColorPicker({ value, rank, onPreview, onCommit }: Props) {
  const t = useTranslations('settings.accounts')
  const [open, setOpen] = useState(false)
  const [hex, setHex] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const effective = accountColor({ badgeColor: value }, rank)

  useEffect(() => {
    if (!open) return
    setHex(value ?? '')
    // Light-dismiss: one click outside closes AND reaches whatever it landed on, because
    // nothing covers the page — the listener is on the document, there is no backdrop.
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, value])

  const choose = (next: string | null) => {
    onPreview(next)
    onCommit(next)
    setHex(next ?? '')
  }

  // The field accepts a colour as the user finishes typing it; anything else is simply
  // not committed, so the mailbox keeps the colour it had rather than losing it to a typo.
  const commitHex = () => {
    const candidate = hex.trim()
    if (!candidate) return choose(null)
    if (BADGE_COLOR_PATTERN.test(candidate)) choose(candidate)
  }

  const invalid = hex.trim() !== '' && !BADGE_COLOR_PATTERN.test(hex.trim())

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('color')}
        data-account-color-trigger
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Palette className="h-3.5 w-3.5" />
        {t('color')}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('color')}
          data-account-color-panel
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <div className="flex flex-wrap gap-1.5">
            {ACCOUNT_PALETTE.map(swatch => (
              <button
                key={swatch}
                type="button"
                onClick={() => choose(swatch)}
                aria-label={swatch}
                data-account-color-swatch={swatch}
                className="flex h-7 w-7 items-center justify-center rounded-full"
                style={{ backgroundColor: swatch, color: readableInk(swatch) }}
              >
                {value === swatch && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>

          <label className="mt-3 flex items-center gap-2">
            <input
              type="color"
              value={effective}
              onChange={e => onPreview(e.target.value)}
              onBlur={e => choose(e.target.value)}
              data-account-color-wheel
              className="h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-0"
            />
            <input
              value={hex}
              onChange={e => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={e => e.key === 'Enter' && commitHex()}
              placeholder={t('colorAuto')}
              aria-label={t('colorHex')}
              spellCheck={false}
              data-account-color-hex
              className={cn(
                'h-8 w-full min-w-0 rounded-lg border bg-background px-2 font-mono text-xs outline-none',
                invalid ? 'border-destructive' : 'border-border',
              )}
            />
          </label>
          {invalid && <p className="mt-1 text-[11px] text-destructive">{t('colorInvalid')}</p>}

          <button
            type="button"
            onClick={() => choose(null)}
            data-account-color-auto
            className={cn(
              'mt-2 w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted',
              value === null && 'font-medium text-foreground',
            )}
          >
            {t('colorAuto')}
          </button>
        </div>
      )}
    </div>
  )
}
