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

/** Couleur de drapeau (lot M2) — `null` retire le drapeau. */
export type MailFlagValue = string | null

/**
 * Palette des drapeaux, dans l'ordre du menu — les sept couleurs que le protocole
 * IMAP transporte en mot-clé (`$MailFlagBit`, convention d'Apple Mail reprise par
 * les autres clients). Un consommateur LIT ce tableau : ni l'ordre, ni les noms ne
 * se recopient ailleurs. La teinte est un jeton Tailwind : le rendu suit le thème.
 */
export interface MailFlagColor {
  /** Valeur passée à `setFlag`, et clé i18n sous `mail.flagColors`. */
  value: string
  /** Classe de fond de la pastille du menu. */
  swatch: string
}

export const MAIL_FLAG_COLORS: readonly MailFlagColor[] = [
  { value: 'red', swatch: 'bg-red-500' },
  { value: 'orange', swatch: 'bg-orange-500' },
  { value: 'yellow', swatch: 'bg-yellow-400' },
  { value: 'green', swatch: 'bg-emerald-500' },
  { value: 'blue', swatch: 'bg-blue-500' },
  { value: 'purple', swatch: 'bg-violet-500' },
  { value: 'grey', swatch: 'bg-zinc-400' },
] as const

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
  markUnread: () => void
  moveTo: (destination: string) => void
}

export type MailActionName = keyof MailActions

/** Ce que la liste publie à chaque rendu. */
export interface MailSelectionState {
  accountId: string | null
  folder: string | null
  /** uids sélectionnés (sélection explorateur). Vide = la cible est le message ouvert. */
  selectedUids: string[]
  /** uid du message ouvert dans le volet de lecture, s'il y en a un. */
  openUid: string | null
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
  selectedUids: [],
  openUid: null,
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
export function targetCount(state: MailSelectionState): number {
  return state.selectedUids.length || (state.openUid ? 1 : 0)
}

export function deriveCapabilities(state: MailSelectionState): MailCapabilities {
  const n = targetCount(state)
  const organize = n > 0 && state.canOrganize
  return {
    refresh: !!state.accountId,
    // Répondre vise UN message : sur une sélection multiple, l'action n'a pas de sens.
    reply: n === 1 && state.canSend,
    replyAll: n === 1 && state.canSend,
    forward: n > 0 && state.canSend,
    archive: organize && state.hasArchive,
    remove: n > 0 && state.canDelete,
    spam: organize && state.hasSpam,
    setFlag: organize,
    markUnread: organize,
    moveTo: organize,
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
}

export const MAIL_TOOLBAR_GROUPS: readonly (readonly MailToolbarItem[])[] = [
  [{ action: 'refresh', labelKey: 'refresh', Icon: RefreshCw }],
  [
    { action: 'archive', labelKey: 'archiveAction', Icon: Archive },
    { action: 'remove', labelKey: 'delete', Icon: Trash2 },
    { action: 'spam', labelKey: 'spam', Icon: MailX },
  ],
  [
    { action: 'reply', labelKey: 'reply', Icon: Reply },
    { action: 'replyAll', labelKey: 'replyAll', Icon: ReplyAll },
    { action: 'forward', labelKey: 'forward', Icon: Forward },
  ],
  [
    { action: 'setFlag', labelKey: 'flag', Icon: Flag },
    { action: 'markUnread', labelKey: 'markUnread', Icon: Mail },
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

function sameState(a: MailSelectionState, b: MailSelectionState): boolean {
  return (
    a.accountId === b.accountId &&
    a.folder === b.folder &&
    a.openUid === b.openUid &&
    a.canSend === b.canSend &&
    a.canDelete === b.canDelete &&
    a.canOrganize === b.canOrganize &&
    a.hasArchive === b.hasArchive &&
    a.hasSpam === b.hasSpam &&
    a.selectedUids.length === b.selectedUids.length &&
    a.selectedUids.every((uid, i) => uid === b.selectedUids[i])
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
