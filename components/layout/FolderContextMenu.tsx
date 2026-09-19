'use client'

/**
 * Clic droit sur un dossier de la barre (lot H3e). Le menu N'INVENTE aucune règle :
 * il grise ce que `lib/folderActions.ts` refuse — la MÊME fonction que les routes
 * `/api/folders*` appliquent avant d'agir. Une entrée offerte ici est donc une
 * entrée que le serveur acceptera, et l'inverse.
 *
 * Il ne fait pas non plus les appels : il remonte l'intention, la barre l'exécute
 * (c'est elle qui tient la saisie en ligne et le rafraîchissement de la liste).
 */

import { FolderPlus, FolderTree, Pencil, MailOpen, Eraser, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  ContextMenuSurface, ContextMenuItem, ContextMenuSeparator, MENU_ICON,
} from '@/components/ui/ContextMenu'
import { folderCapabilities, type FolderAction } from '@/lib/folderActions'
import type { SpecialType } from '@/lib/specialFolders'

export interface FolderMenuState {
  x: number
  y: number
  path: string
  name: string
  special: SpecialType
  /** Vrai si un autre dossier est rangé sous celui-ci : on ne supprime pas un parent. */
  hasChildren: boolean
}

interface Props {
  menu: FolderMenuState
  canOrganize: boolean
  canDelete: boolean
  onAction: (action: FolderAction, menu: FolderMenuState) => void
  onClose: () => void
}

/** L'ordre du menu et l'icône de chaque entrée — la seule chose que ce fichier décide. */
const ENTRIES: Array<{ action: FolderAction; icon: React.ComponentType<{ className?: string }>; label: string; danger?: boolean }> = [
  { action: 'create', icon: FolderPlus, label: 'folderNew' },
  { action: 'createChild', icon: FolderTree, label: 'folderNewChild' },
  { action: 'rename', icon: Pencil, label: 'folderRename' },
  { action: 'markRead', icon: MailOpen, label: 'folderMarkRead' },
  { action: 'empty', icon: Eraser, label: 'folderEmpty' },
  { action: 'remove', icon: Trash2, label: 'folderDelete', danger: true },
]

export function FolderContextMenu({ menu, canOrganize, canDelete, onAction, onClose }: Props) {
  const t = useTranslations('mail')
  const can = folderCapabilities({
    special: menu.special,
    hasChildren: menu.hasChildren,
    canOrganize,
    canDelete,
  })

  return (
    <ContextMenuSurface anchor={menu} onClose={onClose} data-folder-context-menu data-folder-path={menu.path}>
      {ENTRIES.map(({ action, icon: Icon, label, danger }) => (
        <div key={action}>
          {danger && <ContextMenuSeparator />}
          <ContextMenuItem
            itemKey={action}
            icon={<Icon className={MENU_ICON} />}
            label={t(label)}
            onClick={() => onAction(action, menu)}
            onClose={onClose}
            enabled={can[action]}
            danger={danger}
          />
        </div>
      ))}
    </ContextMenuSurface>
  )
}
