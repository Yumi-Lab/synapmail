/**
 * L'identité d'un message — source unique.
 *
 * Un uid n'est unique que DANS un dossier d'une boîte : deux messages sans
 * rapport peuvent porter l'uid 3231 dans « Réception » et dans « Objets
 * envoyés ». Tant qu'une liste n'affichait qu'un dossier, transporter l'uid seul
 * suffisait ; une recherche « tous les dossiers » mélange les origines, et
 * l'application ouvrait alors un AUTRE message, ou agissait (lu, drapeau,
 * déplacer, SUPPRIMER) sur les mauvais.
 *
 * Tout le parcours (ouvrir, cocher, agir, glisser, transférer) transporte donc
 * le TRIPLET ci-dessous, et les requêtes se construisent à partir de lui.
 */

/** Ce qui désigne un message sans ambiguïté, côté client comme côté serveur. */
export interface MessageOrigin {
  accountId: string
  folder: string
  uid: string
}

/** Attribut posé à côté de `data-mail-row` : l'origine complète de la ligne. */
export const MAIL_ORIGIN_ATTR = 'data-mail-origin'

/**
 * Clé de l'origine : ce qui sert de clé React, d'entrée de `Set` pour les cases
 * cochées et de valeur d'attribut DOM. Les trois parties sont encodées, donc un
 * dossier contenant `|` ou un accent ne peut pas produire deux clés identiques
 * pour deux messages différents.
 */
export function originKey(origin: MessageOrigin): string {
  return [origin.accountId, origin.folder, origin.uid].map(encodeURIComponent).join('|')
}

/** L'inverse de `originKey`. `null` si la clé ne porte pas les trois parties. */
export function parseOriginKey(key: string): MessageOrigin | null {
  const parts = key.split('|')
  if (parts.length !== 3) return null
  const [accountId, folder, uid] = parts.map(decodeURIComponent)
  if (!accountId || !folder || !uid) return null
  return { accountId, folder, uid }
}

export function sameOrigin(a: MessageOrigin, b: MessageOrigin): boolean {
  return a.accountId === b.accountId && a.folder === b.folder && a.uid === b.uid
}

/** Un groupe d'uid partageant la MÊME origine : exactement une requête groupée. */
export interface OriginGroup {
  accountId: string
  folder: string
  uids: string[]
}

/**
 * Regroupe des origines par (compte, dossier) en gardant l'ordre d'apparition —
 * des deux côtés : celui des groupes, et celui des uid dans un groupe. Les
 * doublons exacts sont écartés (une ligne cochée deux fois ne part pas deux
 * fois). Chaque groupe donne UNE requête à l'API groupée, dont le contrat
 * (`{ uids, accountId, folder }`) ne change pas.
 *
 * Fonction PURE : son auto-contrôle est `scripts/check-mail-origin.mjs`.
 */
export function groupByOrigin(origins: readonly MessageOrigin[]): OriginGroup[] {
  const groups = new Map<string, OriginGroup>()
  const seen = new Set<string>()
  for (const origin of origins) {
    if (!origin.accountId || !origin.folder || !origin.uid) continue
    const key = originKey(origin)
    if (seen.has(key)) continue
    seen.add(key)
    const groupKey = `${encodeURIComponent(origin.accountId)}|${encodeURIComponent(origin.folder)}`
    const group = groups.get(groupKey)
    if (group) group.uids.push(origin.uid)
    else groups.set(groupKey, { accountId: origin.accountId, folder: origin.folder, uids: [origin.uid] })
  }
  return Array.from(groups.values())
}

/**
 * Les groupes qu'un déplacement vers `destination` ferait VRAIMENT bouger.
 *
 * Un groupe déjà DANS la destination n'a rien à faire : le 20/09/2026, une
 * sélection groupée sur « Réception » proposait « Réception » comme destination
 * et y envoyait une requête de déplacement — du travail serveur pour un
 * non-événement. Le dossier compare bien les deux côtés d'une MÊME boîte : deux
 * boîtes ayant chacune « INBOX » restent deux groupes, et chacun est jugé sur
 * SON dossier.
 *
 * Source unique : la liste s'en sert pour n'émettre QUE les requêtes utiles, les
 * menus pour ne proposer une destination que si au moins un groupe la quitterait.
 *
 * Fonction PURE : son auto-contrôle est `scripts/check-mail-origin.mjs`.
 */
export function groupsToMove(origins: readonly MessageOrigin[], destination: string): OriginGroup[] {
  if (!destination) return []
  return groupByOrigin(origins).filter(group => group.folder !== destination)
}

/** L'origine d'un message reçu de l'API — il porte déjà les trois parties. */
export function originOfMessage(msg: { uid: string; accountId: string; folder: string }): MessageOrigin {
  return { accountId: msg.accountId, folder: msg.folder, uid: msg.uid }
}

/**
 * L'adresse d'UN message côté API. Source unique : lire, marquer, supprimer et
 * télécharger une pièce jointe passent tous par ici, donc aucun appelant ne peut
 * oublier le dossier — l'oubli envoyait la requête sur le dossier AFFICHÉ.
 */
export function messageHref(origin: MessageOrigin, path = ''): string {
  return `/api/messages/${encodeURIComponent(origin.uid)}${path}` +
    `?account=${encodeURIComponent(origin.accountId)}&folder=${encodeURIComponent(origin.folder)}`
}
