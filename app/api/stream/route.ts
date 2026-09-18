import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { schedulerEvents, type ScheduledSentEvent, type RuleAppliedEvent, type AccountShareAcceptedEvent } from '@/lib/schedulerEvents'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { watchMailbox, type MailboxWatcher } from '@/lib/idle'
import { IDLE_FOLDER, MAILBOX_CHANGED, STREAM_ACCOUNT_PARAM } from '@/lib/stream'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user?.id ?? ''
  const encoder = new TextEncoder()

  // Compte à surveiller en temps réel. Absent ou inaccessible → le flux garde
  // ses événements de planificateur, sans surveillance IMAP (pas d'erreur :
  // le temps réel est un supplément, la relecture périodique reste le filet).
  const accountId = new URL(req.url).searchParams.get(STREAM_ACCOUNT_PARAM)
  const account = accountId ? await getAccessibleAccount(accountId, userId) : null

  // Démontage du flux. `start()` retournait une fonction de nettoyage, que l'API
  // des flux n'appelle jamais : les écouteurs restaient posés et, désormais, la
  // connexion IMAP resterait ouverte à chaque onglet fermé. `cancel()` est le
  // rappel effectivement invoqué quand le client se déconnecte.
  let cleanup = () => {}

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      send({ type: 'connected', userId })

      // Keep-alive every 25s
      const interval = setInterval(() => {
        try {
          send({ type: 'ping' })
        } catch {
          clearInterval(interval)
        }
      }, 25000)

      // Forward scheduler sent-events to this SSE client
      const onScheduledSent = (evt: ScheduledSentEvent) => {
        if (evt.userId !== userId) return
        try {
          send({ type: 'scheduled_sent', subject: evt.subject, to: evt.to })
        } catch {
          // Stream already closed
        }
      }
      schedulerEvents.on('scheduled_sent', onScheduledSent)

      const onRuleApplied = (evt: RuleAppliedEvent) => {
        if (evt.userId !== userId) return
        try {
          send({ type: 'rule_applied', ruleName: evt.ruleName, matched: evt.matched, folder: evt.folder })
        } catch {
          // Stream already closed
        }
      }
      schedulerEvents.on('rule_applied', onRuleApplied)

      const onShareAccepted = (evt: AccountShareAcceptedEvent) => {
        if (evt.ownerId !== userId) return
        try {
          send({ type: 'account_share_accepted', accountEmail: evt.accountEmail, inviteeEmail: evt.inviteeEmail })
        } catch {
          // Stream already closed
        }
      }
      schedulerEvents.on('account_share_accepted', onShareAccepted)

      // Temps réel : une connexion IMAP en IDLE sur la boîte du compte actif.
      // Le serveur ne dit pas CE qui a changé, seulement QUE quelque chose a
      // changé : le client relit sa liste, il a déjà tout ce qu'il faut pour ça.
      let watcher: MailboxWatcher | null = null
      if (account) {
        watcher = watchMailbox(
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
          IDLE_FOLDER,
          () => {
            try {
              send({ type: MAILBOX_CHANGED, accountId: account.id, folder: IDLE_FOLDER })
            } catch {
              // Stream already closed
            }
          }
        )
      }

      cleanup = () => {
        watcher?.close()
        watcher = null
        clearInterval(interval)
        schedulerEvents.off('scheduled_sent', onScheduledSent)
        schedulerEvents.off('rule_applied', onRuleApplied)
        schedulerEvents.off('account_share_accepted', onShareAccepted)
      }
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
