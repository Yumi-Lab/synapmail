import { NextResponse } from 'next/server'
import type { AuthContext } from '@/lib/apiAuth'
import { getAccessibleAccount, type AccessibleAccount, type AccountPermission } from '@/lib/accountAccess'
import { authorForWriter, ForbiddenSourceError } from '@/lib/tagging/store'
import { HUMAN_SOURCE } from '@/lib/tagging/engine'
import { ACCOUNT_OF_DOCUMENT, ACCOUNT_OF_FOLDER, ACCOUNT_OF_PATTERN, GedInputError, isUuid } from '@/lib/ged/documents'
import { query } from '@/lib/db'
import type { FilingSource } from '@/lib/ged/model'
import type { Author } from '@/lib/ged/filing'

/**
 * Ce que toutes les routes `/api/documents/*` partagent (lot G5, décision 7) :
 *
 *  - chaque handler appelle `authorize(req)` LUI-MÊME (le banc `check-api-docs` lit la preuve du
 *    mode Bearer dans le corps de la méthode, pas dans un module voisin) ;
 *  - la boîte se nomme `account` (URL) ou `accountId` (corps) — les noms que la barrière par clé
 *    lit déjà (`ACCOUNT_PARAM_KEYS`) — ou se DÉDUIT de l'objet du chemin (document, dossier, motif),
 *    par les MÊMES requêtes que `ACCOUNT_BY_OBJECT` côté barrière ;
 *  - l'auteur d'un rangement et sa SOURCE ne sont pas choisis par le corps : une session écrit
 *    `humain`, une clé écrit `agent` (décision 4) et signe de la clé, ou du moteur qu'elle nomme ;
 *  - une entrée refusée (`GedInputError`) devient la réponse qui porte son statut.
 */

export async function accountFor(ctx: AuthContext, accountId: string | null | undefined, required: AccountPermission[]): Promise<AccessibleAccount | NextResponse> {
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, ctx.id, required)
  return account ?? NextResponse.json({ error: 'Account not found' }, { status: 404 })
}

export const isResponse = (v: unknown): v is NextResponse => v instanceof Response

/** La boîte d'un objet GED nommé dans le chemin, ou `null` (objet inconnu : la route rend 404). */
export const accountOfObject = async (sql: string, id: unknown): Promise<string | null> =>
  isUuid(id) ? (await query<{ id: string | null }>(sql, [id]))[0]?.id ?? null : null

export { ACCOUNT_OF_DOCUMENT, ACCOUNT_OF_FOLDER, ACCOUNT_OF_PATTERN }

export const notFound = (what: string) => NextResponse.json({ error: `${what} not found` }, { status: 404 })

/** Qui écrit, et sous quelle source : décision 4 — une main `humain`, une clé `agent`. */
export async function writer(ctx: AuthContext, engineId?: unknown): Promise<{ source: FilingSource; author: Author }> {
  const author = await authorForWriter({ userId: ctx.id, apiKeyId: ctx.apiKeyId, engineId })
  return { source: ctx.apiKeyId === null ? HUMAN_SOURCE : 'agent', author }
}

export function gedError(err: unknown): NextResponse {
  if (err instanceof GedInputError) return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status })
  if (err instanceof ForbiddenSourceError) return NextResponse.json({ error: err.message }, { status: 403 })
  return NextResponse.json({ error: String(err) }, { status: 500 })
}

export const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  try { return ((await req.json()) ?? {}) as Record<string, unknown> } catch { throw new GedInputError(400, 'invalid JSON body') }
}
