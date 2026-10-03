import { NextResponse } from 'next/server'
import { DuplicateGroupError, InvalidGroupError, UnknownGroupError } from '@/lib/tagging/questionGroups'

/**
 * Les refus NOMMÉS des routes de groupes de questions, en un endroit : un champ fautif (400,
 * `field`), un groupe inconnu (404), un slug déjà pris (409). Même voisinage que
 * `app/api/tags/rules/errors.ts`.
 */
export function groupErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof InvalidGroupError) return NextResponse.json({ error: err.message, field: err.field }, { status: 400 })
  if (err instanceof UnknownGroupError) return NextResponse.json({ error: err.message, id: err.id }, { status: 404 })
  if (err instanceof DuplicateGroupError) return NextResponse.json({ error: err.message, id: err.id }, { status: 409 })
  return null
}
