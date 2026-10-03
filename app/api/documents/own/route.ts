import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { readOwnIdentifiers, writeOwnIdentifiers } from '@/lib/ged/documents'
import { accountFor, gedError, isResponse, readJson } from '../_shared'

export const dynamic = 'force-dynamic'

/**
 * Les identifiants PROPRES de la boîte (décision 5, point 4 de `lib/ged/filing.ts`) : le SIRET, la TVA
 * et l'IBAN réduit du DESTINATAIRE, imprimés sur chaque facture reçue en tant que client. Ils ne sont
 * ni appris ni cherchés comme motif — sans cette liste, la TVA du destinataire rangerait tout émetteur
 * dans le premier dossier qui l'a apprise. `PUT` remplace la liste entière. Permission `organize`.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const account = await accountFor(gate.ctx, new URL(req.url).searchParams.get('account'), [])
  if (isResponse(account)) return account
  try {
    return NextResponse.json({ data: { propres: await readOwnIdentifiers(account.id) } })
  } catch (err) {
    return gedError(err)
  }
}

async function putHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await readJson(req)
    const account = await accountFor(gate.ctx, typeof body.accountId === 'string' ? body.accountId : null, ['organize'])
    if (isResponse(account)) return account
    return NextResponse.json({ data: { propres: await writeOwnIdentifiers(account.id, body.propres) } })
  } catch (err) {
    return gedError(err)
  }
}

export const GET = withApiLog(getHandler)
export const PUT = withApiLog(putHandler)
