/**
 * LE client du moteur de décision — un seul pour JEV et pour Yumi One.
 *
 * Les deux parlent le même protocole `/v1/systemone` (mesuré sur l'API réelle le
 * 22/09/2026, modèle jev-1.13.0) :
 *
 *   POST <url>   Authorization: Bearer <clé>
 *   { "model": "...", "state": {...}, "questions": { "<id>": {...} } }
 *   → { "model": "...", "answers": { "<id>": {...} }, "usage": { "input_tokens": n, "output_tokens": n } }
 *
 * Seules l'URL, la clé et le modèle changent d'un moteur à l'autre : c'est ce qui permet de
 * changer de moteur boîte par boîte, et de comparer les deux sur la même boîte.
 *
 * UNE requête par mail pour TOUTES les questions (fan-out) : l'état n'est lu qu'une fois
 * (mesuré : 1 question = 404 jetons, 3 questions sur le même état = 457 — « asking a question
 * you might not need is close to free »).
 *
 * LE MAIL EST UNE DONNÉE, JAMAIS UNE CONSIGNE. Son contenu ne va que dans `state` ; les
 * consignes viennent toutes de `./questions.ts`, qui n'en contient aucun octet. Et une réponse
 * n'est retenue que si elle nomme une valeur PRÉVUE (`isValidTag`) : un mail qui ferait
 * « répondre » autre chose au moteur produit un rejet, pas une étiquette. C'est cette
 * fermeture — pas un filtre sur le texte — qui rend l'injection inoffensive.
 */
import { messageText } from '../html'
import { NOUL_NO, NOUL_YES, engineQuestionsFor, isValidTag, posedQuestions, valuesOf, type TagQuestion } from './questions'

/**
 * Les sources d'une étiquette : le TYPE du moteur qui l'a produite (décision 13, donc `autre`
 * comprise), ou la main qui l'a écrite.
 */
export const TAG_SOURCES = ['jev', 'one', 'autre', 'humain', 'dossier'] as const
export type TagSource = (typeof TAG_SOURCES)[number]

/** La main qui valide. Écrite par une session humaine, jamais par une clé (décision 7). */
export const HUMAN_SOURCE: TagSource = 'humain'

/**
 * Les TYPES de moteur. `autre` (décision 13) couvre tout service qui parle le même protocole
 * `/v1/systemone` sans être ni JEV ni Yumi One : un moteur s'AJOUTE (table `decision_engines`),
 * il ne se choisit plus entre deux valeurs figées.
 */
export const ENGINES = ['jev', 'one', 'autre'] as const
export type EngineKind = (typeof ENGINES)[number]

/**
 * Ce qui PRÉREMPLIT le formulaire d'ajout d'un moteur — plus la configuration elle-même
 * (décision 13) : l'URL, le modèle et le prix réels vivent sur la ligne `decision_engines`,
 * que l'utilisateur peut modifier. 42 $ par milliard de jetons d'ENTRÉE pour JEV (tarif
 * publié, sortie gratuite) ; Yumi One tourne sur nos serveurs, donc rien à plafonner, et son
 * adresse n'est pas connue d'avance. C'est LA table des préréglages : aucun autre fichier
 * n'écrit un tarif ni une URL de moteur.
 */
export const ENGINE_PRESETS: Record<EngineKind, { url: string; model: string; usdPerBillionInput: number }> = {
  jev: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', usdPerBillionInput: 42 },
  one: { url: '', model: 'one-latest', usdPerBillionInput: 0 },
  autre: { url: '', model: '', usdPerBillionInput: 0 },
}

export const isEngineKind = (v: unknown): v is EngineKind => typeof v === 'string' && (ENGINES as readonly string[]).includes(v)

/**
 * La dépense se lit sur LE MOTEUR, pas sur le préréglage de son type (décision 13) : deux
 * moteurs `autre` peuvent avoir deux tarifs, et le tarif de JEV peut changer sans qu'on
 * redéploie. Le préréglage ne sert qu'à remplir ce champ à la création.
 */
export const costUsd = (usdPerBillionInput: number, inputTokens: number): number =>
  (inputTokens * usdPerBillionInput) / 1e9

/**
 * Ce qu'on envoie du mail, et rien d'autre : « include only the context relevant », et un
 * gros état chargé de détails inutiles dégrade la précision (« context rot »).
 */
export const STATE_BODY_CHARS = 1500

/**
 * Le coût supposé d'un mail tant qu'AUCUNE moyenne n'a été mesurée sur la boîte. Constante
 * documentée comme telle, et remplacée dès la première mesure : 5 018 jetons d'entrée en
 * moyenne, relevés sur 20 mails réels de nicolas@yumi-lab.com le 28/09/2026 avec les
 * 41 questions d'aujourd'hui (jev-1.13.0, lot T8, `.loop/t8-measure.out`), arrondis à
 * 5 000. La moyenne précédente (~1 600) portait sur 7 questions et sous-estimait d'un
 * facteur 3 l'estimation affichée avant le premier tri.
 */
export const ASSUMED_INPUT_TOKENS_PER_MAIL = 5000

export interface MailForState {
  fromName?: string
  fromAddress?: string
  subject?: string
  bodyPlain?: string
  bodyHtml?: string
}

/** L'état envoyé au moteur. `expediteur` est DÉCOMPOSÉ : `usurpation_expediteur` compare le nom au domaine. */
export interface EngineState {
  expediteur: { nom: string; adresse: string }
  objet: string
  corps: string
}

export function buildState(m: MailForState): EngineState {
  // `messageText` SANS `subject` : l'objet est un champ de l'état à part entière, le
  // recopier dans le corps quand le mail est vide le ferait compter deux fois.
  const body = messageText({ bodyPlain: m.bodyPlain, bodyHtml: m.bodyHtml }).replace(/\s+/g, ' ').trim()
  return {
    expediteur: { nom: (m.fromName ?? '').trim(), adresse: (m.fromAddress ?? '').trim() },
    objet: (m.subject ?? '').trim(),
    corps: body.slice(0, STATE_BODY_CHARS),
  }
}

export interface ParsedTag {
  question: string
  valeur: string
  probabilites: Record<string, number> | null
  confiance: number | null
}

export interface EngineResult {
  model: string
  tags: ParsedTag[]
  /** Les questions dont la réponse manquait ou nommait une valeur non prévue. */
  rejected: string[]
  inputTokens: number
}

export interface EngineConfig {
  url: string
  apiKey: string
  model: string
}

/**
 * Pourquoi le moteur a refusé.
 *  - `credit` (402) et `auth` (401/403) arrêtent le tri de la boîte PROPREMENT : les
 *    réessayer ne ferait que brûler des appels sans rien changer ;
 *  - `rate` (429, 529) passe son tour en respectant `retry-after` ;
 *  - `unavailable` (5xx, réseau) compte une erreur et continue ;
 *  - `rejected` (422 et le reste) : le moteur a refusé CE mail, son message est recopié.
 */
export type EngineFailure = 'credit' | 'auth' | 'rate' | 'unavailable' | 'rejected'

/**
 * Pourquoi le tri d'une boîte est en pause. `credit` et `auth` sont les deux refus du moteur
 * qui ne se réessaient pas (`EngineFailure`) ; `budget` est notre propre plafond ; `user` est
 * un clic ; `no_engine` dit qu'aucun moteur n'est choisi (décision 13 : sans moteur, ni tri en
 * masse ni au fil de l'eau). NULL en base = le tri est actif. La contrainte CHECK de
 * `mailbox_tagging` est écrite à partir de cette liste : un seul endroit les nomme.
 */
export const PAUSE_REASONS = ['user', 'budget', 'credit', 'auth', 'no_engine'] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

/** L'avancement d'un tri en masse. */
export const BULK_STATES = ['idle', 'running', 'done'] as const
export type BulkState = (typeof BULK_STATES)[number]

export class EngineError extends Error {
  kind: EngineFailure
  status: number | null
  /** Secondes à attendre, quand le service les annonce (`retry-after`). */
  retryAfter: number | null
  constructor(kind: EngineFailure, status: number | null, message: string, retryAfter: number | null = null) {
    super(message)
    this.name = 'EngineError'
    this.kind = kind
    this.status = status
    this.retryAfter = retryAfter
  }
}

/**
 * Le 402 n'est documenté NULLE PART : seul le contrat (§8.2(a)) dit qu'à solde nul TypeSafe
 * « may decline to generate Output », sans code HTTP. On traite donc aussi comme `credit`
 * tout refus dont le corps parle de crédit, de solde ou de balance — sinon un tri
 * continuerait à cogner une porte fermée jusqu'à épuiser le plafond en erreurs.
 */
const CREDIT_WORDS = /\b(credit|credits|solde|balance|insufficient funds|out of credit|quota exceeded)\b/i

export function failureOf(status: number, body = ''): EngineFailure {
  if (status === 402) return 'credit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status === 529) return 'rate'
  if (status >= 500) return 'unavailable'
  if (CREDIT_WORDS.test(body)) return 'credit'
  return 'rejected'
}

type RawAnswer = { choice?: unknown; score?: unknown; noul?: unknown; confidence?: unknown; probabilities?: unknown }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Une réponse du moteur → une étiquette, ou `null` si elle ne nomme rien de prévu. */
export function parseAnswer(q: TagQuestion, a: RawAnswer | undefined): ParsedTag | null {
  if (!a || typeof a !== 'object') return null
  const probs = a.probabilities && typeof a.probabilities === 'object' ? (a.probabilities as Record<string, unknown>) : null

  if (q.type === 'noul') {
    // La probabilité EST la réponse, PAS une confiance : un noul n'a pas de champ
    // `confidence`. La certitude est la DISTANCE au doute, donc 2 × |p − 0,5|.
    const p = num(a.noul)
    if (p === null || p < 0 || p > 1) return null
    return {
      question: q.id,
      valeur: p >= 0.5 ? NOUL_YES : NOUL_NO,
      probabilites: { [NOUL_YES]: p, [NOUL_NO]: 1 - p },
      confiance: 2 * Math.abs(p - 0.5),
    }
  }

  const values = valuesOf(q)
  if (q.type === 'score') {
    // Les niveaux reviennent par INDICE ("0", "1"…) : la légende du service n'est pas notre
    // vocabulaire. Retenu : le niveau le PLUS PROBABLE, jamais l'arrondi du score — un 1,5
    // arrondirait vers un niveau que le moteur n'a pas privilégié.
    const byValue: Record<string, number> = {}
    for (const [k, p] of Object.entries(probs ?? {})) {
      const i = Number(k)
      const value = Number.isInteger(i) ? values[i] : undefined
      const weight = num(p)
      if (value !== undefined && weight !== null) byValue[value] = weight
    }
    let best = Object.entries(byValue).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (best === undefined) {
      const s = num(a.score)
      if (s === null) return null
      const i = Math.round(s)
      if (!Number.isInteger(i) || values[i] === undefined) return null
      best = values[i]
    }
    return { question: q.id, valeur: best, probabilites: Object.keys(byValue).length ? byValue : null, confiance: num(a.confidence) }
  }

  // `choice` : la SEULE porte d'entrée est `isValidTag`. Une valeur inventée est rejetée.
  if (!isValidTag(q.id, a.choice)) return null
  const byValue: Record<string, number> = {}
  for (const [k, p] of Object.entries(probs ?? {})) {
    const weight = num(p)
    if (values.includes(k) && weight !== null) byValue[k] = weight
  }
  return { question: q.id, valeur: a.choice as string, probabilites: Object.keys(byValue).length ? byValue : null, confiance: num(a.confidence) }
}

/**
 * Ce qu'on retient d'une réponse, pour les questions POSÉES seulement : une question qu'on n'a
 * pas posée n'est ni rejetée ni stockée — la compter en rejet ferait lire un échec là où il n'y
 * a pas eu de demande.
 */
export function parseResponse(body: unknown, questionIds?: readonly string[]): EngineResult {
  const b = (body ?? {}) as { model?: unknown; answers?: Record<string, RawAnswer>; usage?: { input_tokens?: unknown } }
  const answers = b.answers && typeof b.answers === 'object' ? b.answers : {}
  const tags: ParsedTag[] = []
  const rejected: string[] = []
  for (const q of posedQuestions(questionIds)) {
    const tag = parseAnswer(q, answers[q.id])
    if (tag) tags.push(tag)
    else rejected.push(q.id)
  }
  return { model: typeof b.model === 'string' ? b.model : '', tags, rejected, inputTokens: num(b.usage?.input_tokens) ?? 0 }
}

const ENGINE_TIMEOUT_MS = 60_000
/** Ce qu'on recopie du message d'erreur du service : assez pour nommer le champ fautif d'un 422. */
const ERROR_BODY_CHARS = 500

const retryAfterOf = (res: Response): number | null => {
  const raw = res.headers.get('retry-after')
  const seconds = raw === null ? NaN : Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/**
 * UNE requête, toutes les questions — ou le sous-ensemble `questionIds`. Jette une
 * `EngineError` typée, jamais autre chose.
 */
export async function askEngine(cfg: EngineConfig, state: EngineState, questionIds?: readonly string[]): Promise<EngineResult> {
  const questions = engineQuestionsFor(questionIds)
  let res: Response
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    })
  } catch (err) {
    throw new EngineError('unavailable', null, String(err))
  }
  const text = await res.text()
  // Le service décrit ce qu'il refuse (un 422 NOMME le champ fautif) : on recopie son message
  // tel quel plutôt que d'en écrire un qui perdrait cette précision.
  if (!res.ok) throw new EngineError(failureOf(res.status, text), res.status, text.slice(0, ERROR_BODY_CHARS), retryAfterOf(res))
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new EngineError('rejected', res.status, 'unreadable engine response')
  }
  const parsed = parseResponse(body, questionIds)
  return { ...parsed, model: parsed.model || cfg.model }
}
