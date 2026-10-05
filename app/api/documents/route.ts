import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { guardApiPayload, isMachineRequest } from '@/lib/promptGuard'
import { listDocuments, unfiledCount } from '@/lib/ged/documents'
import { readEffectiveFieldsFor, readEffectiveFor } from '@/lib/tagging/store'
import { accountFor, gedError, isResponse } from './_shared'

export const dynamic = 'force-dynamic'

/**
 * Les documents d'une boîte GED (décision 7) : tous, ceux d'un dossier (`folder=<id>`), ceux « à
 * ranger » (`folder=unfiled`), ou ceux dont le texte OCR répond à `q` (tsvector français). Paginé.
 * Le nom de fichier, l'objet et l'expéditeur sont de la donnée EXTERNE : la garde `aiSafety` le dit à
 * une clé, comme pour les mails. Les étiquettes et valeurs EFFECTIVES de la page (type, émetteur,
 * montant — ce que l'écran met sur chaque ligne) viennent en deux requêtes, jamais une par document.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const { searchParams } = new URL(req.url)
  const account = await accountFor(gate.ctx, searchParams.get('account'), [])
  if (isResponse(account)) return account
  try {
    const page = Number(searchParams.get('page') ?? '1')
    const perPage = searchParams.get('perPage') ? Number(searchParams.get('perPage')) : undefined
    if (!Number.isInteger(page) || (perPage !== undefined && !Number.isInteger(perPage))) {
      return NextResponse.json({ error: 'page and perPage must be integers' }, { status: 400 })
    }
    const list = await listDocuments({ accountId: account.id, folder: searchParams.get('folder'), q: searchParams.get('q'), page, perPage })
    const ids = list.documents.map(d => d.tagMessageId)
    const [unfiled, tags, fields] = await Promise.all([unfiledCount(account.id), readEffectiveFor(account.id, ids), readEffectiveFieldsFor(account.id, ids)])
    return NextResponse.json(guardApiPayload(
      { data: { ...list, unfiled, tags: Object.fromEntries(tags), fields: Object.fromEntries(fields) } },
      { enabled: isMachineRequest(req) && account.prompt_guard },
    ))
  } catch (err) {
    return gedError(err)
  }
}

export const GET = withApiLog(getHandler)
