import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { sendMail } from '@/lib/smtp'
import { appendToSentFolder } from '@/lib/imap'
import { toImapConfig } from '@/lib/accounts'
import { prepareOutgoing } from '@/lib/outgoing'
import {
  SEND_REFUSED_BY_SERVER,
  isSizeRefusal,
  sizeRefusalReason,
} from '@/lib/smtpSize'
import { relearnAnnouncedSize } from '@/lib/accountProbe'
import { upsertContactsFromAddresses } from '@/lib/contacts'
import { randomUUID } from 'crypto'
import { appOrigin } from '@/lib/appOrigin'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

function injectTrackingPixel(html: string, pixelUrl: string): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;width:1px;height:1px;" alt="" />`
  // Insert before </body> if present, otherwise append
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`)
  }
  return html + pixel
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const authCtx = gate.ctx

  try {
    // Le corps, la boîte, les transferts, le plafond et les pièces jointes sont
    // validés au MÊME endroit que pour un brouillon (`lib/outgoing.ts`) : ce qui
    // suit ne concerne plus que l'ENVOI.
    const prepared = await prepareOutgoing(req, authCtx.id)
    if (!prepared.ok) return prepared.response
    const { account, mail, warning, ceiling, body } = prepared.value
    const { accountId, subject, html, requestReadReceipt } = body
    const toArr = mail.to
    const ccArr = mail.cc ?? []

    // Tracking — pixel + MDN header — only when explicitly requested
    let token: string | null = null
    if (requestReadReceipt && html) {
      token = randomUUID()
      const appUrl = appOrigin(req)
      mail.html = injectTrackingPixel(html, `${appUrl}/api/track/${token}`)
    }
    if (requestReadReceipt) mail.dispositionNotificationTo = account.email

    let sent: Awaited<ReturnType<typeof sendMail>>
    try {
      sent = await sendMail(
        {
          id: account.id,
          smtpHost: account.smtp_host,
          smtpPort: account.smtp_port,
          smtpSecure: account.smtp_secure,
          username: account.username,
          passwordEncrypted: account.password_encrypted,
          oauthProvider: account.oauth_provider,
          oauthAccessToken: account.oauth_access_token,
          oauthRefreshToken: account.oauth_refresh_token,
          oauthExpiresAt: account.oauth_expires_at,
        },
        mail
      )
    } catch (err) {
      // Un refus de TAILLE, et lui seul, vaut relecture de l'annonce (lot M10,
      // complement de Nicolas du 23/09/2026 : « en cas d'echec, faire une
      // actualisation pour mettre a jour si ca change »). Sans cela, un serveur
      // qui BAISSE sa limite refuserait chaque envoi pour toujours, puisque nous
      // continuerions a lui opposer le chiffre du jour de la creation. Un mot de
      // passe faux ou un serveur injoignable ne reecrit RIEN.
      if (!isSizeRefusal(err)) throw err
      // Une seule implementation de la relecture, partagee avec la sonde : elle
      // ne rend un nombre que s'il y a vraiment quelque chose a apprendre, et
      // n'efface jamais un plafond valable sur un incident reseau.
      const announced = await relearnAnnouncedSize(account)
      // Aucun reessai automatique : le serveur peut avoir refuse APRES avoir
      // accepte l'enveloppe, et renvoyer livrerait deux fois. L'envoi suivant
      // part avec le plafond corrige — c'est la qu'est l'automatisme.
      return NextResponse.json(
        {
          error: SEND_REFUSED_BY_SERVER,
          // La phrase du SERVEUR, pas la notre : elle seule dit pourquoi.
          reason: sizeRefusalReason(err),
          announcedSize: announced,
          refreshed: announced !== null && announced !== ceiling.announced,
        },
        { status: 413 }
      )
    }
    const { messageId, raw } = sent

    // Append to IMAP Sent folder — fire-and-forget
    appendToSentFolder(toImapConfig(account), raw).catch(() => {})

    // Store tracking record — fire-and-forget
    const userId = authCtx.id
    if (requestReadReceipt && token) {
      query(
        `INSERT INTO sent_tracking (token, message_id, account_id, user_id, sent_to, subject)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (token) DO NOTHING`,
        [token, messageId, accountId, userId, toArr.concat(ccArr).join(', '), subject]
      ).catch(() => {})
    }

    // Fire-and-forget: extract recipients as sent contacts
    if (userId) {
      upsertContactsFromAddresses(userId, [...toArr, ...ccArr], 'sent').catch(() => {})
    }

    return NextResponse.json({ success: true, ...warning })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
