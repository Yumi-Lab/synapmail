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
        'rounded-lg border border-border bg-muted/40 p-0.5',
        // Grille 3 colonnes égales (et non flex) : les colonnes se partagent la
        // largeur disponible, donc la piste ne déborde jamais de sa colonne, même
        // à 390 px où elle ne fait qu'une centaine de pixels.
        compact ? 'inline-flex flex-col items-center gap-0.5' : 'grid w-full grid-cols-3 gap-0.5',
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
              // `min-w-0` : sans lui la largeur intrinsèque du libellé empêche la
              // case de rétrécir et la piste déborde horizontalement.
              'flex min-w-0 items-center justify-center gap-2 rounded-[7px] px-2 py-1.5 text-sm',
              compact ? 'w-8' : 'w-full',
              active
                // En sombre `bg-background` est la couleur de la page : la pastille
                // active disparaissait sur la piste. Un voile blanc la détache.
                ? 'bg-background text-foreground shadow-sm dark:bg-white/15'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {/* Sous `sm` (colonne étroite, mobile 390) : icône seule — le nom reste
                porté par aria-label/title, jamais tronqué. */}
            {!compact && <span className="hidden truncate sm:inline">{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
