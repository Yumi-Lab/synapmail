/**
 * Le RANGEMENT d'un document GED et les MOTIFS qu'on en apprend (décisions 3-5).
 *
 *  1. **Ranger = une nouvelle ligne** `ged_filings` (jamais un UPDATE) : l'historique reste et
 *     l'effectif se lit « humain d'abord, puis le plus récent » — le MÊME `EFFECTIVE_ORDER` que
 *     `message_tags`, pas une copie.
 *  2. **Apprendre** : un rangement par une main ou un agent lit les identifiants du texte OCR
 *     (`./patterns.ts`) et les écrit dans `ged_patterns` pour ce dossier. Un rangement par motif
 *     ou par le moteur n'apprend RIEN (il ne ferait que se confirmer lui-même).
 *  3. **Ranger seul** (`source=motif`) : les motifs d'un document désignent UN seul dossier avec
 *     au moins un genre FORT (SIRET, TVA, IBAN réduit, regex). Deux dossiers, ou seulement une
 *     raison sociale : le document reste « À ranger » et ses dossiers candidats deviennent ses
 *     suggestions (calculées à la lecture, jamais stockées).
 *  4. **Les identifiants PROPRES de la boîte** (`ged_mailboxes.propres`) — ceux du destinataire (TVA,
 *     SIRET, IBAN réduit), imprimés sur toute facture reçue — ne sont ni appris ni cherchés : mesuré
 *     sur la vraie boîte, la TVA du destinataire rangeait sinon un courrier d'école dans le dossier
 *     FedEx, et l'IBAN du groupe (sur les factures ET les demandes de RIB) faisait de même. Liste
 *     explicite (API G5, écran G6) ; pas de détection automatique : un identifiant vu dans deux
 *     dossiers est aussi le cas « doute » légitime de la décision 5.
 *  5. **Émetteur inconnu** : un document sans motif connu mais qui porte une raison sociale ou un
 *     identifiant fort reçoit un dossier PROPOSÉ (`auto=true`) sous « Nouveaux émetteurs », nommé
 *     par la raison sociale — à défaut par l'identifiant (« SIRET 196… » : un courrier d'école n'a
 *     pas de forme juridique en en-tête, mesuré sur la vraie boîte) —, rangé en `source=motif` à
 *     confiance basse. Il n'apprend QUE l'identifiant qui le nomme : personne n'a validé ce dossier,
 *     et apprendre tout le document lui donnait aussi les identifiants du destinataire oubliés de
 *     `propres` (mesuré : l'IBAN du groupe appris par le dossier d'une école y rangeait une facture
 *     FedEx). Nommé par un SIRET, le second envoi le rejoint par motif ; nommé par une raison sociale
 *     (faible), il n'est que suggéré jusqu'à un rangement humain ou agent, qui apprend le reste.
 *     À renommer ou déplacer, jamais effacé par la chaîne.
 */
import { query } from '../db'
import { EFFECTIVE_ORDER } from '../tagging/store'
import { HUMAN_SOURCE } from '../tagging/engine'
import { boundedRegex } from '../rulesEval'
import type { FilingSource, PatternKind } from './model'
import { identifiersOf, STRONG_KINDS, type Identifier } from './patterns'

/** Le dossier racine qui reçoit les dossiers proposés pour un émetteur inconnu (décision 3). */
export const AUTO_ROOT_NAME = 'Nouveaux émetteurs'
/** La confiance d'un rangement par motif fort (une clé contrôlée ne ment pas), et celle d'un dossier proposé. */
export const PATTERN_CONFIDENCE = 0.95
export const PROPOSED_CONFIDENCE = 0.5
/** Qui signe les lignes posées par la chaîne elle-même. */
export const PATTERN_AUTHOR = { id: '', nom: 'motif' }

export interface Author { id: string; nom: string }

export interface FilingRow {
  id: string
  document_id: string
  folder_id: string | null
  source: FilingSource
  auteur_id: string
  auteur_nom: string
  confiance: number | null
  cree_le: Date
}

export interface PatternRow {
  id: string
  folder_id: string
  genre: PatternKind
  valeur: string
  touches: number
}

export interface Suggestion { folderId: string; genres: PatternKind[]; patternIds: string[]; strong: boolean }

export interface AutoFileOutcome {
  /** `motif` : rangé par un motif connu ; `propose` : dossier créé pour un émetteur inconnu ; `doute` : 2+ candidats ou motif faible seul ; `aucun` : rien à lire. */
  kind: 'motif' | 'propose' | 'doute' | 'aucun'
  folderId: string | null
  suggestions: Suggestion[]
}

const docText = async (documentId: string): Promise<{ account_id: string; ocr_text: string } | undefined> =>
  (await query<{ account_id: string; ocr_text: string }>(`SELECT account_id, ocr_text FROM ged_documents WHERE id = $1`, [documentId]))[0]

/** Les identifiants du texte MOINS ceux de la boîte elle-même. */
async function emitterIdentifiers(accountId: string, text: string): Promise<Identifier[]> {
  const [box] = await query<{ propres: Identifier[] }>(`SELECT propres FROM ged_mailboxes WHERE account_id = $1`, [accountId])
  const own = new Set((box?.propres ?? []).map(i => `${i.genre}:${i.valeur}`))
  return identifiersOf(text).filter(i => !own.has(`${i.genre}:${i.valeur}`))
}

/** Le dossier effectif d'un document (NULL si aucun, ou si le dernier rangement humain l'a sorti). */
export async function effectiveFiling(documentId: string): Promise<FilingRow | null> {
  const rows = await query<FilingRow>(
    `SELECT * FROM ged_filings WHERE document_id = $1 ORDER BY ${EFFECTIVE_ORDER} LIMIT 1`, [documentId])
  return rows[0] ?? null
}

/**
 * Range un document (nouvelle ligne) ; une main ou un agent apprend au passage les identifiants
 * du texte OCR pour le dossier choisi. `folderId` NULL = sortir de tout dossier (rien n'est appris).
 */
export async function fileDocument(params: {
  documentId: string
  folderId: string | null
  source: FilingSource
  author: Author
  confidence?: number | null
}): Promise<{ filing: FilingRow; learned: Identifier[] }> {
  const { documentId, folderId, source, author } = params
  const [filing] = await query<FilingRow>(
    `INSERT INTO ged_filings (document_id, folder_id, source, auteur_id, auteur_nom, confiance)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [documentId, folderId, source, author.id, author.nom, params.confidence ?? null]
  )
  const learns = folderId && (source === HUMAN_SOURCE || source === 'agent')
  const learned = learns ? await learnPatterns(documentId, folderId, author) : []
  return { filing, learned }
}

/**
 * Écrit dans `ged_patterns` les identifiants du document pour ce dossier (déjà là = laissé tel quel) —
 * tous ceux de l'émetteur, ou seulement `only` (le dossier proposé n'apprend que son nom).
 */
export async function learnPatterns(documentId: string, folderId: string, author: Author, only?: Identifier[]): Promise<Identifier[]> {
  const doc = await docText(documentId)
  if (!doc) return []
  const ids = only ?? await emitterIdentifiers(doc.account_id, doc.ocr_text)
  for (const { genre, valeur } of ids) {
    await query(
      `INSERT INTO ged_patterns (folder_id, genre, valeur, appris_de, auteur_id, auteur_nom)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (folder_id, genre, valeur) DO NOTHING`,
      [folderId, genre, valeur, documentId, author.id, author.nom]
    )
  }
  return ids
}

/**
 * Les dossiers que les motifs connus de la boîte désignent pour ce texte, du plus sûr au moins
 * sûr : un dossier est FORT s'il tient par un SIRET, une TVA, un IBAN réduit ou une regex.
 */
export async function suggestionsFor(accountId: string, text: string): Promise<Suggestion[]> {
  const ids = await emitterIdentifiers(accountId, text)
  const patterns = await query<PatternRow>(
    `SELECT p.id, p.folder_id, p.genre, p.valeur, p.touches FROM ged_patterns p
       JOIN ged_folders f ON f.id = p.folder_id WHERE f.account_id = $1`, [accountId])
  const byFolder = new Map<string, PatternRow[]>()
  for (const p of patterns) {
    const hit = p.genre === 'regex'
      ? boundedRegex(p.valeur)?.test(text) ?? false
      : ids.some(i => i.genre === p.genre && i.valeur === p.valeur)
    if (hit) byFolder.set(p.folder_id, [...(byFolder.get(p.folder_id) ?? []), p])
  }
  return Array.from(byFolder, ([folderId, hits]) => {
    const genres = Array.from(new Set(hits.map(h => h.genre)))
    return { folderId, genres, patternIds: hits.map(h => h.id), strong: genres.some(g => STRONG_KINDS.includes(g)) }
  }).sort((a, b) => Number(b.strong) - Number(a.strong) || b.genres.length - a.genres.length)
}

/** Le dossier « Nouveaux émetteurs » de la boîte, créé au premier besoin. */
async function autoRoot(accountId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO ged_folders (account_id, parent_id, nom, auto) VALUES ($1, NULL, $2, true)
     ON CONFLICT (account_id, parent_id, nom) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [accountId, AUTO_ROOT_NAME])
  return rows[0].id
}

/**
 * Le rangement AUTOMATIQUE d'un document fraîchement océrisé (appelé par la chaîne de réception) :
 * un seul dossier fort → `motif` ; aucun motif mais une raison sociale → dossier proposé ;
 * sinon le document reste « À ranger » avec ses suggestions. Un document déjà rangé n'est pas touché.
 */
export async function autoFile(documentId: string): Promise<AutoFileOutcome> {
  const doc = await docText(documentId)
  if (!doc || !doc.ocr_text) return { kind: 'aucun', folderId: null, suggestions: [] }
  if (await effectiveFiling(documentId)) return { kind: 'aucun', folderId: null, suggestions: [] }

  const suggestions = await suggestionsFor(doc.account_id, doc.ocr_text)
  const strong = suggestions.filter(s => s.strong)
  if (strong.length === 1) {
    await fileDocument({ documentId, folderId: strong[0].folderId, source: 'motif', author: PATTERN_AUTHOR, confidence: PATTERN_CONFIDENCE })
    await query(`UPDATE ged_patterns SET touches = touches + 1 WHERE id = ANY($1::uuid[])`, [strong[0].patternIds])
    return { kind: 'motif', folderId: strong[0].folderId, suggestions }
  }
  if (suggestions.length) return { kind: 'doute', folderId: null, suggestions }

  const ids = await emitterIdentifiers(doc.account_id, doc.ocr_text)
  const namer = ids.find(i => i.genre === 'raison_sociale') ?? ids.find(i => STRONG_KINDS.includes(i.genre))
  if (!namer) return { kind: 'aucun', folderId: null, suggestions }
  const nom = namer.genre === 'raison_sociale' ? namer.valeur : `${namer.genre.toUpperCase()} ${namer.valeur}`
  const root = await autoRoot(doc.account_id)
  const [folder] = await query<{ id: string }>(
    `INSERT INTO ged_folders (account_id, parent_id, nom, auto) VALUES ($1, $2, $3, true)
     ON CONFLICT (account_id, parent_id, nom) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [doc.account_id, root, nom.slice(0, 120)])
  await learnPatterns(documentId, folder.id, PATTERN_AUTHOR, [namer])
  await fileDocument({ documentId, folderId: folder.id, source: 'motif', author: PATTERN_AUTHOR, confidence: PROPOSED_CONFIDENCE })
  return { kind: 'propose', folderId: folder.id, suggestions }
}
