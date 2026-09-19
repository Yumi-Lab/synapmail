/**
 * Ce qu'on a le droit de faire à un dossier — source UNIQUE, lue des deux côtés du
 * contrat : les routes `/api/folders*` refusent (403 / 400) exactement ce que le menu
 * contextuel de la barre grise. Écrire la règle deux fois, c'est promettre un jour à
 * l'utilisateur une entrée cliquable que le serveur refusera.
 *
 * La règle ne connaît QUE deux choses : le rôle du dossier (`lib/specialFolders.ts`)
 * et les permissions du compte (`lib/accountAccess.ts`). Aucun chemin en dur.
 */
import type { SpecialType } from './specialFolders'

export const FOLDER_ACTIONS = ['create', 'createChild', 'rename', 'markRead', 'empty', 'remove'] as const
export type FolderAction = (typeof FOLDER_ACTIONS)[number]

/** Les seuls dossiers qu'on vide : ceux dont c'est la fonction de se vider. */
export const EMPTYABLE: ReadonlySet<SpecialType> = new Set<SpecialType>(['trash', 'spam'])

/** Ce que la règle a besoin de savoir du dossier visé et de la session. */
export interface FolderContext {
  /** Rôle RFC 6154 résolu par `detectSpecials`, `null` pour un dossier ordinaire. */
  special: SpecialType
  /** Vrai si un autre dossier est rangé SOUS celui-ci : on ne supprime pas un parent. */
  hasChildren: boolean
  /** Permission « organiser » du compte (créer, renommer, marquer lu). */
  canOrganize: boolean
  /** Permission « supprimer » du compte (supprimer le dossier, le vider). */
  canDelete: boolean
}

export type FolderCapabilities = Record<FolderAction, boolean>

/**
 * Un dossier spécial porte un rôle que le serveur déclare (RFC 6154) et que le client
 * suppose partout : le renommer ou le supprimer casse la boîte, pas seulement la barre.
 */
const isSpecial = (special: SpecialType) => special !== null

export function folderCapabilities(ctx: FolderContext): FolderCapabilities {
  const { special, hasChildren, canOrganize, canDelete } = ctx
  const structural = canOrganize && !isSpecial(special)
  return {
    create: canOrganize,
    createChild: canOrganize,
    rename: structural,
    markRead: canOrganize,
    empty: canDelete && EMPTYABLE.has(special),
    remove: canDelete && !isSpecial(special) && !hasChildren,
  }
}

/**
 * Un nom de dossier saisi par l'utilisateur, rendu sûr AVANT d'atteindre IMAP : le
 * délimiteur du serveur y placerait une hiérarchie qu'il n'a pas demandée, et les
 * caractères de contrôle cassent la commande elle-même. Retourne `null` si le nom ne
 * peut pas être accepté — l'appelant répond alors 400, il ne « répare » rien.
 */
export const FOLDER_NAME_MAX = 255

// eslint-disable-next-line no-control-regex -- c'est précisément ce qu'on refuse
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function sanitizeFolderName(raw: unknown, delimiter: string): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > FOLDER_NAME_MAX) return null
  if (CONTROL_CHARS.test(name)) return null
  if (delimiter && name.includes(delimiter)) return null
  return name
}

/** Chemin complet d'un dossier créé sous `parent` (racine si `parent` est vide). */
export function joinFolderPath(parent: string, name: string, delimiter: string): string {
  return parent ? `${parent}${delimiter}${name}` : name
}

/** Chemin du dossier renommé : il reste chez son parent, seul son dernier segment change. */
export function renamedPath(path: string, name: string, delimiter: string): string {
  const cut = path.lastIndexOf(delimiter)
  return cut < 0 ? name : `${path.slice(0, cut)}${delimiter}${name}`
}

/** Vrai si `child` est rangé sous `parent` — jamais vrai pour le dossier lui-même. */
export function isDescendant(child: string, parent: string, delimiter: string): boolean {
  return child.startsWith(`${parent}${delimiter}`)
}
