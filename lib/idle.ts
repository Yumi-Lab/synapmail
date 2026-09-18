import type { ImapFlow } from 'imapflow'
import { createClient, type AccountConfig } from './imap'

// Attente de reconnexion : double à chaque échec, plafonnée. Une coupure réseau
// ne doit pas marteler le serveur IMAP, et une coupure longue doit finir par
// retrouver la boîte sans intervention.
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 60_000

export interface MailboxWatcher {
  /** Ferme la connexion et arrête toute reconnexion. Idempotent. */
  close(): void
}

/**
 * Ouvre UNE connexion IMAP qui reste en IDLE sur `folder` et appelle `onChange`
 * à chaque annonce du serveur. imapflow passe seul en IDLE dès que la connexion
 * est inactive : il suffit d'ouvrir la boîte et d'écouter.
 *
 * ponytail: une connexion par flux SSE ouvert, donc par onglet. Plafond connu et
 * assumé ; ne mutualiser par utilisateur+compte que si le serveur IMAP refuse
 * des connexions.
 */
export function watchMailbox(
  account: AccountConfig,
  folder: string,
  onChange: () => void
): MailboxWatcher {
  let stopped = false
  let client: ImapFlow | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0

  const schedule = () => {
    if (stopped || timer) return
    const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
    attempt += 1
    timer = setTimeout(() => { timer = null; void run() }, wait)
    timer.unref?.()
  }

  const run = async () => {
    if (stopped) return
    let c: ImapFlow | null = null
    try {
      c = await createClient(account)
      // Sans écouteur 'error', une coupure de transport devient une exception
      // non capturée et emporte le processus : imapflow émet, on absorbe, la
      // reconnexion est gérée par 'close'.
      c.on('error', () => {})
      const opened = c
      c.on('close', () => {
        if (client !== opened) return
        client = null
        schedule()
      })
      // Les trois annonces non sollicitées qui changent ce que la liste affiche :
      // un message arrive, un message disparaît, un drapeau bouge.
      c.on('exists', onChange)
      c.on('expunge', onChange)
      c.on('flags', onChange)
      await c.mailboxOpen(folder)
      if (stopped) { void opened.logout().catch(() => {}); return }
      client = opened
      attempt = 0
      // imapflow n'entre en IDLE tout seul qu'après 15 s d'inactivité : sans cet
      // appel, la PREMIÈRE arrivée attend ce délai (mesuré : ~9 s de latence là
      // où la DoD en demande moins de 5). `idle()` ne rend la main qu'à la fin
      // de l'IDLE, d'où l'appel non attendu ; sa rupture passe par 'close'.
      void opened.idle().catch(() => {})
    } catch {
      // Connexion refusée, identifiants rejetés, boîte absente : on réessaie.
      if (c) void c.logout().catch(() => {})
      client = null
      schedule()
    }
  }

  void run()

  return {
    close() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      const c = client
      client = null
      if (c) void c.logout().catch(() => {})
    },
  }
}
