/**
 * La chaîne de réception d'une boîte GED (lot G3, décision 6) : les mails ARRIVÉS depuis le
 * curseur sont relus en entier, chaque pièce jointe PDF devient UN document (décision 2),
 * océrisé sur place (`./ocr.ts`) et écrit dans `ged_documents` avec son texte par page.
 *
 * Quatre choix, et rien d'autre :
 *
 *  1. **Un curseur par boîte** (`ged_mailboxes.cursor` = `{ lastUid, uidValidity }` du dossier
 *     surveillé), avancé APRÈS chaque mail traité : une coupure ne perd que le mail en cours, et
 *     un `uidValidity` changé repart de zéro — sans surcoût, puisque `UNIQUE (account_id,
 *     message_id, part_idx)` fait du même PDF relu une ligne déjà là, jamais une seconde OCR.
 *     Curseur NULL = rattrapage de TOUT l'historique du dossier : l'OCR est local, donc gratuit.
 *  2. **L'OCR est à part du mail** : un PDF est d'abord ENREGISTRÉ (`attente`), puis océrisé,
 *     puis mis à jour (`fait` ou `echec` + raison). Un échec d'OCR (délai, PDF corrompu) n'arrête
 *     ni le mail ni la boîte : le document reste visible dans « À ranger » avec son erreur.
 *  3. **Le mail reste INTACT** : la source est lue par `BODY.PEEK` (imapflow), aucun drapeau n'est
 *     posé, rien n'est déplacé. Les dossiers virtuels ne touchent jamais l'IMAP (GOAL).
 *  4. **Le moteur est un PLUS** : la chaîne ne l'appelle pas. Elle appelle en revanche le
 *     rangement par motifs (`./filing.ts` `autoFile`) dès qu'un OCR est fait. C'est le trieur existant
 *     (`lib/tagging/runner.ts`), par la source enrichie `gedMailSource` (`./source.ts`), qui lit
 *     le texte OCR à la place du corps (`buildState`) — avec son plafond, ses pauses et son saut
 *     du déjà-fait. Sans moteur, l'OCR et les motifs (G4) tournent quand même.
 *
 * La source et l'OCR sont des PARAMÈTRES : le banc mesure la chaîne avec une fausse boîte et un
 * faux OCR, sans IMAP ni tesseract — comme le banc du trieur avec sa fausse source.
 */
import { query } from '../db'
import type { ImapAccountRow } from '../accounts'
import type { SourceMail } from '../tagging/runner'
import { messageIdOf } from '../tagging/store'
import { OCR_STATUSES, OCR_STATUS_DONE, OCR_STATUS_FAILED, OCR_STATUS_PENDING, type OcrStatus } from './model'
import { ocrPdf, type OcrResult } from './ocr'
import { autoFile } from './filing'

/** Le dossier d'une boîte GED que la chaîne surveille : le copieur n'écrit que là. */
export const GED_FOLDER = 'INBOX'

/** Les mails relus par passage : chacun peut porter un PDF de 8 pages à ~5 s la page. */
export const GED_BATCH_SIZE = 10

/**
 * Le budget d'UN passage. Un PDF de 8 pages coûte ~40 s d'OCR (mesuré en G0) : le budget en
 * laisse passer quelques-uns, et le planificateur revient 60 s plus tard pour la suite.
 */
export const GED_PASS_BUDGET_MS = 120_000

/** Ce qu'un PDF est, pour la chaîne : le type MIME ou, à défaut, l'extension — un copieur met parfois `application/octet-stream`. */
export const isPdf = (a: { contentType?: string; filename?: string }): boolean =>
  (a.contentType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(a.filename ?? '')

export interface GedAttachment {
  filename?: string
  contentType?: string
  content: Buffer
}

export type GedMail = SourceMail & { attachments: readonly GedAttachment[] }

/** Ce que la chaîne demande à une boîte : le même contrat que `ImapMailSource.fetchFull` + `uids` + `folders`. */
export interface GedSource {
  folders(): Promise<Array<{ path: string; uidValidity: string }>>
  uids(folder: string): Promise<number[]>
  fetchFull(folder: string, uids: number[]): Promise<GedMail[]>
}

export interface GedCursor {
  lastUid: number
  uidValidity: string
}

export interface IntakeOutcome {
  /** Mails relus. */
  mails: number
  /** Documents NOUVEAUX (une ligne `ged_documents` créée). */
  documents: number
  /** OCR menées à bien / en échec, documents déjà connus revus (même PDF, autre UID). */
  ocrDone: number
  ocrFailed: number
  known: number
  /** Documents rangés seuls par un motif connu / dossier proposé pour un émetteur inconnu (G4). */
  filed: number
  proposed: number
  /** Le passage s'est arrêté au budget : il reste des mails. */
  cut: boolean
}

export interface GedDocumentRow {
  id: string
  account_id: string
  message_id: string
  folder: string
  uid: number
  part_idx: number
  filename: string
  from_address: string
  from_name: string
  subject: string
  recu_le: Date | null
  pages: number
  ocr_status: string
  ocr_error: string | null
  ocr_text: string
  confiance: number | null
}

const saveCursor = (accountId: string, cursor: GedCursor): Promise<unknown> =>
  query(`UPDATE ged_mailboxes SET cursor = $2::jsonb WHERE account_id = $1`, [accountId, JSON.stringify(cursor)])

/**
 * Enregistre un PDF comme document, ou le retrouve s'il est déjà là (même mail, même partie —
 * un déplacement IMAP change l'UID, pas la pièce jointe). `created` dit lequel des deux.
 */
async function upsertDocument(accountId: string, mail: GedMail, partIdx: number, a: GedAttachment): Promise<{ row: GedDocumentRow; created: boolean }> {
  const rows = await query<GedDocumentRow & { created: boolean }>(
    `INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, from_address, from_name, subject, recu_le, ocr_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (account_id, message_id, part_idx) DO UPDATE SET folder = EXCLUDED.folder, uid = EXCLUDED.uid
     RETURNING *, (xmax = 0) AS created`,
    [accountId, messageIdOf(mail), mail.folder, mail.uid, partIdx, a.filename ?? `piece-${partIdx}.pdf`,
      mail.fromAddress ?? '', mail.fromName ?? '', mail.subject ?? '', mail.date ? new Date(mail.date) : null, OCR_STATUS_PENDING]
  )
  const { created, ...row } = rows[0]
  return { row, created }
}

async function runOcr(doc: GedDocumentRow, pdf: Buffer, ocr: (pdf: Buffer) => Promise<OcrResult>): Promise<boolean> {
  try {
    const r = await ocr(pdf)
    const read = r.pages.filter(p => !p.blank)
    const confidence = read.length ? read.reduce((s, p) => s + p.confidence, 0) / read.length : 0
    await query(
      `UPDATE ged_documents SET ocr_status = $2, ocr_error = NULL, ocr_text = $3, page_texts = $4::jsonb, pages = $5, confiance = $6 WHERE id = $1`,
      [doc.id, OCR_STATUS_DONE, r.text, JSON.stringify(r.pages), r.pageCount, Math.round(confidence * 10) / 10]
    )
    return true
  } catch (err) {
    await query(`UPDATE ged_documents SET ocr_status = $2, ocr_error = $3 WHERE id = $1`,
      [doc.id, OCR_STATUS_FAILED, String((err as Error).message ?? err).slice(0, 500)])
    return false
  }
}

/**
 * UN passage sur UNE boîte GED : relit les mails arrivés depuis le curseur, enregistre et
 * océrise leurs PDF, avance le curseur.
 */
export async function runIntake(params: {
  accountId: string
  source: GedSource
  ocr?: (pdf: Buffer) => Promise<OcrResult>
  budgetMs?: number
  now?: number
}): Promise<IntakeOutcome> {
  const { accountId, source } = params
  const ocr = params.ocr ?? ((pdf: Buffer) => ocrPdf(pdf))
  const deadline = (params.now ?? Date.now()) + (params.budgetMs ?? GED_PASS_BUDGET_MS)
  const out: IntakeOutcome = { mails: 0, documents: 0, ocrDone: 0, ocrFailed: 0, known: 0, filed: 0, proposed: 0, cut: false }

  const [box] = await query<{ cursor: GedCursor | null }>(`SELECT cursor FROM ged_mailboxes WHERE account_id = $1 AND actif`, [accountId])
  if (!box) return out
  const folder = (await source.folders()).find(f => f.path === GED_FOLDER)
  if (!folder) return out

  // Un `uidValidity` changé : les UID ne désignent plus les mêmes mails, on repart du début —
  // les PDF déjà connus sont retrouvés par leur clé, pas réocérisés.
  let cursor: GedCursor = box.cursor && box.cursor.uidValidity === folder.uidValidity
    ? box.cursor : { lastUid: 0, uidValidity: folder.uidValidity }
  const pending = (await source.uids(GED_FOLDER)).filter(u => u > cursor.lastUid).sort((a, b) => a - b)

  for (let i = 0; i < pending.length; i += GED_BATCH_SIZE) {
    const mails = await source.fetchFull(GED_FOLDER, pending.slice(i, i + GED_BATCH_SIZE))
    for (const mail of mails) {
      if (Date.now() >= deadline) { out.cut = true; return out }
      out.mails += 1
      let partIdx = -1
      for (const a of mail.attachments) {
        partIdx += 1
        if (!isPdf(a)) continue
        const { row, created } = await upsertDocument(accountId, mail, partIdx, a)
        if (!created) { out.known += 1; if (row.ocr_status !== OCR_STATUS_PENDING) continue }
        else out.documents += 1
        if (!(await runOcr(row, a.content, ocr))) { out.ocrFailed += 1; continue }
        out.ocrDone += 1
        const filed = await autoFile(row.id)
        if (filed.kind === 'motif') out.filed += 1
        else if (filed.kind === 'propose') out.proposed += 1
      }
      cursor = { lastUid: mail.uid, uidValidity: folder.uidValidity }
      await saveCursor(accountId, cursor)
    }
  }
  return out
}

/**
 * Les boîtes GED actives, avec leurs identifiants IMAP, en UNE requête — ce que le planificateur
 * parcourt. Vit ici pour être mesurable par le banc sans ouvrir une connexion.
 */
export async function gedMailboxes(): Promise<Array<ImapAccountRow & { account_id: string }>> {
  return query<ImapAccountRow & { account_id: string }>(`
    SELECT a.id, a.imap_host, a.imap_port, a.imap_secure, a.username, a.password_encrypted,
           a.oauth_provider, a.oauth_access_token, a.oauth_refresh_token, a.oauth_expires_at,
           g.account_id
      FROM ged_mailboxes g JOIN email_accounts a ON a.id = g.account_id
     WHERE g.actif
  `)
}

/** Ce que l'écran et l'API lisent d'une boîte GED : déclarée ou non, son curseur, ses documents par état. */
export interface GedMailboxStatus {
  accountId: string
  actif: boolean
  cursor: GedCursor | null
  documents: Record<OcrStatus, number>
}

export async function gedMailboxStatus(accountId: string): Promise<GedMailboxStatus> {
  const [box] = await query<{ actif: boolean; cursor: GedCursor | null }>(`SELECT actif, cursor FROM ged_mailboxes WHERE account_id = $1`, [accountId])
  const counts = await query<{ ocr_status: OcrStatus; n: string }>(`SELECT ocr_status, count(*) AS n FROM ged_documents WHERE account_id = $1 GROUP BY ocr_status`, [accountId])
  const documents = Object.fromEntries(OCR_STATUSES.map(s => [s, 0])) as Record<OcrStatus, number>
  for (const c of counts) documents[c.ocr_status] = Number(c.n)
  return { accountId, actif: box?.actif ?? false, cursor: box?.cursor ?? null, documents }
}

/** Déclare (ou retire) une boîte GED. Retirer ne jette rien : les documents restent, la chaîne s'arrête. */
export const setGedMailbox = (accountId: string, actif: boolean): Promise<unknown> =>
  query(`INSERT INTO ged_mailboxes (account_id, actif) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET actif = EXCLUDED.actif`, [accountId, actif])

/**
 * Le rattrapage des mails déjà présents : un ORDRE d'état, pas un passage synchrone (comme
 * `POST /api/tagging/run`). Le curseur retombe à NULL — le prochain `processGed` relit tout le
 * dossier (les PDF `fait` sont retrouvés par leur clé, jamais réocérisés) — et les OCR en `echec`
 * repassent en `attente` : c'est la seule façon de rejouer un échec (banc G3, B2/B4).
 */
export async function requestCatchUp(accountId: string): Promise<void> {
  await query(`UPDATE ged_documents SET ocr_status = $2, ocr_error = NULL WHERE account_id = $1 AND ocr_status = $3`, [accountId, OCR_STATUS_PENDING, OCR_STATUS_FAILED])
  await query(`UPDATE ged_mailboxes SET cursor = NULL WHERE account_id = $1`, [accountId])
}
