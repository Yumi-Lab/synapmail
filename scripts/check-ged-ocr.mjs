#!/usr/bin/env node
/**
 * Banc du lot G1 : l'OCR auto-hébergé — `ocrPdf()` de `lib/ged/ocr.ts`.
 *
 * Banc LOCAL : aucune base, aucun réseau, aucun vrai document. Le PDF est fabriqué ICI, 100 % image
 * (pages JPEG sans couche texte, vérifié par `pdffonts`/`pdftotext`) : page 1 texte droit,
 * page 2 blanche, page 3 le même texte tourné à 90°. Il lui faut `pdftoppm`, `pdfinfo`, `tesseract`
 * (fra+eng+osd) sur la machine — les binaires du Dockerfile.
 *
 *   node --experimental-strip-types scripts/check-ged-ocr.mjs
 *   node --experimental-strip-types scripts/check-ged-ocr.mjs --negative
 *
 * Ce qu'il mesure :
 *   A. le texte connu de la page 1 est retrouvé à l'identique (n° de facture, montant, SIRET),
 *      confiance moyenne ≥ 80 ;
 *   B. la page blanche est `blank`, confiance 0, absente du texte global (un seul \f entre p1 et p3) ;
 *   C. la page tournée à 90° est redressée (même texte retrouvé) ;
 *   D. un délai par page dépassé lève `OcrTimeoutError` ;
 *   E. au-delà de `OCR_MAX_PAGES` on s'arrête (pageCount garde le vrai total), un PDF plus gros
 *      que `OCR_MAX_PDF_BYTES` est refusé AVANT tout processus (`OcrLimitError`) ;
 *   F. deux appels concurrents sont servis UN PAR UN (au plus un dossier `synap-ocr-*` vivant) ;
 *   G. un octet qui n'est pas un PDF rejette proprement (pas de dossier temporaire laissé).
 *
 * CONTRÔLE NÉGATIF (`--negative`) : A/C cherchent un texte absent, la page 2 porte du texte, D garde
 * le délai normal, E fabrique exactement OCR_MAX_PAGES pages, F lance deux INSTANCES du module (file
 * d'attente séparée). A, B, C, D, E (pages), F DOIVENT tomber ; E (taille) et G tiennent.
 */
import './alias-resolver.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NEGATIVE = process.argv.includes('--negative')
const ocr = await import('../lib/ged/ocr.ts')
const { ocrPdf, OcrTimeoutError, OcrLimitError, OCR_MAX_PAGES, OCR_MAX_PDF_BYTES } = ocr

const failures = []
let ok = 0
const check = (id, cond, detail) => { if (cond) ok++; else failures.push(`${id}: ${String(detail).slice(0, 160)}`) }

const TMP = realpathSync(tmpdir())
const work = mkdtempSync(join(TMP, 'banc-ged-ocr-'))

// --- fabrique : PDF vectoriel → JPEG par page (pdftoppm) → PDF image (DCTDecode), sans aucune police
const MARKS = ['FACTURE N 48213', 'TOTAL 407,70 EUR', 'SIRET 73282932000074']
const vectorPdf = pages => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (const { w, h, content } of pages) {
    const n = objs.length + 1; kids.push(`${n} 0 R`)
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  return serialize(objs)
}
const imagePdf = jpegs => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null]
  const kids = []
  for (const { w, h, jpeg } of jpegs) {
    const n = objs.length + 1; kids.push(`${n} 0 R`)
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im Do Q`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${jpeg.w} /Height ${jpeg.h} /ColorSpace /${jpeg.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.data.length} >>\nstream\n`), jpeg.data, Buffer.from('\nendstream')]))
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${jpegs.length} >>`
  return serialize(objs)
}
const serialize = objs => {
  const parts = [Buffer.from('%PDF-1.4\n')]; const offs = []; let len = parts[0].length
  objs.forEach((o, i) => { offs.push(len); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n')]); parts.push(b); len += b.length })
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`))
  return Buffer.concat(parts)
}
const RENDER_DPI = 300
const rasterize = (pdf, name) => {
  const p = join(work, `${name}.pdf`); writeFileSync(p, pdf)
  execFileSync('pdftoppm', ['-r', String(RENDER_DPI), '-jpeg', '-jpegopt', 'quality=90', p, join(work, name)])
  return readdirSync(work).filter(f => f.startsWith(`${name}-`) && f.endsWith('.jpg')).sort().map(f => {
    const data = readFileSync(join(work, f))
    // SOF0 : après FFC0 + longueur + précision viennent hauteur, largeur (16 bits) puis le nombre de composantes
    const i = data.indexOf(Buffer.from([0xff, 0xc0])); const h = data.readUInt16BE(i + 5), w = data.readUInt16BE(i + 7)
    return { w, h, data, colorSpace: data[i + 9] === 1 ? 'DeviceGray' : 'DeviceRGB' }
  })
}
const A4 = { w: 595, h: 842 }
// Une vraie page porte 130 à 530 mots : l'OSD de tesseract a besoin de cette densité pour trancher
// l'orientation (sur trois lignes seules il se trompe). Repères en tête, remplissage lisible dessous.
const FILLER = 'Le transporteur facture la livraison du colis au client selon le tarif en vigueur.'
const LINES = [...MARKS, ...Array.from({ length: 18 }, () => FILLER)]
const upright = LINES.map((s, i) => `BT /F1 16 Tf 60 ${780 - i * 28} Td (${s}) Tj ET`).join('\n')
const rotated = LINES.map((s, i) => `BT /F1 16 Tf 0 1 -1 0 ${60 + i * 28} 60 Tm (${s}) Tj ET`).join('\n')
const page2 = NEGATIVE ? 'BT /F1 28 Tf 60 400 Td (PAGE DEUX PAS BLANCHE) Tj ET' : ''
const jpegs = rasterize(vectorPdf([{ ...A4, content: upright }, { ...A4, content: page2 }, { ...A4, content: rotated }]), 'vec')
const pdf = imagePdf(jpegs.map(j => ({ ...A4, jpeg: j })))
writeFileSync(join(work, 'img.pdf'), pdf)
check('fabrique : 100 % image', execFileSync('pdffonts', [join(work, 'img.pdf')], { encoding: 'utf8' }).split('\n').length <= 3 && execFileSync('pdftotext', [join(work, 'img.pdf'), '-'], { encoding: 'utf8' }).trim() === '', 'le PDF du banc porte une police ou une couche texte')

const liveDirs = () => readdirSync(TMP).filter(f => f.startsWith('synap-ocr-')).length
const before = liveDirs()

// A + B + C
const want = NEGATIVE ? ['FACTURE N 99999', 'TOTAL 1,00 EUR', 'SIRET 00000000000000'] : MARKS
const r = await ocrPdf(pdf)
check('A0 3 pages', r.pageCount === 3 && r.pages.length === 3, `pageCount=${r.pageCount} pages=${r.pages.length}`)
for (const m of want) check(`A1 p1 « ${m} »`, r.pages[0].text.includes(m), `absent de ${JSON.stringify(r.pages[0].text)}`)
check('A2 p1 confiance ≥ 80', r.pages[0].confidence >= 80 && !r.pages[0].blank, `confiance=${r.pages[0].confidence} blank=${r.pages[0].blank}`)
check('B1 p2 blanche', r.pages[1].blank === true && r.pages[1].text === '' && r.pages[1].confidence === 0, `blank=${r.pages[1].blank} conf=${r.pages[1].confidence} text=${JSON.stringify(r.pages[1].text)}`)
check('B2 texte global = p1 \\f p3', r.text.split('\f').length === 2 && r.text === `${r.pages[0].text}\f${r.pages[2].text}`, `${r.text.split('\f').length} segments`)
for (const m of want) check(`C1 p3 tournée « ${m} »`, r.pages[2].text.includes(m), `absent de ${JSON.stringify(r.pages[2].text)}`)
check('C2 p3 confiance ≥ 80', r.pages[2].confidence >= 80, `confiance=${r.pages[2].confidence}`)

// D
const dErr = await ocrPdf(pdf, NEGATIVE ? undefined : 1).then(() => null, e => e)
check('D1 délai dépassé', dErr instanceof OcrTimeoutError, `obtenu ${dErr?.name ?? 'succès'}`)
check('D2 tmp nettoyé après délai', liveDirs() === before, `${liveDirs() - before} dossier(s) synap-ocr-* restant(s)`)

// E — pages minuscules (50×50 pt) pour que le plafond se mesure en secondes, pas en minutes
const tiny = { w: 50, h: 50, content: '' }
const nTiny = NEGATIVE ? OCR_MAX_PAGES : OCR_MAX_PAGES + 1
const tinyJpegs = rasterize(vectorPdf(Array.from({ length: nTiny }, () => tiny)), 'tiny')
const many = await ocrPdf(imagePdf(tinyJpegs.map(j => ({ ...tiny, jpeg: j }))))
check('E1 plafond de pages', many.pageCount === nTiny && many.pages.length === OCR_MAX_PAGES && many.pageCount > many.pages.length, `pageCount=${many.pageCount} océrisées=${many.pages.length} plafond=${OCR_MAX_PAGES}`)
const t0 = Date.now()
const big = await ocrPdf(Buffer.alloc(OCR_MAX_PDF_BYTES + 1)).then(() => null, e => e)
check('E2 plafond de taille', big instanceof OcrLimitError && Date.now() - t0 < 500, `obtenu ${big?.name ?? 'succès'} en ${Date.now() - t0} ms`)

// F — deux appels en même temps ; en négatif, deux instances du module (deux files d'attente)
const other = NEGATIVE ? (await import('../lib/ged/ocr.ts?instance=2')).ocrPdf : ocrPdf
let maxLive = 0
const poll = setInterval(() => { maxLive = Math.max(maxLive, liveDirs() - before) }, 15)
await Promise.all([ocrPdf(pdf), other(pdf)])
clearInterval(poll)
check('F1 une OCR à la fois', maxLive === 1, `jusqu'à ${maxLive} OCR simultanées`)

// G
const gErr = await ocrPdf(Buffer.from('ceci n\'est pas un PDF')).then(() => null, e => e)
check('G1 non-PDF rejeté', gErr instanceof Error && !(gErr instanceof OcrTimeoutError), `obtenu ${gErr?.name ?? 'succès'}`)
check('G2 tmp nettoyé', liveDirs() === before, `${liveDirs() - before} dossier(s) synap-ocr-* restant(s)`)

rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`FAIL ${f}`)
console.log(`check-ged-ocr${NEGATIVE ? ' --negative' : ''}: ${ok} ok, ${failures.length} FAIL`)
process.exit(failures.length ? 1 : 0)
