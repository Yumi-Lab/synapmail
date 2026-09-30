import { NextResponse } from 'next/server'
import { InvalidTagRuleError, UnknownTagRuleError } from '@/lib/tagging/tagRules'

/**
 * Les refus NOMMÉS des routes de règles d'étiquetage, en un endroit : un champ fautif (400,
 * `field`), une règle inconnue (404). Même voisinage que `app/api/tags/questions/errors.ts`.
 */
export function tagRuleErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof InvalidTagRuleError) return NextResponse.json({ error: err.message, field: err.field }, { status: 400 })
  if (err instanceof UnknownTagRuleError) return NextResponse.json({ error: err.message, id: err.id }, { status: 404 })
  return null
}
