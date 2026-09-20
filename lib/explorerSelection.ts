/**
 * Sélection façon explorateur — la RÈGLE, une seule fois.
 *
 * Trois gestes, et rien d'autre : un clic simple ne garde que la ligne cliquée,
 * Cmd/Ctrl-clic ajoute ou retire celle-là seule, Maj-clic prend la plage entre
 * l'ANCRE (la dernière ligne cliquée sans Maj) et la ligne visée, dans l'ordre
 * AFFICHÉ. L'ancre voyage avec la sélection : la rendre ici évite qu'un écran
 * l'oublie et fasse partir la plage d'ailleurs que de la ligne surlignée.
 *
 * Fonction pure : elle ne connaît ni message, ni abonnement, ni React. Les
 * écrans lui passent les clés VISIBLES dans leur ordre d'affichage et reçoivent
 * l'état suivant. Deux écrans, une seule règle : la liste des messages
 * (`components/layout/MessageList.tsx`) et la liste des abonnements du tableau
 * de bord (`app/(app)/dashboard/SubscriptionsCard.tsx`).
 */

export type ExplorerGesture = 'replace' | 'toggle' | 'range'

export interface ExplorerSelection {
  /** Les clés retenues. L'appelant en fait ce qu'il veut, il ne la mute pas. */
  selected: Set<string>
  /** D'où partira le prochain Maj-clic. `null` = aucune ancre posée. */
  anchor: string | null
}

/** Le geste que décrivent les touches enfoncées pendant le clic. */
export function gestureOf(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>): ExplorerGesture {
  if (e.metaKey || e.ctrlKey) return 'toggle'
  if (e.shiftKey) return 'range'
  return 'replace'
}

/**
 * L'état de sélection APRÈS le clic. `keys` est la liste visible, dans l'ordre
 * affiché : c'est elle qui définit ce qu'une plage contient.
 *
 * Maj-clic sans ancre, ou sur une clé absente de la liste, ne peut pas décrire
 * de plage : il retombe sur la ligne seule, plutôt que de tout prendre.
 */
export function explorerSelect(
  keys: readonly string[],
  current: ExplorerSelection,
  key: string,
  gesture: ExplorerGesture,
): ExplorerSelection {
  if (gesture === 'toggle') {
    const selected = new Set(current.selected)
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    return { selected, anchor: key }
  }

  if (gesture === 'range') {
    const to = keys.indexOf(key)
    const from = current.anchor === null ? -1 : keys.indexOf(current.anchor)
    if (to < 0 || from < 0) return { selected: new Set([key]), anchor: key }
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    // L'ancre NE bouge PAS sur un Maj-clic : deux Maj-clics de suite partent du
    // même point, comme dans un explorateur de fichiers.
    return { selected: new Set(keys.slice(lo, hi + 1)), anchor: current.anchor }
  }

  return { selected: new Set([key]), anchor: key }
}

/** « Tout sélectionner » / « ne rien garder », sur les clés visibles. */
export function selectAll(keys: readonly string[], allSelected: boolean): ExplorerSelection {
  return allSelected ? { selected: new Set(), anchor: null } : { selected: new Set(keys), anchor: null }
}

/** Vrai quand la liste visible n'est pas vide et qu'elle est entièrement retenue. */
export function isAllSelected(keys: readonly string[], selected: ReadonlySet<string>): boolean {
  return keys.length > 0 && keys.every(k => selected.has(k))
}
