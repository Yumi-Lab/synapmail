/**
 * L'ORDRE des cartes du tableau de bord — la règle, une seule fois.
 *
 * Le tableau de bord pose ses cartes dans un ordre par défaut, décrit ici et
 * nulle part ailleurs : `DASHBOARD_CARDS` est la SOURCE unique (identité,
 * largeur en colonnes, rang d'origine). L'écran en dérive son rendu, le banc en
 * dérive ses assertions, et l'ordre enregistré côté serveur n'est qu'une
 * permutation de ces identités.
 *
 * Fonction pure : ni React, ni requête, ni DOM. Elle ne sait pas qu'un ordre
 * vient de `user_settings.dashboard_card_order` — elle prend ce qu'on lui donne
 * et rend un ordre TOUJOURS complet et sans doublon, parce qu'une carte perdue
 * par une valeur corrompue serait une carte invisible sans moyen de la revoir.
 */

/** L'identité d'une carte. Stable : c'est elle qui est enregistrée, pas un rang. */
export type DashboardCardId =
  | 'focus'
  | 'activity'
  | 'accounts'
  | 'receipts'
  | 'scheduled'
  | 'rules'
  | 'followUps'
  | 'subscriptions'
  | 'quickCompose'

export interface DashboardCardSpec {
  id: DashboardCardId
  /** Les classes de largeur dans la grille 12 colonnes. Le rang, lui, se déplace. */
  span: string
}

/**
 * Les cartes, dans leur ORDRE D'ORIGINE — celui que rend « Remettre l'ordre
 * d'origine ». Ajouter une carte ici suffit : l'écran, la remise à zéro et le
 * banc la connaissent aussitôt.
 */
export const DASHBOARD_CARDS: readonly DashboardCardSpec[] = [
  { id: 'focus',         span: 'col-span-12 lg:col-span-6' },
  { id: 'activity',      span: 'col-span-12 lg:col-span-6' },
  { id: 'accounts',      span: 'col-span-12 sm:col-span-6 lg:col-span-4' },
  { id: 'receipts',      span: 'col-span-12 sm:col-span-6 lg:col-span-4' },
  { id: 'scheduled',     span: 'col-span-12 sm:col-span-6 lg:col-span-4' },
  { id: 'rules',         span: 'col-span-12 lg:col-span-8' },
  { id: 'followUps',     span: 'col-span-12 sm:col-span-6 lg:col-span-4' },
  { id: 'subscriptions', span: 'col-span-12 lg:col-span-8' },
  { id: 'quickCompose',  span: 'col-span-12' },
] as const

/** L'ordre d'origine, seul. Une copie neuve : l'appelant peut la trier. */
export function defaultCardOrder(): DashboardCardId[] {
  return DASHBOARD_CARDS.map(c => c.id)
}

const KNOWN = new Set<string>(defaultCardOrder())

/**
 * L'ordre RÉELLEMENT affichable, à partir de ce qui a été enregistré.
 *
 * Tout ce qui n'est pas une carte connue disparaît (renommage, valeur abîmée),
 * les doublons sont réduits à leur première occurrence, et les cartes absentes
 * de la valeur enregistrée reviennent À LEUR RANG D'ORIGINE plutôt qu'à la fin :
 * une carte ajoutée par une mise à jour se pose là où elle a été conçue, sans
 * que personne ait à retoucher les ordres déjà enregistrés.
 */
export function normalizeCardOrder(stored: unknown): DashboardCardId[] {
  const kept: DashboardCardId[] = []
  const seen = new Set<DashboardCardId>()
  if (Array.isArray(stored)) {
    for (const v of stored) {
      if (typeof v !== 'string' || !KNOWN.has(v)) continue
      const id = v as DashboardCardId
      if (seen.has(id)) continue
      seen.add(id)
      kept.push(id)
    }
  }
  if (seen.size === KNOWN.size) return kept

  const out = [...kept]
  defaultCardOrder().forEach((id, rank) => {
    if (seen.has(id)) return
    out.splice(Math.min(rank, out.length), 0, id)
  })
  return out
}

/**
 * L'ordre après avoir DÉPOSÉ `moved` à la place de `target` : `moved` est
 * retirée puis réinsérée à l'index qu'occupe `target` dans la liste ainsi
 * privée d'elle-même. Descendre une carte la pose donc APRÈS sa cible, monter
 * la pose AVANT — ce que fait n'importe quel gestionnaire de fichiers.
 *
 * Une identité inconnue, ou un dépôt sur soi-même, rend l'ordre inchangé : un
 * geste qui ne veut rien dire ne doit rien casser.
 */
export function moveCard(
  order: readonly DashboardCardId[],
  moved: DashboardCardId,
  target: DashboardCardId,
): DashboardCardId[] {
  const from = order.indexOf(moved)
  const to = order.indexOf(target)
  if (from < 0 || to < 0 || from === to) return [...order]
  const out = order.filter(id => id !== moved)
  out.splice(out.indexOf(target) + (from < to ? 1 : 0), 0, moved)
  return out
}

/**
 * L'ordre après avoir déplacé `moved` de `delta` rangs (clavier : −1 / +1).
 * Le déplacement SATURE aux extrémités au lieu de boucler : une carte en tête
 * qui remonte reste en tête, elle ne réapparaît pas en bas.
 */
export function shiftCard(
  order: readonly DashboardCardId[],
  moved: DashboardCardId,
  delta: number,
): DashboardCardId[] {
  const from = order.indexOf(moved)
  if (from < 0 || delta === 0) return [...order]
  const to = Math.max(0, Math.min(order.length - 1, from + delta))
  if (to === from) return [...order]
  const out = order.filter(id => id !== moved)
  out.splice(to, 0, moved)
  return out
}

/** `true` quand l'ordre donné est exactement l'ordre d'origine. */
export function isDefaultCardOrder(order: readonly DashboardCardId[]): boolean {
  const def = defaultCardOrder()
  return order.length === def.length && order.every((id, i) => id === def[i])
}

/** La largeur d'une carte, depuis la source unique. */
export function cardSpan(id: DashboardCardId): string {
  return DASHBOARD_CARDS.find(c => c.id === id)?.span ?? 'col-span-12'
}
