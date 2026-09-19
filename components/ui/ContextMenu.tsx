'use client'

/**
 * Le MENU du clic droit — sa surface, son placement et sa fermeture. Rien d'autre :
 * ni courrier, ni dossier. Extrait de `MessageContextMenu` au lot H3e pour que le clic
 * droit de la barre latérale soit le MÊME menu que celui des messages, et non un second
 * qui dériverait (deux calculs de bord d'écran, deux façons de se fermer).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Où le menu s'ouvre. Chaque menu y ajoute ce que SA cible lui apprend. */
export interface ContextMenuAnchor {
  x: number
  y: number
}

/** Marge gardée entre le menu et le bord de la fenêtre. */
const EDGE_GAP = 8

/** Taille des icônes des entrées — une seule valeur pour tous les menus. */
export const MENU_ICON = 'w-3.5 h-3.5 shrink-0'

export function ContextMenuSurface({
  anchor, onClose, children, ...rest
}: {
  anchor: ContextMenuAnchor
  onClose: () => void
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
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[210px] bg-popover border border-border rounded-lg shadow-xl py-1"
      style={{ left: pos.x, top: pos.y }}
      {...rest}
    >
      {children}
    </div>
  )
}

export function ContextMenuItem({
  itemKey, icon, label, onClick, onClose, enabled, danger,
}: {
  itemKey: string
  icon: React.ReactNode
  label: string
  onClick: () => void
  onClose: () => void
  enabled: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      data-menu-item={itemKey}
      disabled={!enabled}
      onClick={() => { onClick(); onClose() }}
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
