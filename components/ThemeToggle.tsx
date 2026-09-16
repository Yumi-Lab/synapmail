'use client'

import { Sun, Moon, Monitor, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useTheme } from '@/components/theme/ThemeProvider'
import { THEMES, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const ICONS: Record<Theme, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }

/**
 * Toggle de thème unique de l'application (segmented 3 positions).
 * `compact` = icônes seules, pour un pied de barre replié.
 */
export function ThemeToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const t = useTranslations('settings.appearance')
  const { theme, setTheme } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label={t('theme')}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5',
        compact ? 'flex-col' : 'w-full',
        className
      )}
    >
      {THEMES.map((value) => {
        const Icon = ICONS[value]
        const label = t(value)
        const active = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'flex items-center justify-center gap-2 rounded-[7px] px-2 py-1.5 text-sm',
              compact ? 'w-8' : 'flex-1',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!compact && <span className="truncate">{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
