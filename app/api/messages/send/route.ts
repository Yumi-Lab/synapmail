import { NextResponse } from 'next/server'
import { authenticate } from '@/lib/apiAuth'
import { query } from '@/lib/db'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { sendMail } from '@/lib/smtp'
import { appendToSentFolder, getMessageSources } from '@/lib/imap'
import { EML_CONTENT_TYPE, emlFilename } from '@/lib/eml'
import {
  FORWARD_ERROR,
  FORWARD_MAX_TOTAL_BYTES,
  parseForwardedMessages,
  resolveForwardOrigin,
} from '@/lib/forward'
import { upsertContactsFromAddresses } from '@/lib/contacts'
import { randomUUID } from 'crypto'

export const dynamic = 'force-dynamic'

function injectTrackingPixel(html: string, pixelUrl: string): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;width:1px;height:1px;" alt="" />`
  // Insert before </body> if present, otherwise append
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`)
  }
  return html + pixel
}

export async function POST(req: Request) {
  const authCtx = await authenticate(req)
  if (!authCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { accountId, to, cc, bcc, subject, html, text, inReplyTo, references, requestReadReceipt, forwardedMessages } = body as {
      accountId?: string
      to?: string | string[]
      cc?: string | string[]
      bcc?: string | string[]
      subject?: string
      html?: string
      text?: string
      inReplyTo?: string
      references?: string
      requestReadReceipt?: boolean
      /** Messages transférés ENTIERS, joints en `.eml` (lot M5). Validé par `parseForwardedMessages`. */
      forwardedMessages?: unknown
    }

    if (!accountId || !to || !subject) {
      return NextResponse.json({ error: 'accountId, to, and subject are required' }, { status: 400 })
    }

    const account = await getAccessibleAccount(accountId, authCtx.id, ['send'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const toArr = Array.isArray(to) ? to : [to]
    const ccArr = cc ? (Array.isArray(cc) ? cc : [cc]) : []

    // Tracking — pixel + MDN header — only when explicitly requested
    let token: string | null = null
    let trackedHtml = html
    if (requestReadReceipt && html) {
      token = randomUUID()
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
      trackedHtml = injectTrackingPixel(html, `${appUrl}/api/track/${token}`)
    }

    // Transfert de messages entiers. Le compte d'ORIGINE de la sélection n'est
    // pas celui de l'expéditeur : l'utilisateur peut changer « De » après avoir
    // coché ses messages. Relire dans la boîte de l'expéditeur joindrait les
    // messages portant les MÊMES uid dans une AUTRE boîte. L'origine est donc
    // contrôlée à part, en lecture (propriétaire ou partage actif).
    let attachments: Array<{ filename: string; content: Buffer; contentType: string }> | undefined
    if (forwardedMessages !== undefined) {
      const parsed = parseForwardedMessages(forwardedMessages)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.code, limit: parsed.detail }, { status: parsed.status })
      }
      const origin = await resolveForwardOrigin(account, parsed.value.accountId, id =>
        getAccessibleAccount(id, authCtx.id)
      )
      if (!origin.ok) {
        return NextResponse.json({ error: origin.code }, { status: origin.status })
      }
      const src = origin.value
      const result = await getMessageSources(
        {
          id: src.id,
          imapHost: src.imap_host,
          imapPort: src.imap_port,
          imapSecure: src.imap_secure,
          username: src.username,
          passwordEncrypted: src.password_encrypted,
          oauthProvider: src.oauth_provider,
          oauthAccessToken: src.oauth_access_token,
          oauthRefreshToken: src.oauth_refresh_token,
          oauthExpiresAt: src.oauth_expires_at,
        },
        parsed.value.folder,
        parsed.value.uids,
        FORWARD_MAX_TOTAL_BYTES
      )
      if (result.oversized) {
        return NextResponse.json(
          { error: FORWARD_ERROR.tooLarge, limit: FORWARD_MAX_TOTAL_BYTES },
          { status: 413 }
        )
      }
      // Rien ne part amputé : un message disparu entre la sélection et l'envoi
      // annule l'envoi, la fenêtre reste ouverte avec son brouillon.
      if (result.missing.length) {
        return NextResponse.json(
          { error: FORWARD_ERROR.missing, limit: result.missing.length },
          { status: 409 }
        )
      }
      attachments = result.sources.map(m => ({
        filename: emlFilename(m.subject),
        content: m.source,
        contentType: EML_CONTENT_TYPE,
      }))
    }

    const { messageId, raw } = await sendMail(
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
      {
        from: account.email,
        to: toArr,
        cc: ccArr.length ? ccArr : undefined,
        bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
        subject,
        html: trackedHtml,
        text,
        inReplyTo,
        references,
        dispositionNotificationTo: requestReadReceipt ? account.email : undefined,
        attachments,
      }
    )

    // Append to IMAP Sent folder — fire-and-forget
    appendToSentFolder(
      {
        id: account.id,
        imapHost: account.imap_host,
        imapPort: account.imap_port,
        imapSecure: account.imap_secure,
        username: account.username,
        passwordEncrypted: account.password_encrypted,
        oauthProvider: account.oauth_provider,
        oauthAccessToken: account.oauth_access_token,
        oauthRefreshToken: account.oauth_refresh_token,
        oauthExpiresAt: account.oauth_expires_at,
      },
      raw
    ).catch(() => {})

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

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
