import { query } from './db'
import { listAccessibleAccounts } from './accountAccess'
import { readEffectiveFor, readEffectiveFieldsFor, type StoredTag } from './tagging/store'
import { NOUL_YES } from './tagging/questions'
import { FOCUS_FILTER, FOCUS_THRESHOLD, type MailListFilter } from './flags'
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
 * valeur absente pèse 0 (le `non` d'un noul, `calme`, `aucune`…). Négatif = fait descendre.
 * Deux étiquettes ne sont PAS de simples poids (gate du 03/10, mesuré sur la boîte réelle) :
 *  - `spam_hameconnage = oui` est un VETO (`SPAM_CEILING`) : un hameçonnage qui crie « urgent,
 *    fraude, juridique » est justement celui qui cumule le plus de points ;
 *  - `automatique = oui` PLAFONNE les signaux excitables (`AUTO_CAP` : urgence, mot d'échéance ou
 *    de facture en objet), annule « fréquent » et la frustration : un code de connexion « sous
 *    48 h », une infolettre quotidienne ou une notification « agacée » n'est pas à traiter — une
 *    plateforme n'a pas de ton (gate du 03/10, « Mrcreatesuk sent you a message » à +2 agacé).
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
 * Score maximal d'un mail marqué spam/hameçonnage : sous le score le plus bas qu'un mail NON
 * marqué puisse atteindre (la somme des poids négatifs), donc toujours dernier du tri par priorité.
 */
export const SPAM_CEILING = Object.values(TAG_WEIGHTS).flatMap(w => Object.values(w)).filter(p => p < 0).reduce((a, b) => a + b, 0) - 1
/** Ce qu'un signal plafonné (`AUTO_CAPPED`) peut encore peser quand le mail est un envoi automatique. */
export const AUTO_CAP = 2
/** Les composantes plafonnées par `automatique = oui` : une raison de surface ou une question. */
export const AUTO_CAPPED: ReadonlySet<string> = new Set(['urgence', 'deadline', 'invoice'])

/**
 * L'échéance EXTRAITE (`message_fields.echeance`, lot T11) pèse selon sa proximité : à J+2 elle
 * domine une facture, à J+7 elle vaut une échéance d'objet, passée depuis plus d'un mois elle ne
 * pèse plus rien (on n'y fera rien). Entre les deux : poids d'un rappel.
 */
export const ECHEANCE_WEIGHTS: readonly { maxDays: number; points: number }[] = [
  { maxDays: 2, points: 6 },
  { maxDays: 7, points: 4 },
  { maxDays: 30, points: 2 },
]
export const ECHEANCE_STALE_DAYS = 30
const DAY_MS = 86_400_000

export function echeancePoints(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0
  const days = Math.ceil((+new Date(`${iso}T00:00:00Z`) - +now) / DAY_MS)
  if (Number.isNaN(days) || days < -ECHEANCE_STALE_DAYS) return 0
  return ECHEANCE_WEIGHTS.find(w => days <= w.maxDays)?.points ?? 0
}

export { FOCUS_THRESHOLD }

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

export type FocusSignals = Pick<FocusRow, 'subject' | 'from_address' | 'is_starred' | 'has_attachments'> & {
  /** L'échéance extraite effective (`YYYY-MM-DD`), quand le mail en porte une. */
  echeance?: string | null
}

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

  const said = (question: string) => tags.find(t => t.question === question)?.valeur
  const automatic = said('automatique') === NOUL_YES
  const spam = said('spam_hameconnage') === NOUL_YES
  const capped = (key: string, points: number) => (automatic && AUTO_CAPPED.has(key) ? Math.min(points, AUTO_CAP) : points)
  const add = (r: Exclude<FocusReason, 'tag'>, raw: number) => { const points = capped(r, raw); score += points; parts.push({ kind: 'reason', reason: r, points }) }

  if (row.is_starred) { add('starred', 5); reason = 'starred' }
  if (from && vip.has(from)) { add('vip', 4); reason = 'vip' }
  else if (from && frequent.has(from) && !automatic) { add('frequent', 2); if (reason === 'reply') reason = 'frequent' }
  if (INVOICE_RE.test(subject)) { add('invoice', 3); reason = 'invoice' }
  if (DEADLINE_RE.test(subject)) { add('deadline', 4); reason = 'deadline' }
  const echeance = echeancePoints(row.echeance)
  if (echeance) { add('echeance', echeance); if (echeance >= 4) reason = 'echeance' }
  if (REPLY_RE.test(subject)) { add('reply', 2) }
  if (row.has_attachments) { add('attachment', 1); if (reason === 'reply') reason = 'attachment' }

  const topHeuristic = Math.max(0, ...parts.map(p => p.points))
  let topTag = 0
  for (const tag of tags) {
    const weight = TAG_WEIGHTS[tag.question]?.[tag.valeur]
    if (weight === undefined || (automatic && tag.question === 'frustration')) continue
    const points = capped(tag.question, weight)
    score += points
    parts.push({ kind: 'tag', question: tag.question, valeur: tag.valeur, points })
    topTag = Math.max(topTag, points)
  }
  // La pastille nomme la composante la plus forte : une étiquette qui pèse plus que tout signal
  // de surface donne son nom au mail, sinon la raison de surface (ordre historique) reste.
  if (topTag > topHeuristic) reason = 'tag'

  // Le veto : un hameçonnage ne remonte jamais, quoi qu'il cumule. L'infobulle montre l'écart
  // comme une composante, pour que la somme des parts reste le score.
  if (spam && score > SPAM_CEILING) {
    parts.push({ kind: 'reason', reason: 'spam', points: SPAM_CEILING - score })
    score = SPAM_CEILING
    reason = 'spam'
  }

  return { score, reason, parts }
}

/**
 * Contact clé = contact étoilé ; fréquent = un vrai CORRESPONDANT (on lui a déjà écrit,
 * `sent_count > 0`) au-dessus du seuil d'échanges — jamais un expéditeur à sens unique, sinon
 * chaque infolettre quotidienne devient « fréquente » (mesuré au gate du 03/10). Lu UNE fois par requête.
 */
export async function contactSignals(userId: string): Promise<{ vip: Set<string>; frequent: Set<string> }> {
  const contactRows = await query<{ email: string; frequency: number; sent_count: number; is_starred: boolean }>(
    `SELECT email, frequency, sent_count, is_starred FROM contacts WHERE user_id = $1`,
    [userId],
  )
  const vip = new Set(contactRows.filter(c => c.is_starred).map(c => c.email.toLowerCase()))
  const freqThreshold = Math.max(5, ...contactRows.map(c => c.frequency))
  const frequent = new Set(
    contactRows.filter(c => c.sent_count > 0 && c.frequency >= Math.min(freqThreshold, 10)).map(c => c.email.toLowerCase()),
  )
  return { vip, frequent }
}

/** Ce que la priorité lit d'un mail trié : ses étiquettes effectives et son échéance extraite. */
export interface PriorityInputs { tags: StoredTag[]; echeance: string | null }
const NO_INPUTS: PriorityInputs = { tags: [], echeance: null }

/**
 * Les entrées de priorité d'une liste de mails d'UNE boîte, en deux requêtes par page — jamais
 * une par ligne. Restreint aux origines de CONFIANCE (`trusted` : main, trieur, moteur rattaché),
 * à la différence de l'affichage : un moteur d'essai ne doit pas réordonner la boîte.
 */
export async function priorityInputsFor(accountId: string, messageIds: string[]): Promise<Map<string, PriorityInputs>> {
  const [tags, fields] = await Promise.all([
    readEffectiveFor(accountId, messageIds, { trusted: true }),
    readEffectiveFieldsFor(accountId, messageIds, { trusted: true }),
  ])
  const out = new Map<string, PriorityInputs>()
  tags.forEach((list, mid) => out.set(mid, { tags: list, echeance: null }))
  fields.forEach((list, mid) => {
    const echeance = list.find(f => f.question === 'echeance')?.valeur ?? null
    out.set(mid, { tags: out.get(mid)?.tags ?? [], echeance })
  })
  return out
}

/** La même lecture pour des mails de PLUSIEURS boîtes : une paire de requêtes par boîte. */
async function priorityInputsAcross(rows: readonly Pick<FocusRow, 'account_id' | 'message_id'>[]): Promise<Map<string, PriorityInputs>> {
  const byAccount = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.message_id) continue
    const ids = byAccount.get(r.account_id) ?? []
    ids.push(r.message_id)
    byAccount.set(r.account_id, ids)
  }
  const out = new Map<string, PriorityInputs>()
  await Promise.all(Array.from(byAccount, async ([accountId, ids]) => {
    (await priorityInputsFor(accountId, ids)).forEach((inputs, mid) => out.set(tagKey(accountId, mid), inputs))
  }))
  return out
}

const tagKey = (accountId: string, messageId: string | null) => `${accountId}|${messageId ?? ''}`

/**
 * La priorité de chaque message d'une PAGE de liste (`/api/messages?sort=priority`) : les mêmes
 * signaux et les mêmes poids que « à traiter », en deux lectures par page — jamais une par ligne.
 */
export async function withPriority(messages: readonly Message[], accountId: string, userId: string): Promise<Message[]> {
  const [{ vip, frequent }, inputs] = await Promise.all([
    contactSignals(userId),
    priorityInputsFor(accountId, messages.map(m => m.messageId).filter(Boolean)),
  ])
  return messages.map(m => {
    const { tags, echeance } = inputs.get(m.messageId) ?? NO_INPUTS
    return {
      ...m,
      priority: scoreFocus(
        { subject: m.subject, from_address: m.from.address, is_starred: m.isStarred, has_attachments: m.hasAttachments, echeance },
        vip, frequent, tags,
      ),
    }
  })
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
  const inputs = await priorityInputsAcross(focusRows)

  const accountById = new Map(accounts.map(a => [a.id, a]))

  return focusRows
    .map(row => {
      const { tags, echeance } = inputs.get(tagKey(row.account_id, row.message_id)) ?? NO_INPUTS
      return { row, ...scoreFocus({ ...row, echeance }, vip, frequent, tags) }
    })
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
