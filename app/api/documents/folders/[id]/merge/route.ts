import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { GedInputError } from '@/lib/ged/documents'
import { mergeFolder } from '@/lib/ged/filing'
import { ACCOUNT_OF_FOLDER, accountFor, accountOfObject, gedError, isResponse, notFound, readJson, writer } from '../../../_shared'

export const dynamic = 'force-dynamic'

/**
 * FUSIONNER le dossier `[id]` dans `into` (remarque humaine du gate G3/G4) : ses documents y sont
 * rangés — une ligne de rangement chacun, `humain` pour une session, `agent` pour une clé, qui
 * apprend au passage —, ses motifs et sous-dossiers y passent, et `[id]` disparaît. `into` doit être
 * un autre dossier de la même boîte (409 sinon). Permission `organize`.
 */
async function postHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const accountId = await accountOfObject(ACCOUNT_OF_FOLDER, params.id)
  if (!accountId) return notFound('folder')
  const account = await accountFor(gate.ctx, accountId, ['organize'])
  if (isResponse(account)) return account
  try {
    const { into, engineId } = await readJson(req)
    if (typeof into !== 'string' || !into) throw new GedInputError(400, 'into required')
    if (into === params.id) throw new GedInputError(409, 'a folder cannot be merged into itself', { into })
    if (await accountOfObject(ACCOUNT_OF_FOLDER, into) !== account.id) throw new GedInputError(404, 'folder not found', { into })
    const { source, author } = await writer(gate.ctx, engineId)
    const moved = await mergeFolder({ from: params.id, into, source, author })
    return NextResponse.json({ data: { from: params.id, into, source, ...moved } })
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') {
      return NextResponse.json({ error: 'a sub-folder of the merged folder clashes with a sub-folder of the target', from: params.id }, { status: 409 })
    }
    return gedError(err)
  }
}

export const POST = withApiLog(postHandler)
