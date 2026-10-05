/**
 * OCR auto-hébergé d'un PDF image : `pdftoppm` (une page à la fois) puis `tesseract`, tous deux en
 * PROCESSUS ENFANT — rien ne sort de l'instance, rien ne pèse sur le tas Node. Une seule OCR à la
 * fois dans tout le processus (file d'attente par promesse-chaîne) : une page prend ~260 Mo de RSS
 * côté tesseract, le conteneur en a 1 Go dont 768 pour Node.
 *
 * Orientation : `--psm 1` fait l'OSD intégré et redresse la page lui-même (mesuré sur une page
 * tournée à 90° : texte intégral retrouvé ; `--psm 3` sort du bruit). Page blanche : tesseract ne
 * rend aucun mot → page ignorée dans le texte global, gardée dans `pages` avec `blank: true`.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const OCR_DPI = 300
export const OCR_LANGS = 'fra+eng'
export const OCR_PAGE_TIMEOUT_MS = 60_000
export const OCR_MAX_PAGES = 20
export const OCR_MAX_PDF_BYTES = 25 * 1024 * 1024

// Le leptonica Homebrew réécrit tout chemin absolu commençant par `/tmp/` vers le tmp utilisateur
// macOS ; `os.tmpdir()` renvoie `/tmp` sur mac. Le vrai chemin (`/private/tmp`) passe partout.
const TMP_ROOT = realpathSync(tmpdir())

export class OcrLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'OcrLimitError' }
}
export class OcrTimeoutError extends Error {
  constructor(page: number) { super(`OCR page ${page} : délai de ${OCR_PAGE_TIMEOUT_MS} ms dépassé`); this.name = 'OcrTimeoutError' }
}

export interface OcrPage {
  index: number
  text: string
  /** Confiance moyenne des mots (0–100) ; 0 pour une page blanche. */
  confidence: number
  blank: boolean
}
export interface OcrResult {
  /** Pages du PDF, y compris celles au-delà de `OCR_MAX_PAGES` (non océrisées). */
  pageCount: number
  pages: OcrPage[]
  /** Texte des pages non blanches, séparées par un saut de page (\f). */
  text: string
}

export async function pdfPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await run('pdfinfo', [pdfPath])
  return Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1] ?? 0)
}

/** Confiance moyenne et texte reconstitué depuis le TSV de tesseract (niveau 5 = mot). */
function parseTsv(tsv: string): { words: number; confidence: number } {
  const confs: number[] = []
  for (const line of tsv.split('\n')) {
    const c = line.split('\t')
    if (c[0] === '5' && c[10] !== '-1' && c[11]?.trim()) confs.push(Number(c[10]))
  }
  const confidence = confs.length ? confs.reduce((s, v) => s + v, 0) / confs.length : 0
  return { words: confs.length, confidence: Math.round(confidence * 10) / 10 }
}

/** Une page du PDF en PNG (`<base>.png`), à la résolution demandée. */
const rasterize = (pdfPath: string, index: number, dpi: number, base: string, timeout: number) =>
  run('pdftoppm', ['-r', String(dpi), '-f', String(index), '-l', String(index), '-singlefile', '-png', pdfPath, base], { timeout })

/** La résolution d'une page rendue pour l'ÉCRAN (vignette, agrandissement) — pas celle de l'OCR. */
export const PAGE_RENDER_DPI = 110
export const PAGE_RENDER_DPI_MAX = 200

/**
 * Rend UNE page d'un PDF en PNG, pour l'afficher (G5 `GET /api/documents/[id]/pages/[n]`, écran G6).
 * Même `pdftoppm` que l'OCR, hors de sa file : rendre une page à 110 dpi pèse quelques dizaines de Mo
 * et quelques centaines de ms, rien à voir avec tesseract.
 */
export async function renderPage(pdf: Buffer, index: number, dpi = PAGE_RENDER_DPI): Promise<Buffer> {
  const dir = await mkdtemp(join(TMP_ROOT, 'synap-page-'))
  try {
    const pdfPath = join(dir, 'in.pdf')
    await writeFile(pdfPath, pdf)
    const base = join(dir, 'page')
    await rasterize(pdfPath, index, Math.min(Math.max(dpi, 1), PAGE_RENDER_DPI_MAX), base, OCR_PAGE_TIMEOUT_MS)
    return await readFile(`${base}.png`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function ocrPage(pdfPath: string, dir: string, index: number, pageTimeoutMs: number): Promise<OcrPage> {
  const base = join(dir, `p${index}`)
  const opts = { timeout: pageTimeoutMs }
  try {
    await rasterize(pdfPath, index, OCR_DPI, base, pageTimeoutMs)
    await run('tesseract', [`${base}.png`, base, '-l', OCR_LANGS, '--psm', '1', 'txt', 'tsv'], opts)
  } catch (e) {
    if ((e as { killed?: boolean }).killed) throw new OcrTimeoutError(index)
    throw e
  }
  const [txt, tsv] = await Promise.all([readFile(`${base}.txt`, 'utf8'), readFile(`${base}.tsv`, 'utf8')])
  const { words, confidence } = parseTsv(tsv)
  const blank = words === 0
  return { index, text: blank ? '' : txt.trim(), confidence, blank }
}

async function ocrPdfNow(pdf: Buffer, pageTimeoutMs: number): Promise<OcrResult> {
  if (pdf.byteLength > OCR_MAX_PDF_BYTES) throw new OcrLimitError(`PDF de ${pdf.byteLength} octets > ${OCR_MAX_PDF_BYTES}`)
  const dir = await mkdtemp(join(TMP_ROOT, 'synap-ocr-'))
  try {
    const pdfPath = join(dir, 'in.pdf')
    await writeFile(pdfPath, pdf)
    const pageCount = await pdfPageCount(pdfPath)
    if (pageCount < 1) throw new OcrLimitError('PDF sans page lisible')
    const pages: OcrPage[] = []
    for (let i = 1; i <= Math.min(pageCount, OCR_MAX_PAGES); i++) pages.push(await ocrPage(pdfPath, dir, i, pageTimeoutMs))
    return { pageCount, pages, text: pages.filter(p => !p.blank).map(p => p.text).join('\f') }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ponytail: verrou global par promesse-chaîne — une OCR à la fois dans ce processus, plafond connu
// (une seule instance Node). Plusieurs instances → file en base (ged_documents.ocr_status) à G3.
let chain: Promise<unknown> = Promise.resolve()

/** Océrise un PDF image. Les appels concurrents sont mis en file et servis un par un. */
export function ocrPdf(pdf: Buffer, pageTimeoutMs = OCR_PAGE_TIMEOUT_MS): Promise<OcrResult> {
  const next = chain.then(() => ocrPdfNow(pdf, pageTimeoutMs))
  chain = next.catch(() => {})
  return next
}
