import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { createPattern, listPatterns } from '@/lib/ged/documents'
import { accountFor, gedError, isResponse, readJson, writer } from '../_shared'

export const dynamic = 'force-dynamic'

/**
 * Les MOTIFS appris (décision 5) : un identifiant stable de l'émetteur (SIRET, TVA, IBAN réduit,
 * raison sociale, regex bornée) → un dossier. `GET` liste ceux d'une boîte (`folder=` pour un seul
 * dossier). `POST` en pose un à la main ou par un agent : la valeur est normalisée et CONTRÔLÉE
 * comme l'OCR l'aurait été (clé de Luhn, clé de TVA, regex valide) — 422 qui nomme le refus sinon ;
 * un IBAN entier est réduit avant d'entrer. Permission `organize`.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const { searchParams } = new URL(req.url)
  const account = await accountFor(gate.ctx, searchParams.get('account'), [])
  if (isResponse(account)) return account
  try {
    return NextResponse.json({ data: await listPatterns(account.id, searchParams.get('folder')) })
  } catch (err) {
    return gedError(err)
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await readJson(req)
    const account = await accountFor(gate.ctx, typeof body.accountId === 'string' ? body.accountId : null, ['organize'])
    if (isResponse(account)) return account
    const { author } = await writer(gate.ctx, body.engineId)
    return NextResponse.json({ data: await createPattern(account.id, body, author) }, { status: 201 })
  } catch (err) {
    return gedError(err)
  }
}

export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
