#!/usr/bin/env node
/**
 * Banc de la CHAÎNE DE RÉCEPTION GED (lot G3, décisions 2 et 6) : fausse boîte, faux OCR, faux
 * moteur — aucune connexion IMAP, aucun tesseract, aucun crédit dépensé. Banc DB : il crée un
 * utilisateur et une boîte jetables, et le `DELETE FROM users` du `finally` emporte tout par
 * CASCADE (`ged_*`, `message_tags`, `mailbox_tagging`).
 *
 *   A. la chaîne : chaque PDF devient UN document océrisé, les autres pièces sont ignorées, le
 *      curseur avance et un second passage ne relit rien ;
 *   B. ce qui ne doit PAS être repayé : le même PDF sous un autre UID (déplacement, uidValidity
 *      changée) est RETROUVÉ, jamais réocérisé ; un OCR en échec marque le document sans arrêter
 *      ni le mail ni la boîte ; le budget coupe le passage et la suite reprend au bon mail ;
 *   C. le trieur sur la source GED : un `SourceMail` par document, le texte OCR dans l'état du
 *      moteur (limite GED, pas 1 500), l'extraction T11 sur le texte COMPLET (le montant est en
 *      dernière page) ; un mail sans PDF n'est jamais posé au moteur ; un document `attente`
 *      arrête le lot avant lui.
 *
 * `--negative` : le faux OCR rend un texte VIDE pour tout PDF — A3/A4, C2/C4 et C11/C12 (le groupe
 * GED ne se déclenche pas sans texte) DOIVENT tomber.
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
const intake = await import('../lib/ged/intake.ts')
const { runIntake, GED_FOLDER, GED_BATCH_SIZE, isPdf, gedMailboxStatus, setGedMailbox, requestCatchUp } = intake
const { gedMailSource, documentMessageId } = await import('../lib/ged/source.ts')
const { OCR_STATUS_DONE, OCR_STATUS_FAILED, OCR_STATUS_PENDING } = await import('../lib/ged/model.ts')
const { buildState, GED_STATE_BODY_CHARS, STATE_BODY_CHARS, assumedInputTokensPerMail } = await import('../lib/tagging/engine.ts')
const { DEFAULT_SET, GED_GROUP, valuesOf } = await import('../lib/tagging/questions.ts')
const { groupsForAccount, planPasses } = await import('../lib/tagging/questionGroups.ts')
const runner = await import('../lib/tagging/runner.ts')
const { messageIdOf } = await import('../lib/tagging/store.ts')
const { optionId } = await import('../lib/tagging/fields.ts')

const pool = new pg.Pool({ connectionString: DB_URL })
const MID = n => `<banc-g3-${n}@exemple.invalid>`

// ---- la fausse boîte -------------------------------------------------------------------------
// 4 mails : 1 = un PDF de 3 pages (montant en DERNIÈRE page, IBAN) ; 2 = SANS pièce (mot de
// bienvenue) ; 3 = deux PDF + une image ; 4 = un PDF que l'OCR fera ÉCHOUER.
const PAGE = i => `Page ${i} de la facture FX-2026-00${i}. ` + 'Transport international de colis. '.repeat(40)
const LAST = 'Total à payer : 1 234,56 EUR. Échéance le 15/11/2026. IBAN FR76 3000 6000 0112 3456 7890 189.'
const TEXT_1 = [PAGE(1), PAGE(2), PAGE(3) + LAST].join('\f')
const pdf = (name, marker) => ({ filename: name, contentType: 'application/pdf', content: Buffer.from(`%PDF-1.4 ${marker}`) })
const MAILS = [
  { folder: GED_FOLDER, uid: 1, messageId: MID(1), fromName: 'Copieur', fromAddress: 'copieur@exemple.invalid', subject: '', date: new Date('2026-10-01T08:00:00Z'), attachments: [pdf('doc0001.pdf', 'un')] },
  { folder: GED_FOLDER, uid: 2, messageId: MID(2), fromName: 'Hébergeur', fromAddress: 'hello@exemple.invalid', subject: 'Bienvenue', bodyPlain: 'Votre boîte est prête.', date: new Date('2026-10-01T08:01:00Z'), attachments: [] },
  { folder: GED_FOLDER, uid: 3, messageId: MID(3), fromName: 'Copieur', fromAddress: 'copieur@exemple.invalid', subject: '', date: new Date('2026-10-01T08:02:00Z'),
    attachments: [pdf('doc0002.pdf', 'deux'), { filename: 'logo.png', contentType: 'image/png', content: Buffer.from('png') }, { filename: 'doc0003.PDF', contentType: 'application/octet-stream', content: Buffer.from('%PDF trois') }] },
  { folder: GED_FOLDER, uid: 4, messageId: MID(4), fromName: 'Copieur', fromAddress: 'copieur@exemple.invalid', subject: '', date: new Date('2026-10-01T08:03:00Z'), attachments: [pdf('doc0004.pdf', 'casse')] },
]
const makeSource = (mails = MAILS, uidValidity = '7') => ({
  async folders() { return [{ path: GED_FOLDER, uidValidity, total: mails.length }] },
  async uids() { return mails.map(m => m.uid) },
  async fetch(folder, afterUid, limit) { return mails.filter(m => m.folder === folder && m.uid > afterUid).slice(0, limit) },
  async fetchUids(folder, uids) { return mails.filter(m => m.folder === folder && uids.includes(m.uid)) },
  async fetchFull(folder, uids) { return mails.filter(m => m.folder === folder && uids.includes(m.uid)) },
})
// Le faux OCR : le texte dépend du CONTENU du PDF ; « casse » jette, comme un délai dépassé.
const ocrCalls = []
const fakeOcr = async buf => {
  const s = buf.toString()
  ocrCalls.push(s)
  if (s.includes('casse')) throw new Error('OCR timeout: page 1')
  if (NEGATIVE) return { pageCount: 1, pages: [{ index: 0, text: '', confidence: 0, blank: true }], text: '' }
  if (s.includes(' un')) return { pageCount: 3, pages: [1, 2, 3].map(i => ({ index: i - 1, text: i === 3 ? PAGE(3) + LAST : PAGE(i), confidence: 90 + i, blank: false })), text: TEXT_1 }
  return { pageCount: 2, pages: [{ index: 0, text: `Document ${s}.`, confidence: 88, blank: false }, { index: 1, text: '', confidence: 0, blank: true }], text: `Document ${s}.` }
}

console.log(`\nbanc de la chaîne de réception GED (lot G3)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (OCR muet)' : ''}\n`)
await initDb()

const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const tag = crypto.randomBytes(4).toString('hex')
const USER = (await pool.query(`INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, 'banc g3', $2, 'user', 'active') RETURNING id`,
  [`g3-${tag}@banc-g3.invalid`, bcryptPlaceholder])).rows[0].id
try {
  const ACCOUNT = (await pool.query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1, 'banc g3', $2, 'imap.banc-g3.invalid', 993, true, 'smtp.banc-g3.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
    [USER, `g3-${tag}@banc-g3.invalid`])).rows[0].id
  const docs = async () => (await pool.query(`SELECT message_id, uid, part_idx, filename, ocr_status, ocr_error, ocr_text, pages, confiance, folder FROM ged_documents WHERE account_id = $1 ORDER BY uid, part_idx`, [ACCOUNT])).rows
  const cursor = async () => (await pool.query(`SELECT cursor FROM ged_mailboxes WHERE account_id = $1`, [ACCOUNT])).rows[0]?.cursor

  // ---- A -------------------------------------------------------------------------------
  console.log('A. chaque PDF devient un document océrisé, le curseur avance')
  const r0 = await runIntake({ accountId: ACCOUNT, source: makeSource(), ocr: fakeOcr })
  check('A0 une boîte qui n’est PAS déclarée GED ne fait rien (aucun mail relu, aucun OCR)', r0.mails === 0 && ocrCalls.length === 0, JSON.stringify(r0))
  await pool.query(`INSERT INTO ged_mailboxes (account_id) VALUES ($1)`, [ACCOUNT])
  check('A1 `isPdf` lit le type MIME ou, à défaut, l’extension (le copieur met parfois octet-stream)', isPdf({ contentType: 'application/pdf' }) && isPdf({ contentType: 'application/octet-stream', filename: 'x.PDF' }) && !isPdf({ contentType: 'image/png', filename: 'logo.png' }))
  const r1 = await runIntake({ accountId: ACCOUNT, source: makeSource(), ocr: fakeOcr })
  check('A2 un passage relit les 4 mails : 4 documents (1 + 0 + 2 + 1), 3 OCR faites, 1 en échec', r1.mails === 4 && r1.documents === 4 && r1.ocrDone === 3 && r1.ocrFailed === 1 && !r1.cut, JSON.stringify(r1))
  let d = await docs()
  const d1 = d.find(x => x.message_id === MID(1))
  check('A3 le PDF de 3 pages porte son texte entier, ses 3 pages et sa confiance moyenne des pages lues', d1?.ocr_status === OCR_STATUS_DONE && d1.ocr_text === TEXT_1 && d1.pages === 3 && d1.confiance === 92, JSON.stringify([d1?.ocr_status, d1?.pages, d1?.confiance]))
  check('A4 le mail à deux PDF + une image donne DEUX documents (part_idx 0 et 2), l’image n’en est pas un', d.filter(x => x.message_id === MID(3)).map(x => x.part_idx).join(',') === '0,2' && d.filter(x => x.message_id === MID(3)).every(x => x.ocr_status === OCR_STATUS_DONE && x.ocr_text.length > 0), JSON.stringify(d.filter(x => x.message_id === MID(3)).map(x => [x.part_idx, x.filename, x.ocr_status])))
  check('A5 le mail sans pièce ne laisse aucune ligne', !d.some(x => x.message_id === MID(2)))
  const d4 = d.find(x => x.message_id === MID(4))
  check('A6 l’OCR en échec marque le document `echec` avec sa raison, le passage a continué', d4?.ocr_status === OCR_STATUS_FAILED && /timeout/.test(d4.ocr_error ?? ''), JSON.stringify([d4?.ocr_status, d4?.ocr_error]))
  check('A7 le curseur est au dernier mail du dossier, avec son uidValidity', JSON.stringify(await cursor()) === JSON.stringify({ lastUid: 4, uidValidity: '7' }), JSON.stringify(await cursor()))
  const before = ocrCalls.length
  const r2 = await runIntake({ accountId: ACCOUNT, source: makeSource(), ocr: fakeOcr })
  check('A8 un second passage ne relit rien et ne refait aucune OCR', r2.mails === 0 && ocrCalls.length === before, JSON.stringify(r2))

  // ---- B -------------------------------------------------------------------------------
  console.log('B. ce qui ne doit pas être repayé')
  // La boîte a été réindexée : uidValidity change, les UID aussi (+100). Mêmes mails, mêmes PDF.
  const moved = MAILS.map(m => ({ ...m, uid: m.uid + 100 }))
  const r3 = await runIntake({ accountId: ACCOUNT, source: makeSource(moved, '8'), ocr: fakeOcr })
  d = await docs()
  check('B1 uidValidity changée : les 4 mails sont relus, mais les 3 PDF `fait` sont RETROUVÉS (known=3) et pas réocérisés', r3.mails === 4 && r3.documents === 0 && r3.known === 4 && r3.ocrDone === 0, JSON.stringify(r3))
  check('B2 … seul le document en `echec` est resté tel quel (un échec n’est pas rejoué sans qu’on le demande)', d.find(x => x.message_id === MID(4))?.ocr_status === OCR_STATUS_FAILED && ocrCalls.length === before)
  check('B3 les documents portent le NOUVEL uid (la clé est la pièce jointe, pas l’UID)', d.every(x => x.uid > 100) && JSON.stringify(await cursor()) === JSON.stringify({ lastUid: 104, uidValidity: '8' }), JSON.stringify(d.map(x => x.uid)))
  // Un document remis en `attente` (rejouer un échec) est réocérisé au passage suivant, même connu.
  await pool.query(`UPDATE ged_documents SET ocr_status = $2, ocr_error = NULL WHERE account_id = $1 AND message_id = $3`, [ACCOUNT, OCR_STATUS_PENDING, MID(4)])
  await pool.query(`UPDATE ged_mailboxes SET cursor = NULL WHERE account_id = $1`, [ACCOUNT])
  const r4 = await runIntake({ accountId: ACCOUNT, source: makeSource(moved, '8'), ocr: fakeOcr })
  check('B4 curseur NULL = rattrapage de tout le dossier ; un document remis en `attente` est réocérisé (ici : il échoue encore)', r4.mails === 4 && r4.known === 4 && r4.ocrFailed === 1 && ocrCalls.length === before + 1, JSON.stringify(r4))
  // Le budget : 30 mails, budget 0 ms → le premier mail passe la porte ? Non : la coupure tombe
  // AVANT chaque mail ; avec `now` dans le passé le passage s'arrête sans rien lire.
  const many = Array.from({ length: 2 * GED_BATCH_SIZE + 3 }, (_, i) => ({ ...MAILS[0], uid: 200 + i, messageId: MID(`m${i}`), attachments: [pdf(`m${i}.pdf`, `m${i}`)] }))
  const r5 = await runIntake({ accountId: ACCOUNT, source: makeSource(many, '9'), ocr: fakeOcr, budgetMs: 0 })
  check('B5 budget épuisé : le passage se coupe (`cut`) sans lire un mail, le curseur ne bouge pas', r5.cut && r5.mails === 0 && JSON.stringify(await cursor()) === JSON.stringify({ lastUid: 104, uidValidity: '8' }), JSON.stringify(r5))
  const r6 = await runIntake({ accountId: ACCOUNT, source: makeSource(many, '9'), ocr: fakeOcr })
  check(`B6 avec du budget : ${many.length} mails en ${Math.ceil(many.length / GED_BATCH_SIZE)} lots, ${many.length} documents, curseur au dernier`, r6.mails === many.length && r6.documents === many.length && JSON.stringify(await cursor()) === JSON.stringify({ lastUid: 200 + many.length - 1, uidValidity: '9' }), JSON.stringify(r6))
  await pool.query(`DELETE FROM ged_documents WHERE account_id = $1 AND message_id LIKE $2`, [ACCOUNT, MID('m%')])

  // ---- C -------------------------------------------------------------------------------
  console.log('C. le trieur sur la source GED')
  const ENGINE_ID = (await pool.query(`INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc g3', 'jev', 'http://banc.invalid/v1/systemone', 'banc-1', 1) RETURNING id`, [USER])).rows[0].id
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd) VALUES ($1, $2, 1000)`, [ACCOUNT, ENGINE_ID])
  const asked = []
  const engine = {
    source: 'jev', auteur: { id: ENGINE_ID, nom: 'banc g3' }, usdPerBillionInput: 1,
    async ask(state, posed) {
      asked.push({ state, questions: posed.map(q => q.id) })
      return { model: 'banc-1', rejected: [], inputTokens: assumedInputTokensPerMail(posed.length),
        // `montant_mentionne` = oui pour que l'extraction T11 cherche un montant ; le montant lui-même
        // est DÉSIGNÉ par le moteur (premier candidat, `c1`) parmi ceux que le CODE a trouvés dans le
        // texte OCR — la valeur écrite est celle du candidat, jamais une valeur lue au moteur.
        tags: posed.map(q => ({ question: q.id, valeur: q.id === 'montant_mentionne' || q.id === 'echeance_mentionnee' ? 'oui' : q.id === 'montant' ? optionId(0) : valuesOf(q)[0], probabilites: null, confiance: 0.8 })) }
    },
  }
  const gedSource = gedMailSource(ACCOUNT, makeSource(moved, '8'))
  await runner.startBulk(ACCOUNT)
  const pass = await runner.runPass({ accountId: ACCOUNT, source: gedSource, engine, budgetMs: 10_000 })
  const objects = asked.map(a => a.state)
  check('C1 le passage tague les 3 documents océrisés — pas le mail sans PDF, pas le document en échec', pass.tagged === 3 && pass.errors === 0, JSON.stringify(pass))
  const first = asked.filter(a => a.state.corps.startsWith('Page 1 de la facture'))
  check('C2 l’état du moteur porte le texte OCR à la place du corps, sous la limite GED (> 1 500 caractères, ≤ 12 000)', first.length >= 1 && first[0].state.corps.length > STATE_BODY_CHARS && first[0].state.corps.length <= GED_STATE_BODY_CHARS, `${first[0]?.state.corps.length} caractère(s)`)
  check('C3 `buildState` : un mail ordinaire reste borné à 1 500 ; un document GED l’est à `GED_STATE_BODY_CHARS`', buildState({ bodyPlain: 'x'.repeat(5000) }).corps.length === STATE_BODY_CHARS && buildState({ bodyPlain: 'y', ocrText: 'x'.repeat(20000) }).corps.length === GED_STATE_BODY_CHARS && GED_STATE_BODY_CHARS >= 6000)
  const fields = (await pool.query(`SELECT question, valeur FROM message_fields WHERE account_id = $1 AND message_id = $2 ORDER BY question`, [ACCOUNT, MID(1)])).rows
  const f = Object.fromEntries(fields.map(r => [r.question, r.valeur]))
  check('C4 l’extraction T11 a lu le texte OCR COMPLET : montant (dernière page) + IBAN réduit à 4 caractères, sans l’IBAN entier', f.montant === '1234.56' && f.iban === '0189' && !JSON.stringify(fields).includes('3000 6000'), JSON.stringify(f))
  check('C5 un document à UN PDF garde le Message-ID du mail ; à plusieurs PDF, le rang est suffixé', documentMessageId(MID(1), 0, 1) === MID(1) && documentMessageId(MID(3), 2, 2) === `${MID(3)}#p2`)
  const tagged = (await pool.query(`SELECT DISTINCT message_id FROM message_tags WHERE account_id = $1 AND source = 'jev' ORDER BY 1`, [ACCOUNT])).rows.map(r => r.message_id)
  check('C6 en base : les étiquettes visent les 3 documents (mail 1, mail 3 pièce 0 et pièce 2), rien pour les mails 2 et 4', JSON.stringify(tagged) === JSON.stringify([MID(1), `${MID(3)}#p0`, `${MID(3)}#p2`]), JSON.stringify(tagged))
  check('C7 un mail sans PDF n’est jamais posé au moteur', !objects.some(s => s.objet === 'Bienvenue' || s.corps.includes('prête')))
  // Le jeu de questions GED par défaut (décision 6) : quatre questions dans un groupe conditionnel
  // déclenché par `texte_ocr is_true`, posées en SECONDE requête à un document — jamais au tronc.
  const gedQs = DEFAULT_SET.enabled.filter(q => q.group === GED_GROUP.id).map(q => q.id)
  const plan = planPasses(DEFAULT_SET, await groupsForAccount(ACCOUNT))
  check('C10 le jeu par défaut porte 4 questions GED (type, émetteur, destinataire, marque), hors du tronc, dans le groupe `ged`', gedQs.length === 4 && gedQs.includes('type_document') && !plan.trunk.some(q => q.group === GED_GROUP.id) && plan.conditional.some(g => g.group.id === GED_GROUP.id && g.questions.length === 4), JSON.stringify([gedQs, plan.conditional.map(g => g.group.id)]))
  const doc1Calls = asked.filter(a => a.state.corps.startsWith('Page 1 de la facture'))
  check('C11 un document reçoit le tronc, PUIS les 4 questions GED (déclencheur `texte_ocr`), puis les valeurs T11', doc1Calls.length === 3 && JSON.stringify(doc1Calls[1].questions) === JSON.stringify(gedQs) && !doc1Calls[0].questions.some(q => gedQs.includes(q)), JSON.stringify(doc1Calls.map(c => c.questions.length)))
  const gedTags = (await pool.query(`SELECT question, valeur FROM message_tags WHERE account_id = $1 AND message_id = $2 AND question = ANY($3::text[]) ORDER BY question`, [ACCOUNT, MID(1), gedQs])).rows
  check('C12 en base : les 4 réponses GED du document, dans les valeurs de la taxonomie', gedTags.length === 4 && gedTags.every(t => valuesOf(DEFAULT_SET.questionById(t.question)).includes(t.valeur)), JSON.stringify(gedTags))
  // Un mail ORDINAIRE de la même boîte (pas un document) : les 4 questions GED ne lui sont pas posées.
  const plain = { folder: GED_FOLDER, uid: 999, messageId: MID('plain'), fromName: 'Ami', fromAddress: 'ami@exemple.invalid', subject: 'Bonjour', bodyPlain: 'Un mot sans pièce.', date: new Date() }
  const plainSource = { async folders() { return [{ path: GED_FOLDER, uidValidity: '8', total: 1 }] }, async uids() { return [999] }, async fetch(f, after) { return after < 999 ? [plain] : [] }, async fetchUids() { return [plain] } }
  await runner.startBulk(ACCOUNT, { restart: true })
  await runner.runPass({ accountId: ACCOUNT, source: plainSource, engine, budgetMs: 10_000 })
  const plainCalls = asked.filter(a => a.state.objet === 'Bonjour')
  check('C13 un mail ordinaire (sans texte OCR) ne reçoit PAS les questions GED : une seule requête, le tronc', plainCalls.length === 1 && !plainCalls[0].questions.some(q => gedQs.includes(q)), JSON.stringify(plainCalls.map(c => c.questions.length)))
  // Un document `attente` arrête le lot AVANT lui : le trieur ne doit pas « finir » par-dessus.
  await pool.query(`INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, ocr_status) VALUES ($1, $2, $3, 150, 0, 'att.pdf', $4)`, [ACCOUNT, MID(5), GED_FOLDER, OCR_STATUS_PENDING])
  await pool.query(`INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, ocr_status, ocr_text) VALUES ($1, $2, $3, 160, 0, 'apres.pdf', $4, 'Document après.')`, [ACCOUNT, MID(6), GED_FOLDER, OCR_STATUS_DONE])
  const uidsAfter = await gedSource.fetch(GED_FOLDER, 104, 50)
  check('C8 la source GED s’arrête AVANT un document en `attente` : le document `fait` qui le suit n’est pas rendu', uidsAfter.length === 0, `${uidsAfter.length} mail(s)`)
  await pool.query(`UPDATE ged_documents SET ocr_status = $3 WHERE account_id = $1 AND message_id = $2`, [ACCOUNT, MID(5), OCR_STATUS_FAILED])
  const withMails = [...moved, { ...MAILS[0], uid: 150, messageId: MID(5), attachments: [] }, { ...MAILS[0], uid: 160, messageId: MID(6), attachments: [] }]
  const afterFail = await gedMailSource(ACCOUNT, makeSource(withMails, '8')).fetch(GED_FOLDER, 104, 50)
  check('C9 un document en `echec` est SAUTÉ pour de bon : le suivant est rendu, avec son texte OCR', afterFail.length === 1 && messageIdOf(afterFail[0]) === MID(6) && afterFail[0].ocrText === 'Document après.', JSON.stringify(afterFail.map(m => m.messageId)))

  // ---- D -------------------------------------------------------------------------------
  console.log('D. l’interrupteur GED et le rattrapage (ordres d’état de l’écran / de l’API)')
  // État hérité de B6 (curseur au dernier des 23 mails, uidValidity 9) et de C8/C9 (`apres.pdf` fait, `att.pdf` passé en échec).
  const st1 = await gedMailboxStatus(ACCOUNT)
  check('D1 l’état d’une boîte GED : déclarée, curseur posé, documents comptés par état d’OCR', st1.actif && st1.cursor?.lastUid === 222 && st1.documents.fait === 4 && st1.documents.echec === 2 && st1.documents.attente === 0, JSON.stringify(st1))
  await requestCatchUp(ACCOUNT)
  const st2 = await gedMailboxStatus(ACCOUNT)
  check('D2 rattrapage : le curseur retombe à NULL et les OCR en échec repassent en attente (rien d’autre ne bouge)', st2.cursor === null && st2.documents.attente === 2 && st2.documents.echec === 0 && st2.documents.fait === 4, JSON.stringify(st2))
  const before7 = ocrCalls.length
  const r7 = await runIntake({ accountId: ACCOUNT, source: makeSource(moved, '8'), ocr: fakeOcr })
  // Le PDF « casse » (uid 104) est dans la fausse boîte et échoue encore ; `att.pdf` (uid 150) n’y est pas : il reste en attente.
  check('D3 le passage suivant relit tout, retrouve les 4 PDF (known=4) et ne rejoue QUE l’OCR remise en attente', r7.mails === 4 && r7.known === 4 && r7.documents === 0 && r7.ocrFailed === 1 && ocrCalls.length === before7 + 1, JSON.stringify(r7))
  await setGedMailbox(ACCOUNT, false)
  const r8 = await runIntake({ accountId: ACCOUNT, source: makeSource(moved, '8'), ocr: fakeOcr })
  const st3 = await gedMailboxStatus(ACCOUNT)
  check('D4 boîte retirée de la GED : la chaîne ne fait plus rien, les documents RESTENT', !st3.actif && r8.mails === 0 && st3.documents.fait === 4 && st3.documents.echec === 1 && st3.documents.attente === 1, JSON.stringify([st3, r8]))
  await setGedMailbox(ACCOUNT, true)
  check('D5 redéclarée : active à nouveau, même ligne (le curseur n’a pas été jeté)', (await gedMailboxStatus(ACCOUNT)).actif && JSON.stringify(await cursor()) === JSON.stringify({ lastUid: 104, uidValidity: '8' }), JSON.stringify(await cursor()))
  const st0 = await gedMailboxStatus('00000000-0000-0000-0000-000000000000')
  check('D6 une boîte jamais déclarée : état vide, aucune erreur', !st0.actif && st0.cursor === null && st0.documents.fait === 0, JSON.stringify(st0))
} finally {
  await pool.query('DELETE FROM users WHERE id = $1', [USER]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['A3', 'A4', 'C2', 'C4', 'C11', 'C12']
  const fell = expected.filter(p => failures.some(f => f.startsWith(p)))
  const unexpected = failures.filter(f => !expected.some(p => f.startsWith(p)))
  if (fell.length === expected.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif RATÉ : tombés ${fell.join(', ')} ; inattendus ${unexpected.join(', ')}`); process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nchaîne de réception GED : OK')
