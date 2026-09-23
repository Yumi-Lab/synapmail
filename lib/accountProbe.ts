/**
 * SERVEUR UNIQUEMENT. Ce module ouvre des sockets IMAP et SMTP : il ne doit JAMAIS être
 * importé par un composant client, sinon webpack essaie d'embarquer `imapflow` dans le
 * navigateur et le build casse sur `tls`, `net` et `dns`. C'est exactement pour cela qu'il
 * vit ici et pas dans `lib/accountTest.ts`, dont la moitié pure est lue par l'interface.
 * Un `await import()` ne suffit PAS à isoler : webpack analyse l'import statiquement.
 */
import { ImapFlow } from 'imapflow'
import { classifyTestFailure, type TestConnection } from './accountTest'
import { decryptPassword, saveAnnouncedSize, type DbEmailAccount } from './accounts'
import { parseAnnouncedSize } from './smtpSize'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SMTPConnection = require('nodemailer/lib/smtp-connection') as new (opts: Record<string, unknown>) => SmtpSession

/**
 * Ce que nous utilisons d'une session SMTP de nodemailer. `_maxAllowedSize` est
 * le nombre que nodemailer a lu dans le `250 SIZE <octets>` de la réponse EHLO
 * (`smtp-connection/index.js`, « Detect if the server supports SIZE ») : la
 * valeur arrive de toute façon, personne ne l'expose, et `parseAnnouncedSize`
 * refuse tout ce qui n'en serait pas un nombre crédible — un jour où nodemailer
 * la renommerait, nous retomberions sur le plafond prudent, jamais sur un
 * plafond faux.
 */
interface SmtpSession {
  allowsAuth: boolean
  _maxAllowedSize?: unknown
  connect(cb: () => void): void
  login(auth: Record<string, unknown>, cb: (err?: Error | null) => void): void
  quit(): void
  close(): void
  once(event: 'error' | 'end', cb: (err?: Error) => void): void
}

/**
 * Ouvre la session SMTP, s'authentifie, et rend CE QUE LE SERVEUR A ANNONCÉ au
 * passage. C'est l'équivalent exact de `transporter.verify()` de nodemailer —
 * même poignée de main, même authentification, même verdict — à ceci près que
 * la session n'est pas jetée avant qu'on ait lu sa réponse EHLO. Aucune seconde
 * connexion n'est ouverte : la taille annoncée est un sous-produit gratuit de
 * l'essai qu'on faisait déjà.
 */
export function verifySmtp(
  connection: TestConnection,
  password: string
): Promise<{ maxSize: number | null }> {
  return new Promise((resolve, reject) => {
    const session = new SMTPConnection({
      host: connection.smtpHost,
      port: connection.smtpPort,
      secure: connection.smtpSecure,
      tls: { rejectUnauthorized: false },
      logger: false,
    })
    let settled = false
    const fail = (e: unknown) => {
      if (settled) return
      settled = true
      session.close()
      reject(e instanceof Error ? e : new Error(String(e)))
    }
    const succeed = () => {
      if (settled) return
      settled = true
      const maxSize = parseAnnouncedSize(session._maxAllowedSize)
      session.quit()
      resolve({ maxSize })
    }
    session.once('error', fail)
    session.once('end', () => fail(new Error('Connection closed')))
    session.connect(() => {
      if (settled) return
      if (!session.allowsAuth) return succeed()
      session.login({ user: connection.username, pass: password }, err =>
        err ? fail(err) : succeed()
      )
    })
  })
}

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
): Promise<{
  imap: { ok: boolean; error: string }
  smtp: { ok: boolean; error: string; maxSize: number | null }
}> {
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
  // La taille annoncée par le serveur (lot M10). `null` tant qu'on ne l'a pas
  // entendue : un échec de connexion n'efface pas ce qu'on savait déjà.
  let smtpMaxSize: number | null = null
  try {
    smtpMaxSize = (await verifySmtp(connection, password)).maxSize
    smtpOk = true
  } catch (e) {
    smtpError = classifyTestFailure(String(e instanceof Error ? e.message : e))
  }

  return {
    imap: { ok: imapOk, error: imapError },
    smtp: { ok: smtpOk, error: smtpError, maxSize: smtpMaxSize },
  }
}

/**
 * Relit l'annonce `250 SIZE` du serveur d'une boîte déjà enregistrée, après
 * qu'il a refusé un envoi pour cause de taille (lot M10, complément de Nicolas
 * du 23/09/2026 : « en cas d'échec, faire une actualisation pour mettre à jour
 * si ça change »). Sans cela, un serveur qui BAISSE sa limite refuserait chaque
 * envoi pour toujours, puisque nous continuerions à lui opposer le chiffre
 * qu'il annonçait le jour de la création.
 *
 * Même poignée de main que l'essai de connexion — aucune seconde
 * implémentation. Rend `null` quand rien n'est exploitable (serveur muet,
 * connexion échouée, boîte à jeton) : l'appelant garde alors ce qu'il savait,
 * plutôt que d'effacer un plafond valable sur un incident réseau.
 */
export async function refreshAnnouncedSize(
  connection: TestConnection,
  password: string
): Promise<number | null> {
  try {
    return (await verifySmtp(connection, password)).maxSize
  } catch {
    return null
  }
}

/**
 * Ce qu'il faut d'une ligne `email_accounts` pour rejoindre son serveur SMTP.
 * Même intention que `ImapAccountRow` : la conversion vit à UN endroit, une
 * colonne renommée casse à la compilation plutôt qu'en silence.
 */
export type SmtpAccountRow = Pick<
  DbEmailAccount,
  'id' | 'smtp_host' | 'smtp_port' | 'smtp_secure' | 'username' | 'password_encrypted'
  | 'imap_host' | 'imap_port' | 'imap_secure' | 'oauth_provider'
>

/**
 * Le serveur vient de refuser un envoi POUR SA TAILLE : on relit ce qu'il
 * annonce maintenant et on le retient sur la boîte (lot M10, complément de
 * Nicolas du 23/09/2026 — « en cas d'échec, faire une actualisation pour mettre
 * à jour si ça change… comme ça c'est automatique »). Sans cela, un serveur qui
 * BAISSE sa limite refuserait chaque envoi pour toujours : nous continuerions à
 * lui opposer le chiffre du jour de la création, donc à laisser passer des
 * messages qu'il rejette, sans jamais apprendre.
 *
 * Aucun RÉESSAI : le message refusé n'a pas maigri entre-temps, le renvoyer
 * serait refusé à l'identique. Ce qui change, c'est le plafond opposé à
 * l'appelant MAINTENANT, et celui des envois suivants.
 *
 * Rend `null` sans rien écrire quand il n'y a rien à apprendre (boîte à jeton,
 * serveur muet, connexion échouée) : un incident réseau n'efface pas un plafond
 * valable.
 */
export async function relearnAnnouncedSize(account: SmtpAccountRow): Promise<number | null> {
  // Une boîte à jeton n'a pas de mot de passe à déchiffrer : `refreshAnnouncedSize`
  // ne saurait pas s'authentifier, et `decrypt` d'une chaîne vide lèverait.
  if (account.oauth_provider || !account.password_encrypted) return null
  let password: string
  try {
    password = decryptPassword(account.password_encrypted)
  } catch {
    return null
  }
  const size = await refreshAnnouncedSize(
    {
      imapHost: account.imap_host,
      imapPort: account.imap_port,
      imapSecure: account.imap_secure,
      smtpHost: account.smtp_host,
      smtpPort: account.smtp_port,
      smtpSecure: account.smtp_secure,
      username: account.username,
    },
    password
  )
  if (size !== null) await saveAnnouncedSize(account.id, size)
  return size
}
