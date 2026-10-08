/**
 * The mailbox page URL — single source for the folder it shows, and for the URL
 * written on a folder click or an account switch.
 *
 * The current folder lives in the URL (`/mail?folder=…`): the sidebar highlights
 * it, MailClient reads it, the dashboard and the focus list link to it. This
 * module sits next to the page because it describes THIS page's URL; the other
 * components import it rather than keeping a copy of the parameter name.
 *
 * Chemins RELATIFS, comme `lib/search.ts` : ce module est importé tel quel par
 * son auto-contrôle (`node --experimental-strip-types`), qui ne connaît pas
 * l'alias `@/` du compilateur.
 */
import { MAIL_PATH } from '../../../lib/compose'
import { SCOPE_ACCOUNTS, SCOPE_PARAM, SEARCH_PARAM, isSearchQuery, readScope } from '../../../lib/search'

/** URL parameter carrying the displayed folder. */
export const FOLDER_PARAM = 'folder'

/** The folder shown when the URL names none: the inbox. */
export const DEFAULT_FOLDER = 'INBOX'

/** Événement émis par le sélecteur de comptes (barre latérale ET palette). */
export const ACCOUNT_CHANGE_EVENT = 'synapmail:account-change'

/** The address of one folder of the mailbox. */
export const folderHref = (path: string) => `${MAIL_PATH}?${FOLDER_PARAM}=${encodeURIComponent(path)}`

/**
 * Changing folder WITHIN the mailbox only changes URL parameters, so the URL is
 * pushed through the history API — which the Next 14.2 router patches and
 * follows (`useSearchParams` updates on the next render) — never through
 * `router.push`, which re-renders the route on the server: one `_rsc` request per
 * click (measured 06/10/2026 at ~1 s each from China) carrying no useful data.
 * Push, not replace: going back returns to the previous folder. A no-op when the
 * URL already shows this folder.
 */
export function pushFolder(path: string) {
  const href = folderHref(path)
  if (href !== `${window.location.pathname}${window.location.search}`) window.history.pushState(null, '', href)
}

/**
 * L'adresse de la boîte quand on CHANGE de boîte aux lettres — source unique.
 *
 * Le dossier courant vit dans l'URL (`/mail?folder=…`). Changer de boîte sans y
 * toucher lisait la NOUVELLE boîte dans le dossier de l'ANCIENNE : un chemin qui
 * n'existe souvent pas chez elle, donc une liste vide et une requête pour rien.
 * Une boîte s'ouvre sur SA réception ; c'est ce que cette fonction écrit.
 *
 * - le dossier est RETIRÉ (la nouvelle boîte s'ouvre sur sa réception) ;
 * - une recherche de portée « toutes les boîtes » est GARDÉE — elle couvre déjà
 *   la nouvelle boîte, l'effacer perdrait le travail de l'utilisateur ;
 * - une recherche « ce dossier » ou « tous les dossiers » part AVEC le dossier :
 *   elle portait sur l'ancienne boîte, la garder afficherait des résultats que
 *   la boîte affichée ne contient pas ;
 * - tout autre paramètre est conservé tel quel.
 *
 * Fonction PURE : aucun accès au DOM ni au réseau — son auto-contrôle exécutable
 * est `scripts/check-mailbox-switch.mjs`.
 */
export function mailboxSwitchHref(search: string | URLSearchParams): string {
  const params = new URLSearchParams(search)
  params.delete(FOLDER_PARAM)
  const query = params.get(SEARCH_PARAM)
  if (!isSearchQuery(query) || readScope(params.get(SCOPE_PARAM)) !== SCOPE_ACCOUNTS) {
    params.delete(SEARCH_PARAM)
    params.delete(SCOPE_PARAM)
  }
  const qs = params.toString()
  return qs ? `${MAIL_PATH}?${qs}` : MAIL_PATH
}
