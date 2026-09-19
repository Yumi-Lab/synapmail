/**
 * Ce que la barre d'application sait proposer en plus d'une recherche de courrier :
 * les boîtes, les actions transverses et TOUTES les entrées des réglages.
 *
 * Moitié PURE du contrat (aucun React, aucun réseau) : le composant y ajoute les
 * libellés traduits et les icônes, ce module décide seulement de ce qui correspond
 * à la saisie et dans quel ordre. Son auto-contrôle est
 * `scripts/check-omnibar-commands.mjs`.
 */

/**
 * Forme comparable d'un texte : sans accent, sans casse. Les deux côtés de chaque
 * comparaison y passent, donc « thème » se trouve en tapant « theme » et
 * réciproquement.
 */
export function foldText(value: string): string {
  // Plage des diacritiques combinants (U+0300..U+036F) plutot que `\p{Diacritic}` :
  // la classe Unicode exige un `target` ES6+, que ce projet ne fixe pas.
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Ordre des sections du panneau, imposé par la demande : les boîtes d'abord (on
 * bascule plus souvent qu'on ne règle), puis les actions, puis les réglages. La
 * recherche de courrier n'est pas une section : c'est la ligne de repli, toujours
 * rendue en dernier par le composant.
 */
export const OMNIBAR_SECTIONS = ['accounts', 'actions', 'settings'] as const
export type OmnibarSection = (typeof OMNIBAR_SECTIONS)[number]

export type OmnibarEntry = {
  /** Identité stable d'une entrée, ce que le banc et la navigation clavier désignent. */
  id: string
  section: OmnibarSection
  label: string
  /** Ligne discrète sous le libellé : le chemin d'un réglage, l'adresse d'une boîte. */
  hint?: string
  /** Mots supplémentaires par lesquels l'entrée se trouve, séparés par des virgules (traduits). */
  keywords?: string
}

/**
 * Une entrée correspond si CHAQUE mot de la saisie apparaît dans au moins un de ses
 * textes (libellé, ligne discrète, mots-clés) — « clés api » trouve « Clés API »
 * quel que soit l'ordre des mots, et « api » seul la trouve aussi.
 *
 * Contrairement à `parseQuery` (recherche IMAP, où un terme d'une lettre ramènerait
 * la boîte entière), aucun mot n'est écarté pour sa longueur : le panneau se déroule
 * DÈS LE PREMIER caractère et filtre une liste déjà courte, en mémoire.
 */
export function matchOmnibar(query: string, entries: readonly OmnibarEntry[]): OmnibarEntry[] {
  const terms = foldText(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const bySection = (e: OmnibarEntry) => OMNIBAR_SECTIONS.indexOf(e.section)
  /**
   * 0 si le LIBELLÉ porte déjà toute la saisie, 1 sinon. Départage les entrées
   * voisines qui partagent des mots-clés : « sombre » sort « Thème sombre » avant
   * « Thème clair », alors que les deux se trouvent par le mot-clé « thème ».
   * Sans ce rang, l'ordre de déclaration désignait au clavier une entrée que la
   * saisie NOMMAIT pourtant l'autre.
   */
  const byLabel = (e: OmnibarEntry) => {
    const label = foldText(e.label)
    return terms.every(term => label.includes(term)) ? 0 : 1
  }
  return entries
    .filter(entry => {
      const haystacks = [entry.label, entry.hint ?? '', entry.keywords ?? ''].map(foldText)
      return terms.every(term => haystacks.some(h => h.includes(term)))
    })
    // Tri STABLE : à section et à rang égaux, les entrées gardent l'ordre où
    // l'appelant les a déclarées (la navigation des réglages, le rang des boîtes).
    .sort((a, b) => bySection(a) - bySection(b) || byLabel(a) - byLabel(b))
}
