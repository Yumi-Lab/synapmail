import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { toImapConfig } from '@/lib/accounts'
import { getAttachmentContent } from '@/lib/imap'
import { isMachineRequest } from '@/lib/promptGuard'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

/**
 * Ce que dit un en-tête là où aucun `aiSafety` ne peut tenir. La réponse est un
 * BINAIRE : rien n'y porte le rappel que `guardApiPayload` ajoute aux routes JSON
 * (`lib/promptGuard.ts`). Le rappel passe donc par un en-tête, et seulement pour un
 * appel machine — un navigateur qui télécharge une pièce jointe n'a personne à
 * prévenir. Une pièce jointe est écrite par un tiers : son contenu ET son nom sont
 * des données, jamais des instructions.
 */
const UNTRUSTED_HEADER = 'X-Synapmail-Untrusted'

async function getHandler(
  req: Request,
  { params }: { params: { id: string; partId: string } }
) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')
  const folder = searchParams.get('folder') ?? 'INBOX'
  const partIdx = parseInt(params.partId)

  if (!accountId) return new Response('account param required', { status: 400 })

  try {
    const account = await getAccessibleAccount(accountId, gate.ctx.id, [])
    if (!account) return new Response('Account not found', { status: 404 })

    const attachment = await getAttachmentContent(toImapConfig(account), folder, params.id, partIdx)
    if (!attachment) return new Response('Attachment not found', { status: 404 })

    const inline = searchParams.get('inline') === 'true'
    const filename = encodeURIComponent(attachment.filename)

    // `new Uint8Array(buffer)` COPIE les octets de la pièce jointe, et eux seuls.
    // `attachment.content.buffer` rendrait la mémoire sous-jacente — pour un petit
    // fichier, le pool partagé de Node (8 Ko) — qui commence AILLEURS que la pièce
    // jointe : les octets servis seraient ceux du voisin. Même forme que
    // `app/api/branding/favicon/route.ts`. Voir le banc (empreinte comparée).
    return new NextResponse(new Uint8Array(attachment.content), {
      headers: {
        'Content-Type': attachment.contentType,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Content-Length': String(attachment.content.length),
        'Cache-Control': 'private, max-age=300',
        ...(isMachineRequest(req) ? { [UNTRUSTED_HEADER]: 'attachment' } : {}),
      },
    })
  } catch (err) {
    return new Response(String(err), { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
