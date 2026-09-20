/**
 * L'adresse de la boîte quand on CHANGE de boîte aux lettres — source unique.
 *
 * Le dossier courant vit dans l'URL (`/mail?folder=…`). Changer de boîte sans y
 * toucher lisait la NOUVELLE boîte dans le dossier de l'ANCIENNE : un chemin qui
 * n'existe souvent pas chez elle, donc une liste vide et une requête pour rien.
 * Une boîte s'ouvre sur SA réception ; c'est ce que cette fonction écrit.
 */
// Chemins RELATIFS, comme `lib/search.ts` : ce module est importé tel quel par
// son auto-contrôle (`node --experimental-strip-types`), qui ne connaît pas
// l'alias `@/` du compilateur.
import { MAIL_PATH } from '../../../lib/compose'
import { SCOPE_ACCOUNTS, SCOPE_PARAM, SEARCH_PARAM, isSearchQuery, readScope } from '../../../lib/search'

/** Paramètre d'URL portant le dossier affiché. */
export const FOLDER_PARAM = 'folder'

/** Le dossier d'une boîte quand l'URL n'en nomme aucun : sa réception. */
export const DEFAULT_FOLDER = 'INBOX'

/** Événement émis par le sélecteur de comptes (barre latérale ET palette). */
export const ACCOUNT_CHANGE_EVENT = 'synapmail:account-change'

/**
 * L'URL de la boîte après un changement de boîte aux lettres, à partir des
 * paramètres actuels :
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

/**
 * Ce module vit à côté de la page de la boîte (et non dans `lib/`) parce qu'il
 * décrit l'URL de CETTE page ; la barre latérale l'importe pour lire le même
 * nom de paramètre et la même valeur par défaut, jamais pour en garder une copie.
 */
