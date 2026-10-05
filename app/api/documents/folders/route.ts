import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { createFolder, listFolders, unfiledCount } from '@/lib/ged/documents'
import { accountFor, gedError, isResponse, readJson } from '../_shared'

export const dynamic = 'force-dynamic'

/**
 * Les dossiers VIRTUELS d'une boîte GED (décision 3) — en base, jamais dans l'IMAP. La liste est à
 * plat (`parentId` dit la place) avec, par dossier, ses documents effectifs et ses motifs, plus le
 * compteur « À ranger ». Créer exige la permission de partage `organize`.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const account = await accountFor(gate.ctx, new URL(req.url).searchParams.get('account'), [])
  if (isResponse(account)) return account
  try {
    const [folders, unfiled] = await Promise.all([listFolders(account.id), unfiledCount(account.id)])
    return NextResponse.json({ data: { folders, unfiled } })
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
    return NextResponse.json({ data: await createFolder(account.id, body) }, { status: 201 })
  } catch (err) {
    return gedError(err)
  }
}

export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
