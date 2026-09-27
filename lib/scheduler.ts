import { query } from './db'
import { sendMail } from './smtp'
import { appendToSentFolder, getAttachmentContent, listMessages, getMessage } from './imap'
import { schedulerEvents } from './schedulerEvents'
import { upsertContactsFromAddresses } from './contacts'
import { getEnabledRulesForAccount, applyRulesToMessages, logRuleExecution, tagsForMessages } from './rules'
import { engineFromRow, mailboxesToSort, runPass } from './tagging/runner'
import { imapMailSource } from './tagging/imapSource'
import { DELIVERY_RETENTION_DAYS, processWebhookDeliveries, purgeOldDeliveries } from './webhooks'

type AccountRow = {
  id: string; email: string; smtp_host: string; smtp_port: number; smtp_secure: boolean;
  imap_host: string; imap_port: number; imap_secure: boolean;
  username: string; password_encrypted: string;
  oauth_provider: string | null; oauth_access_token: string | null;
  oauth_refresh_token: string | null; oauth_expires_at: number | null;
}

type ScheduledEmail = {
  id: string
  user_id: string
  account_id: string
  to_addresses: string
  cc_addresses: string | null
  bcc_addresses: string | null
  subject: string
  html: string | null
  in_reply_to: string | null
  forwarded_attachments: string | null
}

type ForwardedAttachment = {
  uid: string
  accountId: string
  folder: string
  partIdx: number
  filename: string
  contentType: string
}

export async function processScheduledEmails(): Promise<void> {
  // Atomically claim emails that are due — FOR UPDATE SKIP LOCKED prevents double-send
  const due = await query<ScheduledEmail>(`
    UPDATE scheduled_emails
    SET status = 'processing'
    WHERE id IN (
      SELECT id FROM scheduled_emails
      WHERE status = 'pending' AND send_at <= NOW()
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `)

  for (const email of due) {
    try {
      const accounts = await query<AccountRow>(
        'SELECT * FROM email_accounts WHERE id = $1 LIMIT 1',
        [email.account_id]
      )
      if (!accounts.length) {
        await query(
          'UPDATE scheduled_emails SET status = $1, error = $2 WHERE id = $3',
          ['failed', 'Account not found', email.id]
        )
        continue
      }
      const account = accounts[0]

      // Resolve forwarded attachments from IMAP
      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (email.forwarded_attachments) {
        const fwdAtts = JSON.parse(email.forwarded_attachments) as ForwardedAttachment[]
        for (const att of fwdAtts) {
          const imapAccounts = await query<AccountRow>(
            'SELECT * FROM email_accounts WHERE id = $1 LIMIT 1',
            [att.accountId]
          )
          if (!imapAccounts.length) continue
          const imapAcc = imapAccounts[0]
          const content = await getAttachmentContent(
            {
              id: imapAcc.id,
              imapHost: imapAcc.imap_host,
              imapPort: imapAcc.imap_port,
              imapSecure: imapAcc.imap_secure,
              username: imapAcc.username,
              passwordEncrypted: imapAcc.password_encrypted,
              oauthProvider: imapAcc.oauth_provider,
              oauthAccessToken: imapAcc.oauth_access_token,
              oauthRefreshToken: imapAcc.oauth_refresh_token,
              oauthExpiresAt: imapAcc.oauth_expires_at,
            },
            att.folder,
            att.uid,
            att.partIdx
          )
          if (content) {
            attachments.push({
              filename: content.filename,
              content: content.content,
              contentType: content.contentType,
            })
          }
        }
      }

      const imapConfig = {
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
      }

      const { raw } = await sendMail(
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
          to: JSON.parse(email.to_addresses) as string[],
          cc: email.cc_addresses ? (JSON.parse(email.cc_addresses) as string[]) : undefined,
          bcc: email.bcc_addresses ? (JSON.parse(email.bcc_addresses) as string[]) : undefined,
          subject: email.subject,
          html: email.html ?? undefined,
          inReplyTo: email.in_reply_to ?? undefined,
          attachments: attachments.length ? attachments : undefined,
        }
      )

      // Save to IMAP Sent folder — fire-and-forget
      appendToSentFolder(imapConfig, raw).catch(() => {})

      await query(
        'UPDATE scheduled_emails SET status = $1, sent_at = NOW() WHERE id = $2',
        ['sent', email.id]
      )

      // Track recipients as contacts (fire-and-forget)
      const toArr = JSON.parse(email.to_addresses) as string[]
      const ccArr = email.cc_addresses ? (JSON.parse(email.cc_addresses) as string[]) : []
      upsertContactsFromAddresses(email.user_id, [...toArr, ...ccArr], 'sent').catch(() => {})

      const firstTo = toArr[0] ?? ''
      schedulerEvents.emit('scheduled_sent', {
        userId: email.user_id,
        subject: email.subject,
        to: firstTo,
      })
    } catch (err) {
      await query(
        'UPDATE scheduled_emails SET status = $1, error = $2 WHERE id = $3',
        ['failed', String(err), email.id]
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Rule processing — runs every 5 minutes for all accounts
// ---------------------------------------------------------------------------

type AccountForRules = {
  id: string; user_id: string; email: string;
  imap_host: string; imap_port: number; imap_secure: boolean;
  username: string; password_encrypted: string;
  oauth_provider: string | null; oauth_access_token: string | null;
  oauth_refresh_token: string | null; oauth_expires_at: number | null;
}

const RULE_FOLDERS = ['INBOX']  // folders to scan for rules

export async function processRules(): Promise<void> {
  const accounts = await query<AccountForRules>(`SELECT * FROM email_accounts`)

  for (const acc of accounts) {
    try {
      const rules = await getEnabledRulesForAccount(acc.id)
      if (!rules.length) continue

      const accountConfig = {
        id: acc.id,
        imapHost: acc.imap_host,
        imapPort: acc.imap_port,
        imapSecure: acc.imap_secure,
        username: acc.username,
        passwordEncrypted: acc.password_encrypted,
        oauthProvider: acc.oauth_provider,
        oauthAccessToken: acc.oauth_access_token,
        oauthRefreshToken: acc.oauth_refresh_token,
        oauthExpiresAt: acc.oauth_expires_at,
      }

      for (const folder of RULE_FOLDERS) {
        try {
          // Only process recent unread messages (last 30) to keep it fast
          const { messages } = await listMessages(accountConfig, folder, 1, 30, 'unread', acc.user_id)
          if (!messages.length) continue

          const fullMessageFetcher = async (uid: string) => {
            try { return await getMessage(accountConfig, folder, uid) }
            catch { return null }
          }

          const tagsByUid = await tagsForMessages(acc.id, messages, rules)
          const results = await applyRulesToMessages(accountConfig, folder, messages, rules, fullMessageFetcher, tagsByUid)
          if (!results.length) continue

          // Log per-rule stats
          for (const rule of rules) {
            const matched = results.filter(r => r.matchedRules.includes(rule.name)).length
            if (matched > 0) {
              await logRuleExecution(rule.id, acc.id, acc.user_id, folder, messages.length, matched)
              schedulerEvents.emit('rule_applied', {
                userId: acc.user_id,
                accountId: acc.id,
                ruleName: rule.name,
                matched,
                folder,
              })
            }
          }
        } catch (folderErr) {
          console.error(`[rules] folder ${folder} / account ${acc.id}:`, folderErr)
        }
      }
    } catch (err) {
      console.error(`[rules] account ${acc.id}:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Snooze wake — drops expired snoozes so the message reappears in the list
// on the client's next poll (MessageList refreshes every 60s).
// ---------------------------------------------------------------------------

export async function processSnoozes(): Promise<void> {
  const woken = await query<{ id: string }>(
    `DELETE FROM snoozed_messages WHERE snooze_until <= NOW() RETURNING id`,
  )
  if (woken.length) {
    console.log(`[scheduler/snooze] woke ${woken.length} message(s)`)
  }
}

// ---------------------------------------------------------------------------
// Inbox sync — refreshes messages_cache for EVERY account's INBOX on a timer,
// independently of what the user opens in the UI. Without this, an account the
// user never navigates to keeps stale/zero unread counts (the cache is only
// written when /api/messages is hit). listMessages() upserts the fetched page
// and, on page 1, reconciles (prunes rows whose UID is no longer live).
// ---------------------------------------------------------------------------

const SYNC_FOLDERS = ['INBOX']       // extend if other folders need background counts
const SYNC_PAGE_SIZE = 50            // newest N per folder — matches the app's other cache windows
const SYNC_INTERVAL_MS = 3 * 60_000  // every 3 minutes

export async function processInboxSync(): Promise<void> {
  const accounts = await query<AccountForRules>(`SELECT * FROM email_accounts`)

  for (const acc of accounts) {
    const accountConfig = {
      id: acc.id,
      imapHost: acc.imap_host,
      imapPort: acc.imap_port,
      imapSecure: acc.imap_secure,
      username: acc.username,
      passwordEncrypted: acc.password_encrypted,
      oauthProvider: acc.oauth_provider,
      oauthAccessToken: acc.oauth_access_token,
      oauthRefreshToken: acc.oauth_refresh_token,
      oauthExpiresAt: acc.oauth_expires_at,
    }

    for (const folder of SYNC_FOLDERS) {
      try {
        // 'all' (not 'unread') so recently-read messages also get their
        // is_read flipped in the cache — keeps the count accurate, not just growing.
        await listMessages(accountConfig, folder, 1, SYNC_PAGE_SIZE, 'all', acc.user_id)
      } catch (err) {
        console.error(`[scheduler/sync] account ${acc.id} / ${folder}:`, err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tri automatique (lot T3) — un passage par boîte qui a quelque chose à trier.
//
// Le trieur lui-même ne sait ni ouvrir une connexion IMAP ni parler HTTP : cette
// fonction lui fournit la source RÉELLE (`imapMailSource`) et le moteur choisi par
// la boîte (`engineFromRow`). C'est le seul endroit qui les assemble, donc le seul
// que le banc du lot T3 n'exerce pas — il mesure le trieur avec des faux, ce qui
// est justement ce qui lui permet de ne toucher aucune boîte réelle.
//
// Une seule requête sélectionne les boîtes à travailler : celles qui ont un tri en
// masse en cours OU le fil de l'eau actif, sans pause, dont le verrou est libre.
// Une boîte en pause n'est jamais réveillée ici — il faut un `resume` explicite.
// ---------------------------------------------------------------------------

const TAGGING_INTERVAL_MS = 60_000

export async function processTagging(): Promise<void> {
  for (const box of await mailboxesToSort()) {
    const source = imapMailSource(box)
    try {
      const outcome = await runPass({
        accountId: box.account_id,
        source,
        engine: engineFromRow({
          id: box.engine_id, kind: box.engine_kind, url: box.engine_url,
          key_encrypted: box.engine_key, model: box.engine_model,
          usd_per_billion_input: box.engine_price,
        }),
      })
      if (outcome.tagged || outcome.errors || outcome.paused) {
        console.log(`[scheduler/tagging] ${box.account_id}: ${outcome.reason} tagged=${outcome.tagged} skipped=${outcome.skipped} errors=${outcome.errors}${outcome.paused ? ` paused=${outcome.paused.reason}` : ''}`)
      }
    } catch (err) {
      // Une boîte injoignable ne doit pas empêcher les autres d'être triées.
      console.error(`[scheduler/tagging] account ${box.account_id}:`, err)
    } finally {
      await source.close().catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// API key request log cleanup — the log is a lightweight audit trail, not
// indefinite storage; purge anything older than 30 days so it can't grow
// unbounded on a busy key.
// ---------------------------------------------------------------------------

const API_LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60_000  // every 6 hours

export async function processApiKeyLogCleanup(): Promise<void> {
  const deleted = await query<{ id: string }>(
    `DELETE FROM api_key_requests WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id`,
  )
  if (deleted.length) {
    console.log(`[scheduler/api-log] purged ${deleted.length} request log row(s)`)
  }
}

// ---------------------------------------------------------------------------
// Expired share cleanup — the real access boundary is the live expires_at
// check in lib/accountAccess.ts; this only flips the status so the owner's
// share list in Settings stops showing a stale "active" badge.
// ---------------------------------------------------------------------------

export async function processExpiredShares(): Promise<void> {
  const expired = await query<{ id: string }>(
    `UPDATE account_shares SET status = 'expired'
     WHERE status IN ('pending', 'active')
       AND expires_at IS NOT NULL AND expires_at <= NOW()
     RETURNING id`
  )
  if (expired.length) {
    console.log(`[scheduler/shares] expired ${expired.length} share(s)`)
  }
}

// ---------------------------------------------------------------------------
// Webhooks — un passage envoie ce qui est dû (premier envoi ou reprise) ; le journal
// est purgé au même rythme que celui des clés d'API, pour la même raison.
// ---------------------------------------------------------------------------

const WEBHOOK_INTERVAL_MS = 60_000
const WEBHOOK_PURGE_INTERVAL_MS = 6 * 60 * 60_000

export async function processWebhooks(): Promise<void> {
  const { sent, failed } = await processWebhookDeliveries()
  if (sent || failed) console.log(`[scheduler/webhooks] ${sent} envoyé(s), ${failed} abandonné(s)`)
}

export async function processWebhookLogCleanup(): Promise<void> {
  const purged = await purgeOldDeliveries()
  if (purged) console.log(`[scheduler/webhooks] purgé ${purged} envoi(s) de plus de ${DELIVERY_RETENTION_DAYS} jours`)
}

// ---------------------------------------------------------------------------
// Singleton scheduler — starts once per process lifetime
// ---------------------------------------------------------------------------

let started = false

export function startScheduler(): void {
  if (started) return
  started = true

  // Scheduled emails — every 60s
  setInterval(() => {
    processScheduledEmails().catch(err => console.error('[scheduler/emails]', err))
  }, 60_000)

  // Snooze wake — every 60s
  setInterval(() => {
    processSnoozes().catch(err => console.error('[scheduler/snooze]', err))
  }, 60_000)

  // Rules — every 5 minutes
  setInterval(() => {
    processRules().catch(err => console.error('[scheduler/rules]', err))
  }, 5 * 60_000)

  // Webhooks — every 60s (envois dus et reprises), purge du journal toutes les 6 h
  setInterval(() => {
    processWebhooks().catch(err => console.error('[scheduler/webhooks]', err))
  }, WEBHOOK_INTERVAL_MS)
  setInterval(() => {
    processWebhookLogCleanup().catch(err => console.error('[scheduler/webhooks]', err))
  }, WEBHOOK_PURGE_INTERVAL_MS)

  // Expired share cleanup — every 5 minutes
  setInterval(() => {
    processExpiredShares().catch(err => console.error('[scheduler/shares]', err))
  }, 5 * 60_000)

  // Inbox sync (all accounts) — every 3 minutes, plus one pass shortly after boot
  setInterval(() => {
    processInboxSync().catch(err => console.error('[scheduler/sync]', err))
  }, SYNC_INTERVAL_MS)
  setTimeout(() => {
    processInboxSync().catch(err => console.error('[scheduler/sync]', err))
  }, 15_000)

  // Tri automatique — every 60s (a pass gives itself PASS_BUDGET_MS, so it always
  // returns before the next tick; the per-mailbox lock covers an overrun anyway)
  setInterval(() => {
    processTagging().catch(err => console.error('[scheduler/tagging]', err))
  }, TAGGING_INTERVAL_MS)

  // API key request log cleanup — every 6 hours, plus one pass shortly after boot
  setInterval(() => {
    processApiKeyLogCleanup().catch(err => console.error('[scheduler/api-log]', err))
  }, API_LOG_RETENTION_INTERVAL_MS)
  setTimeout(() => {
    processApiKeyLogCleanup().catch(err => console.error('[scheduler/api-log]', err))
  }, 30_000)
}
