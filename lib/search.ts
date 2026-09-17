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
/** Nombre maximal de résultats renvoyés, toutes boîtes confondues. */
export const SEARCH_RESULT_LIMIT = 50

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
