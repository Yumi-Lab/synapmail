/**
 * Les DÉTECTEURS de divulgation (lot T11b, étage A) : ce qu'un PROGRAMME tranche mieux qu'un
 * moteur — un format. Un téléphone, une adresse tierce, un IBAN (mod 97), une carte (Luhn),
 * un secret technique. Déterministes, gratuits, calculés à chaque passage du trieur, écrits
 * en source `regle` et signés du détecteur (décision 23).
 *
 * CE QUI SORT D'ICI N'EST JAMAIS LA VALEUR TROUVÉE. Un détecteur rend `oui`/`non` et un
 * nombre d'occurrences, rien d'autre : ni un secret, ni un mot de passe, ni un téléphone, ni
 * un numéro — l'étiquette ne doit pas devenir elle-même une fuite, et le banc le PROUVE en
 * semant chaque motif puis en relisant toute la base. Les 4 derniers caractères d'un IBAN,
 * seule exception admise, sont déjà le champ `iban` de `message_fields` (lot T11) : on ne les
 * écrit pas deux fois.
 *
 * L'IBAN réutilise `IBAN_RE` / `isIban` de `./fields.ts` : UNE regex, UNE validation.
 */
import { IBAN_RE, isIban } from './fields'
import { NOUL_NO, NOUL_YES, RULE_QUESTIONS, type RuleQuestionId } from './questions'
import type { TagToWrite } from './store'

/** Ce qu'un détecteur rend : jamais plus que ça. */
export interface Detection {
  question: RuleQuestionId
  occurrences: number
}

/** Ce qu'un détecteur lit : l'objet et le corps, plus les adresses à EXCLURE d'`email_tiers`. */
export interface MailForDetectors {
  subject?: string
  text: string
  fromAddress?: string
  recipients?: readonly string[]
}

// ---------------------------------------------------------------- téléphone

/**
 * FR (+33 / 0X, 9 chiffres après l'indicatif), CN (+86 / 1XXXXXXXXXX, 11 chiffres), E.164 (+ et
 * 8 à 15 chiffres). Séparateurs admis : espace, point, tiret. ponytail: un numéro de commande
 * de 10 chiffres commençant par 0 passerait pour un FR — plafond connu, l'aval (JEV, règles)
 * tranche le contexte.
 */
const PHONE_RES = [
  /(?:^|[^\d+])(?:\+33\s?|0033\s?|0)[1-9](?:[ .-]?\d{2}){4}(?!\d)/g,
  /(?:^|[^\d+])(?:\+86\s?|0086\s?)?1[3-9]\d(?:[ .-]?\d{4}){2}(?!\d)/g,
  /(?:^|[^\d+])\+(?!33|86)[1-9]\d{7,14}(?!\d)/g,
]

/** « +33 6… », « 0033 6… » et « 06… » sont le même numéro : une seule forme, pour ne compter qu'une fois. */
const canonicalPhone = (raw: string): string =>
  raw.replace(/\D/g, '').replace(/^00/, '').replace(/^33(?=\d{9}$)/, '0').replace(/^86(?=1\d{10}$)/, '')

export function countPhones(text: string): number {
  const seen = new Set<string>()
  for (const re of PHONE_RES) {
    for (const m of Array.from(text.matchAll(re))) seen.add(canonicalPhone(m[0]))
  }
  return seen.size
}

// ---------------------------------------------------------------- e-mail tiers

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** Les adresses du texte qui ne sont ni l'expéditeur ni un destinataire, dédoublonnées. */
export function countThirdPartyEmails(text: string, known: readonly (string | undefined)[]): number {
  const mine = new Set(known.filter((a): a is string => !!a).map(a => a.toLowerCase()))
  const found = new Set<string>()
  for (const m of Array.from(text.matchAll(EMAIL_RE))) {
    const a = m[0].toLowerCase()
    if (!mine.has(a)) found.add(a)
  }
  return found.size
}

// ---------------------------------------------------------------- carte bancaire

const CARD_RE = /(?:^|[^\d])(\d(?:[ -]?\d){12,18})(?!\d)/g

/** Luhn (ISO/IEC 7812) : ce qui sépare une carte d'une suite de chiffres. */
export function isLuhn(digits: string): boolean {
  let sum = 0, alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (alt) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

/** Le NOMBRE de cartes valides du texte (13 à 19 chiffres + Luhn), dédoublonnées. */
export function countCards(text: string): number {
  const out = new Set<string>()
  for (const m of Array.from(text.matchAll(CARD_RE))) {
    const digits = m[1].replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && isLuhn(digits)) out.add(digits)
  }
  return out.size
}

// ---------------------------------------------------------------- secret technique

const SECRET_RES = [
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bapikey_[a-f0-9_]{20,}/g,
  /\bsyn_[a-f0-9]{48}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  /\bxox[bp]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]

export function countSecrets(text: string): number {
  let n = 0
  for (const re of SECRET_RES) n += Array.from(text.matchAll(re)).length
  return n
}

// ---------------------------------------------------------------- IBAN

/** Le NOMBRE d'IBAN valides du texte, dédoublonnés. */
export function countIbans(text: string): number {
  const out = new Set<string>()
  for (const m of Array.from(text.matchAll(IBAN_RE))) {
    if (isIban(m[0])) out.add(m[0].replace(/[ \u00a0]/g, '').toUpperCase())
  }
  return out.size
}

// ---------------------------------------------------------------- les cinq, ensemble

/** Les cinq détecteurs sur un mail. Toujours les cinq : un `non` est une réponse, pas un silence. */
export function detect(mail: MailForDetectors): Detection[] {
  const text = `${mail.subject ?? ''}\n${mail.text}`
  const count: Record<RuleQuestionId, number> = {
    telephone: countPhones(text),
    email_tiers: countThirdPartyEmails(text, [mail.fromAddress, ...(mail.recipients ?? [])]),
    iban: countIbans(text),
    carte_bancaire: countCards(text),
    secret_technique: countSecrets(text),
  }
  return RULE_QUESTIONS.map(q => ({ question: q.id, occurrences: count[q.id] }))
}

/** L'auteur d'une étiquette de détecteur : son id ET son nom sont l'id du détecteur (décision 23). */
export const detectorAuthor = (question: RuleQuestionId): { id: string; nom: string } => ({ id: question, nom: question })

/** La clé, dans `probabilites`, du nombre d'occurrences d'un détecteur — lue par l'infobulle. */
export const OCCURRENCES_KEY = 'occurrences'

/**
 * Une détection → l'étiquette à écrire. Le nombre d'occurrences voyage dans `probabilites`
 * (la colonne JSONB d'une étiquette, un objet {clé: nombre}) : un détecteur n'a pas de
 * distribution, c'est la seule chose qu'il y met, et jamais une valeur lue dans le mail.
 */
export const tagOf = (d: Detection): TagToWrite => ({
  question: d.question,
  valeur: d.occurrences > 0 ? NOUL_YES : NOUL_NO,
  probabilites: d.occurrences > 0 ? { [OCCURRENCES_KEY]: d.occurrences } : null,
  confiance: null,
})
