import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { getMessage } from '@/lib/imap'
import { decrypt } from '@/lib/encrypt'
import nodemailer from 'nodemailer'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { accountId, folder } = await req.json()
    if (!accountId || !folder) {
      return NextResponse.json({ error: 'accountId and folder are required' }, { status: 400 })
    }

    const account = await getAccessibleAccount(accountId, session.user?.id ?? '', ['send'])
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    // Fetch the original message to get headers
    const message = await getMessage(
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
      folder,
      params.id
    )

    if (!message?.dispositionNotificationTo) {
      return NextResponse.json({ error: 'No MDN requested for this message' }, { status: 400 })
    }

    // Build RFC 8098-compliant MDN as raw MIME
    const boundary = `mdn_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const readDate = new Date().toUTCString()
    const originalSubject = message.subject ?? '(no subject)'
    const originalMessageId = message.messageId ?? ''

    const raw = [
      `From: ${account.email}`,
      `To: ${message.dispositionNotificationTo}`,
      `Subject: Read: ${originalSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `L'email "${originalSubject}" a été lu le ${readDate}.`,
      ``,
      `--${boundary}`,
      `Content-Type: message/disposition-notification`,
      ``,
      `Reporting-UA: Synapmail/1.0`,
      `Final-Recipient: rfc822; ${account.email}`,
      `Original-Message-ID: ${originalMessageId}`,
      `Disposition: manual-action/MDN-sent-manually; displayed`,
      ``,
      `--${boundary}--`,
    ].join('\r\n')

    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_secure,
      auth: { user: account.username, pass: decrypt(account.password_encrypted) },
    })

    await transporter.sendMail({
      envelope: { from: account.email, to: [message.dispositionNotificationTo] },
      raw,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
