import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { deletePattern } from '@/lib/ged/documents'
import { ACCOUNT_OF_PATTERN, accountFor, accountOfObject, gedError, isResponse, notFound } from '../../_shared'

export const dynamic = 'force-dynamic'

/** Retirer un motif appris : le dossier ne reconnaîtra plus cet identifiant. Permission `organize`. */
async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_PATTERN, params.id)
  if (!accountId) return notFound('pattern')
  const account = await accountFor(gate.ctx, accountId, ['organize'])
  if (isResponse(account)) return account
  try {
    await deletePattern(account.id, params.id)
    return NextResponse.json({ data: { id: params.id } })
  } catch (err) {
    return gedError(err)
  }
}

export const DELETE = withApiLog(deleteHandler)
