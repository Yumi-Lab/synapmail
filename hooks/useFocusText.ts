'use client'

/**
 * L'infobulle de la priorité (lot T12) : chaque composante du score, une par ligne, puis le total.
 * UN endroit pour le volet de lecture, le tableau de bord et la liste — la pastille dit la
 * composante la plus forte, l'infobulle dit tout.
 */
import { useTranslations } from 'next-intl'
import type { FocusPart, FocusReason, FocusScore } from '@/types/dashboard'
import { useTagLabels } from './useTagLabels'

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

export function useFocusText() {
  const t = useTranslations('mail')
  const { q, v } = useTagLabels()
  const reason = (r: FocusReason, part?: FocusPart): string =>
    r === 'tag' && part?.kind === 'tag' ? `${q(part.question)} : ${v(part.valeur)}` : t(`reason_${r}`)
  const describe = (f: FocusScore): string => [
    ...f.parts.map(p => `${p.kind === 'tag' ? `${q(p.question)} : ${v(p.valeur)}` : t(`reason_${p.reason}`)} ${signed(p.points)}`),
    t('priority', { score: f.score }),
  ].join('\n')
  /** La composante la plus forte, celle que la pastille nomme. */
  const top = (f: FocusScore): FocusPart | undefined => [...f.parts].sort((a, b) => b.points - a.points)[0]
  const label = (f: FocusScore): string => reason(f.reason, top(f))
  return { describe, label }
}
