import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { deleteFolder, updateFolder } from '@/lib/ged/documents'
import { ACCOUNT_OF_FOLDER, accountFor, accountOfObject, gedError, isResponse, notFound, readJson } from '../../_shared'

export const dynamic = 'force-dynamic'

/**
 * UN dossier virtuel : le renommer ou le déplacer (`PATCH`), le supprimer avec ses sous-dossiers
 * (`DELETE` — ses documents retombent dans « À ranger », ils ne sont jamais effacés). La boîte se
 * déduit du dossier, comme la barrière par clé le fait (`ACCOUNT_BY_OBJECT`). Permission `organize`.
 */
async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_FOLDER, params.id)
  if (!accountId) return notFound('folder')
  const account = await accountFor(gate.ctx, accountId, ['organize'])
  if (isResponse(account)) return account
  try {
    return NextResponse.json({ data: await updateFolder(account.id, params.id, await readJson(req)) })
  } catch (err) {
    return gedError(err)
  }
}

async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_FOLDER, params.id)
  if (!accountId) return notFound('folder')
  const account = await accountFor(gate.ctx, accountId, ['organize'])
  if (isResponse(account)) return account
  try {
    await deleteFolder(account.id, params.id)
    return NextResponse.json({ data: { id: params.id } })
  } catch (err) {
    return gedError(err)
  }
}

export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
