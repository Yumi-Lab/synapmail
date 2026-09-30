/**
 * La source de mails RÉELLE du déclenchement : une boîte IMAP, vue à travers
 * `WebhookMailSource`. Elle ne sait rien des règles, ni du curseur, ni des webhooks — c'est ce
 * partage qui permet au banc du lot W3 de mesurer le balayage avec une fausse source, sans
 * ouvrir une connexion vers une vraie boîte.
 *
 * Elle ne réimplémente rien : la connexion vient de `createClient`, la conversion de la ligne de
 * compte de `toImapConfig`, la détection des pièces jointes de `detectAttachments`, la date de
 * `messageDate`. Deux seuls choix lui appartiennent :
 *
 *  1. **UNE connexion pour tout le passage**, ouverte au premier besoin, rendue par `close()` —
 *     même raison que `lib/tagging/imapSource.ts` : une rafale d'authentifications fait
 *     blacklister l'IP du serveur.
 *  2. **Le corps n'est téléchargé que si on le demande** (`withBody`), et alors partiellement
 *     (`SOURCE_MAX_BYTES`, la même borne que le trieur) : une condition regex sur le corps ne
 *     regarde que ses 10 000 premiers caractères (`REGEX_BODY_MAX`), donc tirer un mail de 20 Mo
 *     serait payer une bande passante qu'on jette.
 */
import { simpleParser } from 'mailparser'
import type { ImapFlow } from 'imapflow'
import { toImapConfig, type ImapAccountRow } from './accounts'
import { FLAG_IMAP_FLAG } from './flags'
import { createClient, detectAttachments, messageDate } from './imap'
import { SOURCE_MAX_BYTES } from './tagging/imapSource'
import type { WebhookMailSource } from './webhookTrigger'
import type { Message } from '@/types/email'

export interface ImapWebhookSource extends WebhookMailSource {
  close(): Promise<void>
}

export function imapWebhookSource(account: ImapAccountRow): ImapWebhookSource {
  const config = toImapConfig(account)
  let client: ImapFlow | null = null
  let openFolder: string | null = null

  const open = async (folder: string): Promise<ImapFlow> => {
    if (!client) client = await createClient(config)
    if (openFolder !== folder) {
      await client.mailboxOpen(folder)
      openFolder = folder
    }
    return client
  }

  return {
    async state(folder) {
      const c = await open(folder)
      const box = await c.mailboxOpen(folder)
      // Le dernier UID du dossier, pas son nombre de mails : `uidNext` est ce que le PROCHAIN
      // mail portera, donc le dernier posé est juste en dessous. Un dossier vide rend 0.
      const next = Number(box.uidNext ?? 1)
      return {
        uidValidity: box.uidValidity === undefined ? '' : String(box.uidValidity),
        lastUid: Number.isFinite(next) && next > 1 ? next - 1 : 0,
      }
    },

    async fetch(folder, afterUid, limit, withBody) {
      if (limit <= 0) return []
      const c = await open(folder)
      const out: Message[] = []
      // `N:*` rend TOUJOURS au moins un message, même si aucun n'a un UID ≥ N (quirk IMAP) :
      // le filtre sur `uid > afterUid` est obligatoire, pas défensif.
      for await (const msg of c.fetch(
        { uid: `${afterUid + 1}:*` },
        {
          uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true,
          // Les deux champs de condition qui vivent dans un en-tête (`list_unsubscribe`,
          // `priority`) : sans eux, ces conditions seraient silencieusement fausses ici alors
          // qu'elles sont vraies pour `processRules`.
          headers: ['list-unsubscribe', 'x-priority'],
          ...(withBody ? { source: { maxLength: SOURCE_MAX_BYTES } } : {}),
        } as Parameters<typeof c.fetch>[1],
        { uid: true }
      )) {
        const uid = Number(msg.uid)
        if (!Number.isFinite(uid) || uid <= afterUid) continue
        const src = (msg as unknown as { source?: Buffer }).source
        const parsed = withBody && src ? await simpleParser(src) : null
        const hdr = (msg as unknown as { headers?: Buffer }).headers
        const header = (name: string): string | undefined =>
          (Buffer.isBuffer(hdr) ? hdr.toString('utf8') : '').match(new RegExp(`^${name}:\\s*(.+)`, 'im'))?.[1]?.trim()
        const priority = header('x-priority')
        out.push({
          uid: String(uid),
          messageId: msg.envelope?.messageId ?? '',
          from: {
            name: msg.envelope?.from?.[0]?.name ?? '',
            address: msg.envelope?.from?.[0]?.address ?? '',
          },
          to: (msg.envelope?.to ?? []).map(a => ({ name: a.name ?? '', address: a.address ?? '' })),
          cc: (msg.envelope?.cc ?? []).map(a => ({ name: a.name ?? '', address: a.address ?? '' })),
          subject: msg.envelope?.subject ?? '',
          date: messageDate(msg.envelope?.date, msg.internalDate),
          preview: (parsed?.text ?? '').slice(0, 200),
          isRead: msg.flags?.has('\\Seen') ?? false,
          isStarred: msg.flags?.has(FLAG_IMAP_FLAG) ?? false,
          isFlagged: msg.flags?.has(FLAG_IMAP_FLAG) ?? false,
          hasAttachments: detectAttachments(msg.bodyStructure as unknown as Record<string, unknown>),
          folder,
          accountId: account.id,
          size: (msg as unknown as { size?: number }).size,
          bodyPlain: parsed?.text || undefined,
          bodyHtml: typeof parsed?.html === 'string' ? parsed.html : undefined,
          listUnsubscribe: header('list-unsubscribe'),
          xPriority: priority ? parseInt(priority, 10) || undefined : undefined,
        })
        if (out.length >= limit) break
      }
      // IMAP rend les messages par UID croissant, mais le curseur en DÉPEND : on le garantit ici
      // plutôt que de faire confiance au serveur.
      return out.sort((a, b) => Number(a.uid) - Number(b.uid))
    },

    async close() {
      const c = client
      client = null
      openFolder = null
      if (c) await c.logout().catch(() => {})
    },
  }
}
