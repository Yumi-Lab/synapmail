'use client'

import { cn } from '@/lib/utils'

/**
 * Infobulle des icônes du header. Ancrée sur l'ICÔNE (pas sur le pointeur), en CSS
 * pur : pas d'état React, pas de mesure, donc rien qui puisse se décaler d'un rendu
 * à l'autre. Une seule bulle par bouton — l'attribut `title` natif est retiré partout
 * où ce composant est posé, sinon le navigateur en superpose une seconde.
 */

/** Écart entre le bas de l'icône et le haut de la bulle, en px. Le gate lit cette valeur ici. */
export const TOOLTIP_OFFSET_PX = 6
/** Temps de survol avant l'apparition, en ms — la bulle ne clignote pas au passage de la souris. */
export const TOOLTIP_DELAY_MS = 400

/**
 * De quel bord la bulle s'aligne : `start` pour les premières icônes de la barre,
 * `end` pour celles collées au bord droit, `center` partout ailleurs. Une bulle ne
 * doit jamais sortir de l'écran.
 */
export type TooltipAlign = 'start' | 'center' | 'end'

const ALIGN: Record<TooltipAlign, string> = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
}

export function IconTooltip({ label, shortcut, align = 'center', children }: {
  label: string
  /** Raccourci clavier affiché à droite du libellé, quand il en existe un. */
  shortcut?: string
  align?: TooltipAlign
  children: React.ReactNode
}) {
  return (
    <span className="group relative inline-flex shrink-0">
      {children}
      <span
        role="tooltip"
        data-icon-tooltip
        style={{ marginTop: TOOLTIP_OFFSET_PX, '--synap-tip-delay': `${TOOLTIP_DELAY_MS}ms` } as React.CSSProperties}
        className={cn(
          'pointer-events-none absolute top-full z-50 flex items-center gap-1.5 rounded-lg',
          'whitespace-nowrap bg-foreground px-2 py-1 text-[11px] text-background shadow-sm',
          // Apparition retardée, disparition immédiate : le délai se pose sur l'état
          // survolé, jamais sur l'état de repos (sinon la bulle survivrait au départ).
          'invisible opacity-0 transition-[opacity,visibility] duration-100 delay-0',
          'group-hover:visible group-hover:opacity-100 group-hover:delay-[var(--synap-tip-delay)]',
          // `:focus-visible`, jamais `focus-within` : un clic souris laisse le focus sur
          // le bouton, et la bulle resterait plantée après le départ du pointeur.
          'group-has-[:focus-visible]:visible group-has-[:focus-visible]:opacity-100',
          'group-has-[:focus-visible]:delay-[var(--synap-tip-delay)]',
          ALIGN[align],
        )}
      >
        {label}
        {shortcut && <kbd className="rounded bg-background/25 px-1 font-sans">{shortcut}</kbd>}
      </span>
    </span>
  )
}
