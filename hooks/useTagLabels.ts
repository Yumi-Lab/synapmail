'use client'

/**
 * Les libellés AFFICHÉS d'une question, d'une valeur ou d'un groupe (`tags.q.*`, `tags.v.*`,
 * `tags.g.*` dans les trois langues). Une question AJOUTÉE à l'écran (lot T-Q) n'a pas de
 * libellé traduit : son identifiant se lit alors tel quel, tirets bas en espaces — jamais une
 * clé manquante levée par next-intl, jamais une chaîne vide. UN endroit pour la liste, le panneau,
 * le filtre, la répartition et l'écran des questions.
 */
import { useTranslations } from 'next-intl'

const humanize = (id: string) => id.replace(/_/g, ' ')

export function useTagLabels() {
  const t = useTranslations('tags')
  const label = (prefix: 'q' | 'v' | 'g') => (id: string): string => (t.has(`${prefix}.${id}`) ? t(`${prefix}.${id}`) : humanize(id))
  return { q: label('q'), v: label('v'), g: label('g') }
}
