/**
 * Recherche de courrier — source unique du contrat, partagée par la barre
 * d'application (qui écrit), la liste des messages (qui lit) et l'API.
 *
 * L'état de la recherche vit dans l'URL de la boîte (`/mail?q=…&scope=…`) : un
 * seul champ la pilote, un rechargement la conserve, et aucun composant n'en
 * garde une copie qui pourrait diverger.
 */
import { MAIL_PATH } from './compose'

export const SEARCH_PARAM = 'q'
export const SCOPE_PARAM = 'scope'
export const SCOPE_FOLDER = 'folder'
export const SCOPE_ALL = 'all'
export type SearchScope = typeof SCOPE_FOLDER | typeof SCOPE_ALL

/** En deçà, IMAP renverrait la boîte entière : la recherche reste inactive. */
export const MIN_QUERY_LENGTH = 2
/** Frappe → requête : même délai que celui de l'ancien champ de la liste. */
export const SEARCH_DEBOUNCE_MS = 400
/**
 * Nombre maximal de résultats renvoyés PAR DOSSIER interrogé. Au-delà, la réponse
 * porte le nombre total de correspondances (`total`) et l'interface le dit.
 * ponytail: 50 → 200 parce qu'une recherche d'adresse sur une vraie boîte dépasse
 * couramment 50 sans le dire ; passer au-delà demanderait une pagination de la
 * recherche (curseur sur les UID), pas un plafond plus haut.
 */
export const SEARCH_RESULT_LIMIT = 200

/**
 * Les champs interrogés par une recherche, dans l'ordre où l'interface les nomme.
 * Source unique : le serveur construit sa requête IMAP avec, l'interface dit
 * laquelle avec les mêmes clés de traduction (`searchField.<champ>`).
 *
 * Le CORPS des messages n'y est PAS, et ce n'est pas un oubli : mesuré le
 * 19/09/2026 sur IONOS (nicolas@3d-expert.fr), `BODY` comme `TEXT` renvoient 0
 * résultat en 2,5 s — et les ajouter au `OR` fait tomber le `OR` ENTIER à 0.
 * Ne rien y remettre sans l'avoir mesuré sur le serveur visé.
 */
export const SEARCH_FIELDS = ['from', 'to', 'cc', 'subject'] as const
export type SearchField = typeof SEARCH_FIELDS[number]

/** Le raccourci « / » de la boîte donne le focus au champ de la barre. */
export const SEARCH_FOCUS_EVENT = 'synapmail:focus-search'

export function focusSearch() {
  window.dispatchEvent(new CustomEvent(SEARCH_FOCUS_EVENT))
}

export function isSearchQuery(q: string | null | undefined): boolean {
  return (q?.trim().length ?? 0) >= MIN_QUERY_LENGTH
}

export function readScope(raw: string | null | undefined): SearchScope {
  return raw === SCOPE_ALL ? SCOPE_ALL : SCOPE_FOLDER
}

/**
 * Construit l'URL de la boîte portant la recherche, en conservant les autres
 * paramètres déjà présents (le dossier courant, notamment).
 */
export function buildSearchHref(current: string | URLSearchParams, q: string, scope: SearchScope): string {
  const params = new URLSearchParams(current)
  const trimmed = q.trim()
  if (trimmed) params.set(SEARCH_PARAM, trimmed)
  else params.delete(SEARCH_PARAM)
  if (trimmed && scope === SCOPE_ALL) params.set(SCOPE_PARAM, SCOPE_ALL)
  else params.delete(SCOPE_PARAM)
  const qs = params.toString()
  return qs ? `${MAIL_PATH}?${qs}` : MAIL_PATH
}

/**
 * Découpe une requête en TERMES, tous exigés (ET) : « 3d cpi » trouve les messages
 * où « 3d » ET « cpi » apparaissent chacun dans au moins un champ, dans n'importe
 * quel ordre — là où la version précédente cherchait la sous-chaîne « 3d cpi ».
 *
 * - une expression entre guillemets reste UNE sous-chaîne exacte : « "3d cpi" » ;
 * - espaces multiples et casse sont sans effet ;
 * - un terme de moins de MIN_QUERY_LENGTH caractères est ignoré (IMAP renverrait
 *   la boîte entière) ; entre guillemets, il est gardé tel quel s'il est non vide ;
 * - un guillemet non refermé ferme en fin de chaîne.
 *
 * Fonction PURE : aucun accès réseau, aucun état — son auto-contrôle exécutable
 * est `scripts/check-search-parse.mjs`.
 */
export function parseQuery(q: string | null | undefined): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  const add = (raw: string, quoted: boolean) => {
    const term = raw.trim()
    if (!term) return
    if (!quoted && term.length < MIN_QUERY_LENGTH) return
    const key = term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(term)
  }
  // Un seul balayage : on bascule à chaque guillemet entre « mots séparés par des
  // espaces » et « une seule expression ». Pas d'expression régulière à retenir.
  let buffer = ''
  let quoted = false
  for (const ch of q ?? '') {
    if (ch === '"') { add(buffer, quoted); buffer = ''; quoted = !quoted; continue }
    if (!quoted && /\s/.test(ch)) { add(buffer, false); buffer = ''; continue }
    buffer += ch
  }
  add(buffer, quoted)
  return terms
}
