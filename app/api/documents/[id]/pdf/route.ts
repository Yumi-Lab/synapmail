import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { ACCOUNT_OF_DOCUMENT, accountFor, accountOfObject, isResponse, notFound } from '../../_shared'
import { disposition, imapError, readDocumentPdf } from '../_pdf'

export const dynamic = 'force-dynamic'

/**
 * Le PDF d'un document, relu dans la boîte (lecture seule) et servi tel quel — `?download=true` pour
 * le télécharger plutôt que l'afficher. 404 si la pièce a quitté la boîte, 502 si la boîte ne répond pas.
 */
async function getHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_DOCUMENT, params.id)
  if (!accountId) return notFound('document')
  const account = await accountFor(gate.ctx, accountId, [])
  if (isResponse(account)) return account
  let pdf
  try {
    pdf = await readDocumentPdf(account, params.id)
  } catch (err) {
    return imapError(err)
  }
  if (!pdf) return notFound('document')
  const download = new URL(req.url).searchParams.get('download') === 'true'
  return new Response(new Uint8Array(pdf.content), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition(download ? 'attachment' : 'inline', pdf.filename),
      'Content-Length': String(pdf.content.byteLength),
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

export const GET = withApiLog(getHandler)
