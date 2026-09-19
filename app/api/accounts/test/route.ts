import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { getAccountById } from '@/lib/accounts'
import { decrypt } from '@/lib/encrypt'
import {
  TEST_DECISION,
  classifyTestFailure,
  resolveTestPassword,
} from '@/lib/accountTest'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = (session.user as { id: string }).id

  try {
    const {
      accountId, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, username, password,
    } = await req.json()

    if (!imapHost || !smtpHost || !username) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    // Quel mot de passe essayer — la décision vit dans `lib/accountTest.ts`, seule et
    // exécutable. Le compte est chargé par `getAccountById`, qui n'accepte QUE son
    // propriétaire : un invité d'une boîte partagée n'en teste pas les identifiants.
    // Le mot de passe enregistré n'est déchiffré QUE si la décision est `STORED`, donc
    // seulement vers les hôtes ENREGISTRÉS : le formulaire vient du navigateur, et une
    // session volée ne doit pas pouvoir le faire lire par un serveur qu'elle a choisi.
    let storedEncrypted: string | null = null
    const { decision, password: pass } = await resolveTestPassword(
      { accountId, password, imapHost, smtpHost, username },
      async id => {
        const account = await getAccountById(id, userId)
        if (!account) return null
        storedEncrypted = account.password_encrypted || null
        return {
          isOwner: true,
          oauthProvider: account.oauth_provider,
          hasStoredPassword: Boolean(account.password_encrypted),
          imapHost: account.imap_host,
          smtpHost: account.smtp_host,
          username: account.username,
        }
      },
      async () => decrypt(storedEncrypted ?? '')
    )

    if (decision === TEST_DECISION.DENIED) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (decision === TEST_DECISION.OAUTH) {
      return NextResponse.json({ tested: decision })
    }
    if (decision === TEST_DECISION.MISSING) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }
    // Aucune connexion n'est tentée : le formulaire vise un autre serveur, il faut le mot
    // de passe de qui le demande.
    if (decision === TEST_DECISION.PASSWORD_REQUIRED || pass === null) {
      return NextResponse.json({ error: TEST_DECISION.PASSWORD_REQUIRED }, { status: 400 })
    }

    // Test IMAP
    let imapOk = false
    let imapError = ''
    try {
      const client = new ImapFlow({
        host: imapHost,
        port: Number(imapPort) || 993,
        secure: imapSecure ?? true,
        auth: { user: username, pass },
        logger: false,
        tls: { rejectUnauthorized: false },
      })
      await client.connect()
      await client.logout()
      imapOk = true
    } catch (e) {
      imapError = classifyTestFailure(String(e instanceof Error ? e.message : e))
    }

    // Test SMTP
    let smtpOk = false
    let smtpError = ''
    try {
      const transport = nodemailer.createTransport({
        host: smtpHost,
        port: Number(smtpPort) || 587,
        secure: smtpSecure ?? false,
        auth: { user: username, pass },
        tls: { rejectUnauthorized: false },
      })
      await transport.verify()
      smtpOk = true
    } catch (e) {
      smtpError = classifyTestFailure(String(e instanceof Error ? e.message : e))
    }

    return NextResponse.json({
      tested: decision,
      imap: { ok: imapOk, error: imapError },
      smtp: { ok: smtpOk, error: smtpError },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
