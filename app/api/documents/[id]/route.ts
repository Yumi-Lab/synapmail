import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { getDocument } from '@/lib/ged/documents'
import { suggestionsFor } from '@/lib/ged/filing'
import { readEffectiveFor, readFields } from '@/lib/tagging/store'
import { ACCOUNT_OF_DOCUMENT, accountFor, accountOfObject, gedError, isResponse } from '../_shared'

export const dynamic = 'force-dynamic'

/**
 * UN document : son texte OCR (global et par page), ses étiquettes et valeurs effectives (les mêmes
 * lignes que le mail porteur, décision 6), son historique de rangement (humain d'abord, puis le plus
 * récent) et, s'il n'est pas rangé, les dossiers que les motifs connus suggèrent. La boîte se déduit
 * du document : c'est aussi ce que la barrière par clé lit (`ACCOUNT_BY_OBJECT`).
 */
async function getHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_DOCUMENT, params.id)
  if (!accountId) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  const account = await accountFor(gate.ctx, accountId, [])
  if (isResponse(account)) return account
  try {
    const doc = await getDocument(account.id, params.id)
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    const [tags, fields, suggestions] = await Promise.all([
      readEffectiveFor(account.id, [doc.tagMessageId]),
      readFields(account.id, doc.tagMessageId),
      doc.folderId || !doc.ocrText ? Promise.resolve([]) : suggestionsFor(account.id, doc.ocrText),
    ])
    const payload = { data: { ...doc, tags: tags.get(doc.tagMessageId) ?? [], fields: fields.effective, suggestions } }
    return NextResponse.json(guardApiPayload(payload, { enabled: isMachineRequest(req) && account.prompt_guard }))
  } catch (err) {
    return gedError(err)
  }
}

export const GET = withApiLog(getHandler)
