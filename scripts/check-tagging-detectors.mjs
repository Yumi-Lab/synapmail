#!/usr/bin/env node
/**
 * Banc du lot T11b : la détection des DIVULGATIONS — par programme (étage A, source `regle`)
 * et par moteur (étage B, cinq nouls atomiques à la place de `donnees_sensibles`).
 *
 * Banc DB (+ HTTP quand une instance vit). Il crée un utilisateur de banc (`@banc-t11b.invalid`),
 * une boîte et un moteur de banc, et les supprime dans son `finally` (étiquettes en cascade).
 * Aucune connexion IMAP ; la source est fausse, le moteur est un objet du banc qui CAPTURE
 * chaque requête. Aucun crédit dépensé.
 *
 *   node --experimental-strip-types scripts/check-tagging-detectors.mjs
 *   node --experimental-strip-types scripts/check-tagging-detectors.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. (pur) chaque détecteur sur des motifs semés et sur des leurres : téléphone FR/CN/E.164,
 *      e-mail tiers (expéditeur et destinataires exclus), IBAN mod 97 (altéré = non), carte
 *      Luhn (altérée = non), secrets (chaque motif de GOAL.md) ; un détecteur ne rend QUE
 *      `oui`/`non` + `{occurrences}` — aucune valeur ;
 *   B. (pur) la séparation moteur / programme : `regle` ∈ TAG_SOURCES et ∉ ENGINES ;
 *      `sourceForWriter` la REFUSE à une clé comme à une session ; `engineBodyFor` refuse un
 *      détecteur ; `posed` ne le rend jamais ; `enabled` ne le contient pas ; la taxonomie est
 *      passée de 49 à 53 (`donnees_sensibles` partie, cinq nouls arrivés, `demande_identifiants`
 *      restée) et `TAXONOMY_VERSION` a changé ;
 *   C. (DB + faux moteur) le trieur : un mail avec les cinq motifs reçoit cinq `oui` en `regle`,
 *      signés du détecteur ; un mail propre reçoit cinq `non` ; AUCUNE requête au moteur ne
 *      porte un détecteur ; le moteur reçoit bien les cinq nouls de l'étage B et pas
 *      `donnees_sensibles` ;
 *   C9. la base ENTIÈRE est relue : AUCUNE des valeurs semées (téléphone, e-mail, IBAN, carte,
 *      clé d'API, jeton…) n'apparaît dans AUCUNE colonne de `message_tags`, `message_fields`
 *      (hors les 4 derniers de l'IBAN, lot T11) ni `tagged_messages` ;
 *   D. (DB) les gardes d'écriture : un moteur (`writeTags` source `jev`) ne peut pas écrire un
 *      détecteur ; une règle d'étiquetage ne peut pas le poser ; une main PEUT le corriger ;
 *      le filtre `origine=regle` rend le mail détecté ;
 *   E. (HTTP) `PUT /api/messages/[id]/tags` par clé avec `source: 'regle'` → 403 qui la nomme ;
 *      `POST /api/tags/questions` avec un id de détecteur → 400 `reserved_id`.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les détecteurs sont NEUTRALISÉS (le trieur reçoit un texte
 * vidé de ses motifs — on simule un détecteur qui ne verrait rien) et le faux moteur répond `non`
 * partout. A tient (pur), B tient (structure), mais C2 (cinq `oui`), C6 et C11 (le groupe
 * `security`, déclenché par un détecteur, n'est plus posé) et D4 (filtre `regle`) DOIVENT tomber ; C9 tient (rien de semé → rien à fuir,
 * ce qui est bien ce qu'il mesure, pas la présence du code). Ce qu'il démontre : C2/C6/C11/D4
 * mesurent une détection, pas la présence d'une ligne.
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
const det = await import('../lib/tagging/detectors.ts')
const { detect, countPhones, countThirdPartyEmails, countIbans, countCards, countSecrets, isLuhn, tagOf, OCCURRENCES_KEY } = det
const questions = await import('../lib/tagging/questions.ts')
const { DEFAULT_SET, DEFAULT_QUESTIONS, RULE_QUESTIONS, RULE_QUESTION_IDS, isRuleQuestionId, engineBodyFor, NOUL_YES, NOUL_NO, questionSet } = questions
const { TAG_SOURCES, ENGINES, RULE_SOURCE, HUMAN_SOURCE } = await import('../lib/tagging/engine.ts')
const store = await import('../lib/tagging/store.ts')
const { sourceForWriter, ForbiddenSourceError, InvalidTagError, writeTags, readTags, filterByTag, taxonomyVersion } = store
const { validateTagRule, InvalidTagRuleError } = await import('../lib/tagging/tagRules.ts')
const runner = await import('../lib/tagging/runner.ts')
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { users: [], keys: [], engines: [] }

console.log(`\nbanc des détecteurs de divulgation (lot T11b)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (motifs retirés du texte)' : ''}\n`)

// ---- les motifs semés -------------------------------------------------------------------
const SEED = {
  phoneFr: '+33 6 12 34 56 78', phoneFr2: '01.44.55.66.77', phoneCn: '+86 138 0013 8000', phoneE164: '+41791234567',
  email: 'tiers.secret@exemple-tiers.invalid',
  iban: 'FR76 3000 6000 0112 3456 7890 189', ibanBad: 'FR76 3000 6000 0112 3456 7890 188',
  card: '4539 1488 0343 6467', cardBad: '4539 1488 0343 6468',
  sk: 'sk-' + 'A1b2C3d4'.repeat(4), apikey: 'apikey_' + 'a1b2c3d4e5'.repeat(3), syn: 'syn_' + 'ab'.repeat(24),
  akia: 'AKIAIOSFODNN7EXAMPLE', ghp: 'ghp_' + 'x9Y8z7W6'.repeat(4) + 'abcd', xox: 'xoxb-1234567890-abcdefghijk',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', pem: '-----BEGIN RSA PRIVATE KEY-----',
}
const FROM = 'compta@exemple.invalid', TO = 'nicolas@banc-t11b.invalid'

// ---- A. les détecteurs, purs ----------------------------------------------------------------
console.log('A. les détecteurs, purs')
check('A1 téléphones : FR +33, FR 0X, CN +86, E.164 → 4 ; un n° de commande de 8 chiffres ou une date → 0',
  countPhones(`Tél ${SEED.phoneFr} ou ${SEED.phoneFr2}, 手机 ${SEED.phoneCn}, Suisse ${SEED.phoneE164}`) === 4 && countPhones('commande 12345678 du 15/10/2026, total 1 234,56 €') === 0,
  String(countPhones(`Tél ${SEED.phoneFr} ou ${SEED.phoneFr2}, 手机 ${SEED.phoneCn}, Suisse ${SEED.phoneE164}`)))
check('A2 le même numéro écrit deux fois (+33 6… et 06…) compte UNE occurrence', countPhones('+33 6 12 34 56 78 / 06 12 34 56 78') === 1)
check('A3 e-mail tiers : l’expéditeur et les destinataires sont EXCLUS, le tiers compte, la casse est ignorée',
  countThirdPartyEmails(`De ${FROM} à ${TO}, copie ${SEED.email} et ${SEED.email.toUpperCase()}`, [FROM, TO]) === 1 && countThirdPartyEmails(`${FROM} ${TO}`, [FROM, TO]) === 0)
check('A4 IBAN : un valide (mod 97) compte, un altéré ne compte pas', countIbans(`RIB ${SEED.iban}`) === 1 && countIbans(`RIB ${SEED.ibanBad}`) === 0)
check('A5 carte : Luhn valide compte, altérée non ; 13-19 chiffres avec espaces ou tirets', isLuhn('4539148803436467') && countCards(`CB ${SEED.card}`) === 1 && countCards(`CB ${SEED.cardBad}`) === 0 && countCards('5555-5555-5555-4444') === 1)
check('A6 un IBAN ou un téléphone n’est pas pris pour une carte', countCards(`${SEED.iban} ${SEED.phoneFr}`) === 0)
const secrets = Object.entries(SEED).filter(([k]) => ['sk', 'apikey', 'syn', 'akia', 'ghp', 'xox', 'jwt', 'pem'].includes(k))
for (const [k, v] of secrets) check(`A7 secret \`${k}\` détecté`, countSecrets(`clé : ${v}`) === 1, v)
check('A8 secrets : un mot ordinaire, un hash court ou une URL ne comptent pas', countSecrets('skills, apikey=, syn_123, AKIA, ghp, eyJ.eyJ, https://x.invalid/a/b') === 0)
const full = `Objet\nTél ${SEED.phoneFr}, contact ${SEED.email}, RIB ${SEED.iban}, CB ${SEED.card}, clé ${SEED.sk}`
const ds = detect({ subject: 'Objet', text: full, fromAddress: FROM, recipients: [TO] })
check('A9 `detect` rend les CINQ détecteurs, dans l’ordre de `RULE_QUESTIONS`, tous à 1 occurrence',
  JSON.stringify(ds.map(d => [d.question, d.occurrences])) === JSON.stringify(RULE_QUESTION_IDS.map(id => [id, 1])), JSON.stringify(ds))
const dsEmpty = detect({ text: 'Bonjour, merci.', fromAddress: FROM })
check('A10 un mail propre rend cinq détecteurs à 0', dsEmpty.every(d => d.occurrences === 0) && dsEmpty.length === 5)
const t1 = tagOf(ds[0]), t0 = tagOf(dsEmpty[0])
check('A11 `tagOf` : `oui` + {occurrences} / `non` + null — et jamais une autre clé',
  t1.valeur === NOUL_YES && JSON.stringify(t1.probabilites) === JSON.stringify({ [OCCURRENCES_KEY]: 1 }) && t0.valeur === NOUL_NO && t0.probabilites === null)
const leaks = Object.values(SEED).map(v => v.replace(/[ .-]/g, ''))
check('A12 ce que `detect` + `tagOf` rendent ne contient AUCUNE valeur semée',
  !leaks.some(v => JSON.stringify(ds.map(tagOf)).replace(/[ .-]/g, '').includes(v.slice(0, 10))))

// ---- B. séparation moteur / programme ----------------------------------------------------------
console.log('B. la séparation moteur / programme')
check('B1 `regle` ∈ TAG_SOURCES et ∉ ENGINES', TAG_SOURCES.includes(RULE_SOURCE) && !ENGINES.includes(RULE_SOURCE))
const byKey = (() => { try { sourceForWriter({ session: false, requested: RULE_SOURCE }); return null } catch (e) { return e } })()
const bySession = (() => { try { sourceForWriter({ session: true, requested: RULE_SOURCE }); return null } catch (e) { return e } })()
check('B2 `sourceForWriter` REFUSE `regle` à une clé ET à une session, en la nommant', byKey instanceof ForbiddenSourceError && byKey.source === RULE_SOURCE && bySession instanceof ForbiddenSourceError && bySession.source === RULE_SOURCE)
check('B3 `RULE_QUESTIONS` porte exactement `RULE_QUESTION_IDS`, aucune question par défaut ne les prend',
  JSON.stringify(RULE_QUESTIONS.map(q => q.id)) === JSON.stringify([...RULE_QUESTION_IDS]) && !DEFAULT_QUESTIONS.some(q => isRuleQuestionId(q.id)))
check('B4 `enabled` ne contient aucun détecteur ; `rules` les contient tous ; `questionById` les connaît ; `isValidTag` les admet',
  !DEFAULT_SET.enabled.some(q => isRuleQuestionId(q.id)) && DEFAULT_SET.rules.length === 5 && RULE_QUESTION_IDS.every(id => DEFAULT_SET.questionById(id) && DEFAULT_SET.isValidTag(id, NOUL_YES) && !DEFAULT_SET.isValidTag(id, 'peut-être')))
const bodyErr = (() => { try { engineBodyFor([DEFAULT_SET.questionById('iban')]); return null } catch (e) { return e } })()
const posedErr = (() => { try { DEFAULT_SET.posed(['iban']); return null } catch (e) { return e } })()
check('B5 `engineBodyFor` et `posed` REFUSENT un détecteur : aucune requête ne peut l’emporter', bodyErr instanceof Error && /iban/.test(bodyErr.message) && posedErr instanceof Error)
const ids = DEFAULT_QUESTIONS.map(q => q.id)
const newNouls = ['partage_mot_de_passe', 'partage_secret_technique', 'donnees_personnelles_tiers', 'piece_identite', 'donnees_bancaires']
check('B6 taxonomie 49 → 53 : `donnees_sensibles` partie, cinq nouls arrivés, `demande_identifiants` restée',
  ids.length === 53 && !ids.includes('donnees_sensibles') && newNouls.every(id => ids.includes(id) && DEFAULT_SET.questionById(id).type === 'noul') && ids.includes('demande_identifiants'), String(ids.length))
const V_T11 = 'b99eee39c459' // `taxonomyVersion(DEFAULT_SET)` mesurée avant ce lot, 49 questions
check(`B7 \`TAXONOMY_VERSION\` a changé (${V_T11} → ${taxonomyVersion(DEFAULT_SET)})`, taxonomyVersion(DEFAULT_SET) !== V_T11)
check('B8 un jeu qui se voit passer un détecteur l’écarte de `all` et ne le pose pas', questionSet([DEFAULT_QUESTIONS[0], RULE_QUESTIONS[0]]).all.length === 1 && questionSet([RULE_QUESTIONS[0]]).enabled.length === 0)

// ---- C. le trieur ------------------------------------------------------------------------
await initDb()
const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const u = await pool.query(`INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, 'banc t11b', $2, 'user', 'active') RETURNING id`,
  [`t11b-${crypto.randomBytes(4).toString('hex')}@banc-t11b.invalid`, bcryptPlaceholder])
const U1 = u.rows[0].id
created.users.push(U1)
try {
  const A1 = (await pool.query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1, 'banc t11b', $2, 'imap.banc-t11b.invalid', 993, true, 'smtp.banc-t11b.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
    [U1, TO])).rows[0].id
  const eng = await pool.query(`INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc t11b', 'jev', 'http://banc.invalid/v1/systemone', 'banc-1', 42) RETURNING id`, [U1])
  const ENGINE_ID = eng.rows[0].id
  created.engines.push(ENGINE_ID)
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd) VALUES ($1, $2, 1000)`, [A1, ENGINE_ID])
  // Le groupe `security` devient CONDITIONNEL, déclenché par un détecteur : c'est la preuve que
  // les détections sont des « étiquettes déjà obtenues » avant la passe 1 (décision 24.2).
  await pool.query(`INSERT INTO tag_question_groups (user_id, id, name, position, condition_logic, conditions) VALUES ($1, 'security', 'Sécurité', 0, 'all', $2::jsonb)`,
    [U1, JSON.stringify([{ field: 'tag', operator: 'equals', tagQuestion: 'secret_technique', value: NOUL_YES }])])

  console.log('C. le trieur : cinq détecteurs par programme, cinq nouls par moteur')
  const MID = n => `<banc-t11b-${n}@exemple.invalid>`
  const SEEDED = `Bonjour,\nvoici mes coordonnées : ${SEED.phoneFr} / ${SEED.phoneCn}.\nContact : ${SEED.email}\nRIB : ${SEED.iban}\nCB : ${SEED.card}\nClé : ${SEED.sk}\nJeton : ${SEED.jwt}\n${SEED.pem}\nMerci.`
  const MAILS = [
    { folder: 'INBOX', uid: 1, messageId: MID(1), fromName: 'Fournisseur', fromAddress: FROM, subject: 'Mes coordonnées',
      bodyPlain: NEGATIVE ? 'Bonjour, voici mes coordonnées. Merci.' : SEEDED, recipients: [TO], date: new Date('2026-09-20T10:00:00Z') },
    { folder: 'INBOX', uid: 2, messageId: MID(2), fromName: 'Ami', fromAddress: 'ami@exemple.invalid', subject: 'Bonjour', bodyPlain: 'On se voit bientôt ?', recipients: [TO], date: new Date('2026-09-20T10:00:00Z') },
  ]
  const source = {
    async folders() { return [{ path: 'INBOX', uidValidity: '1', total: MAILS.length }] },
    async uids() { return MAILS.map(m => m.uid) },
    async fetch(folder, afterUid, limit) { return MAILS.filter(m => m.uid > afterUid).slice(0, limit) },
    async fetchUids(folder, uids) { return MAILS.filter(m => uids.includes(m.uid)) },
  }
  const asked = []
  const engine = {
    source: 'jev', auteur: { id: ENGINE_ID, nom: 'banc t11b' }, usdPerBillionInput: 42,
    async ask(state, posed) {
      asked.push({ objet: state.objet, questions: posed.map(q => q.id) })
      return { model: 'banc-1', rejected: [], inputTokens: 100 * posed.length, tags: posed.map(q => ({
        question: q.id, valeur: q.type === 'noul' ? NOUL_NO : questions.valuesOf(q)[0], probabilites: null, confiance: 0.8,
      })) }
    },
  }
  await runner.startBulk(A1)
  const pass = await runner.runPass({ accountId: A1, source, engine, budgetMs: 5_000 })
  check('C1 le passage traite les 2 mails sans erreur', pass.tagged === 2 && pass.errors === 0, JSON.stringify(pass))
  const r1 = await readTags(A1, MID(1))
  const detTags = r1.effective.filter(t => isRuleQuestionId(t.question))
  check('C2 « Mes coordonnées » : CINQ étiquettes `regle` à `oui`, chacune signée du détecteur (auteur_id = auteur_nom = id), modèle vide',
    detTags.length === 5 && detTags.every(t => t.valeur === NOUL_YES && t.source === RULE_SOURCE && t.auteurId === t.question && t.auteurNom === t.question && t.modele === null),
    JSON.stringify(detTags.map(t => [t.question, t.valeur, t.source, t.auteurId])))
  check('C3 chaque `oui` porte {occurrences ≥ 1} et RIEN d’autre dans `probabilites`',
    detTags.every(t => t.valeur !== NOUL_YES || (Object.keys(t.probabilites ?? {}).join() === OCCURRENCES_KEY && t.probabilites[OCCURRENCES_KEY] >= 1)) && (NEGATIVE || detTags.find(t => t.question === 'telephone')?.probabilites?.[OCCURRENCES_KEY] === 2),
    JSON.stringify(detTags.map(t => t.probabilites)))
  const r2 = await readTags(A1, MID(2))
  const clean = r2.effective.filter(t => isRuleQuestionId(t.question))
  check('C4 « Bonjour » : CINQ étiquettes `regle` à `non`, `probabilites` null', clean.length === 5 && clean.every(t => t.valeur === NOUL_NO && t.probabilites === null))
  const posedIds = asked.flatMap(a => a.questions)
  check('C5 AUCUNE requête au moteur ne porte un détecteur', !posedIds.some(isRuleQuestionId), posedIds.filter(isRuleQuestionId).join())
  check('C6 le moteur reçoit les cinq nouls de l’étage B et pas `donnees_sensibles`', newNouls.every(id => posedIds.includes(id)) && !posedIds.includes('donnees_sensibles'))
  check('C7 les détecteurs ne coûtent rien : « Bonjour » = UNE requête (tronc), le mail semé = DEUX (tronc + groupe `security` déclenché)',
    asked.filter(a => a.objet === 'Bonjour').length === 1 && asked.filter(a => a.objet === 'Mes coordonnées').length === (NEGATIVE ? 1 : 2), JSON.stringify(asked.map(a => [a.objet, a.questions.length])))
  const again = await runner.runPass({ accountId: A1, source, engine, budgetMs: 5_000 })
  const r1b = await readTags(A1, MID(1))
  check('C8 un second passage ne refait rien (0 appel) et ne DOUBLE pas les lignes `regle` (clé idempotente)', again.calls === 0 && r1b.tags.filter(t => isRuleQuestionId(t.question)).length === 5, `${again.calls} appel(s), ${r1b.tags.filter(t => isRuleQuestionId(t.question)).length} ligne(s)`)
  // C9 : la base ENTIÈRE relue. Chaque valeur semée, normalisée sans séparateurs, est cherchée
  // dans la concaténation de toutes les colonnes texte des trois tables (séparateurs retirés aussi).
  const dump = await pool.query(
    `SELECT string_agg(x, ' ') AS all FROM (
       SELECT question || ' ' || valeur || ' ' || COALESCE(probabilites::text, '') || ' ' || auteur_id || ' ' || auteur_nom || ' ' || modele AS x FROM message_tags WHERE account_id = $1
       UNION ALL SELECT question || ' ' || valeur || ' ' || COALESCE(candidats::text, '') || ' ' || auteur_nom AS x FROM message_fields WHERE account_id = $1
       UNION ALL SELECT COALESCE(subject, '') || ' ' || COALESCE(from_address, '') || ' ' || COALESCE(from_name, '') AS x FROM tagged_messages WHERE account_id = $1
     ) t`, [A1])
  const flat = (dump.rows[0].all ?? '').replace(/[ .\-\u00a0]/g, '')
  const ibanLast4 = SEED.iban.replace(/ /g, '').slice(-4)
  const leaked = leaks.filter(v => flat.includes(v.slice(0, 10)))
  check('C9 la base ENTIÈRE relue (message_tags, message_fields, tagged_messages) : AUCUNE valeur semée n’y figure (10 premiers caractères de chacune)', leaked.length === 0, leaked.join(' | '))
  check(`C10 seule exception admise : les 4 derniers de l’IBAN (${ibanLast4}) dans \`message_fields.iban\` (lot T11), et l’IBAN entier n’y est pas`,
    NEGATIVE || (dump.rows[0].all.includes(ibanLast4) && !flat.includes(SEED.iban.replace(/ /g, '').slice(0, 12))))
  const second = asked.find(a => a.objet === 'Mes coordonnées' && a.questions.includes('partage_secret_technique'))
  check('C11 les détections nourrissent les déclencheurs : le groupe `security` (déclencheur `secret_technique = oui`) est posé au mail semé en passe 2, jamais à « Bonjour »',
    !!second && !second.questions.includes('categorie') && !asked.some(a => a.objet === 'Bonjour' && a.questions.includes('partage_secret_technique')), JSON.stringify(asked.map(a => [a.objet, a.questions.slice(0, 3)])))

  // ---- D. les gardes d'écriture --------------------------------------------------------------
  console.log('D. les gardes d’écriture et le filtre')
  const AUTH = { id: U1, nom: 'banc' }
  const byEngine = await writeTags({ accountId: A1, messageId: MID(2), source: 'jev', auteur: { id: ENGINE_ID, nom: 'banc' }, tags: [{ question: 'iban', valeur: NOUL_YES }] }).then(() => null, e => e)
  check('D1 un MOTEUR (`writeTags` source `jev`) ne peut pas écrire un détecteur : `InvalidTagError` qui le nomme', byEngine instanceof InvalidTagError && byEngine.question === 'iban')
  const set = await (await import('../lib/tagging/userQuestions.ts')).loadQuestionSet(U1)
  const ruleErr = (() => { try { validateTagRule({ name: 'r', conditions: [{ field: 'subject', operator: 'contains', value: 'x' }], actions: [{ question: 'carte_bancaire', valeur: NOUL_YES }] }, set); return null } catch (e) { return e } })()
  check('D2 une règle d’étiquetage ne peut pas poser un détecteur : 400 qui nomme `actions[0].question`', ruleErr instanceof InvalidTagRuleError && ruleErr.field === 'actions[0].question')
  await writeTags({ accountId: A1, messageId: MID(2), source: HUMAN_SOURCE, auteur: AUTH, validePar: U1, tags: [{ question: 'telephone', valeur: NOUL_YES }] })
  const corrected = await readTags(A1, MID(2))
  check('D3 une MAIN peut corriger un détecteur : `humain` devient l’effective, la ligne `regle` reste', corrected.effective.find(t => t.question === 'telephone')?.source === HUMAN_SOURCE && corrected.tags.filter(t => t.question === 'telephone').length === 2)
  const hits = await filterByTag({ accountId: A1, question: 'secret_technique', valeur: NOUL_YES, origine: RULE_SOURCE })
  check('D4 le filtre `origine=regle` sur `secret_technique = oui` rend le mail semé et lui seul', hits.total === 1 && hits.messages[0]?.messageId === MID(1), JSON.stringify(hits))
  const none = await filterByTag({ accountId: A1, question: 'secret_technique', valeur: NOUL_YES, origine: ENGINE_ID })
  check('D5 le même filtre restreint au MOTEUR ne rend rien : le moteur n’a jamais répondu à un détecteur', none.total === 0)

  // ---- E. les routes ---------------------------------------------------------------------
  const alive = BASE ? await fetch(`${BASE}/login`).then(r => r.status === 200).catch(() => false) : false
  if (!alive) {
    console.log(`E. les routes — SAUTÉ (pas de serveur de dev sur ${BASE ?? '<SYNAPMAIL_TEST_URL non renseigné>'})`)
  } else {
    console.log('E. les routes')
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, 'banc t11b', $2, $3, $4::text[], NOW(), NOW()) RETURNING id`,
      [U1, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest('hex'), ALL_SCOPES])
    created.keys.push(row.rows[0].id)
    await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2)', [row.rows[0].id, A1])
    const call = async (path, { method = 'GET', body } = {}) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* rapporté via text */ }
      return { status: res.status, body: parsed, text }
    }
    const put = await call(`/api/messages/${encodeURIComponent(MID(2))}/tags`, { method: 'PUT', body: { accountId: A1, source: RULE_SOURCE, tags: [{ question: 'iban', valeur: NOUL_YES }] } })
    check('E1 `PUT …/tags` par clé avec `source: regle` → 403 qui nomme `regle`', put.status === 403 && put.body?.source === RULE_SOURCE, `${put.status} ${put.text.slice(0, 120)}`)
    const putJev = await call(`/api/messages/${encodeURIComponent(MID(2))}/tags`, { method: 'PUT', body: { accountId: A1, source: 'jev', engineId: ENGINE_ID, tags: [{ question: 'carte_bancaire', valeur: NOUL_YES }] } })
    check('E2 `PUT …/tags` par clé en `jev` sur un détecteur → 422 qui nomme `carte_bancaire`', putJev.status === 422 && putJev.body?.question === 'carte_bancaire', `${putJev.status} ${putJev.text.slice(0, 120)}`)
    const post = await call('/api/tags/questions', { method: 'POST', body: { id: 'secret_technique', type: 'noul', instructions: 'x' } })
    check('E3 `POST /api/tags/questions` avec un id de détecteur → 400 `reserved_id`', post.status === 400 && post.body?.code === 'reserved_id', `${post.status} ${post.text.slice(0, 120)}`)
    const got = await call(`/api/messages/${encodeURIComponent(MID(1))}/tags?account=${A1}`)
    check('E4 `GET …/tags` rend les lignes `regle` avec `auteurId` = le détecteur', got.status === 200 && got.body?.data?.effective?.some(t => t.source === RULE_SOURCE && isRuleQuestionId(t.auteurId)), `${got.status}`)
  }
} finally {
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.engines) await pool.query('DELETE FROM decision_engines WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['C2', 'C6', 'C11', 'D4']
  const fell = failures.map(x => x.split(' ')[0]).filter(k => expected.includes(k))
  const unexpected = failures.filter(x => !expected.includes(x.split(' ')[0]))
  if (fell.length === expected.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif : attendu ${expected.join(', ')}, tombés ${fell.join(', ') || 'aucun'}, inattendus ${unexpected.join(' | ') || 'aucun'}`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\ndétecteurs de divulgation : OK')
