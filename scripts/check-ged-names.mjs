#!/usr/bin/env node
/**
 * Banc du NOM d'un dossier proposé (lot N1) : un en-tête sans forme juridique nomme le dossier par
 * son ORGANISME (« LYCÉE … », « FINANCES PUBLIQUES ») et non plus par un numéro (« SIRET 1967… »).
 * Faux textes OCR fabriqués ici — aucun vrai document, aucun nom réel.
 *
 *   A. `organisationOf` (module pur) : première ligne trouvée dans l'ordre de lecture, lue à partir
 *      du mot d'organisme, bruit OCR retiré, majuscules ; une ligne de 90 caractères est ignorée ;
 *      un bloc destinataire « Service Comptabilité » ne nomme rien ; sans mot d'organisme → null ;
 *      un mot d'organisme suivi de « : » (« Banque : EXEMPLE BANK », « Agence : … ») est l'étiquette
 *      d'un champ, pas un nom (lot N1b, faux positif mesuré sur un bloc de règlement) ;
 *   B. `proposedFolderName` : la raison sociale reste prioritaire, le repli « SIRET … » reste tel quel ;
 *   C. (base) le dossier proposé apprend EXACTEMENT le même identifiant qu'avant : le SIRET, jamais
 *      le nom d'organisme. Banc DB jetable : le `DELETE FROM users` du `finally` emporte tout par CASCADE.
 *      Sans DATABASE_URL, C est SAUTÉ et le dit.
 *
 * `--negative` : l'ANCIENNE règle de nommage (`raison sociale ?? GENRE valeur`) remplace la nouvelle dans
 * le banc : B2 (le nom attendu) et C1 (le nom que la base a VRAIMENT reçu ne suit plus cette règle) DOIVENT
 * tomber ; et `organisationOf` lit comme avant N1b, où « : » ne voulait rien dire (A10, A11, B5 tombent) ;
 * le reste de A (inchangé par le remplacement) et C2 (l'apprentissage) tiennent dans les deux modes.
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const NEGATIVE = process.argv.includes('--negative')
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const patterns = await import('../lib/ged/patterns.ts')
const { identifiersOf, namerOf } = patterns
/** En `--negative`, la lecture d'avant N1b : le « : » après un mot d'organisme ne voulait rien dire. */
const organisationOf = NEGATIVE ? text => patterns.organisationOf(text.replace(/:/g, ' ')) : patterns.organisationOf
/** En `--negative`, la règle d'avant le lot N1 : l'organisme de l'en-tête n'existe pas. */
const oldName = (text, namer) => namer.genre === 'raison_sociale' ? namer.valeur : `${namer.genre.toUpperCase()} ${namer.valeur}`
const proposedFolderName = NEGATIVE ? oldName : patterns.proposedFolderName

// ---- les faux textes OCR ------------------------------------------------------------------
const SIRET = '196 712 345 00012'
const PAGE2 = '\fPage 2. Académie fantôme, jamais lue. '
const TEXT_LYCEE = `Ex Lycée des Métiers — UFA Jean-Moulin\nACADEMIE DE NULLE-PART\n12 rue du Banc\nSIRET ${SIRET}\nDemande de RIB${PAGE2}`
const TEXT_FISC = `Ê{gb:[çîî' FINANCES PUBLIQUES\nDirection générale\nAvis d'imposition\nIBAN FR76 3000 6000 0112 3456 7890 189${PAGE2}`
const TEXT_SAS = `EXEMPLE TRANSPORT FR SAS\nCentre de tri du banc\nSIRET ${SIRET}${PAGE2}`
const TEXT_DEST = `Service Comptabilité\nBP 1\nSIRET ${SIRET}${PAGE2}`
const LONG = `Lycée ${'x'.repeat(84)}`
const TEXT_LONG = `${LONG}\nSIRET ${SIRET}${PAGE2}`
const TEXT_NONE = `Relevé sans en-tête\nSIRET ${SIRET}${PAGE2}`
const TEXT_BANK = `Règlement par virement\nBanque : EXEMPLE BANK\nCentre de formation du banc\nSIRET ${SIRET}${PAGE2}`
const TEXT_LABEL = `Agence : Nulle-Part\nSIRET ${SIRET}${PAGE2}`

console.log(`\nbanc du nom d'un dossier proposé (lot N1)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (ancienne règle de nommage)' : ''}\n`)

console.log('A. le nom d’organisme de l’en-tête (module pur)')
check('A1 lettre d’établissement : « Ex Lycée … » AVANT « ACADEMIE DE … » → la PREMIÈRE ligne, à partir du mot, en majuscules',
  organisationOf(TEXT_LYCEE) === 'LYCÉE DES MÉTIERS — UFA JEAN-MOULIN', JSON.stringify(organisationOf(TEXT_LYCEE)))
check('A2 avis fiscal : le bruit OCR qui précède tombe → « FINANCES PUBLIQUES »',
  organisationOf(TEXT_FISC) === 'FINANCES PUBLIQUES', JSON.stringify(organisationOf(TEXT_FISC)))
check('A3 bloc destinataire « Service Comptabilité » : ne nomme rien', organisationOf(TEXT_DEST) === null, JSON.stringify(organisationOf(TEXT_DEST)))
check(`A4 une ligne de ${LONG.length} caractères est ignorée`, LONG.length === 90 && organisationOf(TEXT_LONG) === null, JSON.stringify(organisationOf(TEXT_LONG)))
check('A5 aucun mot d’organisme → null', organisationOf(TEXT_NONE) === null, JSON.stringify(organisationOf(TEXT_NONE)))
check('A6 la page 2 n’est jamais lue (« Académie » après le `\\f`)', organisationOf(`Relevé${PAGE2}`) === null)
check('A7 mot ENTIER, sans casse ni accents : « Centrer » et « Agences » ne valent rien, « ecole » vaut « école »',
  organisationOf('Centrer la page\nAgences partout') === null && organisationOf('ecole du banc') === 'ECOLE DU BANC')
check('A8 jetons de fin à moins de 50 % de lettres retirés, ponctuation de bord, ≤ 60 caractères',
  organisationOf(`Mairie de Nulle-Part |]'. ,,`) === 'MAIRIE DE NULLE-PART' && organisationOf(`Université ${'a'.repeat(60)}`)?.length === 60)
check('A9 un mot d’organisme en deux mots (« ville de ») se lit à partir du premier', organisationOf('La Ville de Nulle-Part') === 'VILLE DE NULLE-PART')
check('A10 « Banque : EXEMPLE BANK » AVANT la ligne d’organisme : l’étiquette de champ ne compte pas → l’organisme, jamais la banque',
  organisationOf(TEXT_BANK) === 'CENTRE DE FORMATION DU BANC' && organisationOf(TEXT_BANK.replace('Banque : ', 'Banque: ')) === 'CENTRE DE FORMATION DU BANC', JSON.stringify(organisationOf(TEXT_BANK)))
check('A11 une ligne « Agence : … » seule → null (avec ou sans espace avant le « : », mot en deux mots compris)',
  organisationOf(TEXT_LABEL) === null && organisationOf('Agence: Nulle-Part') === null && organisationOf('Finances publiques : avis') === null, JSON.stringify(organisationOf(TEXT_LABEL)))

console.log('B. le nom du dossier proposé')
const nameOf = text => proposedFolderName(text, namerOf(identifiersOf(text)))
check('B1 facture « EXEMPLE TRANSPORT FR SAS » : la raison sociale reste prioritaire (« Centre de tri » ignoré)', nameOf(TEXT_SAS) === 'EXEMPLE TRANSPORT FR SAS', nameOf(TEXT_SAS))
check('B2 lettre d’établissement → « LYCÉE DES MÉTIERS — UFA JEAN-MOULIN » et non plus « SIRET 1967… »', nameOf(TEXT_LYCEE) === 'LYCÉE DES MÉTIERS — UFA JEAN-MOULIN', nameOf(TEXT_LYCEE))
check('B3 aucun mot d’organisme → repli « SIRET … » inchangé', nameOf(TEXT_NONE) === 'SIRET 19671234500012', nameOf(TEXT_NONE))
check('B4 bloc destinataire seul → repli « SIRET … »', nameOf(TEXT_DEST) === 'SIRET 19671234500012', nameOf(TEXT_DEST))
check('B5 facture sans forme juridique, « Banque : … » avant l’organisme → « CENTRE DE FORMATION DU BANC », jamais la banque', nameOf(TEXT_BANK) === 'CENTRE DE FORMATION DU BANC', nameOf(TEXT_BANK))

console.log('C. ce que le dossier proposé APPREND (inchangé)')
if (!process.env.DATABASE_URL) {
  console.log('  SAUTÉ (pas de DATABASE_URL)')
} else {
  const pg = (await import('pg')).default
  const { initDb } = await import('../lib/db.ts')
  const { autoFile } = await import('../lib/ged/filing.ts')
  const { GED_FOLDER } = await import('../lib/ged/intake.ts')
  const { OCR_STATUS_DONE } = await import('../lib/ged/model.ts')
  await initDb()
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const tag = crypto.randomBytes(4).toString('hex')
  const USER = (await pool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'banc n1', 'x', 'user') RETURNING id`, [`n1-${tag}@banc-n1.invalid`])).rows[0].id
  try {
    const ACCOUNT = (await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1, 'banc n1', $2, 'imap.banc-n1.invalid', 993, true, 'smtp.banc-n1.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
      [USER, `n1-${tag}@banc-n1.invalid`])).rows[0].id
    await pool.query(`INSERT INTO ged_mailboxes (account_id) VALUES ($1)`, [ACCOUNT])
    const docId = (await pool.query(
      `INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, ocr_status, ocr_text, pages) VALUES ($1, $2, $3, 1, 0, 'doc.pdf', $4, $5, 2) RETURNING id`,
      [ACCOUNT, `<banc-n1-${tag}@exemple.invalid>`, GED_FOLDER, OCR_STATUS_DONE, TEXT_LYCEE])).rows[0].id
    const out = await autoFile(docId)
    const folder = (await pool.query(`SELECT nom FROM ged_folders WHERE id = $1`, [out.folderId])).rows[0]
    const learned = (await pool.query(`SELECT genre, valeur FROM ged_patterns WHERE folder_id = $1`, [out.folderId])).rows
    // L'identifiant appris est celui d'AVANT le lot : le premier identifiant fort du texte (le SIRET), et rien d'autre.
    const expected = namerOf(identifiersOf(TEXT_LYCEE))
    check('C1 le dossier proposé est nommé par l’organisme…', out.kind === 'propose' && folder?.nom === nameOf(TEXT_LYCEE), JSON.stringify([out.kind, folder]))
    check('C2 … mais apprend EXACTEMENT le même identifiant qu’avant : un seul motif, `siret` 19671234500012 — jamais le nom', learned.length === 1 && learned[0].genre === 'siret' && learned[0].valeur === '19671234500012' && expected.genre === learned[0].genre && expected.valeur === learned[0].valeur, JSON.stringify([expected, learned]))
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [USER]).catch(() => {})
    await pool.end()
  }
}

if (NEGATIVE) {
  const expected = ['A10', 'A11', 'B2', 'B5', 'C1']
  const fell = expected.filter(p => failures.some(f => f.startsWith(p)))
  const unexpected = failures.filter(f => !expected.some(p => f.startsWith(p)))
  if (fell.length === expected.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif RATÉ : tombés ${fell.join(', ')} ; inattendus ${unexpected.join(', ')}`); process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nnom d’un dossier proposé : OK')
