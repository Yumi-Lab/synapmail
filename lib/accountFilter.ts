/**
 * Filtre de boîtes, moitié PURE : ce qu'une saisie retient d'une liste de boîtes.
 * Aucun React, aucun réseau — le composant n'y ajoute que le champ et le clavier.
 * Son auto-contrôle est `scripts/check-account-filter.mjs`.
 *
 * La saisie est lue comme une EXPRESSION RÉGULIÈRE ; une expression invalide
 * (`bruno(`, tapée en cours de frappe) n'est pas une erreur : elle retombe sur une
 * recherche de texte simple. Les deux côtés de la comparaison passent par
 * `foldText`, donc « thème » se trouve en tapant « theme » et réciproquement.
 */
import { foldText } from './omnibarCommands'

/** Bornage de la saisie, lu AUSSI par le champ (`maxLength`) : une seule source. */
export const ACCOUNT_FILTER_MAX = 64

/** Ce qu'une boîte doit exposer pour être filtrée — rien de plus. */
export type FilterableAccount = { email: string; name?: string | null }

/** L'expression compilée, ou `null` si la saisie n'en est pas une. */
function compile(folded: string): RegExp | null {
  try {
    // Sans le drapeau `g` : `lastIndex` survivrait d'un `test` au suivant et
    // ferait sauter une ligne sur deux.
    return new RegExp(folded)
  } catch {
    return null
  }
}

export function filterAccounts<T extends FilterableAccount>(query: string, accounts: readonly T[]): T[] {
  const raw = query.trim().slice(0, ACCOUNT_FILTER_MAX)
  if (!raw) return [...accounts]
  const folded = foldText(raw)
  const re = compile(folded)
  return accounts.filter(acc => {
    const hay = [acc.email, acc.name ?? ''].map(foldText)
    return re ? hay.some(h => re.test(h)) : hay.some(h => h.includes(folded))
  })
}
