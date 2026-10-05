/**
 * Vocabulaire du modèle GED (décisions 3-5) : les listes que `lib/db.ts` pose en CHECK et que la
 * chaîne (G3), le rangement (G4) et l'API (G5) écrivent. Module PUR — aucun import de l'OCR
 * (`./ocr.ts` lance des processus) pour pouvoir être lu depuis un composant client.
 */
import { HUMAN_SOURCE } from '@/lib/tagging/engine'

/** L'état de l'OCR d'un document : en attente, fait, ou en échec (`ocr_error` dit pourquoi). */
export const OCR_STATUSES = ['attente', 'fait', 'echec'] as const
export type OcrStatus = (typeof OCR_STATUSES)[number]
/** L'état d'un document qui vient d'être vu : son OCR n'a pas encore tourné. */
export const OCR_STATUS_PENDING: OcrStatus = 'attente'
export const OCR_STATUS_DONE: OcrStatus = 'fait'
export const OCR_STATUS_FAILED: OcrStatus = 'echec'

/**
 * Qui a rangé un document (décision 4) : une main humaine (même valeur que `message_tags`),
 * un agent par l'API, un motif appris, ou le moteur de tri. Comme pour les étiquettes,
 * l'effectif est `humain` d'abord, puis le plus récent.
 */
export const FILING_SOURCES = [HUMAN_SOURCE, 'agent', 'motif', 'moteur'] as const
export type FilingSource = (typeof FILING_SOURCES)[number]

/** Les identifiants stables d'un émetteur qu'on apprend d'un rangement (décision 5). */
export const PATTERN_KINDS = ['siret', 'tva', 'iban4', 'raison_sociale', 'regex'] as const
export type PatternKind = (typeof PATTERN_KINDS)[number]

/** La valeur de `folder` (URL de la liste, API) qui veut dire « À ranger » : les documents sans dossier effectif. */
export const UNFILED = 'unfiled'

/** Les routes de l'écran et de l'API documents, écrites UNE fois (barre latérale, page, bancs). */
export const DOCUMENTS_PATH = '/documents'
export const DOCUMENTS_ENDPOINT = '/api/documents'
export const DOCUMENT_FOLDERS_ENDPOINT = `${DOCUMENTS_ENDPOINT}/folders`
/** Paramètres d'URL de la page `/documents`. */
export const DOCUMENT_FOLDER_PARAM = 'folder'
export const DOCUMENT_QUERY_PARAM = 'q'
export const DOCUMENT_ID_PARAM = 'doc'
/** Type MIME du glisser-déposer d'un document vers un dossier virtuel (jamais confondu avec celui des mails). */
export const DOCUMENT_DRAG_TYPE = 'application/synapmail-document'
/** Émis après un rangement (dépôt, « Ranger… », fusion) : la liste et le volet de `/documents` se rafraîchissent. */
export const DOCUMENTS_CHANGED_EVENT = 'synapmail:documents-changed'
