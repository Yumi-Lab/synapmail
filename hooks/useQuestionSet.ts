'use client'

/**
 * Le jeu de questions de l'utilisateur, côté navigateur (lot T-Q) : UN SWR partagé sur
 * `/api/tags/questions` (mêmes règles que `/api/settings` : `{ data }`, un seul fetcher, une
 * `mutate` de cette clé rafraîchit la liste, le panneau et l'écran de réglages ensemble).
 * Rend un `QuestionSet` — le même objet que le serveur manipule — pour que les pastilles, le
 * filtre et la correction lisent exactement les mêmes règles que l'écriture.
 */
import { useMemo } from 'react'
import useSWR from 'swr'
import { questionSet, type QuestionSet } from '@/lib/tagging/questions'
import { QUESTIONS_ENDPOINT } from '@/lib/tagging/view'
import type { StoredQuestion } from '@/lib/tagging/userQuestions'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Un jeu VIDE tant que la réponse n'est pas là : rien ne s'affiche, rien n'est refusé à tort. */
const EMPTY = questionSet([])

export function useQuestionSet(): { set: QuestionSet; questions: StoredQuestion[]; loaded: boolean; mutate: () => Promise<unknown> } {
  const { data, mutate } = useSWR<{ data: StoredQuestion[] }>(QUESTIONS_ENDPOINT, fetcher)
  const questions = data?.data
  const set = useMemo(() => (questions ? questionSet(questions) : EMPTY), [questions])
  return { set, questions: questions ?? [], loaded: !!questions, mutate }
}
