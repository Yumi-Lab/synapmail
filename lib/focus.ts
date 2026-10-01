import { query } from './db'
import { listAccessibleAccounts } from './accountAccess'
import { readEffectiveFor, type StoredTag } from './tagging/store'
import { FOCUS_FILTER, type MailListFilter } from './flags'
import type { Message } from '@/types/email'
import type { FocusItem, FocusPart, FocusReason, FocusScore } from '@/types/dashboard'

/**
 * LA fonction de priorité du dépôt — « à traiter » (volet de lecture vide, tableau de bord)
 * et le tri « par priorité » de la liste lisent la même. Deux étages, un seul score :
 *  - les signaux de surface (drapeau, contact clé, regex d'objet, pièce jointe), toujours là ;
 *  - les étiquettes EFFECTIVES du mail quand il a été trié (lot T12, décision 20), pesées par
 *    `TAG_WEIGHTS` — la seule table de poids. Un mail non trié garde exactement l'ancien calcul.
 * Chaque composante est rendue (`parts`) pour l'infobulle. Aucune question de plus au moteur.
 */

export const INVOICE_RE = /\b(facture|invoice|paiement|payment|reçu|receipt|devis|quote)\b/i
export const DEADLINE_RE = /(urgent|expire|expir|échéance|echeance|deadline|action requise|action required|rappel|reminder|dernier délai)/i
export const REPLY_RE = /^\s*(re|ré|rép|tr|fwd|fw)\s*:/i

/**
 * Le poids de chaque étiquette qui change la priorité : `question → valeur → points`. Une
 * valeur absente pèse 0 (le `non` d'un noul, `calme`, `aucune`…). Négatif = fait descendre :
 * un envoi automatique ou un hameçonnage n'est pas « à traiter », même avec « URGENT » en objet.
 */
export const TAG_WEIGHTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  urgence: { sous_48h: 4, aujourdhui: 8 },
  reponse_requise: { oui: 3 },
  frustration: { agace: 2, colere: 4, insultant: 5 },
  menace_juridique: { oui: 5 },
  risque_depart: { oui: 4 },
  fraude_paiement: { oui: 5 },
  demande_remboursement: { oui: 3 },
  automatique: { oui: -3 },
  spam_hameconnage: { oui: -5 },
}

/**
 * À partir de ce score un mail est « à traiter ». Un signal faible seul (pièce jointe 1,
 * « Re : » 2, contact fréquent 2) n'y suffit pas ; un signal fort (facture 3, échéance 4,
 * drapeau 5, toute étiquette pesée ≥ 3) y suffit.
 */
export const FOCUS_THRESHOLD = 3

/**
 * Les non-lus les plus récents passés au score — pour le top-5 comme pour le filtre de liste
 * « à traiter ». ponytail: une fenêtre fixe plutôt qu'une pagination (un non-lu plus ancien que
 * les 200 derniers n'est pas « à traiter ») ; si une boîte le dément, paginer sur le score.
 */
export const FOCUS_SCAN = 200

export interface FocusRow {
  uid: string
  account_id: string
  message_id: string | null
  folder: string
  subject: string | null
  from_name: string | null
  from_address: string | null
  date: string
  is_starred: boolean
  has_attachments: boolean
}

export type FocusSignals = Pick<FocusRow, 'subject' | 'from_address' | 'is_starred' | 'has_attachments'>

/** Ce que le serveur IMAP reçoit pour un filtre de liste : « à traiter » se lit dans les non-lus. */
export const imapFilterOf = (filter: MailListFilter): Exclude<MailListFilter, 'focus'> => (filter === FOCUS_FILTER ? 'unread' : filter)

export function scoreFocus(
  row: FocusSignals,
  vip: Set<string>,
  frequent: Set<string>,
  tags: readonly Pick<StoredTag, 'question' | 'valeur'>[] = [],
): FocusScore {
  const subject = row.subject ?? ''
  const from = (row.from_address ?? '').toLowerCase()
  const parts: FocusPart[] = []
  let score = 0
  let reason: FocusReason = 'reply'
  const add = (r: Exclude<FocusReason, 'tag'>, points: number) => { score += points; parts.push({ kind: 'reason', reason: r, points }) }

  if (row.is_starred) { add('starred', 5); reason = 'starred' }
  if (from && vip.has(from)) { add('vip', 4); reason = 'vip' }
  else if (from && frequent.has(from)) { add('frequent', 2); if (reason === 'reply') reason = 'frequent' }
  if (INVOICE_RE.test(subject)) { add('invoice', 3); reason = 'invoice' }
  if (DEADLINE_RE.test(subject)) { add('deadline', 4); reason = 'deadline' }
  if (REPLY_RE.test(subject)) { add('reply', 2) }
  if (row.has_attachments) { add('attachment', 1); if (reason === 'reply') reason = 'attachment' }

  const topHeuristic = Math.max(0, ...parts.map(p => p.points))
  let topTag = 0
  for (const tag of tags) {
    const points = TAG_WEIGHTS[tag.question]?.[tag.valeur]
    if (points === undefined) continue
    score += points
    parts.push({ kind: 'tag', question: tag.question, valeur: tag.valeur, points })
    topTag = Math.max(topTag, points)
  }
  // La pastille nomme la composante la plus forte : une étiquette qui pèse plus que tout signal
  // de surface donne son nom au mail, sinon la raison de surface (ordre historique) reste.
  if (topTag > topHeuristic) reason = 'tag'

  return { score, reason, parts }
}

/** Contact clé = contact étoilé ; fréquent = au-dessus du seuil d'échanges. Lu UNE fois par requête. */
export async function contactSignals(userId: string): Promise<{ vip: Set<string>; frequent: Set<string> }> {
  const contactRows = await query<{ email: string; frequency: number; is_starred: boolean }>(
    `SELECT email, frequency, is_starred FROM contacts WHERE user_id = $1`,
    [userId],
  )
  const vip = new Set(contactRows.filter(c => c.is_starred).map(c => c.email.toLowerCase()))
  const freqThreshold = Math.max(5, ...contactRows.map(c => c.frequency))
  const frequent = new Set(
    contactRows.filter(c => c.frequency >= Math.min(freqThreshold, 10)).map(c => c.email.toLowerCase()),
  )
  return { vip, frequent }
}

/**
 * Les étiquettes effectives d'une liste de mails de PLUSIEURS boîtes : une requête par boîte
 * (`readEffectiveFor` est la source unique de la règle « effective »), jamais une par mail.
 */
export async function effectiveTagsFor(rows: readonly Pick<FocusRow, 'account_id' | 'message_id'>[]): Promise<Map<string, StoredTag[]>> {
  const byAccount = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.message_id) continue
    const ids = byAccount.get(r.account_id) ?? []
    ids.push(r.message_id)
    byAccount.set(r.account_id, ids)
  }
  const out = new Map<string, StoredTag[]>()
  await Promise.all(Array.from(byAccount, async ([accountId, ids]) => {
    (await readEffectiveFor(accountId, ids)).forEach((tags, mid) => out.set(tagKey(accountId, mid), tags))
  }))
  return out
}

const tagKey = (accountId: string, messageId: string | null) => `${accountId}|${messageId ?? ''}`

/**
 * La priorité de chaque message d'une PAGE de liste (`/api/messages?sort=priority`) : les mêmes
 * signaux et les mêmes poids que « à traiter », en deux lectures par page — jamais une par ligne.
 */
export async function withPriority(messages: readonly Message[], accountId: string, userId: string): Promise<Message[]> {
  const [{ vip, frequent }, tags] = await Promise.all([
    contactSignals(userId),
    readEffectiveFor(accountId, messages.map(m => m.messageId).filter(Boolean)),
  ])
  return messages.map(m => ({
    ...m,
    priority: scoreFocus(
      { subject: m.subject, from_address: m.from.address, is_starred: m.isStarred, has_attachments: m.hasAttachments },
      vip, frequent, tags.get(m.messageId) ?? [],
    ),
  }))
}

// Folder-name fragments that must NOT count as "inbox" mail. Includes Gmail's
// "All Mail" / "Important" (localised) so an unread there is not double-counted
// against the copy already sitting in INBOX.
const NON_INBOX = `(mc.folder ILIKE '%trash%' OR mc.folder ILIKE '%sent%' OR mc.folder ILIKE '%junk%'
  OR mc.folder ILIKE '%spam%' OR mc.folder ILIKE '%draft%' OR mc.folder ILIKE '%archive%'
  OR mc.folder ILIKE '%deleted%' OR mc.folder ILIKE '%all mail%' OR mc.folder ILIKE '%tous les messages%'
  OR mc.folder ILIKE '%important%')`

/**
 * Top-N « à traiter » d'un utilisateur, éventuellement réduit à une boîte : les non-lus de la
 * réception dont le score atteint `FOCUS_THRESHOLD`, les reportés exclus. Le tableau de bord et
 * le volet de lecture vide appellent cette fonction — pas une copie.
 */
export async function getFocusItems(userId: string, accountId?: string | null, limit = 5): Promise<FocusItem[]> {
  const scoped = !!accountId
  const params: unknown[] = scoped ? [userId, accountId] : [userId]
  const byEa = scoped ? 'AND ea.id = $2' : ''

  const [accounts, focusRows, { vip, frequent }] = await Promise.all([
    // Les boîtes par la règle PARTAGÉE (mêmes boîtes, même ordre que la barre latérale).
    listAccessibleAccounts(userId),
    query<FocusRow>(
      `SELECT mc.uid, mc.account_id, mc.message_id, mc.folder, mc.subject, mc.from_name, mc.from_address,
              mc.date, mc.is_starred, mc.has_attachments
       FROM messages_cache mc JOIN email_accounts ea ON ea.id = mc.account_id
       WHERE ea.user_id = $1 AND mc.is_read = false AND NOT ${NON_INBOX} ${byEa}
         AND NOT EXISTS (
           SELECT 1 FROM snoozed_messages sm
           WHERE sm.account_id = mc.account_id AND sm.folder = mc.folder
             AND sm.uid = mc.uid AND sm.snooze_until > now()
         )
       ORDER BY mc.date DESC LIMIT ${FOCUS_SCAN}`,
      params,
    ),
    contactSignals(userId),
  ])
  const tags = await effectiveTagsFor(focusRows)

  const accountById = new Map(accounts.map(a => [a.id, a]))

  return focusRows
    .map(row => ({ row, ...scoreFocus(row, vip, frequent, tags.get(tagKey(row.account_id, row.message_id)) ?? []) }))
    .filter(x => x.score >= FOCUS_THRESHOLD)
    .sort((a, b) => b.score - a.score || +new Date(b.row.date) - +new Date(a.row.date))
    .slice(0, limit)
    .map(({ row, score, reason, parts }) => ({
      uid: row.uid,
      messageId: row.message_id ?? '',
      accountId: row.account_id,
      accountName: accountById.get(row.account_id)?.name ?? '',
      folder: row.folder,
      subject: row.subject ?? '',
      fromName: row.from_name,
      fromAddress: row.from_address,
      date: row.date,
      score,
      reason,
      parts,
    }))
}
