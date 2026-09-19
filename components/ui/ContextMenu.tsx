'use client'

/**
 * Le MENU du clic droit — sa surface, son placement et sa fermeture. Rien d'autre :
 * ni courrier, ni dossier. Extrait de `MessageContextMenu` au lot H3e pour que le clic
 * droit de la barre latérale soit le MÊME menu que celui des messages, et non un second
 * qui dériverait (deux calculs de bord d'écran, deux façons de se fermer).
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** Délai avant qu'un sous-menu OUVERT cède la place, en ms : le pointeur est passé sur une
 *  autre entrée du menu parent. Il existe parce qu'une traversée en diagonale vers le
 *  panneau passe forcément au-dessus des entrées voisines — changer à l'instant même rendait
 *  le sous-menu inatteignable à la souris (mesuré : panneau fermé avant l'arrivée, banc
 *  scripts/check-move-menu.mjs). Atteindre le panneau pendant ce délai annule le changement.
 *  Rien à attendre à la PREMIÈRE ouverture : aucun panneau n'est encore posé.
 *  ponytail: valeur posée à la main ; à recalibrer si un banc mesure une traversée plus lente. */
const SUBMENU_SWITCH_MS = 260

/**
 * Un menu n'a qu'UN sous-menu ouvert. L'état vit donc sur la SURFACE, pas sur chaque
 * sous-menu : sans cela deux panneaux pourraient rester ouverts ensemble, et survoler une
 * autre entrée n'aurait aucun moyen de fermer le panneau du voisin.
 */
type SubmenuControl = {
  openKey: string | null
  /** Le panneau ouvert, partagé : la surface doit savoir qu'un défilement ou un clic
   *  dedans lui appartient, alors qu'il n'est pas son descendant (il est porté par le
   *  même portail, pas par le menu). */
  panelRef: React.MutableRefObject<HTMLDivElement | null>
  /** Demande que `key` (ou aucun sous-menu, pour `null`) soit l'ouvert. Immédiat si rien
   *  n'est ouvert, différé de `SUBMENU_SWITCH_MS` sinon — le temps d'atteindre le panneau. */
  request: (key: string | null) => void
  /** Annule un changement en attente : le pointeur a atteint le panneau. */
  cancelSwitch: () => void
  open: (key: string) => void
  close: () => void
}

const SubmenuContext = createContext<SubmenuControl | null>(null)

/**
 * Déplace le focus de `step` entrées parmi les `selector` de `container`, en boucle.
 * Partagé par le menu d'une ligne de réglages et par la liste des dossiers : deux copies
 * dériveraient sur le cas « rien n'a encore le focus » (le premier ou le dernier ?).
 */
/** Les entrees d'un menu qui peuvent recevoir le focus : une seule ecriture. */
export const MENU_ITEM_SELECTOR = '[data-menu-item]:not([disabled])'

export function focusMenuStep(container: HTMLElement | null, selector: string, step: number) {
  const items = Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? [])
  if (items.length === 0) return
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = at === -1 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length
  items[next].focus()
}

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
  /** Le panneau du sous-menu ouvert. Il vit dans le MÊME portail que la surface mais n'en
   *  est pas un descendant : sans cette référence, défiler dedans ou y cliquer serait lu
   *  comme « hors du menu » et fermerait tout. */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y })
  const [openKey, setOpenKey] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  const cancelSwitch = () => clearTimeout(closeTimer.current)
  const submenu: SubmenuControl = {
    openKey,
    panelRef,
    cancelSwitch,
    request: key => {
      cancelSwitch()
      if (openKey === null) return setOpenKey(key)
      if (key === openKey) return
      closeTimer.current = setTimeout(() => setOpenKey(key), SUBMENU_SWITCH_MS)
    },
    open: key => { cancelSwitch(); setOpenKey(key) },
    close: () => { cancelSwitch(); setOpenKey(null) },
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])

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
    /** Le menu, sous-menu compris : ce qui s'y passe lui appartient. */
    const inside = (node: Node) =>
      !!ref.current?.contains(node) || !!panelRef.current?.contains(node)

    // `mousedown` ferme AVANT le `click` : le même clic atteint donc sa cible
    // sous le menu, sans second clic ni zone morte.
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node
      if (ignoreRef?.current?.contains(node)) return
      if (ref.current && !inside(node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Capture : la liste des mails défile dans son propre conteneur, pas sur la fenêtre —
    // sans capture l'évènement ne remonterait pas jusqu'ici. Mais un défilement DANS le
    // menu (sa liste de dossiers, son sous-menu) est le geste de quelqu'un qui CHERCHE :
    // le fermer rendait « Déplacer vers » inutilisable dès que la liste dépassait sa
    // hauteur (mesuré en prod sur 1 244 dossiers).
    const onScroll = (e: Event) => {
      const node = e.target as Node
      if (node && node.nodeType !== undefined && inside(node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
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
    <SubmenuContext.Provider value={submenu}>
      <div
        ref={ref}
        className="fixed z-[100] bg-popover border border-border rounded-lg shadow-xl py-1"
        style={{ left: pos.x, top: pos.y, minWidth: MENU_MIN_WIDTH }}
        data-context-menu-surface
        {...rest}
      >
        {children}
      </div>
    </SubmenuContext.Provider>
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
  const ctx = useContext(SubmenuContext)
  return (
    <button
      type="button"
      data-menu-item={itemKey}
      disabled={!enabled}
      // Survoler une entrée ORDINAIRE demande au sous-menu ouvert de céder la place —
      // après le délai, pour qu'une diagonale qui passe par là puisse encore l'atteindre.
      onMouseEnter={() => ctx?.request(null)}
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

/** Écart entre l'entrée et le panneau de son sous-menu, en px. */
const SUBMENU_GAP = 2

/**
 * Une entrée qui ouvre un panneau. Le panneau n'est PLUS un `group-hover` CSS : un
 * survol pur disparaissait dès que le pointeur quittait l'entrée, donc en attrapant
 * l'ascenseur du panneau ou en le rejoignant en diagonale. Ici il s'ouvre au survol ET
 * au clic, et ne se ferme qu'en choisissant, en cliquant dehors, ou après un court délai
 * passé sur une autre entrée du menu parent.
 */
export function ContextMenuSubmenu({
  itemKey, icon, label, enabled, children,
}: {
  itemKey: string
  icon: React.ReactNode
  label: string
  enabled: boolean
  children: React.ReactNode
}) {
  const ctx = useContext(SubmenuContext)
  const rowRef = useRef<HTMLDivElement>(null)
  const open = ctx?.openKey === itemKey

  return (
    <div
      className={cn('relative', !enabled && 'opacity-40 pointer-events-none')}
      data-menu-item={itemKey}
      onMouseEnter={() => ctx?.request(itemKey)}
    >
      <div
        ref={rowRef}
        role="button"
        tabIndex={enabled ? 0 : -1}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? ctx?.close() : ctx?.open(itemKey))}
        onKeyDown={e => {
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return
          e.preventDefault()
          ctx?.open(itemKey)
        }}
        className={cn(
          'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-foreground cursor-default transition-colors',
          'focus-visible:outline-none focus-visible:bg-accent',
          open ? 'bg-accent' : 'hover:bg-accent',
        )}
      >
        {icon}
        {label}
        <ChevronRight className="w-3 h-3 ml-auto" />
      </div>
      {open && ctx && <SubmenuPanel rowRef={rowRef} ctx={ctx} itemKey={itemKey}>{children}</SubmenuPanel>}
    </div>
  )
}

/**
 * Le panneau d'un sous-menu, posé dans le portail du menu et recalé dans l'écran à partir
 * de sa taille RÉELLE : à gauche de l'entrée s'il n'y a pas la place à droite, remonté
 * s'il déborde en bas. En `absolute left-full top-0` il sortait simplement de la fenêtre
 * pour un clic droit près du bord.
 */
function SubmenuPanel({ rowRef, ctx, itemKey, children }: {
  rowRef: React.RefObject<HTMLDivElement>
  ctx: SubmenuControl
  itemKey: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  // Volontairement sans liste de dépendances : le contenu d'un panneau change (une liste
  // de dossiers qu'on filtre), donc sa hauteur change, et c'est à ce moment qu'il faut le
  // recaler. `setPos` rend l'état précédent quand rien n'a bougé : pas de boucle.
  const place = useCallback(() => {
    const row = rowRef.current?.getBoundingClientRect()
    const box = ref.current?.getBoundingClientRect()
    if (!row || !box) return
    const right = row.right + SUBMENU_GAP
    const x = right + box.width + EDGE_GAP <= window.innerWidth
      ? right
      : Math.max(EDGE_GAP, row.left - SUBMENU_GAP - box.width)
    const y = Math.max(EDGE_GAP, Math.min(row.top, window.innerHeight - box.height - EDGE_GAP))
    setPos(prev => (prev && prev.x === x && prev.y === y ? prev : { x, y }))
  }, [rowRef])

  useLayoutEffect(place)

  const setRef = (node: HTMLDivElement | null) => {
    ref.current = node
    ctx.panelRef.current = node
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={setRef}
      data-menu-panel={itemKey}
      onMouseEnter={ctx.cancelSwitch}
      onMouseLeave={() => ctx.request(null)}
      className="fixed z-[101] bg-popover border border-border rounded-lg shadow-xl py-1"
      // Avant la première mesure le panneau est rendu hors champ plutôt que caché :
      // `visibility: hidden` lui donnerait une taille, `display: none` non — et sans
      // taille il n'y a rien à recaler.
      style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: 0 }}
    >
      {children}
    </div>,
    document.body,
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
export const focusMenuItem = (list: HTMLElement | null, step: number): void =>
  focusMenuStep(list, MENU_ITEM_SELECTOR, step)

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
