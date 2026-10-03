'use client'

/**
 * Les libellés AFFICHÉS d'une question, d'une valeur, d'un groupe, d'un champ extrait ou d'une
 * origine de rangement (`tags.q.*`, `tags.v.*`, `tags.g.*`, `tags.f.*`, `tags.source.*` dans les
 * trois langues). Une question AJOUTÉE à l'écran (lot T-Q) n'a pas de libellé traduit : son
 * identifiant se lit alors tel quel, tirets bas en espaces — jamais une clé manquante levée par
 * next-intl, jamais une chaîne vide. UN endroit pour la liste, le panneau, le filtre, la
 * répartition, l'écran des questions et l'écran des documents.
 */
import { useTranslations } from 'next-intl'

const humanize = (id: string) => id.replace(/_/g, ' ')

export function useTagLabels() {
  const t = useTranslations('tags')
  const label = (prefix: 'q' | 'v' | 'g' | 'f' | 'source') => (id: string): string => (t.has(`${prefix}.${id}`) ? t(`${prefix}.${id}`) : humanize(id))
  return { q: label('q'), v: label('v'), g: label('g'), f: label('f'), source: label('source') }
}
