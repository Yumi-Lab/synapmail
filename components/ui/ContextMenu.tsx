'use client'

/**
 * Le MENU du clic droit — sa surface, son placement et sa fermeture. Rien d'autre :
 * ni courrier, ni dossier. Extrait de `MessageContextMenu` au lot H3e pour que le clic
 * droit de la barre latérale soit le MÊME menu que celui des messages, et non un second
 * qui dériverait (deux calculs de bord d'écran, deux façons de se fermer).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconTooltip } from '@/components/ui/IconTooltip'

/** Où le menu s'ouvre. Chaque menu y ajoute ce que SA cible lui apprend. */
export interface ContextMenuAnchor {
  x: number
  y: number
}

/** Marge gardée entre le menu et le bord de la fenêtre. */
const EDGE_GAP = 8

/** Taille des icônes des entrées — une seule valeur pour tous les menus. */
export const MENU_ICON = 'w-3.5 h-3.5 shrink-0'

/** Largeur minimale du menu, en px. Sert aussi à aligner un menu sur le BORD DROIT de
 *  ce qui l'ouvre : sans cette valeur il faudrait la mesurer après coup, donc après un
 *  premier rendu déjà posé au mauvais endroit. Posée en style en ligne, pas en classe :
 *  Tailwind ne compile pas une valeur calculée, et deux écritures dériveraient. */
export const MENU_MIN_WIDTH = 210

export function ContextMenuSurface({
  anchor, onClose, ignoreRef, children, ...rest
}: {
  anchor: ContextMenuAnchor
  onClose: () => void
  /** Élément qui commande le menu : un clic dessus ne le ferme pas, il le BASCULE.
   *  Sans cela le clic fermerait ici puis rouvrirait là, et le bouton paraîtrait mort. */
  ignoreRef?: React.RefObject<HTMLElement>
  children: React.ReactNode
} & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y })

  // Le menu reste dans l'écran d'après sa taille RÉELLE : une hauteur devinée
  // laisserait les dernières entrées sous le bord dès qu'on en ajoute une.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPos({
      x: Math.max(EDGE_GAP, Math.min(anchor.x, window.innerWidth - box.width - EDGE_GAP)),
      y: Math.max(EDGE_GAP, Math.min(anchor.y, window.innerHeight - box.height - EDGE_GAP)),
    })
  }, [anchor.x, anchor.y])

  useEffect(() => {
    // `mousedown` ferme AVANT le `click` : le même clic atteint donc sa cible
    // sous le menu, sans second clic ni zone morte.
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node
      if (ignoreRef?.current?.contains(node)) return
      if (ref.current && !ref.current.contains(node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // Capture : la liste défile dans son propre conteneur, pas sur la fenêtre.
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose, ignoreRef])

  // Rendu dans un PORTAIL sur `document.body`. Sans cela, `position: fixed` ne se cale
  // PAS sur la fenêtre dès qu'un ancêtre porte `transform`, `filter`, `backdrop-filter`,
  // `will-change` ou `contain` : ces propriétes font de l'ancêtre le bloc conteneur, et
  // les coordonnées calculées pour la fenêtre s'ajoutent alors à son décalage. Mesuré :
  // la carte des réglages porte `backdrop-blur-sm`, et le menu s'ouvrait 237 px à droite
  // et 469 px sous la fenêtre. Le portail sort la surface de tous ces blocs d'un coup,
  // pour les sept écrans de réglages comme pour le clic droit du courrier.
  const surface = (
    <div
      ref={ref}
      className="fixed z-[100] bg-popover border border-border rounded-lg shadow-xl py-1"
      style={{ left: pos.x, top: pos.y, minWidth: MENU_MIN_WIDTH }}
      {...rest}
    >
      {children}
    </div>
  )

  // Le rendu serveur n'a pas de `document` ; la surface n'y paraît jamais, puisqu'elle
  // n'existe qu'après une interaction.
  if (typeof document === 'undefined') return null
  return createPortal(surface, document.body)
}

export function ContextMenuItem({
  itemKey, icon, label, onClick, onClose, enabled, danger, ...rest
}: {
  itemKey: string
  icon: React.ReactNode
  label: string
  onClick: () => void
  onClose: () => void
  enabled: boolean
  danger?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      data-menu-item={itemKey}
      disabled={!enabled}
      onClick={() => { onClick(); onClose() }}
      {...rest}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-accent',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** Sous-menu au survol — CSS pur, aucun état : il ne peut pas rester ouvert par erreur. */
export function ContextMenuSubmenu({
  itemKey, icon, label, enabled, children,
}: {
  itemKey: string
  icon: React.ReactNode
  label: string
  enabled: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn('group relative', !enabled && 'opacity-40 pointer-events-none')} data-menu-item={itemKey}>
      <div className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-foreground hover:bg-accent cursor-default transition-colors">
        {icon}
        {label}
        <ChevronRight className="w-3 h-3 ml-auto" />
      </div>
      <div className="absolute left-full top-0 hidden group-hover:block bg-popover border border-border rounded-lg shadow-xl py-1 z-[101]">
        {children}
      </div>
    </div>
  )
}

export const ContextMenuSeparator = () => <div className="my-1 border-t border-border" />

/** Écart entre le bas du bouton qui ouvre un menu et le haut de ce menu, en px. */
export const MENU_ANCHOR_GAP = 4

/**
 * Déplace le focus d'une entrée à l'autre dans un menu ouvert, en bouclant. Exporté
 * parce que DEUX déclencheurs l'utilisent (le « … » d'une ligne de réglages et la
 * puce de portée de l'omnibar) : une seconde copie dériverait sur ce que « l'entrée
 * suivante » veut dire quand une entrée est désactivée.
 */
export function focusMenuItem(list: HTMLElement | null, step: number): void {
  const items = Array.from(list?.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not([disabled])') ?? [])
  if (items.length === 0) return
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = at === -1 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length
  items[next].focus()
}

/**
 * Le bouton « … » d'une ligne de réglages, et le menu qu'il ouvre. C'est le MÊME menu
 * que le clic droit du courrier et des dossiers (`ContextMenuSurface` ci-dessus) : même
 * rayon, même ombre, même fermeture en un clic dehors qui atteint sa cible.
 *
 * Il existe parce que la suppression est RARE : une corbeille rouge sur chaque ligne
 * met la destruction au premier plan d'un écran qu'on ouvre pour tout autre chose. Ici
 * le rouge n'apparaît que dans le menu ouvert.
 *
 * Le clavier : Tab atteint le bouton, Entrée ouvre sur la première entrée, les flèches
 * parcourent, Échap ferme et rend le focus au bouton.
 */
export function RowMenu({ label, itemsKey, children }: {
  /** Libellé lu par l'infobulle et les lecteurs d'écran — il NOMME la ligne. */
  label: string
  /** Identifie la ligne pour le banc : `data-row-menu="<clé>"` sur le bouton. */
  itemsKey: string
  /** Les entrées, bâties avec `ContextMenuItem` / `ContextMenuSeparator`. */
  children: (close: () => void) => React.ReactNode
}) {
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const open = () => {
    const box = triggerRef.current?.getBoundingClientRect()
    if (box) setAnchor({ x: box.right - MENU_MIN_WIDTH, y: box.bottom + MENU_ANCHOR_GAP })
  }

  // Fermer rend le focus au bouton : sans cela le focus retombe sur le corps de la
  // page et la tabulation suivante repart du haut de l'écran.
  const close = () => {
    setAnchor(null)
    triggerRef.current?.focus()
  }

  // Ouvrir au clavier pose le focus sur la première entrée ; ouvrir à la souris ne le
  // fait pas (le pointeur choisit déjà), sinon la bulle de survol resterait plantée.
  const focusItem = (step: number) => focusMenuItem(listRef.current, step)

  return (
    <>
      <IconTooltip label={label} align="end">
        <button
          ref={triggerRef}
          type="button"
          data-row-menu={itemsKey}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-label={label}
          onClick={() => (anchor ? setAnchor(null) : open())}
          onKeyDown={e => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            if (!anchor) open()
            requestAnimationFrame(() => focusItem(e.key === 'ArrowDown' ? 1 : -1))
          }}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground',
            'transition-colors hover:bg-accent hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </IconTooltip>
      {anchor && (
        <ContextMenuSurface
          anchor={anchor}
          onClose={close}
          ignoreRef={triggerRef}
          role="menu"
          data-row-menu-surface={itemsKey}
        >
          <div
            ref={listRef}
            onKeyDown={e => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault()
              focusItem(e.key === 'ArrowDown' ? 1 : -1)
            }}
          >
            {children(close)}
          </div>
        </ContextMenuSurface>
      )}
    </>
  )
}
