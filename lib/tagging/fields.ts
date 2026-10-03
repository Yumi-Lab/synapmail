/**
 * L'extraction de VALEURS (décision 19) : un montant, une échéance, un numéro de commande, un
 * numéro de suivi — ce qu'une étiquette ne peut pas porter parce que ce n'est pas une valeur
 * PRÉVUE mais une valeur LUE dans le mail.
 *
 * La méthode tient en trois temps, et le moteur n'a jamais le dernier mot sur une valeur :
 *
 *  1. des REGEX trouvent les CANDIDATS dans l'état envoyé au moteur (objet + corps, donc ce
 *     que le moteur voit aussi) ;
 *  2. le moteur reçoit un `choice` dont les options SONT ces candidats (`c1`, `c2`…) plus
 *     `aucun` : il DÉSIGNE, il n'invente pas — une réponse hors liste est rejetée par
 *     `parseAnswer` comme pour toute autre question ;
 *  3. la valeur retenue est celle du candidat, telle que le CODE l'a normalisée : un montant en
 *     nombre, une date en ISO calculée ici (y compris « sous 30 jours » depuis la date du mail),
 *     un transporteur déduit du FORMAT du numéro. Jamais de calcul demandé au moteur.
 *
 * La seconde requête n'a lieu QUE si `montant_mentionne` / `echeance_mentionnee` = oui (avec des
 * candidats) ou si une regex trouve un n° de commande ou de suivi : un mail sans rien à extraire
 * ne coûte rien de plus.
 *
 * Un IBAN n'est JAMAIS stocké en clair : seulement ses 4 derniers caractères (sa présence est la
 * ligne elle-même). Il ne passe par aucun moteur. `ibanOf` et `IBAN_RE` sont réutilisés par les
 * détecteurs du lot T11b.
 */
import { NOUL_YES, type TagQuestion } from './questions'

export const FIELDS = [
  'montant', 'devise', 'type_montant', 'echeance', 'type_echeance',
  'numero_commande', 'numero_suivi', 'transporteur_suivi', 'iban',
] as const
export type FieldName = (typeof FIELDS)[number]
export const isFieldName = (v: unknown): v is FieldName => typeof v === 'string' && (FIELDS as readonly string[]).includes(v)

export const TYPE_MONTANT = ['a_payer', 'a_encaisser', 'remboursement'] as const
export const TYPE_ECHEANCE = ['paiement', 'livraison', 'rendez_vous', 'reponse'] as const
/** Les transporteurs qu'un FORMAT de numéro désigne ; `autre` quand seul le contexte l'a trouvé. */
export const CARRIERS = ['colissimo', 'chronopost', 'dhl', 'ups', 'fedex', 'autre'] as const

export const NONE = 'aucun'

/** Un candidat : la valeur normalisée par le code, et le texte tel que le moteur le lit. */
export interface Candidate {
  valeur: string
  texte: string
  devise?: string
  transporteur?: string
}

/** Ce qu'un champ extrait vaut, prêt à écrire. */
export interface FieldValue {
  champ: FieldName
  valeur: string
  candidats?: Candidate[] | null
}

/**
 * ponytail: 8 candidats par champ au plus — au-delà, le mail est un relevé, pas une demande, et
 * la liste ne ferait que grossir la requête. Voie d'amélioration : garder les 8 plus proches
 * d'un mot-clé (« total », « à régler », « avant le »).
 */
const MAX_CANDIDATES = 8

const dedupe = (cs: Candidate[]): Candidate[] => {
  const seen = new Set<string>()
  return cs.filter(c => !seen.has(c.valeur) && seen.add(c.valeur)).slice(0, MAX_CANDIDATES)
}

// ---------------------------------------------------------------- montants

const CURRENCY: Record<string, string> = {
  '€': 'EUR', eur: 'EUR', euros: 'EUR', euro: 'EUR', '$': 'USD', usd: 'USD', '£': 'GBP', gbp: 'GBP',
  '¥': 'CNY', cny: 'CNY', rmb: 'CNY', yuan: 'CNY', '元': 'CNY', chf: 'CHF',
}
const CUR = '(€|\\$|£|¥|元|EUR|USD|GBP|CNY|RMB|CHF|euros?|yuan)'
const NUM = '\\d{1,3}(?:[ \\u00a0\\u202f.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?'
const AMOUNT_RES = [
  new RegExp(`(${NUM})\\s?${CUR}(?![A-Za-z])`, 'gi'),
  new RegExp(`${CUR}\\s?(${NUM})(?!\\d)`, 'gi'),
]

/** « 1 234,56 » → `1234.56` : le DERNIER séparateur suivi de 1-2 chiffres est la décimale, le reste des milliers. */
export function parseAmount(raw: string): string | null {
  const s = raw.replace(/[ \u00a0\u202f]/g, '')
  const m = s.match(/^(.*?)(?:[.,](\d{1,2}))?$/)
  if (!m) return null
  const whole = m[1].replace(/[.,]/g, '')
  if (!/^\d+$/.test(whole)) return null
  const n = Number(m[2] ? `${whole}.${m[2]}` : whole)
  return Number.isFinite(n) && n > 0 ? String(n) : null
}

export function amountCandidates(text: string): Candidate[] {
  const out: Candidate[] = []
  for (const [i, re] of Array.from(AMOUNT_RES.entries())) {
    for (const m of Array.from(text.matchAll(re))) {
      const [num, cur] = i === 0 ? [m[1], m[2]] : [m[2], m[1]]
      const valeur = parseAmount(num)
      const devise = CURRENCY[cur.toLowerCase()] ?? CURRENCY[cur]
      if (valeur && devise) out.push({ valeur, texte: m[0].trim(), devise })
    }
  }
  return dedupe(out)
}

// ---------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}
const MONTH = Object.keys(MONTHS).join('|')
const DATE_RES: { re: RegExp; ymd: (m: RegExpMatchArray) => [number, number, number] | null }[] = [
  { re: /\b(20\d{2})-(\d{2})-(\d{2})\b/g, ymd: m => [+m[1], +m[2], +m[3]] },
  // ponytail: jour/mois/année, l'ordre français ; une date américaine « 10/15/2026 » tombe
  // en mois 15, donc est écartée plutôt que lue à l'envers.
  { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/g, ymd: m => [+m[3], +m[2], +m[1]] },
  { re: new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(${MONTH})\\.?\\s+(20\\d{2})\\b`, 'gi'), ymd: m => [+m[3], MONTHS[m[2].toLowerCase()], +m[1]] },
  { re: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi'), ymd: m => [+m[3], MONTHS[m[1].toLowerCase()], +m[2]] },
  { re: /\b(20\d{2})年(\d{1,2})月(\d{1,2})日/g, ymd: m => [+m[1], +m[2], +m[3]] },
]
const RELATIVE_RE = /\b(?:sous|dans|d'ici|avant|within|in|under|next)\s+(\d{1,3})\s*(jours?|days?|j|d|heures?|hours?|h)\b/gi

const pad = (n: number) => String(n).padStart(2, '0')

/** Une date civile valide → `AAAA-MM-JJ`, sinon `null` (un 31/02 ou un mois 15 n'est pas une date). */
export function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

export const ISO_DATE_RE = /^20\d{2}-\d{2}-\d{2}$/

export function dateCandidates(text: string, mailDate?: Date | string | null): Candidate[] {
  const out: Candidate[] = []
  for (const { re, ymd } of DATE_RES) {
    for (const m of Array.from(text.matchAll(re))) {
      const parts = ymd(m)
      const valeur = parts && isoDate(...parts)
      if (valeur) out.push({ valeur, texte: m[0] })
    }
  }
  // « sous 30 jours » se COMPTE depuis la date du mail — ici, jamais par le moteur.
  const base = mailDate ? new Date(mailDate) : null
  if (base && !Number.isNaN(base.getTime())) {
    for (const m of Array.from(text.matchAll(RELATIVE_RE))) {
      const n = Number(m[1])
      const hours = /^(h|heure|hour)/i.test(m[2])
      const t = new Date(base.getTime() + n * (hours ? 3_600_000 : 86_400_000))
      const valeur = isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
      if (valeur) out.push({ valeur, texte: m[0] })
    }
  }
  return dedupe(out)
}

// ---------------------------------------------------------------- numéros

const ORDER_RE = /\b(?:commande|order|cde|bon de commande|po|订单)\s*(?:n[°o]\.?|#|:|number|no\.?)?\s*#?([A-Z0-9][A-Z0-9-]{3,24}\d[A-Z0-9-]*|\d[A-Z0-9-]{3,24})\b/gi
// Une URL n'est jamais un n° de commande : « …-PoW3CgLy… » au milieu d'un lien y ressemblait (gate T11, mail 827).
const URL_RE = /\bhttps?:\/\/\S+/gi

export function orderCandidates(text: string): Candidate[] {
  return dedupe(Array.from(text.replace(URL_RE, ' ').matchAll(ORDER_RE), m => ({ valeur: m[1].toUpperCase(), texte: m[0].trim() })))
}

/**
 * Les formats qui désignent un transporteur à eux seuls. Un numéro fait de chiffres seulement
 * (DHL 10, FedEx 12/15) ressemble à un téléphone : il n'est retenu qu'après un mot de suivi.
 */
const TRACKING_FORMATS: { re: RegExp; carrier: (typeof CARRIERS)[number]; context: boolean }[] = [
  { re: /\b1Z[0-9A-Z]{16}\b/g, carrier: 'ups', context: false },
  { re: /\b[0-9][A-Z][0-9]{11}\b/g, carrier: 'colissimo', context: false },
  // ponytail: le format S10 (XX123456789FR) est partagé par Chronopost et Colissimo
  // international ; Chronopost est le cas le plus fréquent sur nos boîtes.
  { re: /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g, carrier: 'chronopost', context: false },
  { re: /\b\d{10}\b/g, carrier: 'dhl', context: true },
  { re: /\b\d{12}\b|\b\d{15}\b/g, carrier: 'fedex', context: true },
  { re: /\b[A-Z0-9]{11,22}\b/g, carrier: 'autre', context: true },
]
const TRACKING_CONTEXT_RE = /\b(?:suivi|suivre|tracking|track|colis|parcel|shipment|expédition|expedition|envoi|运单|快递)\b/i

export function trackingCandidates(text: string): Candidate[] {
  const out: Candidate[] = []
  for (const { re, carrier, context } of TRACKING_FORMATS) {
    for (const m of Array.from(text.matchAll(re))) {
      if (context && !TRACKING_CONTEXT_RE.test(text.slice(Math.max(0, m.index! - 60), m.index!))) continue
      // Un IBAN sans espaces ressemble à un numéro de suivi : il n'entre dans aucun candidat.
      if (!/\d/.test(m[0]) || isIban(m[0])) continue
      out.push({ valeur: m[0], texte: m[0], transporteur: carrier })
    }
  }
  return dedupe(out)
}

// ---------------------------------------------------------------- IBAN

export const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ \u00a0]?[A-Z0-9]{4}){2,7}(?:[ \u00a0]?[A-Z0-9]{1,4})?\b/g

/** La validation officielle (ISO 13616, mod 97) : ce qui sépare un IBAN d'une référence qui lui ressemble. */
export function isIban(raw: string): boolean {
  const s = raw.replace(/[ \u00a0]/g, '').toUpperCase()
  if (s.length < 15 || s.length > 34) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rest = (rest * 10 + Number(d)) % 97
  }
  return rest === 1
}

/** Les 4 derniers caractères du premier IBAN valide du texte — jamais le reste. */
export function ibanOf(text: string): string | null {
  for (const m of Array.from(text.matchAll(IBAN_RE))) {
    if (isIban(m[0])) return m[0].replace(/[ \u00a0]/g, '').slice(-4).toUpperCase()
  }
  return null
}

// ---------------------------------------------------------------- questions au moteur

const TEMPLATES: Record<'montant' | 'echeance' | 'numero_commande' | 'numero_suivi', string> = {
  montant: 'Parmi ces montants cités dans le mail, lequel est LE montant que ce mail demande de payer, annonce à encaisser ou à rembourser ?',
  echeance: 'Parmi ces dates citées dans le mail, laquelle est la date limite ou l\'échéance que ce mail fixe ? Ne pas confondre avec la durée de validité d\'un lien, d\'un code ou d\'une offre.',
  numero_commande: 'Parmi ces numéros cités dans le mail, lequel est le numéro de la commande dont parle ce mail ?',
  numero_suivi: 'Parmi ces numéros cités dans le mail, lequel est un numéro de suivi de colis ?',
}
const TYPE_ECHEANCE_QUESTION: TagQuestion = {
  id: 'type_echeance', group: 'finance', type: 'choice',
  instructions: 'À quoi se rapporte l\'échéance que ce mail fixe ?',
  options: [
    { value: 'paiement', definition: 'la date limite pour régler un montant' },
    { value: 'livraison', definition: 'la date de livraison ou d\'expédition annoncée' },
    { value: 'rendez_vous', definition: 'un rendez-vous, une réunion, un appel' },
    { value: 'reponse', definition: 'la date avant laquelle une réponse ou une décision est attendue' },
    { value: NONE, definition: 'aucune échéance, ou aucune de celles-ci' },
  ],
}

export const optionId = (i: number): string => `c${i + 1}`

/** La question d'un champ à candidats : les options SONT les candidats, plus `aucun`. */
export function questionFor(champ: keyof typeof TEMPLATES, candidates: readonly Candidate[]): TagQuestion {
  return {
    id: champ, group: 'finance', type: 'choice', instructions: TEMPLATES[champ],
    options: [
      ...candidates.map((c, i) => ({ value: optionId(i), definition: c.texte })),
      { value: NONE, definition: 'aucun de ceux-ci, ou aucun ne convient' },
    ],
  }
}

/**
 * La VERSION d'un champ, pour `message_fields.question_version` : le hachage de la CONSIGNE,
 * sans les candidats (qui changent à chaque mail). Même fonction que les étiquettes
 * (`questionVersion`), appliquée au gabarit vide. Calculée par l'appelant qui l'a importée.
 */
export const fieldTemplate = (champ: FieldName): TagQuestion =>
  champ === 'type_echeance' ? TYPE_ECHEANCE_QUESTION
    : { id: champ, group: 'finance', type: 'choice', instructions: TEMPLATES[champ as keyof typeof TEMPLATES] ?? champ, options: [] }

export interface Extraction {
  /** Les questions à poser dans la seconde requête ; vide = pas de requête. */
  questions: TagQuestion[]
  candidates: Partial<Record<FieldName, Candidate[]>>
  /** Les champs qui ne passent par AUCUN moteur : l'IBAN (4 derniers), déjà prêts à écrire. */
  direct: FieldValue[]
}

const said = (held: readonly { question: string; valeur: string }[], question: string): string | undefined =>
  held.find(t => t.question === question)?.valeur

/**
 * Ce qu'il y a à extraire d'un mail, au vu de son état et des étiquettes déjà obtenues.
 * `text` est l'état tel que le moteur le lit (objet + corps tronqué) : un candidat que le moteur
 * ne verrait pas ne serait pas désignable.
 */
export function extractionFor(text: string, held: readonly { question: string; valeur: string }[], mailDate?: Date | string | null): Extraction {
  const candidates: Extraction['candidates'] = {}
  const questions: TagQuestion[] = []
  if (said(held, 'montant_mentionne') === NOUL_YES) {
    const cs = amountCandidates(text)
    if (cs.length) { candidates.montant = cs; questions.push(questionFor('montant', cs)) }
  }
  if (said(held, 'echeance_mentionnee') === NOUL_YES) {
    const cs = dateCandidates(text, mailDate)
    if (cs.length) { candidates.echeance = cs; questions.push(questionFor('echeance', cs), TYPE_ECHEANCE_QUESTION) }
  }
  const orders = orderCandidates(text)
  if (orders.length) { candidates.numero_commande = orders; questions.push(questionFor('numero_commande', orders)) }
  const tracking = trackingCandidates(text)
  if (tracking.length) { candidates.numero_suivi = tracking; questions.push(questionFor('numero_suivi', tracking)) }
  const iban = ibanOf(text)
  return { questions, candidates, direct: iban ? [{ champ: 'iban', valeur: iban }] : [] }
}

/** `type_montant` se DÉDUIT des étiquettes déjà posées : aucune question de plus au moteur. */
export function typeMontantOf(held: readonly { question: string; valeur: string }[]): (typeof TYPE_MONTANT)[number] | null {
  if (said(held, 'demande_remboursement') === NOUL_YES) return 'remboursement'
  const flux = said(held, 'sens_flux')
  return flux === 'a_payer' || flux === 'a_encaisser' ? flux : null
}

/**
 * Les réponses du moteur → les valeurs à écrire. Une réponse `aucun` n'écrit rien ; une réponse
 * à une question non posée est ignorée (le faux moteur du banc répond à tout).
 */
export function fieldsFromAnswers(
  x: Extraction, answers: readonly { question: string; valeur: string }[], held: readonly { question: string; valeur: string }[],
): FieldValue[] {
  const out: FieldValue[] = []
  const pick = (champ: keyof Extraction['candidates']): Candidate | null => {
    const a = answers.find(t => t.question === champ)?.valeur
    const cs = x.candidates[champ]
    if (!a || a === NONE || !cs) return null
    const i = cs.findIndex((_, k) => optionId(k) === a)
    return i >= 0 ? cs[i] : null
  }
  const montant = pick('montant')
  if (montant) {
    out.push({ champ: 'montant', valeur: montant.valeur, candidats: x.candidates.montant })
    if (montant.devise) out.push({ champ: 'devise', valeur: montant.devise })
    const type = typeMontantOf(held)
    if (type) out.push({ champ: 'type_montant', valeur: type })
  }
  const echeance = pick('echeance')
  if (echeance) {
    out.push({ champ: 'echeance', valeur: echeance.valeur, candidats: x.candidates.echeance })
    const type = answers.find(t => t.question === 'type_echeance')?.valeur
    if (type && type !== NONE) out.push({ champ: 'type_echeance', valeur: type })
  }
  const order = pick('numero_commande')
  if (order) out.push({ champ: 'numero_commande', valeur: order.valeur, candidats: x.candidates.numero_commande })
  const tracking = pick('numero_suivi')
  if (tracking) {
    out.push({ champ: 'numero_suivi', valeur: tracking.valeur, candidats: x.candidates.numero_suivi })
    if (tracking.transporteur) out.push({ champ: 'transporteur_suivi', valeur: tracking.transporteur })
  }
  return out
}

/**
 * Ce qu'une valeur de champ peut être, pour TOUTE source — la porte d'entrée du stockage, comme
 * `isValidTag` pour les étiquettes. Une main qui corrige passe par la même.
 */
export function isValidFieldValue(champ: string, valeur: unknown): boolean {
  if (typeof valeur !== 'string' || !valeur) return false
  switch (champ) {
    case 'montant': return /^\d+(\.\d{1,2})?$/.test(valeur)
    case 'devise': return /^[A-Z]{3}$/.test(valeur)
    case 'type_montant': return (TYPE_MONTANT as readonly string[]).includes(valeur)
    case 'echeance': return ISO_DATE_RE.test(valeur) && isoDate(+valeur.slice(0, 4), +valeur.slice(5, 7), +valeur.slice(8, 10)) === valeur
    case 'type_echeance': return (TYPE_ECHEANCE as readonly string[]).includes(valeur)
    case 'numero_commande': case 'numero_suivi': return /^[A-Z0-9-]{4,32}$/i.test(valeur)
    case 'transporteur_suivi': return (CARRIERS as readonly string[]).includes(valeur)
    case 'iban': return /^[A-Z0-9]{4}$/.test(valeur)
    default: return false
  }
}
