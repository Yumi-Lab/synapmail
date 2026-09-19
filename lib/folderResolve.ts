/**
 * Résoudre un chemin de dossier AVANT d'agir dessus : le compte accessible, le dossier
 * réellement présent chez le serveur, son rôle, son délimiteur et ses enfants. Toutes
 * les routes de mutation partent de là — un chemin inventé par le client n'atteint
 * jamais IMAP, et la règle de `lib/folderActions.ts` est évaluée sur des faits du
 * serveur, pas sur ce que le client a bien voulu envoyer.
 */
import { getAccessibleAccount, type AccessibleAccount, type AccountPermission } from './accountAccess'
import { toImapConfig } from './accounts'
import { listFolders } from './imap'
import { detectSpecials, type SpecialType } from './specialFolders'
import { folderCapabilities, isDescendant, type FolderCapabilities } from './folderActions'
import type { Folder } from '@/types/email'

export interface ResolvedFolder {
  account: AccessibleAccount
  config: ReturnType<typeof toImapConfig>
  folders: Folder[]
  /** Le dossier visé, `null` quand on ne vise que le compte (création à la racine). */
  folder: Folder | null
  special: SpecialType
  delimiter: string
  hasChildren: boolean
  can: FolderCapabilities
}

/** Délimiteur du compte, pris sur les dossiers eux-mêmes — jamais supposé `/`. */
export function accountDelimiter(folders: Folder[]): string {
  return folders.find(f => f.delimiter)?.delimiter ?? '/'
}

/**
 * `path` vide ou absent = on ne vise aucun dossier (création à la racine). Retourne
 * `null` quand le compte n'est pas accessible OU quand le chemin n'existe pas : même
 * forme d'échec dans les deux cas, pour ne rien révéler de ce qui existe.
 */
export async function resolveFolder(
  accountId: string | null,
  userId: string,
  path: string | null,
  required: AccountPermission[] = [],
): Promise<ResolvedFolder | null> {
  if (!accountId) return null
  const account = await getAccessibleAccount(accountId, userId, required)
  if (!account) return null

  const config = toImapConfig(account)
  const folders = await listFolders(config)
  const delimiter = accountDelimiter(folders)

  const folder = path ? folders.find(f => f.path === path) ?? null : null
  if (path && !folder) return null

  const specials = detectSpecials(folders)
  const special = folder ? specials.get(folder.path) ?? null : null
  const hasChildren = folder ? folders.some(f => isDescendant(f.path, folder.path, delimiter)) : false

  return {
    account, config, folders, folder, special, delimiter, hasChildren,
    can: folderCapabilities({
      special,
      hasChildren,
      canOrganize: account.permissions.organize,
      canDelete: account.permissions.delete,
    }),
  }
}
