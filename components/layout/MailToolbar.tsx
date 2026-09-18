'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Folder } from '@/types/email'
import {
  MAIL_FLAG_COLORS, MAIL_TOOLBAR_GROUPS, useMailSelection,
  type MailActionName, type MailToolbarItem,
} from '@/lib/mailSelection'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/**
 * Les deux actions qui ne s'exécutent pas au clic : elles ouvrent un petit menu
 * ancré (les sept couleurs, la liste des dossiers). Le reste appelle son action.
 */
const MENU_ACTIONS = new Set<MailActionName>(['setFlag', 'moveTo'])

/**
 * Ordre dans lequel les groupes passent au menu « … » quand la place manque : le
 * DERNIER groupe part le premier. Relever (groupe 0) et le groupe répondre/supprimer
 * restent visibles le plus longtemps — la priorité demandée au lot H3.
 */
const OVERFLOW_ORDER = MAIL_TOOLBAR_GROUPS.map((_, i) => i).reverse()

/**
 * Largeur qu'il faut pour afficher les groupes visibles. Mesurée, pas devinée :
 * la barre compare la place réelle au besoin réel et replie un groupe de plus tant
 * que ça déborde. Aucun point de rupture en dur — une traduction plus longue ou une
 * police plus large replie simplement plus tôt.
 */
function useOverflowGroups(hostRef: React.RefObject<HTMLElement>, probeRef: React.RefObject<HTMLElement>) {
  const [hidden, setHidden] = useState<number[]>([])

  useEffect(() => {
    const host = hostRef.current
    const probe = probeRef.current
    if (!host || !probe) return

    const measure = () => {
      const available = host.getBoundingClientRect().width
      const widths = Array.from(probe.children).map(el => el.getBoundingClientRect().width)
      const total = widths.reduce((a, b) => a + b, 0)
      if (total <= available) { setHidden(prev => (prev.length ? [] : prev)); return }
      const next: number[] = []
      let used = total
      for (const index of OVERFLOW_ORDER) {
        // Le bouton « … » prend la place d'un bouton : on la compte une seule fois.
        const budget = available - (next.length ? 0 : widths[0])
        if (used <= budget) break
        used -= widths[index]
        next.push(index)
      }
      setHidden(prev => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [hostRef, probeRef])

  return hidden
}

/** Un motif pour tous les boutons d'action — icône seule, jamais de bouton plein. */
const ACTION = 'w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors ' +
  'text-foreground/70 hover:text-foreground hover:bg-foreground/[0.06] ' +
  'disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-foreground/70 disabled:cursor-default'
const ICON = 'w-[18px] h-[18px]'
const SEPARATOR = 'mx-1 h-5 w-px shrink-0 bg-border'
const MENU_BOX = 'absolute left-0 top-full z-50 mt-1 rounded-xl border border-border bg-popover p-1 shadow-xl'
const MENU_ROW = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground/80 ' +
  'hover:bg-foreground/[0.06] hover:text-foreground transition-colors'

/**
 * Menu ancré sous un bouton, fermé par UN clic dehors qui atteint sa cible
 * (écouteur `mousedown`, jamais un voile) et par Échap, qui rend le focus.
 * Même motif que le menu du compte utilisateur.
 */
function useAnchoredMenu(open: boolean, close: () => void, triggerRef: React.RefObject<HTMLButtonElement>) {
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, triggerRef])
  return boxRef
}

type ButtonProps = { item: MailToolbarItem; openMenu: MailActionName | null; setOpenMenu: (a: MailActionName | null) => void }

function ToolbarButton({ item, openMenu, setOpenMenu }: ButtonProps) {
  const t = useTranslations('mail')
  const { can, run, state } = useMailSelection()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isMenu = MENU_ACTIONS.has(item.action)
  const open = isMenu && openMenu === item.action
  const boxRef = useAnchoredMenu(open, () => setOpenMenu(null), triggerRef)
  const label = t(item.labelKey)
  const enabled = can[item.action]

  const { data: foldersRes } = useSWR<{ data: Folder[] }>(
    open && item.action === 'moveTo' && state.accountId ? `/api/folders?account=${state.accountId}` : null,
    fetcher,
  )
  const folders = foldersRes?.data ?? []

  const button = (
    <button
      ref={triggerRef}
      type="button"
      disabled={!enabled}
      title={label}
      aria-label={label}
      {...(isMenu ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open } : {})}
      onClick={() => {
        if (!isMenu) { run(item.action as Exclude<MailActionName, 'setFlag' | 'moveTo'>); return }
        setOpenMenu(open ? null : item.action)
      }}
      data-mail-action={item.action}
      className={ACTION}
    >
      <item.Icon className={ICON} />
    </button>
  )

  if (!isMenu) return button

  return (
    <div ref={boxRef} className="relative shrink-0">
      {button}
      {open && item.action === 'setFlag' && (
        <div role="menu" data-mail-action-menu="setFlag" className={cn(MENU_BOX, 'w-44')}>
          {MAIL_FLAG_COLORS.map(colour => (
            <button
              key={colour.value}
              type="button"
              role="menuitem"
              data-mail-flag={colour.value}
              onClick={() => { run('setFlag', colour.value); setOpenMenu(null) }}
              className={MENU_ROW}
            >
              <span className={cn('h-3 w-3 shrink-0 rounded-full', colour.swatch)} />
              <span className="flex-1 truncate text-left">{t(`flagColors.${colour.value}`)}</span>
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            data-mail-flag="none"
            onClick={() => { run('setFlag', null); setOpenMenu(null) }}
            className={MENU_ROW}
          >
            <span className="h-3 w-3 shrink-0 rounded-full border border-border" />
            <span className="flex-1 truncate text-left">{t('flagRemove')}</span>
          </button>
        </div>
      )}
      {open && item.action === 'moveTo' && (
        <div role="menu" data-mail-action-menu="moveTo" className={cn(MENU_BOX, 'max-h-72 w-56 overflow-y-auto')}>
          {folders.map(folder => (
            <button
              key={folder.path}
              type="button"
              role="menuitem"
              data-mail-move-target={folder.path}
              onClick={() => { run('moveTo', folder.path); setOpenMenu(null) }}
              className={MENU_ROW}
            >
              <span className="flex-1 truncate text-left">{folder.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Un groupe = ses boutons, précédés d'un trait fin dès qu'il n'est pas le premier affiché. */
function ToolbarGroup({ items, first, openMenu, setOpenMenu }: {
  items: readonly MailToolbarItem[]
  first: boolean
} & Pick<ButtonProps, 'openMenu' | 'setOpenMenu'>) {
  return (
    <>
      {!first && <span data-mail-toolbar-separator className={SEPARATOR} />}
      {items.map(item => (
        <ToolbarButton key={item.action} item={item} openMenu={openMenu} setOpenMenu={setOpenMenu} />
      ))}
    </>
  )
}

/**
 * Barre d'outils du courrier, dans la head bar — « comme Mail sur Mac » : relever |
 * archiver, supprimer, indésirable | répondre, répondre à tous, transférer | drapeau,
 * non lu, déplacer. L'ordre, les icônes et les libellés viennent de
 * `MAIL_TOOLBAR_GROUPS` : ce composant ne connaît AUCUNE logique de courrier, il lit
 * une capacité et appelle une action du contexte partagé.
 *
 * Un bouton sans capacité est grisé, jamais masqué : la barre ne saute pas quand la
 * sélection change. Ce qui ne tient plus dans la largeur passe dans le menu « … ».
 */
export function MailToolbar() {
  const t = useTranslations('mail')
  const [openMenu, setOpenMenu] = useState<MailActionName | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreBoxRef = useAnchoredMenu(moreOpen, () => setMoreOpen(false), moreRef)
  const hidden = useOverflowGroups(hostRef, probeRef)

  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const visible = MAIL_TOOLBAR_GROUPS.map((items, i) => ({ items, i })).filter(g => !hiddenSet.has(g.i))
  const overflowed = MAIL_TOOLBAR_GROUPS.map((items, i) => ({ items, i })).filter(g => hiddenSet.has(g.i))

  return (
    <div ref={hostRef} data-mail-toolbar className="relative flex min-w-0 flex-1 items-center">
      {/* Sonde hors écran : la largeur que TOUS les groupes demanderaient, mesurée
          sur le rendu réel. Elle ne se voit pas et ne se clique pas. */}
      <div
        ref={probeRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 flex items-center opacity-0"
        style={{ visibility: 'hidden' }}
      >
        {MAIL_TOOLBAR_GROUPS.map((items, i) => (
          <span key={i} className="flex items-center">
            {i > 0 && <span className={SEPARATOR} />}
            {items.map(item => (
              <span key={item.action} className={ACTION}><item.Icon className={ICON} /></span>
            ))}
          </span>
        ))}
      </div>

      {visible.map((group, index) => (
        <ToolbarGroup
          key={group.i}
          items={group.items}
          first={index === 0}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
        />
      ))}

      {overflowed.length > 0 && (
        <>
        <span data-mail-toolbar-separator className={SEPARATOR} />
        <div ref={moreBoxRef} className="relative shrink-0">
          <button
            ref={moreRef}
            type="button"
            title={t('moreActions')}
            aria-label={t('moreActions')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(o => !o)}
            data-mail-toolbar-more
            className={ACTION}
          >
            <MoreHorizontal className={ICON} />
          </button>
          {moreOpen && (
            <div role="menu" data-mail-toolbar-more-menu className={cn(MENU_BOX, 'flex w-auto items-center p-1')}>
              {overflowed.map((group, index) => (
                <ToolbarGroup
                  key={group.i}
                  items={group.items}
                  first={index === 0}
                  openMenu={openMenu}
                  setOpenMenu={setOpenMenu}
                />
              ))}
            </div>
          )}
        </div>
        </>
      )}
    </div>
  )
}
