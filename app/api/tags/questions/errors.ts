import { NextResponse } from 'next/server'
import { DuplicateQuestionError, InvalidQuestionError, UnknownQuestionError } from '@/lib/tagging/userQuestions'

/**
 * Les refus NOMMÉS des routes de questions, en un endroit : un champ fautif (400, `field`), un id
 * déjà pris (409), une question inconnue (404). Un fichier de route ne peut exporter que ses
 * méthodes HTTP, d'où ce voisin. Voir lib/tagging/userQuestions.ts.
 */
export function questionErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof InvalidQuestionError) return NextResponse.json({ error: err.message, field: err.field, ...(err.code ? { code: err.code, id: err.id } : {}) }, { status: 400 })
  if (err instanceof DuplicateQuestionError) return NextResponse.json({ error: err.message, id: err.id }, { status: 409 })
  if (err instanceof UnknownQuestionError) return NextResponse.json({ error: err.message, id: err.id }, { status: 404 })
  return null
}
