#!/usr/bin/env node
/**
 * Banc du RANGEMENT et des MOTIFS APPRIS (lot G4, décisions 3-5) : faux textes OCR, fausse boîte —
 * aucune connexion IMAP, aucun tesseract, aucun moteur. Banc DB : il crée un utilisateur et une
 * boîte jetables ; le `DELETE FROM users` du `finally` emporte tout par CASCADE.
 *
 *   A. les identifiants (module pur) : SIRET à clé de Luhn, TVA FR à clé, IBAN RÉDUIT (jamais
 *      l'IBAN entier), raison sociale de l'en-tête (première page seulement) ; la regex bornée
 *      et l'opérateur `matches` sur `texte_ocr` ;
 *   B. le rangement : une main range → les motifs sont appris ; un nouveau document qui porte un
 *      motif FORT est rangé seul (`source=motif`, touches +1) ; deux dossiers candidats ou une
 *      raison sociale seule → « À ranger » avec suggestions ; émetteur inconnu → dossier proposé
 *      sous « Nouveaux émetteurs », que le second envoi rejoint par motif ; l'effectif reste la
 *      main même après un motif ; un rangement par motif n'apprend rien ; les identifiants PROPRES
 *      de la boîte (`ged_mailboxes.propres`, ceux du destinataire) ne sont ni appris ni cherchés ;
 *   C. la chaîne : `runIntake` range au fil de l'OCR (`filed` / `proposed` dans son bilan).
 *
 * `--negative` : les clés des identifiants sont FAUSSES (un chiffre d'écart, comme un OCR qui lit
 * mal) — rien de FORT n'existe plus, seule la raison sociale (faible) reste : A1, A2, A3, B1, B3, B4,
 * B5, B6, B7, B10, B11b, B12, B14, C1 DOIVENT tomber (B8, Wanhao sans clé, tient dans les deux modes).
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import pg from 'pg'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const { DATABASE_URL: DB_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
if (!DB_URL) harness("DATABASE_URL n'est pas renseigné")

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const { initDb } = await import('../lib/db.ts')
const { siretsOf, tvasOf, ibansOf, raisonSocialeOf, identifiersOf, luhnOk, tvaFrOk } = await import('../lib/ged/patterns.ts')
const filing = await import('../lib/ged/filing.ts')
const { fileDocument, effectiveFiling, suggestionsFor, autoFile, AUTO_ROOT_NAME, PATTERN_CONFIDENCE, PROPOSED_CONFIDENCE } = filing
const { boundedRegex, evalCondition, MATCH_PATTERN_MAX } = await import('../lib/rulesEval.ts')
const { runIntake, GED_FOLDER } = await import('../lib/ged/intake.ts')
const { OCR_STATUS_DONE } = await import('../lib/ged/model.ts')
const { HUMAN_SOURCE } = await import('../lib/tagging/engine.ts')

// ---- les faux textes OCR ------------------------------------------------------------------
// Clés VRAIES (Luhn / TVA / mod 97) en mode normal ; en `--negative`, un chiffre d'écart partout.
const SIRET_A = NEGATIVE ? '912 345 678 00012' : '912 345 678 00011'
const TVA_A   = NEGATIVE ? 'FR75912345678'     : 'FR74912345678'
const IBAN_A  = NEGATIVE ? 'FR76 3000 6000 0112 3456 7890 180' : 'FR76 3000 6000 0112 3456 7890 189'
const SIRET_B = NEGATIVE ? '845 210 367 00016' : '845 210 367 00015'
const PAGE2 = '\fPage 2. Détail des prestations. '.repeat(3)
const TEXT_FEDEX = n => `FEDEX EXPRESS FR SAS\n2 rue du Test, 75000 Paris\nSIRET ${SIRET_A}  TVA intracom. ${TVA_A}\nFacture n° ${n}  Total 40,89 EUR\nIBAN ${IBAN_A}${PAGE2}`
const TEXT_ARTI  = n => `ARTILLERY3D SARL\nZone industrielle\nSIRET ${SIRET_B}\nFacture AR-${n}  Total 407,70 EUR${PAGE2}`
const TEXT_WANHAO = n => `Wanhao Co., Ltd\nInvoice W-${n}\nTotal 199,00 USD${PAGE2}`
const TEXT_NOHEAD = `Relevé sans en-tête.\nMontant 12,00 EUR${PAGE2}`
const TEXT_MIXED = `Bordereau groupé\nSIRET ${SIRET_A} et SIRET ${SIRET_B}${PAGE2}`

console.log(`\nbanc du rangement et des motifs GED (lot G4)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (clés fausses)' : ''}\n`)

// ---- A. module pur ----------------------------------------------------------------------
console.log('A. les identifiants et la regex bornée')
const t1 = TEXT_FEDEX(1)
check('A1 SIRET : la clé de Luhn garde le bon et rejette celui qui diffère d’un chiffre', JSON.stringify(siretsOf(t1)) === '["91234567800011"]' && !luhnOk('91234567800012'), JSON.stringify(siretsOf(t1)))
check('A2 TVA FR : la clé est contrôlée (FR74 912345678 passe, FR75 non)', JSON.stringify(tvasOf(t1)) === '["FR74912345678"]' && !tvaFrOk('FR75912345678'), JSON.stringify(tvasOf(t1)))
const ib = ibansOf(t1)
check('A3 IBAN : RÉDUIT à banque + 4 derniers (30006…0189), jamais l’IBAN entier', JSON.stringify(ib) === '["30006…0189"]' && !ib.some(v => v.includes('0112')), JSON.stringify(ib))
check('A4 raison sociale : la ligne d’en-tête de la PREMIÈRE page, en majuscules ; une forme étrangère (Co., Ltd) aussi ; rien sans en-tête', raisonSocialeOf(t1) === 'FEDEX EXPRESS FR SAS' && raisonSocialeOf(TEXT_WANHAO(1)) === 'WANHAO CO., LTD' && raisonSocialeOf(TEXT_NOHEAD) === null && raisonSocialeOf('x\f ACME SAS') === null, JSON.stringify([raisonSocialeOf(t1), raisonSocialeOf(TEXT_WANHAO(1)), raisonSocialeOf(TEXT_NOHEAD)]))
const all = identifiersOf(t1)
check('A5 identifiersOf : aucun identifiant ne contient l’IBAN en clair', !JSON.stringify(all).includes('0112') && !JSON.stringify(all).includes('7890'), JSON.stringify(all))
check('A6 boundedRegex : vide, trop long (> MATCH_PATTERN_MAX) ou invalide → null ; sinon insensible à la casse, sans drapeau g', boundedRegex('') === null && boundedRegex('a'.repeat(MATCH_PATTERN_MAX + 1)) === null && boundedRegex('(') === null && boundedRegex('fedex').test('FEDEX') && !boundedRegex('x').global)
const msg = { from: {}, subject: '', date: new Date().toISOString(), ocrText: t1 }
const cond = (operator, value) => ({ id: 'c', field: 'texte_ocr', operator, value })
check('A7 evalCondition `texte_ocr matches` : vrai sur le motif, faux sur un autre, faux sur un motif invalide, faux sans texte OCR', evalCondition(msg, cond('matches', 'facture n° \\d+')) && !evalCondition(msg, cond('matches', 'chronopost')) && !evalCondition(msg, cond('matches', '(')) && !evalCondition({ ...msg, ocrText: undefined }, cond('matches', '.')))

// ---- B / C. base ------------------------------------------------------------------------
await initDb()
const pool = new pg.Pool({ connectionString: DB_URL })
const tag = crypto.randomBytes(4).toString('hex')
const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const USER = (await pool.query(`INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, 'banc g4', $2, 'user', 'active') RETURNING id`,
  [`g4-${tag}@banc-g4.invalid`, bcryptPlaceholder])).rows[0].id
try {
  const ACCOUNT = (await pool.query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1, 'banc g4', $2, 'imap.banc-g4.invalid', 993, true, 'smtp.banc-g4.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
    [USER, `g4-${tag}@banc-g4.invalid`])).rows[0].id
  await pool.query(`INSERT INTO ged_mailboxes (account_id) VALUES ($1)`, [ACCOUNT])
  let uid = 0
  const doc = async text => (await pool.query(
    `INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, ocr_status, ocr_text, pages) VALUES ($1, $2, $3, $4, 0, 'doc.pdf', $5, $6, 2) RETURNING id`,
    [ACCOUNT, `<banc-g4-${++uid}@exemple.invalid>`, GED_FOLDER, uid, OCR_STATUS_DONE, text])).rows[0].id
  const folder = async (nom, parent = null) => (await pool.query(`INSERT INTO ged_folders (account_id, parent_id, nom) VALUES ($1, $2, $3) RETURNING id`, [ACCOUNT, parent, nom])).rows[0].id
  const filings = async id => (await pool.query(`SELECT folder_id, source, auteur_nom, confiance FROM ged_filings WHERE document_id = $1 ORDER BY id`, [id])).rows
  const patterns = async fid => (await pool.query(`SELECT genre, valeur, touches FROM ged_patterns WHERE folder_id = $1 ORDER BY genre`, [fid])).rows
  const folders = async () => (await pool.query(`SELECT id, parent_id, nom, auto FROM ged_folders WHERE account_id = $1 ORDER BY cree_le`, [ACCOUNT])).rows
  const NICO = { id: USER, nom: 'Nicolas' }

  console.log('B. le rangement et ce qu’il apprend')
  const fournisseurs = await folder('Fournisseurs')
  const fedex = await folder('FedEx', fournisseurs)
  const d1 = await doc(TEXT_FEDEX(1))
  const r1 = await fileDocument({ documentId: d1, folderId: fedex, source: HUMAN_SOURCE, author: NICO })
  let p = await patterns(fedex)
  check('B1 une main range le PDF FedEx → 4 motifs appris pour le dossier (iban4, raison_sociale, siret, tva), aucun IBAN en clair', p.map(x => x.genre).join(',') === 'iban4,raison_sociale,siret,tva' && r1.learned.length === 4 && !p.some(x => x.valeur.includes('0112')), JSON.stringify(p))
  const f1 = await filings(d1)
  check('B2 le rangement est une ligne `humain` signée (auteur_nom = copie du nom)', f1.length === 1 && f1[0].source === HUMAN_SOURCE && f1[0].auteur_nom === 'Nicolas' && f1[0].folder_id === fedex, JSON.stringify(f1))

  const d2 = await doc(TEXT_FEDEX(2))
  const a2 = await autoFile(d2)
  const f2 = await filings(d2)
  p = await patterns(fedex)
  check('B3 un nouvel envoi FedEx (même SIRET/TVA/IBAN) est rangé SEUL : `source=motif`, confiance 0.95, dans FedEx, et les motifs forts comptent +1', a2.kind === 'motif' && a2.folderId === fedex && f2.length === 1 && f2[0].source === 'motif' && Number(f2[0].confiance) === PATTERN_CONFIDENCE && p.every(x => x.touches === 1), JSON.stringify([a2.kind, f2, p.map(x => [x.genre, x.touches])]))
  check('B4 un rangement par motif n’APPREND rien : toujours 4 motifs, pas un de plus', p.length === 4, String(p.length))
  const a2b = await autoFile(d2)
  check('B5 un document déjà rangé n’est pas touché par un second passage (aucune nouvelle ligne)', a2b.kind === 'aucun' && (await filings(d2)).length === 1, JSON.stringify(a2b))

  // Une correction à la main reste en tête : la main sort d2 de FedEx, un motif tenterait de le remettre.
  await fileDocument({ documentId: d2, folderId: null, source: HUMAN_SOURCE, author: NICO })
  await pool.query(`INSERT INTO ged_filings (document_id, folder_id, source, auteur_nom, confiance) VALUES ($1, $2, 'motif', 'motif', 0.9)`, [d2, fedex])
  const eff = await effectiveFiling(d2)
  check('B6 l’effectif = la main d’abord (même plus ancienne qu’un motif ultérieur) : d2 est HORS dossier ; sortir n’apprend rien (toujours 4 motifs)', eff?.source === HUMAN_SOURCE && eff.folder_id === null && (await patterns(fedex)).length === 4, JSON.stringify(eff))

  // Le doute : un agent range un bordereau à DEUX SIRET dans « Douane » → le SIRET A pointe FedEx ET Douane.
  const douane = await folder('Douane')
  const dm = await doc(TEXT_MIXED)
  await fileDocument({ documentId: dm, folderId: douane, source: 'agent', author: { id: 'k1', nom: 'agent' } })
  const d3 = await doc(TEXT_FEDEX(3))
  const a3 = await autoFile(d3)
  check('B7 deux dossiers candidats forts (FedEx et Douane portent le même SIRET) → DOUTE : rien rangé, 2 suggestions, FedEx (3 genres) devant Douane (1)', a3.kind === 'doute' && (await filings(d3)).length === 0 && a3.suggestions.length === 2 && a3.suggestions[0].folderId === fedex && a3.suggestions[1].folderId === douane && a3.suggestions.every(s => s.strong), JSON.stringify(a3))
  await pool.query(`DELETE FROM ged_patterns WHERE folder_id = $1`, [douane])

  // Une raison sociale seule est un motif FAIBLE : elle suggère, elle ne range pas.
  const wanhao = await folder('Wanhao', fournisseurs)
  const dw = await doc(TEXT_WANHAO(1))
  await fileDocument({ documentId: dw, folderId: wanhao, source: HUMAN_SOURCE, author: NICO })
  const dw2 = await doc(TEXT_WANHAO(2))
  const aw = await autoFile(dw2)
  check('B8 une raison sociale seule (Wanhao, sans SIRET) → DOUTE avec Wanhao en suggestion FAIBLE, rien rangé', aw.kind === 'doute' && aw.suggestions.length === 1 && aw.suggestions[0].folderId === wanhao && !aw.suggestions[0].strong && (await filings(dw2)).length === 0, JSON.stringify(aw))

  // Émetteur inconnu → dossier proposé.
  const d4 = await doc(TEXT_ARTI(1))
  const a4 = await autoFile(d4)
  const fl = await folders()
  const root = fl.find(f => f.nom === AUTO_ROOT_NAME)
  const prop = fl.find(f => f.nom === 'ARTILLERY3D SARL')
  const f4 = await filings(d4)
  check('B9 émetteur inconnu avec en-tête → dossier PROPOSÉ « ARTILLERY3D SARL » (auto) sous « Nouveaux émetteurs » (auto, racine), rangé `motif` à confiance 0.5', a4.kind === 'propose' && root?.auto && root.parent_id === null && prop?.auto && prop.parent_id === root.id && a4.folderId === prop.id && f4.length === 1 && f4[0].source === 'motif' && Number(f4[0].confiance) === PROPOSED_CONFIDENCE, JSON.stringify([a4.kind, root, prop, f4]))
  const d5 = await doc(TEXT_ARTI(2))
  const a5 = await autoFile(d5)
  check('B10 le second envoi du même émetteur rejoint le dossier proposé par MOTIF (SIRET appris au dossier proposé)', a5.kind === 'motif' && a5.folderId === prop?.id, JSON.stringify(a5))
  const d6 = await doc(TEXT_NOHEAD)
  const a6 = await autoFile(d6)
  check('B11 ni motif ni en-tête ni identifiant → rien : aucun dossier créé, aucun rangement', a6.kind === 'aucun' && (await folders()).length === fl.length && (await filings(d6)).length === 0, JSON.stringify(a6))
  const SIRET_C = NEGATIVE ? '196 712 345 00013' : '196 712 345 00012'
  const dl = await doc(`Lycée Sans-Forme-Juridique\nSIRET ${SIRET_C}\nDemande de RIB${PAGE2}`)
  const al = await autoFile(dl)
  const lyceeProp = (await folders()).find(f => f.nom === `SIRET ${SIRET_C.replace(/ /g, '')}`)
  check('B11b un émetteur sans forme juridique en en-tête mais avec un SIRET → dossier proposé nommé « SIRET … » (renommable), le second envoi le rejoint', al.kind === 'propose' && lyceeProp?.auto && lyceeProp.parent_id === root?.id && (await autoFile(await doc(`Lycée\nSIRET ${SIRET_C}${PAGE2}`))).kind === 'motif', JSON.stringify([al, lyceeProp?.nom]))
  const d7 = await doc(TEXT_ARTI(3))
  const a7 = await autoFile(d7)
  check('B12 un troisième envoi du même émetteur ne crée PAS un second dossier proposé (même nom, même parent)', a7.kind === 'motif' && (await folders()).filter(f => f.nom === 'ARTILLERY3D SARL').length === 1, JSON.stringify(a7))

  // Un motif `regex` posé à la main (ou par un agent) range aussi, tout seul.
  const lycee = await folder('Lycée')
  await pool.query(`INSERT INTO ged_patterns (folder_id, genre, valeur, auteur_nom) VALUES ($1, 'regex', 'lyc[ée]e\\s+alpha', 'Nicolas')`, [lycee])
  const d8 = await doc(`Courrier\nLYCEE   ALPHA-BETA demande de RIB${PAGE2}`)
  const a8 = await autoFile(d8)
  check('B13 un motif `regex` (bornée, insensible à la casse) range seul : `source=motif` dans Lycée', a8.kind === 'motif' && a8.folderId === lycee && a8.suggestions[0].genres.includes('regex'), JSON.stringify(a8))
  // Les identifiants PROPRES de la boîte : la TVA du destinataire est sur TOUTES les factures reçues.
  const OWN_TVA = NEGATIVE ? 'FR91845210367' : 'FR74912345678'
  await pool.query(`UPDATE ged_mailboxes SET propres = $2::jsonb WHERE account_id = $1`, [ACCOUNT, JSON.stringify([{ genre: 'tva', valeur: OWN_TVA }])])
  const autre = await folder('Autre émetteur')
  const d9 = await doc(`AUTRE EMETTEUR SA\nFacturé à : client TVA ${TVA_A}\nRéf 9${PAGE2}`)
  const r9 = await fileDocument({ documentId: d9, folderId: autre, source: HUMAN_SOURCE, author: NICO })
  const p9 = await patterns(autre)
  check('B15 un identifiant PROPRE de la boîte (TVA du destinataire) n’est pas appris : le dossier n’a que la raison sociale', !r9.learned.some(i => i.genre === 'tva') && p9.map(x => x.genre).join(',') === 'raison_sociale', JSON.stringify(p9))
  const s9 = await suggestionsFor(ACCOUNT, `Inconnu\nTVA ${TVA_A} seule${PAGE2}`)
  check('B16 … ni cherché : un texte qui ne porte que la TVA du destinataire ne désigne AUCUN dossier (FedEx l’avait apprise avant)', s9.length === 0, JSON.stringify(s9))
  await pool.query(`UPDATE ged_mailboxes SET propres = '[]'::jsonb WHERE account_id = $1`, [ACCOUNT])
  const sug = await suggestionsFor(ACCOUNT, TEXT_FEDEX(9))
  check('B14 suggestionsFor lit TOUS les motifs de la boîte : le texte FedEx ne désigne que FedEx (Douane a été vidé)', sug.length === 1 && sug[0].folderId === fedex && sug[0].strong, JSON.stringify(sug))

  console.log('C. la chaîne de réception range au fil de l’OCR')
  const mails = [
    { folder: GED_FOLDER, uid: 500, messageId: '<banc-g4-chain-1@exemple.invalid>', fromAddress: 'copieur@exemple.invalid', subject: '', date: new Date(), attachments: [{ filename: 'f.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF fedex') }] },
    { folder: GED_FOLDER, uid: 501, messageId: '<banc-g4-chain-2@exemple.invalid>', fromAddress: 'copieur@exemple.invalid', subject: '', date: new Date(), attachments: [{ filename: 'n.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF nouveau') }] },
  ]
  const source = { async folders() { return [{ path: GED_FOLDER, uidValidity: '1' }] }, async uids() { return mails.map(m => m.uid) }, async fetchFull(f, uids) { return mails.filter(m => uids.includes(m.uid)) } }
  const page = text => ({ pageCount: 1, pages: [{ index: 0, text, confidence: 90, blank: false }], text })
  const ocr = async buf => page(buf.toString().includes('fedex') ? TEXT_FEDEX(77) : `NOUVEAU FOURNISSEUR EURL\nDevis 1${PAGE2}`)
  const r = await runIntake({ accountId: ACCOUNT, source, ocr })
  const chainDocs = (await pool.query(`SELECT d.id, f.folder_id, f.source FROM ged_documents d LEFT JOIN ged_filings f ON f.document_id = d.id WHERE d.uid IN (500, 501) ORDER BY d.uid`)).rows
  check('C1 runIntake : le PDF FedEx est rangé par motif (filed=1), l’inconnu reçoit un dossier proposé (proposed=1)', r.ocrDone === 2 && r.filed === 1 && r.proposed === 1 && chainDocs[0]?.folder_id === fedex && chainDocs[0].source === 'motif' && chainDocs[1]?.source === 'motif', JSON.stringify([r, chainDocs]))
  check('C2 le dossier proposé « NOUVEAU FOURNISSEUR EURL » existe sous « Nouveaux émetteurs »', (await folders()).some(f => f.nom === 'NOUVEAU FOURNISSEUR EURL' && f.parent_id === root?.id && f.auto))
} finally {
  await pool.query('DELETE FROM users WHERE id = $1', [USER]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['A1', 'A2', 'A3', 'B1', 'B3', 'B4', 'B5', 'B6', 'B7', 'B10', 'B11b', 'B12', 'B14', 'C1']
  const fell = expected.filter(p => failures.some(f => f.startsWith(p)))
  const unexpected = failures.filter(f => !expected.some(p => f.startsWith(p)))
  if (fell.length === expected.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif RATÉ : tombés ${fell.join(', ')} ; inattendus ${unexpected.join(', ')}`); process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nrangement et motifs GED : OK')
