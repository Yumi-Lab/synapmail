'use client'

/**
 * Menu du clic droit. Il ne contient AUCUNE logique de courrier : il lit les
 * capacités de `lib/mailSelection` et appelle ses actions, exactement comme la
 * barre d'outils de la barre d'application. Ce que le menu sait de la ligne
 * visée se limite à ce qu'il AFFICHE (lu / non lu, couleur du drapeau posé) ;
 * la CIBLE des actions est la sélection publiée par la liste.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Clock, Flag, Forward, Mail, MailOpen, MailX, MoveRight, Reply, ReplyAll, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { ThinScroll } from '@/components/layout/ThinScroll'
import { FlagPicker } from '@/components/mail/FlagPicker'
import {
  ContextMenuSurface, ContextMenuItem, ContextMenuSubmenu, ContextMenuSeparator,
  MENU_ICON, focusMenuStep,
} from '@/components/ui/ContextMenu'
import { flagByKey } from '@/lib/flags'
import { movableFolders, useMailSelection } from '@/lib/mailSelection'
import { foldText } from '@/lib/omnibarCommands'
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

export function MessageContextMenu({ menu, folders, onClose }: Props) {
  const t = useTranslations('mail')
  const { can, run, state } = useMailSelection()
  const item = (
    key: string,
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    { enabled, danger }: { enabled: boolean; danger?: boolean },
  ) => (
    <ContextMenuItem key={key} itemKey={key} icon={icon} label={label} onClick={onClick} onClose={onClose} enabled={enabled} danger={danger} />
  )

  const submenu = (key: string, icon: React.ReactNode, label: string, enabled: boolean, body: React.ReactNode) => (
    <ContextMenuSubmenu itemKey={key} icon={icon} label={label} enabled={enabled}>{body}</ContextMenuSubmenu>
  )

  const ICON = MENU_ICON
  const separator = <ContextMenuSeparator />
  // La cible peut mêler plusieurs dossiers : ce n'est pas le dossier de la ligne
  // cliquée qui décide, mais ce que la SÉLECTION quitterait (`movableFolders`).
  const otherFolders = movableFolders(state, folders)

  return (
    <ContextMenuSurface anchor={menu} onClose={onClose} data-mail-context-menu>
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
        <FolderPicker folders={otherFolders} onPick={path => { run('moveTo', path); onClose() }} />,
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
    </ContextMenuSurface>
  )
}

/** Hauteur maximale de la liste des dossiers, en px : au-delà elle défile. Choisie pour
 *  qu'une dizaine de lignes tienne sans que le panneau couvre l'écran. */
const FOLDER_LIST_MAX_H = 260

/**
 * Le chemin du PARENT d'un dossier, tel qu'on l'écrit à l'écran, ou `null` à la racine.
 * Il est affiché en second plan parce que deux branches ont souvent un « Archive » : à
 * plat, les deux lignes étaient le même mot, et rien ne disait où l'on déplaçait. Une
 * indentation ne l'aurait dit que liste entière — dès qu'on filtre, le parent disparaît
 * de la liste et le décalage ne désigne plus rien.
 */
function folderParent(folder: Folder): string | null {
  const sep = folder.delimiter || '/'
  const at = folder.path.lastIndexOf(sep)
  return at <= 0 ? null : folder.path.slice(0, at).split(sep).join(' / ')
}

/**
 * La liste « Déplacer vers ». Elle défile avec l'ascenseur de l'application (`ThinScroll`,
 * saisissable à la souris) et non avec un `overflow-y-auto` nu : attraper l'ascenseur natif
 * du panneau était justement le geste qui refermait le menu.
 *
 * Le champ de filtre a le focus à l'ouverture — sur une boîte de 1 244 dossiers, dérouler
 * une liste à la molette n'est pas une façon de choisir.
 */
function FolderPicker({ folders, onPick }: { folders: Folder[]; onPick: (path: string) => void }) {
  const t = useTranslations('mail')
  const [filter, setFilter] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Insensible à la casse ET aux accents : « Réponses » se trouve en tapant « repon ».
  // `foldText` est celui de l'omnibar, pas une copie — une seconde normalisation
  // dériverait de la première au premier caractère particulier.
  const shown = useMemo(() => {
    const needle = foldText(filter.trim())
    if (!needle) return folders
    return folders.filter(f => foldText(f.path).includes(needle) || foldText(f.name).includes(needle))
  }, [folders, filter])

  const rows = '[data-menu-folder]'

  return (
    <div className="w-[240px]" data-menu-folder-picker>
      <input
        ref={inputRef}
        type="text"
        value={filter}
        data-menu-folder-filter
        onChange={e => setFilter(e.target.value)}
        placeholder={t('filterFolders')}
        aria-label={t('filterFolders')}
        onKeyDown={e => {
          // Entrée déplace vers le PREMIER résultat : c'est la raison d'être du filtre,
          // taper trois lettres puis valider sans quitter le clavier.
          if (e.key === 'Enter') {
            e.preventDefault()
            if (shown.length > 0) onPick(shown[0].path)
            return
          }
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          focusMenuStep(listRef.current, rows, e.key === 'ArrowDown' ? 1 : -1)
        }}
        className={cn(
          'w-full px-3 py-1.5 mb-1 text-xs bg-transparent text-foreground placeholder:text-muted-foreground',
          'border-b border-border focus:outline-none',
        )}
      />
      {shown.length === 0
        ? <p className="px-3 py-2 text-xs text-muted-foreground">{t('noFolders')}</p>
        : (
          <ThinScroll style={{ maxHeight: FOLDER_LIST_MAX_H }}>
            <div ref={listRef}>
              {shown.map(f => (
                <button
                  key={f.path}
                  type="button"
                  data-menu-folder={f.path}
                  onClick={() => onPick(f.path)}
                  onKeyDown={e => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                    e.preventDefault()
                    focusMenuStep(listRef.current, rows, e.key === 'ArrowDown' ? 1 : -1)
                  }}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-xs text-foreground transition-colors',
                    'hover:bg-accent focus-visible:outline-none focus-visible:bg-accent',
                  )}
                >
                  <span className="block truncate">{f.name}</span>
                  {folderParent(f) && (
                    <span className="block truncate text-[10px] text-muted-foreground">{folderParent(f)}</span>
                  )}
                </button>
              ))}
            </div>
          </ThinScroll>
        )}
    </div>
  )
}
