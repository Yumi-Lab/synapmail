import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { toImapConfig } from '@/lib/accounts'
import { query } from '@/lib/db'
import { getMessage } from '@/lib/imap'
import { EngineError, askEngine, buildState } from '@/lib/tagging/engine'
import { decrypt } from '@/lib/encrypt'
import { loadQuestionSet } from '@/lib/tagging/userQuestions'

export const dynamic = 'force-dynamic'

/**
 * « Tester sur un mail » (lot T-Q) : UNE requête au moteur de la boîte, pour UNE question, sur
 * UN mail — de quoi lire ce que le moteur répond avant de payer la boîte entière. Il en coûte un
 * appel, jamais 49. La question est celle de l'appelant ; le moteur et le mail sont ceux de la
 * boîte nommée (`organize`, comme lancer un tri). La clé se déchiffre ici et n'en sort pas.
 */
async function postHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as { accountId?: string; folder?: string; uid?: unknown }
    if (!body.accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    if (!body.folder || body.uid === undefined || body.uid === null) return NextResponse.json({ error: 'folder and uid required' }, { status: 400 })
    const account = await getAccessibleAccount(body.accountId, gate.ctx.id, ['organize'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const set = await loadQuestionSet(gate.ctx.id)
    const question = set.questionById(params.id)
    if (!question) return NextResponse.json({ error: `question inconnue: ${params.id}`, id: params.id }, { status: 404 })

    const [engine] = await query<{ url: string; key_encrypted: string | null; model: string }>(
      `SELECT e.url, e.key_encrypted, e.model FROM mailbox_tagging m JOIN decision_engines e ON e.id = m.engine_id WHERE m.account_id = $1`,
      [body.accountId]
    )
    if (!engine) return NextResponse.json({ error: 'no engine chosen for this mailbox' }, { status: 409 })

    const message = await getMessage(toImapConfig(account), body.folder, String(body.uid))
    if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 })

    const started = Date.now()
    const result = await askEngine(
      { url: engine.url, apiKey: engine.key_encrypted ? decrypt(engine.key_encrypted) : '', model: engine.model },
      buildState({ fromName: message.from.name, fromAddress: message.from.address, subject: message.subject, bodyPlain: message.bodyPlain, bodyHtml: message.bodyHtml }),
      [question]
    )
    return NextResponse.json({ data: {
      question: question.id, ms: Date.now() - started, model: result.model, inputTokens: result.inputTokens,
      answer: result.tags[0] ?? null, rejected: result.rejected.length > 0,
    } })
  } catch (err) {
    if (err instanceof EngineError) return NextResponse.json({ error: err.message, failure: err.kind, status: err.status }, { status: 502 })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
