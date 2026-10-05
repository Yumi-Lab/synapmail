/**
 * Les identifiants STABLES d'un émetteur, lus dans un texte OCR (décision 5) : SIRET (14 chiffres,
 * clé de Luhn), n° de TVA intracommunautaire français (clé contrôlée), IBAN RÉDUIT (code banque +
 * 4 derniers caractères — jamais l'IBAN entier, comme `lib/tagging/fields.ts`), raison sociale de
 * l'en-tête (la première ligne de la première page qui porte une forme juridique).
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
const RAISON_MAX_LINE = 80

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
    if (line.length > RAISON_MAX_LINE) continue
    const m = RAISON_RE.exec(line)
    if (m) return m[1].replace(/\s+/g, ' ').trim().toUpperCase()
  }
  return null
}

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
