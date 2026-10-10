/**
 * Les identifiants STABLES d'un émetteur, lus dans un texte OCR (décision 5) : SIRET (14 chiffres,
 * clé de Luhn), n° de TVA intracommunautaire français (clé contrôlée), IBAN RÉDUIT (code banque +
 * 4 derniers caractères — jamais l'IBAN entier, comme `lib/tagging/fields.ts`), raison sociale de
 * l'en-tête (la première ligne de la première page qui porte une forme juridique) ; et, pour NOMMER
 * seulement (jamais appris), le nom d'organisme de l'en-tête (`organisationOf`).
 *
 * Module PUR : aucune base, aucun processus. Ce que l'OCR lit mal (un chiffre pour un autre) ne
 * passe pas les clés — c'est le but : un motif qui ne tient pas à un chiffre près ne vaut rien.
 */
import { IBAN_RE, isIban } from '../tagging/fields'
import type { PatternKind } from './model'

export interface Identifier { genre: PatternKind; valeur: string }

/** Les genres qui désignent UN émetteur à coup sûr : seuls eux rangent un document tout seuls. */
export const STRONG_KINDS: readonly PatternKind[] = ['siret', 'tva', 'iban4', 'regex']

const SIRET_RE = /\b\d{3}[ \u00a0]?\d{3}[ \u00a0]?\d{3}[ \u00a0]?\d{5}\b/g
const TVA_FR_RE = /\bFR[ \u00a0]?\d{2}[ \u00a0]?\d{3}[ \u00a0]?\d{3}[ \u00a0]?\d{3}\b/g
/** Les formes juridiques qui closent une raison sociale, en France et chez les fournisseurs étrangers courants. */
const LEGAL_FORM = String.raw`(?:S\.?A\.?S\.?U?|S\.?A\.?R\.?L\.?|E\.?U\.?R\.?L\.?|S\.?A\.?|S\.?C\.?I\.?|S\.?N\.?C\.?|SCOP|GIE|GmbH|AG|Ltd\.?|LLC|Inc\.?|Co\.?,? ?Ltd\.?|B\.?V\.?|S\.?p\.?A\.?|S\.?L\.?|S\.?r\.?l\.?)`
const RAISON_RE = new RegExp(String.raw`^\W*([\p{L}\p{N}][\p{L}\p{N}&'. -]{1,60}?\b${LEGAL_FORM})(?=$|[^\p{L}\p{N}])`, 'iu')
/** Une ligne d'en-tête plus longue est du corps de texte, pas un nom. */
const HEADER_MAX_LINE = 80
/**
 * Les mots qui font d'une ligne d'en-tête un NOM D'ORGANISME (comparés sans casse ni accents, mot
 * entier) — un courrier d'école ou un avis des Finances publiques n'a pas de forme juridique, mais
 * porte son nom en clair sur une des premières lignes (mesuré sur la vraie boîte).
 */
const ORGANISM_WORDS = ['lycée', 'collège', 'école', 'université', 'institut', 'académie', 'mairie', 'commune', 'ville de',
  'département', 'conseil', 'région', 'préfecture', 'hôpital', 'clinique', 'centre', 'caisse', 'banque', 'association',
  'fédération', 'syndicat', 'chambre', 'tribunal', 'finances publiques', 'trésor', 'urssaf', 'ministère', 'direction',
  'agence', 'office']
const ORGANISM_MAX_LINES = 25
const ORGANISM_MAX_NAME = 60
/** Un mot d'organisme suivi de « : » (« Banque : », « Agence : ») est l'ÉTIQUETTE d'un champ, pas un nom. */
const FIELD_LABEL_RE = /^[^\s:]*\s*:/

const digits = (s: string): string => s.replace(/\D/g, '')

/** Clé de Luhn sur une suite de chiffres (SIRET, SIREN). */
export function luhnOk(num: string): boolean {
  let sum = 0
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return num.length > 0 && sum % 10 === 0
}

/** La clé d'un n° de TVA FR à clé numérique : `(12 + 3 × (SIREN mod 97)) mod 97`. */
export function tvaFrOk(tva: string): boolean {
  const m = /^FR(\d{2})(\d{9})$/.exec(tva)
  return !!m && Number(m[1]) === (12 + 3 * (Number(m[2]) % 97)) % 97
}

export const siretsOf = (text: string): string[] =>
  uniq(Array.from(text.matchAll(SIRET_RE), m => digits(m[0])).filter(luhnOk))

export const tvasOf = (text: string): string[] =>
  uniq(Array.from(text.matchAll(TVA_FR_RE), m => m[0].replace(/[ \u00a0]/g, '').toUpperCase()).filter(tvaFrOk))

/** Le réduit d'un IBAN : code banque (5 caractères après le pays et la clé) + les 4 derniers, séparés d'un `…`. */
export const reducedIban = (iban: string): string => {
  const s = iban.replace(/[ \u00a0]/g, '').toUpperCase()
  return `${s.slice(4, 9)}…${s.slice(-4)}`
}

export const ibansOf = (text: string): string[] =>
  uniq(Array.from(text.matchAll(IBAN_RE), m => m[0]).filter(isIban).map(reducedIban))

/** La raison sociale de l'en-tête : la première ligne courte de la première page qui finit par une forme juridique. */
export function raisonSocialeOf(text: string): string | null {
  const firstPage = text.split('\f')[0] ?? ''
  for (const line of firstPage.split('\n')) {
    if (line.length > HEADER_MAX_LINE) continue
    const m = RAISON_RE.exec(line)
    if (m) return m[1].replace(/\s+/g, ' ').trim().toUpperCase()
  }
  return null
}

// `new RegExp(…, 'u')` et non des littéraux `/…/u` : la cible TypeScript du dépôt ne les accepte pas (comme `RAISON_RE`).
const MARKS_RE = new RegExp(String.raw`\p{M}`, 'gu')
const EDGE_PUNCT_RE = new RegExp(String.raw`^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$`, 'gu')
const LETTER_RE = new RegExp(String.raw`\p{L}`, 'gu')
/** Sans accents, sans casse, sans ponctuation de bord : ce qu'un mot vaut pour la comparaison. */
const fold = (word: string): string =>
  word.normalize('NFD').replace(MARKS_RE, '').toLowerCase().replace(EDGE_PUNCT_RE, '')
const ORGANISM_FOLDED = ORGANISM_WORDS.map(w => w.split(' ').map(fold))
const letterRatio = (word: string): number => (word.match(LETTER_RE)?.length ?? 0) / word.length

/**
 * Le nom d'organisme de l'en-tête : dans les premières lignes de la première page, la première qui
 * porte un mot d'organisme, lue À PARTIR de ce mot (le bruit OCR qui précède tombe), nettoyée des
 * jetons de fin qui ne sont pas des mots, en majuscules. Une ligne où le mot est suivi de « : »
 * (« Banque : BNP … » dans un bloc de règlement) est une étiquette de champ et ne compte pas.
 * Sert à NOMMER un dossier proposé, jamais à l'apprendre — l'identifiant appris reste `namerOf`.
 */
export function organisationOf(text: string): string | null {
  const firstPage = text.split('\f')[0] ?? ''
  const lines = firstPage.split('\n').map(l => l.trim()).filter(Boolean).slice(0, ORGANISM_MAX_LINES)
  for (const line of lines) {
    if (line.length > HEADER_MAX_LINE) continue
    const tokens = Array.from(line.matchAll(/\S+/g), m => ({ at: m.index, folded: fold(m[0]) }))
    let start = -1, last = -1
    for (let i = 0; i < tokens.length && start < 0; i++)
      for (const w of ORGANISM_FOLDED)
        if (w.every((part, k) => tokens[i + k]?.folded === part)) { start = i; last = i + w.length - 1; break }
    if (start < 0 || FIELD_LABEL_RE.test(line.slice(tokens[last].at))) continue
    const tail = line.slice(tokens[start].at).split(/\s+/)
    while (tail.length && letterRatio(tail[tail.length - 1]) < 0.5) tail.pop()
    const name = tail.join(' ').replace(EDGE_PUNCT_RE, '').toUpperCase().slice(0, ORGANISM_MAX_NAME).trim()
    if (name) return name
  }
  return null
}

/** L'identifiant qu'un dossier proposé APPREND (décision G4, mesurée — ne pas y toucher) : la raison sociale, sinon le premier identifiant fort. */
export const namerOf = (ids: Identifier[]): Identifier | undefined =>
  ids.find(i => i.genre === 'raison_sociale') ?? ids.find(i => STRONG_KINDS.includes(i.genre))

/** Le NOM du dossier proposé — jamais ce qu'il apprend : raison sociale, sinon nom d'organisme de l'en-tête, sinon « GENRE valeur ». */
export const proposedFolderName = (text: string, namer: Identifier): string =>
  namer.genre === 'raison_sociale' ? namer.valeur : organisationOf(text) ?? `${namer.genre.toUpperCase()} ${namer.valeur}`

/** Tous les identifiants d'un texte, prêts à être appris ou cherchés. */
export function identifiersOf(text: string): Identifier[] {
  const out: Identifier[] = []
  for (const valeur of siretsOf(text)) out.push({ genre: 'siret', valeur })
  for (const valeur of tvasOf(text)) out.push({ genre: 'tva', valeur })
  for (const valeur of ibansOf(text)) out.push({ genre: 'iban4', valeur })
  const raison = raisonSocialeOf(text)
  if (raison) out.push({ genre: 'raison_sociale', valeur: raison })
  return out
}

const uniq = (xs: string[]): string[] => Array.from(new Set(xs))
