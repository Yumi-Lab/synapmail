import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { PAGE_RENDER_DPI, PAGE_RENDER_DPI_MAX, renderPage } from '@/lib/ged/ocr'
import { ACCOUNT_OF_DOCUMENT, accountFor, accountOfObject, isResponse, notFound } from '../../../_shared'
import { imapError, readDocumentPdf } from '../../_pdf'

export const dynamic = 'force-dynamic'

/**
 * UNE page d'un document en PNG (`n` compte à partir de 1), rendue à la demande par `pdftoppm` depuis
 * le PDF relu dans la boîte — rien n'est stocké. `?dpi=` entre 1 et `PAGE_RENDER_DPI_MAX` (défaut
 * `PAGE_RENDER_DPI`) : une vignette ou un agrandissement, même route.
 */
async function getHandler(req: Request, { params }: { params: { id: string; n: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_DOCUMENT, params.id)
  if (!accountId) return notFound('document')
  const account = await accountFor(gate.ctx, accountId, [])
  if (isResponse(account)) return account
  const n = Number(params.n)
  const dpiParam = new URL(req.url).searchParams.get('dpi')
  const dpi = dpiParam === null ? PAGE_RENDER_DPI : Number(dpiParam)
  if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: 'page must be an integer >= 1', page: params.n }, { status: 400 })
  if (!Number.isInteger(dpi) || dpi < 1 || dpi > PAGE_RENDER_DPI_MAX) return NextResponse.json({ error: `dpi must be an integer between 1 and ${PAGE_RENDER_DPI_MAX}`, dpi: dpiParam }, { status: 400 })
  let pdf
  try {
    pdf = await readDocumentPdf(account, params.id)
  } catch (err) {
    return imapError(err)
  }
  if (!pdf) return notFound('document')
  if (pdf.pages && n > pdf.pages) return NextResponse.json({ error: `page ${n} does not exist: the document has ${pdf.pages}`, page: n, pages: pdf.pages }, { status: 404 })
  try {
    const png = await renderPage(pdf.content, n, dpi)
    return new Response(new Uint8Array(png), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.byteLength), 'Cache-Control': 'private, max-age=3600' },
    })
  } catch (err) {
    return NextResponse.json({ error: `page ${n} could not be rendered: ${err instanceof Error ? err.message : String(err)}`, page: n }, { status: 500 })
  }
}

export const GET = withApiLog(getHandler)
