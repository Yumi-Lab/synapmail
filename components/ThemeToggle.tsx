'use client'

import { Sun, Moon, Monitor, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useTheme } from '@/components/theme/ThemeProvider'
import { THEMES, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const ICONS: Record<Theme, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }

/** Durée UNIQUE du glissement du curseur (ms). `prefers-reduced-motion` la neutralise. */
export const THEME_TOGGLE_TRANSITION_MS = 180

/**
 * Côté d'une case, en unités Tailwind (`h-8`/`w-8` = 2rem). La case est CARRÉE et
 * de taille identique dans les deux orientations : c'est ce qui rend la piste
 * verticale assez étroite pour une barre repliée, et le calcul du curseur exact.
 */
const CELL = 'h-8 w-8'
/** Rembourrage de la piste, des deux côtés — repris tel quel dans le calcul du curseur. */
const TRACK_PAD_PX = 2

/**
 * Toggle de thème unique de l'application : 3 icônes, aucun libellé (le nom vit
 * dans `aria-label`/`title`), et un curseur unique qui GLISSE d'une case à l'autre.
 * `compact` = orientation verticale, pour un pied de barre replié.
 */
export function ThemeToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const t = useTranslations('settings.appearance')
  const { theme, setTheme } = useTheme()
  const index = Math.max(0, THEMES.indexOf(theme))

  return (
    <div
      role="radiogroup"
      aria-label={t('theme')}
      className={cn(
        // `w-fit` : les cases restent CARRÉES (icônes seules), la piste ne s'étire
        // jamais — c'est ce qui rend le calcul du curseur exact et la piste
        // verticale assez étroite pour une barre repliée. `mx-auto` centre la
        // piste verticale dans le rail replié.
        'relative isolate grid w-fit rounded-lg border border-border bg-muted/40 p-0.5',
        compact ? 'mx-auto grid-cols-1' : 'grid-cols-3',
        className
      )}
    >
      {/* Curseur : SEUL élément qui bouge. Sa taille vaut exactement une case, donc
          `translate(index * 100%)` l'amène pile sur la case active, sans valeur
          magique à maintenir. Les cases, elles, ne changent jamais de peinture. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -z-10 rounded-[7px] bg-background shadow-sm',
          // En sombre `bg-background` est la couleur de la page : un voile blanc
          // détache le curseur de la piste (contraste mesuré par check-segmented).
          'dark:bg-white/15',
          'ease-out motion-reduce:transition-none',
          compact ? 'transition-[top]' : 'transition-[left]'
        )}
        style={{
          transitionDuration: `${THEME_TOGGLE_TRANSITION_MS}ms`,
          [compact ? 'height' : 'width']: `calc((100% - ${2 * TRACK_PAD_PX}px) / ${THEMES.length})`,
          [compact ? 'width' : 'height']: `calc(100% - ${2 * TRACK_PAD_PX}px)`,
          [compact ? 'left' : 'top']: TRACK_PAD_PX,
          [compact ? 'top' : 'left']: `calc(${TRACK_PAD_PX}px + (100% - ${2 * TRACK_PAD_PX}px) * ${index} / ${THEMES.length})`,
        }}
      />
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
              'flex items-center justify-center rounded-[7px]',
              CELL,
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
          </button>
        )
      })}
    </div>
  )
}
