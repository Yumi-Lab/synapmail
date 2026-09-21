/**
 * SERVEUR UNIQUEMENT. Ce module ouvre des sockets IMAP et SMTP : il ne doit JAMAIS être
 * importé par un composant client, sinon webpack essaie d'embarquer `imapflow` dans le
 * navigateur et le build casse sur `tls`, `net` et `dns`. C'est exactement pour cela qu'il
 * vit ici et pas dans `lib/accountTest.ts`, dont la moitié pure est lue par l'interface.
 * Un `await import()` ne suffit PAS à isoler : webpack analyse l'import statiquement.
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { classifyTestFailure, type TestConnection } from './accountTest'

/**
 * Essaie RÉELLEMENT la connexion, IMAP puis SMTP, et rend le même verdict pour tout le monde.
 * Une seule implémentation : la route de test l'utilise, et l'ajout d'une boîte aussi — sinon
 * une boîte ajoutée par l'API pouvait être enregistrée sans que personne n'ait vérifié qu'elle
 * répond, et l'utilisateur découvrait une boîte vide sans explication.
 * Aucune exception ne remonte : un échec est une DONNÉE, pas une panne.
 */
export async function probeConnection(
  connection: TestConnection,
  password: string
): Promise<{ imap: { ok: boolean; error: string }; smtp: { ok: boolean; error: string } }> {
  let imapOk = false
  let imapError = ''
  try {
    const client = new ImapFlow({
      host: connection.imapHost,
      port: connection.imapPort,
      secure: connection.imapSecure,
      auth: { user: connection.username, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
    })
    await client.connect()
    await client.logout()
    imapOk = true
  } catch (e) {
    imapError = classifyTestFailure(String(e instanceof Error ? e.message : e))
  }

  let smtpOk = false
  let smtpError = ''
  try {
    const transport = nodemailer.createTransport({
      host: connection.smtpHost,
      port: connection.smtpPort,
      secure: connection.smtpSecure,
      auth: { user: connection.username, pass: password },
      tls: { rejectUnauthorized: false },
    })
    await transport.verify()
    smtpOk = true
  } catch (e) {
    smtpError = classifyTestFailure(String(e instanceof Error ? e.message : e))
  }

  return { imap: { ok: imapOk, error: imapError }, smtp: { ok: smtpOk, error: smtpError } }
}
