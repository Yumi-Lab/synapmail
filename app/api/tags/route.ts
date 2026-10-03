import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { auditPending } from '@/lib/tagging/audit'
import { filterByTag, readEffectiveFor } from '@/lib/tagging/store'
import { questionSetForAccount } from '@/lib/tagging/userQuestions'

export const dynamic = 'force-dynamic'

/**
 * Deux lectures, une route, parce qu'elles répondent à la même question sous deux angles :
 *
 *  - `?question=&valeur=` → les mails PORTANT cette étiquette effective, avec leur dernière
 *    position connue (`tagged_messages`), donc y compris ceux sortis de la page chargée ;
 *    `&origine=` restreint à une origine — une source (`humain`) ou l'id d'un moteur (décision 23) ;
 *  - `?id=<mid>&id=<mid>…` → les étiquettes effectives d'une LISTE de mails : ce que la liste
 *    affiche en pastilles, en UNE requête par page et jamais une par ligne (décision 11) ;
 *  - `?audit=1` → les mails de l'AUDIT ALÉATOIRE (lot T14) qu'aucune main n'a encore jugés,
 *    même forme que le filtre : la liste les montre comme un filtre, et chaque validation
 *    les en retire.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, gate.ctx.id, [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const ids = searchParams.getAll('id')
    if (ids.length) {
      const byMessage = await readEffectiveFor(accountId, ids)
      return NextResponse.json({ data: { effective: Object.fromEntries(byMessage) } })
    }

    const page = Number(searchParams.get('page') ?? '1')
    if (searchParams.get('audit') === '1') {
      const { messages, total, drawn } = await auditPending(accountId, page)
      return NextResponse.json({ data: { messages, total, drawn, page: Math.max(page || 1, 1) } })
    }

    const question = searchParams.get('question')
    const valeur = searchParams.get('valeur')
    if (!question || !valeur) {
      return NextResponse.json({ error: 'question and valeur required, or one id at least' }, { status: 400 })
    }
    // Une question ou une valeur inconnue du jeu de la boîte ne peut RIEN porter : le dire est
    // plus utile qu'une page vide, qu'on confondrait avec « aucun mail ne porte ceci ».
    const set = await questionSetForAccount(accountId)
    if (!set.questionById(question)) return NextResponse.json({ error: `question inconnue: ${question}`, question }, { status: 422 })
    if (!set.isValidTag(question, valeur)) return NextResponse.json({ error: `valeur non prévue pour la question ${question}: ${valeur}`, question, valeur }, { status: 422 })

    const { messages, total } = await filterByTag({ accountId, question, valeur, page, origine: searchParams.get('origine') })
    return NextResponse.json({ data: { messages, total, page: Math.max(page || 1, 1) } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
