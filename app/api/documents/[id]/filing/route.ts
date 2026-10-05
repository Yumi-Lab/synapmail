import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getDocument, toFilingView } from '@/lib/ged/documents'
import { fileDocument } from '@/lib/ged/filing'
import { ACCOUNT_OF_DOCUMENT, ACCOUNT_OF_FOLDER, accountFor, accountOfObject, gedError, isResponse, readJson, writer } from '../../_shared'

export const dynamic = 'force-dynamic'

/**
 * RANGER un document (décision 4) : une nouvelle ligne `ged_filings`, jamais un UPDATE — l'historique
 * reste. `folderId: null` le sort de tout dossier. La source n'est pas choisie par le corps : une
 * session range en `humain`, une clé en `agent` ; l'un comme l'autre apprennent les identifiants du
 * texte OCR pour le dossier choisi (décision 5). Exige la permission de partage `organize`.
 */
async function postHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_DOCUMENT, params.id)
  if (!accountId) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  const account = await accountFor(gate.ctx, accountId, ['organize'])
  if (isResponse(account)) return account
  try {
    const body = await readJson(req)
    const folderId = body.folderId ?? null
    if (folderId !== null && typeof folderId !== 'string') return NextResponse.json({ error: 'folderId must be a string or null' }, { status: 400 })
    if (folderId !== null && await accountOfObject(ACCOUNT_OF_FOLDER, folderId) !== account.id) {
      return NextResponse.json({ error: 'folder not found', folderId }, { status: 404 })
    }
    const { source, author } = await writer(gate.ctx, body.engineId)
    const { filing, learned } = await fileDocument({ documentId: params.id, folderId, source, author })
    const doc = await getDocument(account.id, params.id)
    return NextResponse.json({ data: { filing: toFilingView(filing), learned, filings: doc?.filings ?? [] } })
  } catch (err) {
    return gedError(err)
  }
}

export const POST = withApiLog(postHandler)
