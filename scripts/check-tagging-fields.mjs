#!/usr/bin/env node
/**
 * Banc du lot T11 : l'extraction de VALEURS (décision 19) — montant, échéance, n° de commande,
 * n° de suivi, et « IBAN présent » sans jamais l'IBAN.
 *
 * Banc DB (+ HTTP quand une instance vit). Il crée un utilisateur de banc (`@banc-t11.invalid`),
 * une boîte et un moteur de banc, et les supprime dans son `finally` (étiquettes et valeurs
 * partent en cascade). Aucune connexion IMAP ; la source est fausse, le moteur est un objet du
 * banc qui CAPTURE chaque requête. Aucun crédit dépensé.
 *
 *   node --experimental-strip-types scripts/check-tagging-fields.mjs
 *   node --experimental-strip-types scripts/check-tagging-fields.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. (pur) les regex : les candidats trouvés, les normalisations (« 1 234,56 € » → 1234.56 EUR,
 *      « 15 octobre 2026 » → 2026-10-15, « sous 30 jours » CALCULÉ depuis la date du mail,
 *      un 31/02 écarté), le transporteur déduit du format, l'IBAN validé mod 97 et réduit à 4
 *      caractères ;
 *   B. (DB + faux moteur) le trieur : la 3e requête ne part QUE si `montant_mentionne` /
 *      `echeance_mentionnee` = oui avec des candidats, ou si une regex trouve un numéro ; ses
 *      options SONT les candidats + `aucun` ; la valeur écrite est celle du candidat désigné,
 *      normalisée par le code ; `aucun` n'écrit rien ; l'IBAN s'écrit SANS moteur ;
 *   B9. la base ENTIÈRE est relue : l'IBAN semé n'y figure nulle part (ni `message_fields`, ni
 *      `message_tags`, ni `tagged_messages`) — l'étiquette ne doit pas devenir elle-même une fuite ;
 *   C. (DB) le stockage : une valeur mal formée est refusée AVANT la base ; l'effective est la
 *      `humain` d'abord ;
 *   D. (HTTP) `GET`/`PUT /api/messages/[id]/fields` : 200, 422 qui nomme, 403 sans `tags:write`.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le faux moteur répond `non` à `montant_mentionne` et
 * `echeance_mentionnee` et désigne `aucun` partout, et la clé de banc reçoit TOUTES les portées —
 * B3/B4/B5/B6/B10 (la 3e requête n'emporte plus que le n° trouvé par regex, aucune valeur n'est
 * écrite), C3/D1 (sans ligne de moteur, la correction humaine n'a plus de ligne à côté d'elle)
 * et D4 (le 403 de portée) DOIVENT tomber. B2 tient (« Bonjour » n'avait déjà qu'une requête),
 * B8/B9 tiennent (l'IBAN ne passe par aucun moteur), D5 tient (`humain` par clé est refusé quelle
 * que soit la portée). Ce qu'il démontre : les assertions mesurent la conditionnalité et la
 * désignation, pas la présence du code.
 */
import './alias-resolver.mjs'
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const { DATABASE_URL: DB_URL, SYNAPMAIL_TEST_URL: BASE } = process.env
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
const f = await import('../lib/tagging/fields.ts')
const { amountCandidates, dateCandidates, orderCandidates, trackingCandidates, ibanOf, isIban, extractionFor, fieldsFromAnswers, questionFor, isValidFieldValue, NONE } = f
const { DEFAULT_SET, valuesOf, NOUL_YES, NOUL_NO } = await import('../lib/tagging/questions.ts')
const { writeFields, readFields, InvalidTagError } = await import('../lib/tagging/store.ts')
const { parseAnswer } = await import('../lib/tagging/engine.ts')
const runner = await import('../lib/tagging/runner.ts')
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { users: [], keys: [], engines: [] }

console.log(`\nbanc de l'extraction de valeurs (lot T11)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (le moteur dit non et désigne aucun)' : ''}\n`)

// ---- A. les regex (pur) ------------------------------------------------------------------
console.log('A. les regex trouvent et normalisent, le code calcule')
const am = amountCandidates('Total à régler : 1 234,56 € avant le 15/10/2026. Acompte de 500€ reçu. Prix public $1,299.00.')
check('A1 trois montants, normalisés : 1234.56 EUR, 500 EUR, 1299 USD', JSON.stringify(am.map(c => [c.valeur, c.devise])) === JSON.stringify([['1234.56', 'EUR'], ['500', 'EUR'], ['1299', 'USD']]), JSON.stringify(am))
const mailDate = new Date('2026-09-20T10:00:00Z')
const dm = dateCandidates('Échéance le 15 octobre 2026, livraison prévue le 31/02/2026, paiement sous 30 jours, deadline October 5th, 2026, 2026年11月1日.', mailDate)
check('A2 dates : 2026-10-15, 2026-10-20 (20/09 + 30 j CALCULÉ), 2026-10-05, 2026-11-01 — le 31/02 écarté', JSON.stringify(dm.map(c => c.valeur)) === JSON.stringify(['2026-10-15', '2026-10-05', '2026-11-01', '2026-10-20']), JSON.stringify(dm))
check('A3 sans date de mail, « sous 30 jours » n’est pas un candidat', !dateCandidates('paiement sous 30 jours', null).length)
const om = orderCandidates('Votre commande n° YL-2026-0042 est confirmée. Order #SO12345 shipped.')
check('A4 numéros de commande : YL-2026-0042 et SO12345', JSON.stringify(om.map(c => c.valeur)) === JSON.stringify(['YL-2026-0042', 'SO12345']), JSON.stringify(om))
const tm = trackingCandidates('Suivi UPS 1Z999AA10123456784, Colissimo 6A12345678901, Chronopost XY123456789FR. Appelez le 0612345678.')
check('A5 numéros de suivi avec transporteur déduit du format : ups, colissimo, chronopost — et jamais le téléphone', JSON.stringify(tm.map(c => [c.valeur, c.transporteur])) === JSON.stringify([['1Z999AA10123456784', 'ups'], ['6A12345678901', 'colissimo'], ['XY123456789FR', 'chronopost']]), JSON.stringify(tm))
check('A6 un numéro de 10 chiffres n’est DHL qu’après un mot de suivi', trackingCandidates('numéro de suivi 1234567890')[0]?.transporteur === 'dhl' && !trackingCandidates('tel 1234567890').length)
const IBAN = 'FR76 3000 6000 0112 3456 7890 189'
check('A7 un IBAN valide (mod 97) est reconnu, un IBAN altéré ne l’est pas', isIban(IBAN) && !isIban('FR76 3000 6000 0112 3456 7890 188'))
check('A8 `ibanOf` ne rend que les 4 derniers caractères', ibanOf(`RIB : ${IBAN}`) === '0189' && ibanOf('pas de rib ici') === null)
check('A9 un IBAN collé n’est pas pris pour un numéro de suivi', !trackingCandidates('suivi FR7630006000011234567890189').length)
const q = questionFor('montant', am)
check('A10 la question au moteur a pour options les candidats (c1..c3) + aucun, et `parseAnswer` rejette une valeur hors liste', JSON.stringify(valuesOf(q)) === JSON.stringify(['c1', 'c2', 'c3', NONE]) && parseAnswer(q, { choice: '1234.56' }) === null && parseAnswer(q, { choice: 'c1' })?.valeur === 'c1')
check('A11 `isValidFieldValue` : 2026-02-31 refusé, 1234.56 admis, IBAN entier refusé, 4 caractères admis', !isValidFieldValue('echeance', '2026-02-31') && isValidFieldValue('echeance', '2026-10-15') && isValidFieldValue('montant', '1234.56') && !isValidFieldValue('iban', IBAN.replace(/ /g, '')) && isValidFieldValue('iban', '0189'))
const xNone = extractionFor('Bonjour, merci pour votre message.', [{ question: 'montant_mentionne', valeur: NOUL_YES }], mailDate)
check('A12 `montant_mentionne = oui` SANS candidat regex → aucune question (rien à faire désigner)', xNone.questions.length === 0 && xNone.direct.length === 0)

// ---- B. le trieur -------------------------------------------------------------------------
await initDb()
const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const u = await pool.query(`INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, 'banc t11', $2, 'user', 'active') RETURNING id`,
  [`t11-${crypto.randomBytes(4).toString('hex')}@banc-t11.invalid`, bcryptPlaceholder])
const U1 = u.rows[0].id
created.users.push(U1)
try {
  const A1 = (await pool.query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1, 'banc t11', $2, 'imap.banc-t11.invalid', 993, true, 'smtp.banc-t11.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
    [U1, `t11-${crypto.randomBytes(4).toString('hex')}@banc-t11.invalid`])).rows[0].id
  const eng = await pool.query(`INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc t11', 'jev', 'http://banc.invalid/v1/systemone', 'banc-1', 42) RETURNING id`, [U1])
  const ENGINE_ID = eng.rows[0].id
  created.engines.push(ENGINE_ID)
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd) VALUES ($1, $2, 1000)`, [A1, ENGINE_ID])

  console.log('B. le trieur : une 3e requête seulement quand il y a de quoi désigner')
  const MID = n => `<banc-t11-${n}@exemple.invalid>`
  const MAILS = [
    { folder: 'INBOX', uid: 1, messageId: MID(1), fromName: 'Fournisseur', fromAddress: 'compta@exemple.invalid', subject: 'Facture F-2026-118',
      bodyPlain: `Montant total : 1 234,56 € TTC (dont TVA 205,76 €). Règlement avant le 15/10/2026 par virement sur ${IBAN}. Réf. commande n° YL-2026-0042.`, date: mailDate },
    { folder: 'INBOX', uid: 2, messageId: MID(2), fromName: 'Ami', fromAddress: 'ami@exemple.invalid', subject: 'Bonjour', bodyPlain: 'On se voit bientôt ?', date: mailDate },
    { folder: 'INBOX', uid: 3, messageId: MID(3), fromName: 'Transporteur', fromAddress: 'noreply@exemple.invalid', subject: 'Votre colis est en route',
      bodyPlain: 'Numéro de suivi : 1Z999AA10123456784. Livraison prévue sous 3 jours.', date: mailDate },
  ]
  const source = {
    async folders() { return [{ path: 'INBOX', uidValidity: '1', total: MAILS.length }] },
    async uids() { return MAILS.map(m => m.uid) },
    async fetch(folder, afterUid, limit) { return MAILS.filter(m => m.uid > afterUid).slice(0, limit) },
    async fetchUids(folder, uids) { return MAILS.filter(m => uids.includes(m.uid)) },
  }
  const asked = []
  // Le faux moteur : « Facture » mentionne un montant et une échéance, à payer ; il désigne le
  // PREMIER candidat de chaque champ (c1) et `paiement` comme type d'échéance. Les nouls du
  // tronc répondent `non` sauf pour la facture. En négatif : tout `non`, et `aucun` partout.
  const engine = {
    source: 'jev', auteur: { id: ENGINE_ID, nom: 'banc t11' }, usdPerBillionInput: 42,
    async ask(state, posed) {
      asked.push({ objet: state.objet, questions: posed.map(q => q.id), options: posed.map(q => valuesOf(q)) })
      const facture = /^Facture/.test(state.objet)
      return { model: 'banc-1', rejected: [], inputTokens: 100 * posed.length, tags: posed.map(q => {
        if (q.type === 'noul') return { question: q.id, valeur: !NEGATIVE && facture && ['montant_mentionne', 'echeance_mentionnee'].includes(q.id) ? NOUL_YES : NOUL_NO, probabilites: null, confiance: 0.8 }
        const values = valuesOf(q)
        let valeur = values[0]
        if (q.id === 'sens_flux') valeur = facture ? 'a_payer' : 'aucun'
        if (['montant', 'echeance', 'numero_commande', 'numero_suivi'].includes(q.id)) valeur = NEGATIVE ? NONE : 'c1'
        if (q.id === 'type_echeance') valeur = NEGATIVE ? NONE : 'paiement'
        return { question: q.id, valeur, probabilites: null, confiance: 0.8 }
      }) }
    },
  }
  await runner.startBulk(A1)
  const pass = await runner.runPass({ accountId: A1, source, engine, budgetMs: 5_000 })
  check('B1 le passage traite les 3 mails sans erreur', pass.tagged === 3 && pass.errors === 0, JSON.stringify(pass))
  const calls = objet => asked.filter(a => a.objet === objet)
  check('B2 « Bonjour » (rien à extraire) : UNE requête, le tronc seul', calls('Bonjour').length === 1, `${calls('Bonjour').length} requête(s)`)
  const fact = calls('Facture F-2026-118')
  check('B3 « Facture » : DEUX requêtes, la seconde = montant + echeance + type_echeance + numero_commande', fact.length === 2 && JSON.stringify(fact[1]?.questions) === JSON.stringify(['montant', 'echeance', 'type_echeance', 'numero_commande']), `${fact.length} requête(s) : ${JSON.stringify(fact[1]?.questions)}`)
  check('B4 les options de `montant` SONT les candidats + aucun (c1, c2, aucun : 1 234,56 € et 205,76 €)', JSON.stringify(fact[1]?.options[0]) === JSON.stringify(['c1', 'c2', NONE]), JSON.stringify(fact[1]?.options[0]))
  const { effective } = await readFields(A1, MID(1))
  const val = champ => effective.find(x => x.question === champ)?.valeur
  check('B5 en base, « Facture » : montant 1234.56 EUR à payer, échéance 2026-10-15 (paiement), commande YL-2026-0042', val('montant') === '1234.56' && val('devise') === 'EUR' && val('type_montant') === 'a_payer' && val('echeance') === '2026-10-15' && val('type_echeance') === 'paiement' && val('numero_commande') === 'YL-2026-0042', JSON.stringify(effective.map(x => [x.question, x.valeur])))
  const colis = calls('Votre colis est en route')
  const colisFields = (await readFields(A1, MID(3))).effective
  const cval = champ => colisFields.find(x => x.question === champ)?.valeur
  check('B6 « Colis » : la regex trouve un n° de suivi → 2e requête, UPS déduit du format, pas d’échéance (noul = non)', colis.length === 2 && JSON.stringify(colis[1]?.questions) === JSON.stringify(['numero_suivi']) && cval('numero_suivi') === '1Z999AA10123456784' && cval('transporteur_suivi') === 'ups' && cval('echeance') === undefined, `${colis.length} requête(s) ${JSON.stringify(colisFields.map(x => [x.question, x.valeur]))}`)
  check('B7 « Bonjour » n’a aucune valeur en base', !(await readFields(A1, MID(2))).effective.length)
  check('B8 l’IBAN est écrit SANS moteur : 4 derniers caractères, signé du moteur de la boîte', val('iban') === '0189' && effective.find(x => x.question === 'iban')?.source === 'jev', val('iban'))
  const leak = IBAN.replace(/ /g, '')
  const everywhere = await pool.query(
    `SELECT (SELECT COUNT(*) FROM message_fields WHERE valeur LIKE $1 OR candidats::text LIKE $1)
          + (SELECT COUNT(*) FROM message_tags WHERE valeur LIKE $1 OR probabilites::text LIKE $1)
          + (SELECT COUNT(*) FROM tagged_messages WHERE subject LIKE $1) AS n`, [`%${leak.slice(0, 12)}%`])
  check('B9 la base ENTIÈRE relue : aucune colonne ne contient les 12 premiers caractères de l’IBAN semé', Number(everywhere.rows[0].n) === 0, `${everywhere.rows[0].n} ligne(s)`)
  check('B10 `candidats` de `montant` garde les 2 montants que les regex avaient trouvés', effective.find(x => x.question === 'montant')?.candidats?.length === 2)
  const again = await runner.runPass({ accountId: A1, source, engine, budgetMs: 5_000 })
  check('B11 un second passage ne refait rien (0 appel) : les valeurs suivent le saut des étiquettes', again.calls === 0, `${again.calls}`)

  // ---- C. le stockage -----------------------------------------------------------------
  console.log('C. le stockage : la porte d’entrée et l’effective')
  const AUTH = { id: U1, nom: 'banc' }
  const bad = await writeFields({ accountId: A1, messageId: MID(1), source: 'humain', auteur: AUTH, fields: [{ champ: 'echeance', valeur: '31/02/2026' }] }).then(() => null, e => e)
  check('C1 une date mal formée est un `InvalidTagError` qui la nomme, avant la base', bad instanceof InvalidTagError && bad.question === 'echeance')
  const badIban = await writeFields({ accountId: A1, messageId: MID(1), source: 'humain', auteur: AUTH, fields: [{ champ: 'iban', valeur: leak }] }).then(() => null, e => e)
  check('C2 un IBAN entier est refusé même par une main', badIban instanceof InvalidTagError)
  await writeFields({ accountId: A1, messageId: MID(1), source: 'humain', auteur: AUTH, validePar: U1, fields: [{ champ: 'montant', valeur: '205.76' }] })
  const after = await readFields(A1, MID(1))
  check('C3 une correction humaine devient l’effective, la ligne du moteur reste lisible', after.effective.find(x => x.question === 'montant')?.valeur === '205.76' && after.fields.filter(x => x.question === 'montant').length === 2)

  // ---- D. les routes ------------------------------------------------------------------
  const alive = BASE ? await fetch(`${BASE}/login`).then(r => r.status === 200).catch(() => false) : false
  if (!alive) {
    console.log(`D. les routes — SAUTÉ (pas de serveur de dev sur ${BASE ?? '<SYNAPMAIL_TEST_URL non renseigné>'})`)
  } else {
    console.log('D. les routes')
    const makeKey = async scopes => {
      const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
      const row = await pool.query(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
         VALUES ($1, 'banc t11', $2, $3, $4::text[], NOW(), NOW()) RETURNING id`,
        [U1, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest('hex'), NEGATIVE ? ALL_SCOPES : scopes])
      created.keys.push(row.rows[0].id)
      await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2)', [row.rows[0].id, A1])
      return raw
    }
    const call = async (path, { method = 'GET', key, body } = {}) => {
      const headers = { authorization: `Bearer ${key}` }
      if (body) headers['content-type'] = 'application/json'
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body) })
      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* rapporté via text */ }
      return { status: res.status, body: parsed, text }
    }
    const P = `/api/messages/${encodeURIComponent(MID(1))}/fields`
    const writer = await makeKey(['tags:read', 'tags:write'])
    const reader = await makeKey(['tags:read'])
    const got = await call(`${P}?account=${A1}`, { key: reader })
    check('D1 `GET …/fields` rend `{ data: { fields, effective } }` avec le montant corrigé en effective', got.status === 200 && got.body?.data?.effective?.find(x => x.question === 'montant')?.valeur === '205.76' && got.body.data.fields.length > got.body.data.effective.length, `${got.status} ${got.text.slice(0, 160)}`)
    const put = await call(P, { method: 'PUT', key: writer, body: { accountId: A1, source: 'jev', engineId: ENGINE_ID, fields: [{ champ: 'numero_suivi', valeur: 'XY123456789FR' }, { champ: 'transporteur_suivi', valeur: 'chronopost' }] } })
    check('D2 un PUT valide par clé écrit en `jev` signé du moteur nommé', put.status === 200 && put.body?.data?.written === 2 && put.body.data.effective.find(x => x.question === 'numero_suivi')?.auteurId === ENGINE_ID, `${put.status} ${put.text.slice(0, 160)}`)
    const bad422 = await call(P, { method: 'PUT', key: writer, body: { accountId: A1, source: 'jev', fields: [{ champ: 'montant', valeur: 'douze' }] } })
    check('D3 une valeur mal formée est un 422 qui NOMME `montant`', bad422.status === 422 && bad422.body?.question === 'montant', `${bad422.status} ${bad422.text.slice(0, 120)}`)
    const noWrite = await call(P, { method: 'PUT', key: reader, body: { accountId: A1, source: 'jev', fields: [{ champ: 'devise', valeur: 'EUR' }] } })
    check('D4 une clé sans `tags:write` est refusée par un 403 qui nomme la portée', noWrite.status === 403 && noWrite.body?.missingScope === 'tags:write', `${noWrite.status} ${noWrite.text.slice(0, 120)}`)
    const human = await call(P, { method: 'PUT', key: writer, body: { accountId: A1, source: 'humain', fields: [{ champ: 'devise', valeur: 'EUR' }] } })
    check('D5 une clé qui demande `humain` est un 403 qui nomme la source', human.status === 403 && human.body?.source === 'humain', `${human.status}`)
  }
} finally {
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.engines) await pool.query('DELETE FROM decision_engines WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['B3', 'B4', 'B5', 'B6', 'B10', 'C3', 'D1', 'D4']
  const fell = failures.map(x => x.split(' ')[0]).filter(k => expected.includes(k))
  const unexpected = failures.filter(x => !expected.includes(x.split(' ')[0]))
  const want = BASE ? expected : expected.filter(k => !k.startsWith('D'))
  if (fell.length === want.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif : attendu ${want.join(', ')}, tombés ${fell.join(', ') || 'aucun'}, inattendus ${unexpected.join(' | ') || 'aucun'}`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nextraction de valeurs : OK')
