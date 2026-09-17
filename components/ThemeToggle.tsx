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
 * `compact` (barre repliée) = UNE seule case, l'icône du mode actif ; un clic
 * passe au mode suivant (clair → sombre → système) et l'icône fait un flip.
 */
export function ThemeToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const t = useTranslations('settings.appearance')
  const { theme, setTheme } = useTheme()
  const index = Math.max(0, THEMES.indexOf(theme))

  if (compact) {
    const next = THEMES[(index + 1) % THEMES.length]
    const Icon = ICONS[theme]
    const label = t('cycleTheme', { current: t(theme), next: t(next) })
    return (
      <button
        type="button"
        data-theme-cycle={theme}
        aria-label={label}
        title={label}
        onClick={() => setTheme(next)}
        className={cn(
          'mx-auto flex items-center justify-center rounded-lg border border-border bg-muted/40 p-0.5',
          'text-foreground/70 hover:text-foreground',
          className
        )}
      >
        {/* `key={theme}` remonte l'icône à chaque changement : c'est ce qui rejoue
            le flip (animation définie dans globals.css, même durée que le curseur). */}
        <span
          key={theme}
          className={cn('flex items-center justify-center rounded-[7px]', CELL, 'theme-flip motion-reduce:animate-none')}
          style={{ animationDuration: `${THEME_TOGGLE_TRANSITION_MS}ms` }}
        >
          <Icon className="h-4 w-4 shrink-0" />
        </span>
      </button>
    )
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('theme')}
      className={cn(
        // `w-max` (et JAMAIS `w-fit`/`w-full`) : la piste garde sa largeur
        // INTRINSÈQUE — 3 cases carrées + rembourrage — même dans une colonne
        // étroite. Avec `fit-content`, des pistes en `1fr` (min-content = 0) se
        // comprimaient sous 3 cases et les icônes se chevauchaient à 390 px.
        'relative isolate grid w-max rounded-lg border border-border bg-muted/40 p-0.5',
        className
      )}
      // Pistes en `auto` : chaque colonne (ou rangée) prend la taille de sa case
      // et ne se comprime pas. Le nombre vient de THEMES — aucune valeur en dur.
      style={{ gridTemplateColumns: `repeat(${THEMES.length}, auto)` }}
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
          'ease-out transition-[left] motion-reduce:transition-none'
        )}
        style={{
          transitionDuration: `${THEME_TOGGLE_TRANSITION_MS}ms`,
          width: `calc((100% - ${2 * TRACK_PAD_PX}px) / ${THEMES.length})`,
          height: `calc(100% - ${2 * TRACK_PAD_PX}px)`,
          top: TRACK_PAD_PX,
          left: `calc(${TRACK_PAD_PX}px + (100% - ${2 * TRACK_PAD_PX}px) * ${index} / ${THEMES.length})`,
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
