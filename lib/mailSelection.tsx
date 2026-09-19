'use client'

/**
 * État partagé de la boîte — source unique de ce qu'une barre d'outils de
 * courrier doit connaître, et des actions qu'elle peut déclencher.
 *
 * La liste des messages PUBLIE ici le compte, le dossier, la sélection et le
 * message ouvert, puis ENREGISTRE ses actions. Tout consommateur (menu
 * contextuel, barre d'outils de la barre d'application) ne fait que LIRE l'état
 * et APPELER ces actions : aucune logique de courrier ne vit hors de la liste.
 *
 * Hors de la boîte, le fournisseur n'a rien reçu : la cible est vide et toutes
 * les capacités sont fausses.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Archive, Flag, Forward, Mail, MoveRight, RefreshCw, Reply, ReplyAll, Trash2, MailX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { groupByOrigin, groupsToMove, sameOrigin, type MessageOrigin } from './mailOrigin'

/** Couleur de drapeau (lot M2) — `null` retire le drapeau. */
export type MailFlagValue = string | null

/**
 * La palette des sept drapeaux vit dans `lib/flags.ts` (clés, index IMAP,
 * couleurs) et se rend par `components/mail/FlagPicker.tsx` : une barre d'outils
 * qui propose des couleurs monte CE composant. Aucune seconde liste ici — la
 * précédente divergeait déjà de la source (`grey` contre `gray`).
 */

/** Actions qu'une barre d'outils peut déclencher. Une action non enregistrée ne fait rien. */
export interface MailActions {
  refresh: () => void
  reply: () => void
  replyAll: () => void
  forward: () => void
  archive: () => void
  remove: () => void
  spam: () => void
  setFlag: (flag: MailFlagValue) => void
  markRead: () => void
  markUnread: () => void
  moveTo: (destination: string) => void
  /** Reporte la cible : elle disparaît de la liste jusqu'à cette date (lot M3b). */
  snooze: (until: Date) => void
}

export type MailActionName = keyof MailActions

/** Ce que la liste publie à chaque rendu. */
export interface MailSelectionState {
  /** Boîte et dossier AFFICHÉS — le contexte de la liste, pas l'origine des cibles. */
  accountId: string | null
  folder: string | null
  /**
   * Lignes sélectionnées, chacune avec SON origine : une recherche « tous les
   * dossiers » en mêle plusieurs, et un uid ne désigne un message que dans son
   * dossier. Vide = la cible est le message ouvert.
   */
  selected: MessageOrigin[]
  /** Message ouvert dans le volet de lecture, avec son origine, s'il y en a un. */
  open: MessageOrigin | null
  /** Permissions de partage du compte actif (voir lib/accountAccess.ts côté serveur). */
  canSend: boolean
  canDelete: boolean
  canOrganize: boolean
  /** Un dossier d'archive / d'indésirables existe-t-il sur ce compte ? */
  hasArchive: boolean
  hasSpam: boolean
}

export type MailCapabilities = Record<MailActionName, boolean>

const EMPTY_STATE: MailSelectionState = {
  accountId: null,
  folder: null,
  selected: [],
  open: null,
  canSend: false,
  canDelete: false,
  canOrganize: false,
  hasArchive: false,
  hasSpam: false,
}

/**
 * Nombre de messages que les actions viseraient : la sélection si elle existe,
 * sinon le message ouvert. Une barre d'outils affiche ce compte ; les capacités
 * en dérivent.
 */
export function targetOrigins(state: MailSelectionState): MessageOrigin[] {
  if (state.selected.length) return state.selected
  return state.open ? [state.open] : []
}

export function targetCount(state: MailSelectionState): number {
  return targetOrigins(state).length
}

/**
 * Les cibles regroupées par origine : UNE requête groupée par (compte, dossier).
 * Toute action de masse passe par là — jamais par le dossier affiché.
 */
export function targetGroups(state: MailSelectionState) {
  return groupByOrigin(targetOrigins(state))
}

/**
 * Les dossiers qu'un menu « Déplacer vers » a le droit de proposer : ceux qu'au
 * moins un groupe visé QUITTERAIT. Proposer le dossier où toute la cible se
 * trouve déjà promettait une action qui n'en est pas une (mesuré le 20/09/2026).
 * Les deux menus (clic droit, barre d'outils) lisent CETTE fonction — pas deux
 * filtres écrits séparément, dont l'un oubliait la boîte du groupe.
 */
export function movableFolders<T extends { path: string }>(
  state: MailSelectionState,
  folders: readonly T[],
): T[] {
  const origins = targetOrigins(state)
  return folders.filter(folder => groupsToMove(origins, folder.path).length > 0)
}

export function deriveCapabilities(state: MailSelectionState): MailCapabilities {
  const n = targetCount(state)
  const organize = n > 0 && state.canOrganize
  // Un transfert multiple relit les sources dans UN dossier d'UNE boîte
  // (`lib/forward.ts`) : une sélection qui en mêle plusieurs n'a pas d'origine
  // unique à annoncer, et la transférer joindrait les messages portant les
  // mêmes uid dans le mauvais dossier. Le bouton se désactive — c'est la
  // réponse honnête, et elle ne coûte aucune seconde liste de règles.
  // ponytail: refus tant qu'un besoin mesuré n'impose pas un envoi par origine.
  const oneOrigin = targetGroups(state).length <= 1
  return {
    refresh: !!state.accountId,
    // Répondre vise UN message : sur une sélection multiple, l'action n'a pas de sens.
    reply: n === 1 && state.canSend,
    replyAll: n === 1 && state.canSend,
    forward: n > 0 && state.canSend && oneOrigin,
    archive: organize && state.hasArchive,
    remove: n > 0 && state.canDelete,
    spam: organize && state.hasSpam,
    setFlag: organize,
    markRead: organize,
    markUnread: organize,
    moveTo: organize,
    snooze: organize,
  }
}

/**
 * Ordre canonique des boutons, « comme la barre d'outils de Mail sur Mac » :
 * relever | archiver, supprimer, indésirable | répondre, répondre à tous,
 * transférer | drapeau, non lu, déplacer. Une barre d'outils lit CE tableau —
 * l'ordre, les libellés et les icônes ne se recopient nulle part ailleurs.
 */
export interface MailToolbarItem {
  action: MailActionName
  /** Clé i18n, sous l'espace `mail`. */
  labelKey: string
  Icon: LucideIcon
  /**
   * Touche qui déclenche la même action au clavier (`hooks/useKeyboardShortcuts.ts`),
   * affichée dans l'infobulle du bouton. Absente = l'action n'a pas de raccourci.
   */
  shortcut?: string
}

export const MAIL_TOOLBAR_GROUPS: readonly (readonly MailToolbarItem[])[] = [
  [{ action: 'refresh', labelKey: 'refresh', Icon: RefreshCw }],
  [
    { action: 'archive', labelKey: 'archiveAction', Icon: Archive },
    { action: 'remove', labelKey: 'delete', Icon: Trash2, shortcut: '⌦' },
    { action: 'spam', labelKey: 'spam', Icon: MailX },
  ],
  [
    { action: 'reply', labelKey: 'reply', Icon: Reply, shortcut: 'R' },
    { action: 'replyAll', labelKey: 'replyAll', Icon: ReplyAll, shortcut: 'A' },
    { action: 'forward', labelKey: 'forward', Icon: Forward, shortcut: 'F' },
  ],
  [
    { action: 'setFlag', labelKey: 'flag', Icon: Flag },
    { action: 'markUnread', labelKey: 'markUnread', Icon: Mail, shortcut: 'U' },
    { action: 'moveTo', labelKey: 'move', Icon: MoveRight },
  ],
] as const

interface MailSelectionContextValue {
  state: MailSelectionState
  can: MailCapabilities
  count: number
  /** Appelle l'action enregistrée, ou ne fait rien si la capacité est fausse. */
  run: <K extends MailActionName>(name: K, ...args: Parameters<MailActions[K]>) => void
  /** Réservé à la boîte : publie l'état (`null` = la boîte est quittée, cible vide). */
  publish: (state: MailSelectionState | null) => void
  /** Réservé à la boîte : ajoute des actions au registre, sans effacer celles des autres. */
  register: (actions: Partial<MailActions>) => void
}

const MailSelectionContext = createContext<MailSelectionContextValue | null>(null)

export function MailSelectionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MailSelectionState>(EMPTY_STATE)
  // Les actions changent d'identité à chaque rendu de la liste : les garder dans
  // une référence évite de re-rendre tous les consommateurs pour rien.
  const actionsRef = useRef<Partial<MailActions>>({})

  const publish = useCallback((next: MailSelectionState | null) => {
    const value = next ?? EMPTY_STATE
    setState(prev => (sameState(prev, value) ? prev : value))
  }, [])

  const register = useCallback((actions: Partial<MailActions>) => {
    actionsRef.current = { ...actionsRef.current, ...actions }
  }, [])

  const can = useMemo(() => deriveCapabilities(state), [state])
  const count = targetCount(state)

  // `run` est stable : il lit l'état courant par référence plutôt que par clôture.
  const stateRef = useRef(state)
  stateRef.current = state

  const run = useCallback<MailSelectionContextValue['run']>((name, ...args) => {
    if (!deriveCapabilities(stateRef.current)[name]) return
    const fn = actionsRef.current[name] as ((...a: unknown[]) => void) | undefined
    fn?.(...args)
  }, [])

  const value = useMemo(
    () => ({ state, can, count, run, publish, register }),
    [state, can, count, run, publish, register]
  )

  return <MailSelectionContext.Provider value={value}>{children}</MailSelectionContext.Provider>
}

function sameOpen(a: MessageOrigin | null, b: MessageOrigin | null): boolean {
  return a === b || (!!a && !!b && sameOrigin(a, b))
}

function sameState(a: MailSelectionState, b: MailSelectionState): boolean {
  return (
    a.accountId === b.accountId &&
    a.folder === b.folder &&
    a.canSend === b.canSend &&
    a.canDelete === b.canDelete &&
    a.canOrganize === b.canOrganize &&
    a.hasArchive === b.hasArchive &&
    a.hasSpam === b.hasSpam &&
    sameOpen(a.open, b.open) &&
    a.selected.length === b.selected.length &&
    a.selected.every((origin, i) => sameOrigin(origin, b.selected[i]))
  )
}

/** Lecture seule + déclenchement, pour tout consommateur (menu, barre d'outils). */
export function useMailSelection(): MailSelectionContextValue {
  const ctx = useContext(MailSelectionContext)
  if (ctx) return ctx
  // Hors de la boîte, le fournisseur peut ne pas être monté : état vide, tout faux.
  return FALLBACK
}

const FALLBACK: MailSelectionContextValue = {
  state: EMPTY_STATE,
  can: deriveCapabilities(EMPTY_STATE),
  count: 0,
  run: () => {},
  publish: () => {},
  register: () => {},
}

/**
 * Attribut posé par la liste sur son conteneur : le nombre de messages visés.
 * Le banc de mesure le lit dans le DOM — pas de variable globale en production.
 */
export const MAIL_SELECTION_COUNT_ATTR = 'data-mail-selection-count'
