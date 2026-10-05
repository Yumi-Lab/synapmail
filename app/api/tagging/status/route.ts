import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { auditStatus, reliability } from '@/lib/tagging/audit'
import { readTaggingStatus } from '@/lib/tagging/mailbox'
import { questionVersion, tagDistribution } from '@/lib/tagging/store'
import { questionSetForAccount, staleCounts } from '@/lib/tagging/userQuestions'

export const dynamic = 'force-dynamic'

/**
 * Où en est le tri d'une boîte : état, compteurs, dépense, estimation, et `hasKey` — jamais la
 * clé du moteur, ni en clair ni chiffrée (décision 13). C'est ce que l'écran rafraîchit pendant
 * un tri.
 *
 * `?distribution=1` y ajoute la RÉPARTITION des valeurs par question (lot T10b) : ce qu'on lit
 * après un échantillon pour décider de lancer le reste. Elle n'est pas dans la réponse par défaut
 * parce que l'écran redemande l'état toutes les 20 s pendant un tri, et qu'un GROUP BY sur toutes
 * les étiquettes de la boîte n'a pas à tourner à ce rythme.
 *
 * `?stale=1` y ajoute, par question, le nombre de mails tagués sous une AUTRE version que la
 * courante (lot T-Q) : le « N mails tagués avec une ancienne version » de l'écran. Même raison
 * de ne pas être dans la réponse par défaut.
 *
 * `?reliability=1` y ajoute le tableau « Fiabilité » (lot T14, `lib/tagging/audit.ts`) et
 * l'état de l'audit aléatoire (`audit`) : plusieurs balayages de `message_tags`, demandés
 * seulement quand l'écran les montre.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const accountId = new URL(req.url).searchParams.get('account')
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, gate.ctx.id, [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const status = await readTaggingStatus(accountId)
    const params = new URL(req.url).searchParams
    return NextResponse.json({ data: {
      ...status,
      ...(params.get('distribution') === '1' ? { distribution: await tagDistribution(accountId) } : {}),
      ...(params.get('stale') === '1' ? { staleCounts: await staleCounts(accountId, await questionSetForAccount(accountId), questionVersion) } : {}),
      ...(params.get('reliability') === '1' ? { reliability: await reliability(accountId), audit: await auditStatus(accountId) } : {}),
    } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
