/**
 * La source de mails RÉELLE du trieur : une boîte IMAP, vue à travers l'interface `MailSource`.
 *
 * Elle ne sait rien du tri — ni curseur, ni plafond, ni moteur. C'est ce partage qui permet au
 * banc du lot T3 de mesurer le trieur avec une fausse source, sans toucher une boîte réelle.
 *
 * Elle ne réimplémente rien : la connexion vient de `createClient` (qui gère déjà OAuth et le
 * déchiffrement du mot de passe), la conversion de la ligne de compte de `toImapConfig`, les
 * rôles de dossiers de `detectSpecials`. Deux seuls choix lui appartiennent :
 *
 *  1. **UNE connexion pour tout le passage**, ouverte au premier besoin et fermée par `close()`.
 *     Ouvrir une connexion par lot de 20 mails ferait, sur une boîte de 10 000 mails, 500
 *     ouvertures — et une rafale d'authentifications fait blacklister l'IP du serveur.
 *  2. **Le corps est lu PARTIELLEMENT** (`SOURCE_MAX_BYTES`) : le moteur n'en voit que les 1 500
 *     premiers caractères (`STATE_BODY_CHARS`), donc télécharger un mail de 20 Mo pour en garder
 *     1 500 caractères serait payer une bande passante qu'on jette.
 */
import { simpleParser } from 'mailparser'
import type { ImapFlow } from 'imapflow'
import { toImapConfig, type ImapAccountRow } from '../accounts'
import { createClient, messageDate } from '../imap'
import { detectSpecials } from '../specialFolders'
import type { MailSource, SourceMail } from './runner'

/**
 * Ce qu'on télécharge d'un mail. Assez pour couvrir les en-têtes et le début du texte dont le
 * moteur se sert (`STATE_BODY_CHARS` = 1 500 caractères), pas le mail entier : un corps tronqué
 * au milieu d'un encodage se parse en texte partiel, ce qui suffit ici et n'est jamais réécrit
 * dans la boîte.
 */
export const SOURCE_MAX_BYTES = 65536

/** Les rôles de dossiers qu'on ne trie PAS : rien à étiqueter dans une corbeille ou un brouillon. */
const SKIPPED_ROLES = new Set(['trash', 'drafts', 'sent'])

/**
 * La source IMAP d'une boîte. `close()` rend la connexion : l'appelant DOIT l'appeler (le
 * planificateur le fait dans un `finally`), sinon la connexion reste ouverte jusqu'au timeout
 * du serveur.
 */
export interface ImapMailSource extends MailSource {
  close(): Promise<void>
}

export function imapMailSource(account: ImapAccountRow): ImapMailSource {
  const config = toImapConfig(account)
  let client: ImapFlow | null = null
  let openFolder: string | null = null

  const connected = async (): Promise<ImapFlow> => {
    if (!client) client = await createClient(config)
    return client
  }

  /** Ouvre un dossier, et se souvient duquel : réouvrir celui qui l'est déjà coûte un aller-retour. */
  const open = async (folder: string): Promise<ImapFlow> => {
    const c = await connected()
    if (openFolder !== folder) {
      await c.mailboxOpen(folder)
      openFolder = folder
    }
    return c
  }

  return {
    async folders() {
      const c = await connected()
      // `LIST` avec `statusQuery` donne le compte ET l'`uidValidity` de chaque dossier en UNE
      // commande (extension LIST-STATUS, annoncée par IONOS) — cf. `rankFolders` de `lib/imap.ts`,
      // où la mesure est consignée : 222 ms pour 101 dossiers, contre 6 592 ms en `STATUS` séparés.
      const list = await c.list({ statusQuery: { messages: true, uidValidity: true } })
      const selectable = list
        .filter(f => !f.flags?.has('\\Noselect'))
        .map(f => ({
          path: f.path,
          name: f.name,
          delimiter: f.delimiter ?? '/',
          specialUse: (f as unknown as Record<string, unknown>).specialUse as string | undefined,
          messages: f.status?.messages ?? 0,
          uidValidity: f.status?.uidValidity,
        }))
      const roles = detectSpecials(selectable)
      return selectable
        .filter(f => {
          const role = roles.get(f.path)
          return !(role && SKIPPED_ROLES.has(role))
        })
        .map(f => ({
          path: f.path,
          // `uidValidity` est un BigInt : comparé en texte, comme il est stocké dans le curseur.
          uidValidity: f.uidValidity === undefined ? '' : String(f.uidValidity),
          total: f.messages,
        }))
    },

    async uids(folder) {
      const c = await open(folder)
      // `UID SEARCH ALL` : une commande, une liste de nombres, AUCUN corps téléchargé. C'est la
      // seule façon de nommer les mails d'un dossier sans les lire — les UID ne sont pas contigus
      // (un mail supprimé laisse un trou), donc `1..total` ne dit pas lesquels existent.
      const found = await c.search({ all: true }, { uid: true })
      return found === false ? [] : found.map(Number).filter(Number.isFinite)
    },

    async fetch(folder, afterUid, limit) {
      if (limit <= 0) return []
      const c = await open(folder)
      const out: SourceMail[] = []
      // `N:*` rend TOUJOURS au moins un message, même si aucun n'a un UID ≥ N (quirk IMAP bien
      // connu) : le filtre sur `uid > afterUid` est donc obligatoire, pas défensif.
      for await (const msg of c.fetch(
        { uid: `${afterUid + 1}:*` },
        { uid: true, envelope: true, internalDate: true, source: { maxLength: SOURCE_MAX_BYTES } },
        { uid: true }
      )) {
        const uid = Number(msg.uid)
        if (!Number.isFinite(uid) || uid <= afterUid) continue
        const parsed = await simpleParser(msg.source ?? Buffer.alloc(0))
        out.push({
          messageId: parsed.messageId ?? msg.envelope?.messageId ?? null,
          folder,
          uid,
          fromName: parsed.from?.value?.[0]?.name ?? msg.envelope?.from?.[0]?.name ?? '',
          fromAddress: parsed.from?.value?.[0]?.address ?? msg.envelope?.from?.[0]?.address ?? '',
          subject: parsed.subject ?? msg.envelope?.subject ?? '',
          bodyPlain: parsed.text || undefined,
          bodyHtml: typeof parsed.html === 'string' ? parsed.html : undefined,
          date: messageDate(parsed.date, msg.envelope?.date, msg.internalDate),
        })
        if (out.length >= limit) break
      }
      // IMAP rend les messages par UID croissant, mais le curseur en DÉPEND : on le garantit ici
      // plutôt que de faire confiance au serveur.
      return out.sort((a, b) => a.uid - b.uid)
    },

    async close() {
      const c = client
      client = null
      openFolder = null
      if (c) await c.logout().catch(() => {})
    },
  }
}
