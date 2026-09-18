'use client'

/**
 * Menu du clic droit. Il ne contient AUCUNE logique de courrier : il lit les
 * capacités de `lib/mailSelection` et appelle ses actions, exactement comme la
 * barre d'outils de la barre d'application. Ce que le menu sait de la ligne
 * visée se limite à ce qu'il AFFICHE (lu / non lu, couleur du drapeau posé) ;
 * la CIBLE des actions est la sélection publiée par la liste.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Archive, Clock, Flag, Forward, Mail, MailOpen, MailX, MoveRight, Reply, ReplyAll, Trash2, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { FlagPicker } from '@/components/mail/FlagPicker'
import { flagByKey } from '@/lib/flags'
import { useMailSelection } from '@/lib/mailSelection'
import { snoozePresets } from '@/lib/snooze-presets'
import { cn } from '@/lib/utils'
import type { Folder } from '@/types/email'

export interface ContextMenuState {
  x: number
  y: number
  /** Ligne cliquée — sert à l'AFFICHAGE (bascule lu/non lu, pastille cochée). */
  isRead: boolean
  flag: string | null
  folderPath: string
}

interface Props {
  menu: ContextMenuState
  folders: Folder[]
  onClose: () => void
}

/** Marge gardée entre le menu et le bord de la fenêtre. */
const EDGE_GAP = 8

export function MessageContextMenu({ menu, folders, onClose }: Props) {
  const t = useTranslations('mail')
  const { can, run } = useMailSelection()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  // Le menu reste dans l'écran d'après sa taille RÉELLE : une hauteur devinée
  // laisserait les dernières entrées sous le bord dès qu'on en ajoute une.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPos({
      x: Math.max(EDGE_GAP, Math.min(menu.x, window.innerWidth - box.width - EDGE_GAP)),
      y: Math.max(EDGE_GAP, Math.min(menu.y, window.innerHeight - box.height - EDGE_GAP)),
    })
  }, [menu.x, menu.y])

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

  const item = (
    key: string,
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    { enabled, danger }: { enabled: boolean; danger?: boolean },
  ) => (
    <button
      key={key}
      type="button"
      data-menu-item={key}
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

  const submenu = (key: string, icon: React.ReactNode, label: string, enabled: boolean, body: React.ReactNode) => (
    <div className={cn('group relative', !enabled && 'opacity-40 pointer-events-none')} data-menu-item={key}>
      <div className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-foreground hover:bg-accent cursor-default transition-colors">
        {icon}
        {label}
        <ChevronRight className="w-3 h-3 ml-auto" />
      </div>
      <div className="absolute left-full top-0 hidden group-hover:block bg-popover border border-border rounded-lg shadow-xl py-1 z-[101]">
        {body}
      </div>
    </div>
  )

  const ICON = 'w-3.5 h-3.5 shrink-0'
  const separator = <div className="my-1 border-t border-border" />
  const otherFolders = folders.filter(f => f.path !== menu.folderPath)

  return (
    <div
      ref={ref}
      data-mail-context-menu
      className="fixed z-[100] min-w-[210px] bg-popover border border-border rounded-lg shadow-xl py-1"
      style={{ left: pos.x, top: pos.y }}
    >
      {item('reply', <Reply className={ICON} />, t('reply'), () => run('reply'), { enabled: can.reply })}
      {item('replyAll', <ReplyAll className={ICON} />, t('replyAll'), () => run('replyAll'), { enabled: can.replyAll })}
      {item('forward', <Forward className={ICON} />, t('forward'), () => run('forward'), { enabled: can.forward })}

      {separator}

      {submenu(
        'flag',
        <Flag className={cn(ICON, menu.flag && 'fill-current')} style={flagByKey(menu.flag)?.color ? { color: flagByKey(menu.flag)!.color } : undefined} />,
        t('flag'),
        can.setFlag,
        <FlagPicker current={menu.flag} onPick={flag => { run('setFlag', flag); onClose() }} />,
      )}
      {menu.isRead
        ? item('markUnread', <Mail className={ICON} />, t('markUnread'), () => run('markUnread'), { enabled: can.markUnread })
        : item('markRead', <MailOpen className={ICON} />, t('markRead'), () => run('markRead'), { enabled: can.markRead })}

      {separator}

      {item('archive', <Archive className={ICON} />, t('archiveAction'), () => run('archive'), { enabled: can.archive })}
      {submenu(
        'move',
        <MoveRight className={ICON} />,
        t('move'),
        can.moveTo,
        <div className="min-w-[180px] max-h-64 overflow-y-auto">
          {otherFolders.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{t('noFolders')}</p>}
          {otherFolders.map(f => (
            <button
              key={f.path}
              type="button"
              data-menu-folder={f.path}
              onClick={() => { run('moveTo', f.path); onClose() }}
              className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors truncate"
            >
              {f.name}
            </button>
          ))}
        </div>,
      )}
      {item('spam', <MailX className={ICON} />, t('spam'), () => run('spam'), { enabled: can.spam })}
      {/* Reporter : retiré des lignes au lot M3b, il n'existait nulle part ailleurs. */}
      {submenu(
        'snooze',
        <Clock className={ICON} />,
        t('snooze'),
        can.snooze,
        <div className="min-w-[180px]">
          {snoozePresets().map(p => (
            <button
              key={p.key}
              type="button"
              data-menu-snooze={p.key}
              onClick={() => { run('snooze', p.date); onClose() }}
              className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
            >
              <span>{t(p.key)}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {p.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </button>
          ))}
        </div>,
      )}

      {separator}

      {item('remove', <Trash2 className={ICON} />, t('delete'), () => run('remove'), { enabled: can.remove, danger: true })}
    </div>
  )
}
