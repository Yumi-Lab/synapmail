import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { authorForWriter, readFields, sourceForWriter, writeFields, ForbiddenSourceError, InvalidTagError } from '@/lib/tagging/store'
import type { FieldValue } from '@/lib/tagging/fields'

export const dynamic = 'force-dynamic'

/**
 * Les VALEURS extraites d'UN message (décision 19) : le pendant de `…/tags` pour ce qui se LIT
 * dans le mail (montant, échéance, n° de commande, n° de suivi) plutôt que ce qui se choisit
 * dans une liste. Même identifiant (`Message-ID` RFC, pris tel quel — voir `…/tags`), même
 * source déduite de l'appelant, même auteur, même refus nommé.
 */
const messageIdFrom = (params: { id: string }): string => params.id

async function denyUnreachable(accountId: string | null, userId: string, required: 'organize' | null): Promise<NextResponse | null> {
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, userId, required ? [required] : [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  return null
}

async function getHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const accountId = new URL(req.url).searchParams.get('account')
  const denied = await denyUnreachable(accountId, gate.ctx.id, null)
  if (denied) return denied

  try {
    const messageId = messageIdFrom(params)
    const { fields, effective } = await readFields(accountId!, messageId)
    return NextResponse.json({ data: { messageId, fields, effective } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * Corrige une valeur en un clic (humain) ou en écrit une pour un moteur (clé). Une valeur mal
 * formée (un montant qui n'est pas un nombre, une date qui n'existe pas, un IBAN entier) est
 * refusée en 422 qui NOMME le champ — un IBAN n'entre jamais ici qu'en 4 caractères.
 */
async function putHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const body = await req.json() as { accountId?: string; source?: unknown; model?: string | null; engineId?: unknown; fields?: FieldValue[] }
    const accountId = body.accountId ?? null
    const denied = await denyUnreachable(accountId, gate.ctx.id, 'organize')
    if (denied) return denied
    if (!Array.isArray(body.fields) || !body.fields.length) {
      return NextResponse.json({ error: 'fields required' }, { status: 400 })
    }

    const session = gate.ctx.apiKeyId === null
    const source = sourceForWriter({ session, requested: body.source })
    const auteur = await authorForWriter({ userId: gate.ctx.id, apiKeyId: gate.ctx.apiKeyId, engineId: body.engineId })
    const messageId = messageIdFrom(params)
    const written = await writeFields({
      accountId: accountId!, messageId, source, auteur,
      fields: body.fields.map(f => ({ champ: f.champ, valeur: f.valeur })),
      modele: body.model ?? null,
      validePar: session ? gate.ctx.id : null,
    })
    const { fields, effective } = await readFields(accountId!, messageId)
    return NextResponse.json({ data: { messageId, written, source, fields, effective } })
  } catch (err) {
    if (err instanceof InvalidTagError) {
      return NextResponse.json({ error: err.message, question: err.question, valeur: err.valeur }, { status: 422 })
    }
    if (err instanceof ForbiddenSourceError) {
      return NextResponse.json({ error: err.message, source: err.source }, { status: 403 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const PUT = withApiLog(putHandler)
