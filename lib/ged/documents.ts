/**
 * Ce que l'API agents (lot G5, décision 7) et l'écran (G6) LISENT et TAILLENT d'une boîte GED :
 * la liste des documents (par dossier, « à ranger », recherche plein texte), le détail d'un
 * document, l'arbre des dossiers virtuels, les motifs appris, les identifiants propres de la boîte.
 *
 * Rien ici ne range (c'est `./filing.ts`) ni n'océrise (`./ocr.ts`). Tout est scopé par la boîte :
 * chaque requête porte `account_id`, et un identifiant d'une autre boîte ne rend rien. Une entrée
 * refusée jette `GedInputError` avec le statut HTTP qui lui revient — la route la relaie telle quelle.
 */
import { query } from '../db'
import { EFFECTIVE_ORDER } from '../tagging/store'
import { boundedRegex } from '../rulesEval'
import { isIban } from '../tagging/fields'
import { PATTERN_KINDS, type FilingSource, type PatternKind } from './model'
import { luhnOk, reducedIban, tvaFrOk, type Identifier } from './patterns'

/**
 * La boîte d'un objet GED, par son identifiant — LES requêtes que la barrière par clé
 * (`ACCOUNT_BY_OBJECT`, `lib/apiKeyAccounts.ts`) et les routes `/api/documents/*` lisent toutes deux :
 * une seule source, sinon la barrière et la route pourraient répondre deux boîtes différentes.
 */
/** Un identifiant d'objet est un UUID : tout le reste (`unfiled`, `run`, une faute de frappe) n'en désigne aucun — plutôt qu'un 500 de Postgres. */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)

export const ACCOUNT_OF_DOCUMENT = 'SELECT account_id AS id FROM ged_documents WHERE id = $1'
export const ACCOUNT_OF_FOLDER = 'SELECT account_id AS id FROM ged_folders WHERE id = $1'
export const ACCOUNT_OF_PATTERN = 'SELECT f.account_id AS id FROM ged_patterns p JOIN ged_folders f ON f.id = p.folder_id WHERE p.id = $1'

export class GedInputError extends Error {
  status: number
  extra: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message); this.name = 'GedInputError'; this.status = status; this.extra = extra
  }
}

/** Le dossier EFFECTIF de chaque document (décision 4), en une sous-requête réutilisable. */
const EFFECTIVE_FILINGS = `
  SELECT DISTINCT ON (document_id) document_id, folder_id, source, auteur_nom, confiance, cree_le
    FROM ged_filings ORDER BY document_id, ${EFFECTIVE_ORDER}`

export const DOCUMENTS_PER_PAGE = 50
export const DOCUMENTS_PER_PAGE_MAX = 200
/** La valeur de `folder` qui veut dire « À ranger » : les documents sans dossier effectif. */
export const UNFILED = 'unfiled'
/** Le nom le plus long d'un dossier, le même que la colonne (`VARCHAR(120)`). */
export const FOLDER_NAME_MAX = 120

export interface GedDocumentSummary {
  id: string
  messageId: string
  folder: string
  uid: number
  partIdx: number
  filename: string
  fromAddress: string
  fromName: string
  subject: string
  recuLe: Date | null
  pages: number
  ocrStatus: string
  ocrError: string | null
  confiance: number | null
  folderId: string | null
  filingSource: FilingSource | null
}

const toSummary = (r: Record<string, unknown>): GedDocumentSummary => ({
  id: r.id as string, messageId: r.message_id as string, folder: r.folder as string, uid: r.uid as number,
  partIdx: r.part_idx as number, filename: r.filename as string, fromAddress: r.from_address as string,
  fromName: r.from_name as string, subject: r.subject as string, recuLe: r.recu_le as Date | null,
  pages: r.pages as number, ocrStatus: r.ocr_status as string, ocrError: r.ocr_error as string | null,
  confiance: r.confiance as number | null, folderId: (r.folder_id as string | null) ?? null,
  filingSource: (r.filing_source as FilingSource | null) ?? null,
})

/**
 * Les documents d'une boîte, du plus récent au plus ancien. `folder` = un dossier (ses documents
 * effectifs), `UNFILED` (sans dossier effectif), ou rien (tous). `q` cherche dans le texte OCR
 * (tsvector français, syntaxe « web » : mots, guillemets, `-mot`).
 */
export async function listDocuments(params: {
  accountId: string; folder?: string | null; q?: string | null; page?: number; perPage?: number
}): Promise<{ documents: GedDocumentSummary[]; total: number; page: number; perPage: number }> {
  const perPage = Math.min(Math.max(params.perPage ?? DOCUMENTS_PER_PAGE, 1), DOCUMENTS_PER_PAGE_MAX)
  const page = Math.max(params.page ?? 1, 1)
  const folder = params.folder || null
  const q = params.q?.trim() || null
  const rows = await query<Record<string, unknown> & { total: string }>(
    `WITH eff AS (${EFFECTIVE_FILINGS})
     SELECT d.id, d.message_id, d.folder, d.uid, d.part_idx, d.filename, d.from_address, d.from_name, d.subject,
            d.recu_le, d.pages, d.ocr_status, d.ocr_error, d.confiance, eff.folder_id, eff.source AS filing_source,
            COUNT(*) OVER () AS total
       FROM ged_documents d LEFT JOIN eff ON eff.document_id = d.id
      WHERE d.account_id = $1
        AND ($2::text IS NULL OR ($2 = $6 AND eff.folder_id IS NULL) OR eff.folder_id::text = $2)
        AND ($3::text IS NULL OR d.texte_tsv @@ websearch_to_tsquery('french', $3))
      ORDER BY d.recu_le DESC NULLS LAST, d.uid DESC, d.part_idx
      LIMIT $4 OFFSET $5`,
    [params.accountId, folder, q, perPage, (page - 1) * perPage, UNFILED]
  )
  return { documents: rows.map(toSummary), total: rows.length ? Number(rows[0].total) : 0, page, perPage }
}

export interface GedDocumentDetail extends GedDocumentSummary {
  ocrText: string
  pageTexts: Array<{ index: number; text: string; confidence: number; blank: boolean }> | null
  /** Le `Message-ID` sous lequel ses étiquettes et valeurs sont stockées (`documentMessageId`). */
  tagMessageId: string
  filings: Array<{ id: string; folderId: string | null; source: FilingSource; auteurId: string; auteurNom: string; confiance: number | null; creeLe: Date }>
}

/** Un document avec son texte, ses pages et son historique de rangement — `null` s'il n'est pas de cette boîte. */
export async function getDocument(accountId: string, id: string): Promise<GedDocumentDetail | null> {
  const [r] = await query<Record<string, unknown>>(
    `WITH eff AS (${EFFECTIVE_FILINGS})
     SELECT d.*, eff.folder_id, eff.source AS filing_source,
            (SELECT COUNT(*) FROM ged_documents s WHERE s.account_id = d.account_id AND s.message_id = d.message_id)::int AS parts
       FROM ged_documents d LEFT JOIN eff ON eff.document_id = d.id
      WHERE d.account_id = $1 AND d.id = $2`, [accountId, id])
  if (!r) return null
  const filings = await query<{ id: string; folder_id: string | null; source: FilingSource; auteur_id: string; auteur_nom: string; confiance: number | null; cree_le: Date }>(
    `SELECT id, folder_id, source, auteur_id, auteur_nom, confiance, cree_le FROM ged_filings WHERE document_id = $1 ORDER BY ${EFFECTIVE_ORDER}`, [id])
  const parts = r.parts as number
  return {
    ...toSummary(r),
    ocrText: r.ocr_text as string,
    pageTexts: (r.page_texts as GedDocumentDetail['pageTexts']) ?? null,
    tagMessageId: parts > 1 ? `${r.message_id as string}#p${r.part_idx as number}` : (r.message_id as string),
    filings: filings.map(f => ({ id: String(f.id), folderId: f.folder_id, source: f.source, auteurId: f.auteur_id, auteurNom: f.auteur_nom, confiance: f.confiance, creeLe: f.cree_le })),
  }
}

/** La position IMAP d'un document, pour relire son PDF — `null` s'il n'est pas de cette boîte. */
export const documentPlace = async (accountId: string, id: string): Promise<{ folder: string; uid: number; part_idx: number; filename: string; pages: number } | undefined> =>
  (await query<{ folder: string; uid: number; part_idx: number; filename: string; pages: number }>(
    `SELECT folder, uid, part_idx, filename, pages FROM ged_documents WHERE account_id = $1 AND id = $2`, [accountId, id]))[0]

// ---- dossiers ------------------------------------------------------------------------------

export interface GedFolder {
  id: string
  parentId: string | null
  nom: string
  position: number
  auto: boolean
  creeLe: Date
  /** Documents dont c'est le dossier EFFECTIF (pas les sous-dossiers). */
  documents: number
  patterns: number
}

type FolderRow = { id: string; parent_id: string | null; nom: string; position: number; auto: boolean; cree_le: Date; documents: string; patterns: string }
const toFolder = (r: FolderRow): GedFolder => ({
  id: r.id, parentId: r.parent_id, nom: r.nom, position: r.position, auto: r.auto, creeLe: r.cree_le,
  documents: Number(r.documents), patterns: Number(r.patterns),
})

/** L'arbre d'une boîte, À PLAT (parentId dit la place) : l'appelant l'imbrique s'il en a besoin. */
export async function listFolders(accountId: string): Promise<GedFolder[]> {
  const rows = await query<FolderRow>(
    `WITH eff AS (${EFFECTIVE_FILINGS})
     SELECT f.id, f.parent_id, f.nom, f.position, f.auto, f.cree_le,
            (SELECT COUNT(*) FROM eff WHERE eff.folder_id = f.id) AS documents,
            (SELECT COUNT(*) FROM ged_patterns p WHERE p.folder_id = f.id) AS patterns
       FROM ged_folders f WHERE f.account_id = $1
      ORDER BY f.parent_id NULLS FIRST, f.position, f.nom`, [accountId])
  return rows.map(toFolder)
}

/** Le nombre de documents sans dossier effectif (« À ranger »). */
export async function unfiledCount(accountId: string): Promise<number> {
  const [r] = await query<{ n: string }>(
    `WITH eff AS (${EFFECTIVE_FILINGS})
     SELECT COUNT(*) AS n FROM ged_documents d LEFT JOIN eff ON eff.document_id = d.id
      WHERE d.account_id = $1 AND eff.folder_id IS NULL`, [accountId])
  return Number(r.n)
}

const folderOf = async (accountId: string, id: unknown): Promise<FolderRow | undefined> =>
  isUuid(id) ? (await query<FolderRow>(`SELECT *, 0 AS documents, 0 AS patterns FROM ged_folders WHERE account_id = $1 AND id = $2`, [accountId, id]))[0] : undefined

function cleanName(nom: unknown): string {
  const s = typeof nom === 'string' ? nom.trim().replace(/\s+/g, ' ') : ''
  if (!s) throw new GedInputError(400, 'nom required')
  if (s.length > FOLDER_NAME_MAX) throw new GedInputError(400, `nom longer than ${FOLDER_NAME_MAX} characters`, { nom: s })
  return s
}

/** Le parent demandé existe dans la boîte, sinon 404 qui le nomme. `null` = la racine. */
async function checkParent(accountId: string, parentId: unknown): Promise<string | null> {
  if (parentId === undefined || parentId === null || parentId === '') return null
  if (typeof parentId !== 'string') throw new GedInputError(400, 'parentId must be a string or null')
  if (!(await folderOf(accountId, parentId))) throw new GedInputError(404, `parent folder not found: ${parentId}`, { parentId })
  return parentId
}

/** `candidate` est-il `folderId` lui-même ou l'un de ses descendants ? (Un dossier ne se met pas sous lui-même.) */
async function isSelfOrDescendant(folderId: string, candidate: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `WITH RECURSIVE sub AS (SELECT id FROM ged_folders WHERE id = $1
       UNION ALL SELECT f.id FROM ged_folders f JOIN sub ON f.parent_id = sub.id)
     SELECT id FROM sub WHERE id = $2`, [folderId, candidate])
  return rows.length > 0
}

/** Deux frères ne portent pas le même nom (contrainte de la table) : le dire en 409 plutôt qu'en 500. */
const siblingClash = (err: unknown): boolean => (err as { code?: string })?.code === '23505'

export async function createFolder(accountId: string, input: { nom?: unknown; parentId?: unknown }): Promise<GedFolder> {
  const nom = cleanName(input.nom)
  const parentId = await checkParent(accountId, input.parentId)
  try {
    const [r] = await query<FolderRow>(
      `INSERT INTO ged_folders (account_id, parent_id, nom) VALUES ($1, $2, $3) RETURNING *, 0 AS documents, 0 AS patterns`,
      [accountId, parentId, nom])
    return toFolder(r)
  } catch (err) {
    if (siblingClash(err)) throw new GedInputError(409, `a folder named "${nom}" already exists at that place`, { nom, parentId })
    throw err
  }
}

/** Renommer et/ou déplacer. Un dossier PROPOSÉ (`auto`) qu'une main touche cesse d'être proposé. */
export async function updateFolder(accountId: string, id: string, input: { nom?: unknown; parentId?: unknown }): Promise<GedFolder> {
  const current = await folderOf(accountId, id)
  if (!current) throw new GedInputError(404, 'folder not found', { id })
  const nom = input.nom === undefined ? current.nom : cleanName(input.nom)
  let parentId = current.parent_id
  if (input.parentId !== undefined) {
    parentId = await checkParent(accountId, input.parentId)
    if (parentId && await isSelfOrDescendant(id, parentId)) throw new GedInputError(409, 'a folder cannot be moved under itself', { id, parentId })
  }
  try {
    const [r] = await query<FolderRow>(
      `UPDATE ged_folders SET nom = $3, parent_id = $4, auto = false WHERE account_id = $1 AND id = $2 RETURNING *, 0 AS documents, 0 AS patterns`,
      [accountId, id, nom, parentId])
    return toFolder(r)
  } catch (err) {
    if (siblingClash(err)) throw new GedInputError(409, `a folder named "${nom}" already exists at that place`, { nom, parentId })
    throw err
  }
}

/**
 * Supprime un dossier et ses sous-dossiers (cascade de la table). Ses rangements et motifs partent
 * avec lui : les documents qu'il tenait retombent dans « À ranger » — les documents eux-mêmes restent.
 */
export async function deleteFolder(accountId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>(`DELETE FROM ged_folders WHERE account_id = $1 AND id = $2 RETURNING id`, [accountId, id])
  if (!rows.length) throw new GedInputError(404, 'folder not found', { id })
}

// ---- motifs --------------------------------------------------------------------------------

export interface GedPattern extends Identifier {
  id: string
  folderId: string
  apprisDe: string | null
  auteurNom: string
  touches: number
  creeLe: Date
}

type PatternRow = { id: string; folder_id: string; genre: PatternKind; valeur: string; appris_de: string | null; auteur_nom: string; touches: number; cree_le: Date }
const toPattern = (r: PatternRow): GedPattern => ({
  id: r.id, folderId: r.folder_id, genre: r.genre, valeur: r.valeur, apprisDe: r.appris_de, auteurNom: r.auteur_nom, touches: r.touches, creeLe: r.cree_le,
})

export async function listPatterns(accountId: string, folderId?: string | null): Promise<GedPattern[]> {
  if (folderId && !isUuid(folderId)) throw new GedInputError(400, 'folder must be a folder id', { folder: folderId })
  const rows = await query<PatternRow>(
    `SELECT p.* FROM ged_patterns p JOIN ged_folders f ON f.id = p.folder_id
      WHERE f.account_id = $1 AND ($2::uuid IS NULL OR p.folder_id = $2)
      ORDER BY p.folder_id, p.genre, p.valeur`, [accountId, folderId || null])
  return rows.map(toPattern)
}

/** Les genres qu'une boîte peut déclarer comme SIENS : ceux imprimés sur une facture reçue en tant que client. */
export const OWN_KINDS: readonly PatternKind[] = ['siret', 'tva', 'iban4']

/**
 * Un identifiant tel qu'un agent ou une main le saisit, NORMALISÉ et CONTRÔLÉ comme l'OCR l'aurait
 * été (`./patterns.ts`) : un SIRET sans clé de Luhn, une TVA sans clé, une regex invalide ou trop
 * longue sont refusés en 422 ; un IBAN entier est RÉDUIT avant d'entrer (jamais stocké en clair).
 */
export function normalizeIdentifier(input: { genre?: unknown; valeur?: unknown }, allowed: readonly PatternKind[] = PATTERN_KINDS): Identifier {
  const genre = input.genre as PatternKind
  if (typeof genre !== 'string' || !allowed.includes(genre)) {
    throw new GedInputError(422, `genre must be one of ${allowed.join(', ')}`, { genre: genre ?? null })
  }
  const raw = typeof input.valeur === 'string' ? input.valeur.trim() : ''
  if (!raw) throw new GedInputError(422, 'valeur required', { genre })
  const refuse = (why: string): never => { throw new GedInputError(422, `invalid ${genre}: ${why}`, { genre, valeur: raw }) }
  switch (genre) {
    case 'siret': { const d = raw.replace(/[ \u00a0]/g, ''); if (!/^\d{14}$/.test(d) || !luhnOk(d)) refuse('14 digits with a valid Luhn key expected'); return { genre, valeur: d } }
    case 'tva': { const v = raw.replace(/[ \u00a0]/g, '').toUpperCase(); if (!tvaFrOk(v)) refuse('FR + 2-digit key + SIREN expected, key checked'); return { genre, valeur: v } }
    case 'iban4': {
      if (/^[A-Z0-9]{5}…[A-Z0-9]{4}$/.test(raw)) return { genre, valeur: raw }
      if (!isIban(raw.replace(/[ \u00a0]/g, ''))) refuse('a full IBAN (reduced on entry) or an already reduced one (bank…last4) expected')
      return { genre, valeur: reducedIban(raw) }
    }
    case 'regex': if (!boundedRegex(raw)) refuse('empty, too long or not a valid regular expression'); return { genre, valeur: raw }
    case 'raison_sociale': return { genre, valeur: raw.replace(/\s+/g, ' ').toUpperCase().slice(0, FOLDER_NAME_MAX) }
  }
}

/** Pose un motif à la main ou par un agent — déjà là = laissé tel quel (comme l'apprentissage). */
export async function createPattern(accountId: string, input: { folderId?: unknown; genre?: unknown; valeur?: unknown }, author: { id: string; nom: string }): Promise<GedPattern> {
  if (typeof input.folderId !== 'string' || !(await folderOf(accountId, input.folderId))) {
    throw new GedInputError(404, 'folder not found', { folderId: input.folderId ?? null })
  }
  const { genre, valeur } = normalizeIdentifier(input)
  const [r] = await query<PatternRow>(
    `INSERT INTO ged_patterns (folder_id, genre, valeur, auteur_id, auteur_nom) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (folder_id, genre, valeur) DO UPDATE SET valeur = EXCLUDED.valeur RETURNING *`,
    [input.folderId, genre, valeur, author.id, author.nom])
  return toPattern(r)
}

export async function deletePattern(accountId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>(
    `DELETE FROM ged_patterns p USING ged_folders f WHERE f.id = p.folder_id AND f.account_id = $1 AND p.id = $2 RETURNING p.id`, [accountId, id])
  if (!rows.length) throw new GedInputError(404, 'pattern not found', { id })
}

// ---- identifiants propres de la boîte ------------------------------------------------------

export async function readOwnIdentifiers(accountId: string): Promise<Identifier[]> {
  const [r] = await query<{ propres: Identifier[] }>(`SELECT propres FROM ged_mailboxes WHERE account_id = $1`, [accountId])
  return r?.propres ?? []
}

/** Remplace la liste entière (une liste vide la vide). La boîte doit être déclarée GED. */
export async function writeOwnIdentifiers(accountId: string, input: unknown): Promise<Identifier[]> {
  if (!Array.isArray(input)) throw new GedInputError(400, 'propres must be an array of { genre, valeur }')
  const seen = new Set<string>()
  const propres = input.map(i => normalizeIdentifier(i as { genre?: unknown; valeur?: unknown }, OWN_KINDS))
    .filter(i => { const k = `${i.genre}:${i.valeur}`; if (seen.has(k)) return false; seen.add(k); return true })
  const rows = await query<{ account_id: string }>(
    `UPDATE ged_mailboxes SET propres = $2::jsonb WHERE account_id = $1 RETURNING account_id`, [accountId, JSON.stringify(propres)])
  if (!rows.length) throw new GedInputError(409, 'mailbox is not a GED', { accountId })
  return propres
}
