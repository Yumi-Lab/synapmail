import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { getAccountById } from '@/lib/accounts'
import { decrypt } from '@/lib/encrypt'
import {
  TEST_DECISION,
  resolveTestPassword,
} from '@/lib/accountTest'
import { probeConnection } from '@/lib/accountProbe'
import { withApiLog } from '@/lib/apiLog'

export const dynamic = 'force-dynamic'

async function postHandler(req: Request) {
  const access = await authorize(req)
  if ('denied' in access) return access.denied
  const userId = access.ctx.id

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
    const { decision, password: pass, connection } = await resolveTestPassword(
      {
        accountId, password, username,
        imapHost, imapPort, imapSecure,
        smtpHost, smtpPort, smtpSecure,
      },
      async id => {
        const account = await getAccountById(id, userId)
        if (!account) return null
        storedEncrypted = account.password_encrypted || null
        return {
          isOwner: true,
          oauthProvider: account.oauth_provider,
          hasStoredPassword: Boolean(account.password_encrypted),
          imapHost: account.imap_host,
          imapPort: account.imap_port,
          imapSecure: account.imap_secure,
          smtpHost: account.smtp_host,
          smtpPort: account.smtp_port,
          smtpSecure: account.smtp_secure,
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
    if (decision === TEST_DECISION.PASSWORD_REQUIRED || pass === null || !connection) {
      return NextResponse.json({ error: TEST_DECISION.PASSWORD_REQUIRED }, { status: 400 })
    }

    // Une seule implémentation de l'essai, partagée avec l'ajout d'une boîte.
    const { imap, smtp } = await probeConnection(connection, pass)

    return NextResponse.json({ tested: decision, imap, smtp })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
