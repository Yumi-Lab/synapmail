#!/usr/bin/env node
/**
 * Banc du lot T-Q3 : groupes de questions CONDITIONNELS, découpage automatique d'une passe, coût
 * visible AVANT de lancer (décision 24.2-4).
 *
 * Banc DB (+ HTTP quand une instance vit). Il crée deux utilisateurs de banc (`@banc-tq3.invalid`),
 * une boîte et un moteur de banc, et les supprime dans son `finally` (groupes, questions et
 * étiquettes partent en cascade). Aucune connexion IMAP ; la source est fausse, le moteur est un
 * objet du banc qui CAPTURE chaque requête (mail + questions). Aucun crédit dépensé.
 *
 *   node --experimental-strip-types scripts/check-tagging-groups.mjs
 *   node --experimental-strip-types scripts/check-tagging-groups.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. le partage : le déclencheur passe par `evaluateRule` de `lib/rulesEval.ts` (pas une copie),
 *      le champ `tag` y est évalué sur les étiquettes DÉJÀ obtenues ;
 *   B. le validateur : slug, champ inconnu, question inconnue sur `tag`, valeur hors liste, opérateur
 *      hors `equals`/`not_equals` sur `tag`, doublon de slug (409) ;
 *   C. `planPasses` : sans groupe tout est tronc ; un groupe conditionnel retire ses questions du
 *      tronc ; un groupe sans question active n'apparaît pas ;
 *   D. le TRIEUR : passe 2 déclenchée SEULEMENT quand le déclencheur est vrai après la passe 1
 *      (1 requête pour le mail « bonjour », 2 pour le mail « réclamation ») ; la passe 2 ne porte
 *      QUE les questions du groupe ; une règle qui fait foi déclenche aussi la passe 2 sans que sa
 *      question soit reposée ;
 *   E. le DÉCOUPAGE : un jeu dont le corps estimé dépasse le budget part en plusieurs requêtes qui
 *      tiennent chacune sous le budget, toutes les questions sont posées exactement une fois, et
 *      `chunkByBudget` ne coupe jamais une question ;
 *   F. le COÛT AVANT : `readTaggingStatus().passes` — jetons par mail du tronc = la mesure T8
 *      (7 164 000 / 995 mails, `ASSUMED_INPUT_TOKENS_PER_QUESTION × 49`, à ±1 %), requêtes par
 *      mail (1 tronc, +1 par groupe), taux de déclenchement lu dans la répartition de
 *      l'échantillon ; la migration rétro-remplit `input_mails` d'une boîte triée avant la colonne,
 *      et la moyenne reste dans [0,5×, 2×] de la vraie après son premier passage ; la répartition
 *      est lue question par question sous sa définition courante (lot T-Q3b) : désactiver une AUTRE
 *      question ne fait pas tomber le taux, redéfinir la question lue le fait ; le choix « Étiquette »
 *      ne propose que des questions actives ;
 *   G. (HTTP) les routes : 201, 400 qui nomme le champ, 404, 409, 403 sans `tags:write`.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le déclencheur du groupe est remplacé EN BASE par un
 * déclencheur toujours faux (`subject not_contains ""` est faux : "" est contenu partout), et le
 * budget de découpage n'est plus honoré (le banc appelle `chunkByBudget` avec un budget infini)
 * et la clé de banc reçoit TOUTES les portées — D3/D5/D6/D7 (la passe 2 ne part plus), E1/E2
 * (une seule requête porte tout), F4/F5/F6 (un déclencheur sur un champ du mail compte pour 1,
 * plus pour 2/3, et `measuredOn` ne lit plus rien : F12, et de même après l'interrupteur : F13), F10 (`input_mails` remis à 0 après la
 * migration : la moyenne redevient l'historique divisé par le dernier passage) et G5 (le 403)
 * DOIVENT tomber. D2 tient (« Bonjour » n'avait déjà qu'une
 * requête). Ce qu'il démontre : ces assertions mesurent bien le déclenchement, la coupe et le
 * taux, pas la présence du code.
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

const { initDb, query } = await import('../lib/db.ts')
const questions = await import('../lib/tagging/questions.ts')
const { loadQuestionSet, createQuestion, updateQuestion } = await import('../lib/tagging/userQuestions.ts')
const g = await import('../lib/tagging/questionGroups.ts')
const { validateGroup, InvalidGroupError, UnknownGroupError, DuplicateGroupError, createGroup, updateGroup, deleteGroup, listGroups, groupsForAccount, planPasses, chunkByBudget, estimateTokens, triggerRate, PASS_TOKEN_BUDGET } = g
const { ASSUMED_INPUT_TOKENS_PER_QUESTION, assumedInputTokensPerMail } = await import('../lib/tagging/engine.ts')
const { evaluateRule } = await import('../lib/rulesEval.ts')
const { readTaggingStatus } = await import('../lib/tagging/mailbox.ts')
const { taxonomyVersion, tagDistribution } = await import('../lib/tagging/store.ts')
const tr = await import('../lib/tagging/tagRules.ts')
const runner = await import('../lib/tagging/runner.ts')
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { users: [], keys: [], engines: [] }
const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const makeUser = async tag => {
  const row = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, $2, $3, 'user', 'active') RETURNING id`,
    [`${tag}-${crypto.randomBytes(4).toString('hex')}@banc-tq3.invalid`, `banc ${tag}`, bcryptPlaceholder]
  )
  created.users.push(row.rows[0].id)
  return row.rows[0].id
}
const makeAccount = async userId => (await pool.query(
  `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
   VALUES ($1, 'banc tq3', $2, 'imap.banc-tq3.invalid', 993, true, 'smtp.banc-tq3.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
  [userId, `tq3-${crypto.randomBytes(4).toString('hex')}@banc-tq3.invalid`])).rows[0].id

console.log(`\nbanc des groupes conditionnels (lot T-Q3)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (déclencheur toujours faux, budget ignoré)' : ''}\n`)
await initDb()

const T8 = { tokens: 7_164_000, mails: 995 }
const near = (a, b, tol = 0.01) => Math.abs(a - b) / b < tol

try {
  // ---- A. partagé ---------------------------------------------------------------------
  console.log('A. le déclencheur est évalué par la fonction partagée')
  const src = readFileSync(new URL('../lib/tagging/questionGroups.ts', import.meta.url), 'utf8')
  check('A1 `questionGroups.ts` importe `evaluateRule` de `lib/rulesEval.ts` et ne réécrit aucun opérateur', /import \{[^}]*evaluateRule[^}]*\} from '\.\.\/rulesEval'/.test(src) && !/case 'contains'|\.startsWith\(|fieldVal/.test(src))
  const msg = tr.messageForRules({ subject: 'x' })
  const cond = { id: 'c', field: 'tag', operator: 'equals', value: 'reclamation', tagQuestion: 'intention' }
  check('A2 `evalCondition` lit le champ `tag` sur les étiquettes passées : vrai si tenue, faux sinon', evaluateRule(msg, { enabled: true, conditionLogic: 'all', conditions: [cond] }, [{ question: 'intention', valeur: 'reclamation' }]) === true && evaluateRule(msg, { enabled: true, conditionLogic: 'all', conditions: [cond] }, [{ question: 'intention', valeur: 'sav' }]) === false)
  check('A3 `not_equals` sur `tag` : vrai quand la valeur n’est pas tenue', evaluateRule(msg, { enabled: true, conditionLogic: 'all', conditions: [{ ...cond, operator: 'not_equals' }] }, []) === true)

  // ---- B. validateur --------------------------------------------------------------------
  console.log('B. le validateur')
  const U1 = await makeUser('u1'), U2 = await makeUser('u2')
  const set1 = await loadQuestionSet(U1)
  const INT = 'intention'
  const RECL = questions.valuesOf(set1.questionById(INT)).find(v => v === 'reclamation') ?? questions.valuesOf(set1.questionById(INT))[0]
  const GOOD = { id: 'support', name: 'Support', conditions: [{ field: 'tag', operator: 'equals', tagQuestion: INT, value: RECL }] }
  const refused = input => { try { validateGroup(input, set1); return null } catch (e) { return e instanceof InvalidGroupError ? e.field : `!${e.message}` } }
  check('B1 un groupe bien formé passe, avec ses défauts (all, position 0)', (() => { const r = validateGroup(GOOD, set1); return r.conditionLogic === 'all' && r.position === 0 && r.conditions[0].tagQuestion === INT })())
  check('B2 sans condition = tronc (`toujours`), accepté', validateGroup({ id: 'tronc' }, set1).conditions.length === 0)
  for (const [label, input, field] of [
    ['B3 un slug invalide est refusé sur `id`', { ...GOOD, id: 'Pas Un Slug' }, 'id'],
    ['B4 un champ inconnu est refusé sur `conditions[0].field`', { ...GOOD, conditions: [{ field: 'couleur', operator: 'equals', value: 'x' }] }, 'conditions[0].field'],
    ['B5 une question inconnue sur `tag` est refusée sur `conditions[0].tagQuestion`', { ...GOOD, conditions: [{ field: 'tag', operator: 'equals', tagQuestion: 'fantome', value: 'x' }] }, 'conditions[0].tagQuestion'],
    ['B6 une valeur hors liste sur `tag` est refusée sur `conditions[0].value`', { ...GOOD, conditions: [{ field: 'tag', operator: 'equals', tagQuestion: INT, value: 'hors_liste' }] }, 'conditions[0].value'],
    ['B7 `contains` sur `tag` est refusé sur `conditions[0].operator`', { ...GOOD, conditions: [{ field: 'tag', operator: 'contains', tagQuestion: INT, value: RECL }] }, 'conditions[0].operator'],
    ['B8 une logique inconnue : refus sur `conditionLogic`', { ...GOOD, conditionLogic: 'xor' }, 'conditionLogic'],
  ]) check(label, refused(input) === field, `champ refusé : ${refused(input)}`)
  check('B9 un champ du mail est admis dans un déclencheur (`subject contains`)', refused({ ...GOOD, conditions: [{ field: 'subject', operator: 'contains', value: 'urgent' }] }) === null)

  // ---- C. planPasses ---------------------------------------------------------------------
  console.log('C. la répartition tronc / groupes')
  const all = set1.enabled.map(q => q.id)
  const p0 = planPasses(set1, [])
  check('C1 sans groupe, tout le jeu actif est du tronc et rien n’est conditionnel', p0.trunk.length === all.length && p0.conditional.length === 0)
  const grpSupport = await createGroup(U1, GOOD, set1)
  const supportQs = set1.enabled.filter(q => q.group === 'support')
  const p1 = planPasses(set1, [grpSupport])
  check(`C2 le groupe \`support\` (${supportQs.length} questions actives) sort du tronc et forme la passe 2`, p1.trunk.length === all.length - supportQs.length && p1.conditional.length === 1 && p1.conditional[0].questions.length === supportQs.length && !p1.trunk.some(q => q.group === 'support'))
  const p2 = planPasses(set1, [grpSupport, { ...grpSupport, id: 'groupe_vide', conditions: GOOD.conditions }])
  check('C3 un groupe sans question active n’apparaît pas', p2.conditional.length === 1)
  const dup = await createGroup(U1, GOOD, set1).then(() => null, e => e)
  check('C4 un second groupe sur le même slug est un `DuplicateGroupError`', dup instanceof DuplicateGroupError)

  // ---- D. le trieur --------------------------------------------------------------------
  console.log('D. le trieur : passe 2 seulement quand le déclencheur est vrai')
  const A1 = await makeAccount(U1)
  const eng = await pool.query(`INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc tq3', 'jev', 'http://banc.invalid/v1/systemone', 'banc-1', 42) RETURNING id`, [U1])
  const ENGINE_ID = eng.rows[0].id
  created.engines.push(ENGINE_ID)
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd) VALUES ($1, $2, 1000)`, [A1, ENGINE_ID])
  const NOUL_Q = set1.enabled.find(q => q.type === 'noul' && q.group !== 'support').id
  const ruleFoi = await tr.createTagRule(U1, { name: 'Réclamation fait foi', authoritative: true, conditions: [{ field: 'subject', operator: 'contains', value: 'litige' }], actions: [{ question: INT, valeur: RECL }] }, set1)
  const MID = n => `<banc-tq3-${n}@exemple.invalid>`
  const MAILS = [
    { folder: 'INBOX', uid: 1, messageId: MID(1), fromName: 'Client', fromAddress: 'client@exemple.invalid', subject: 'Réclamation colis cassé', bodyPlain: 'x', date: new Date() },
    { folder: 'INBOX', uid: 2, messageId: MID(2), fromName: 'Ami', fromAddress: 'ami@exemple.invalid', subject: 'Bonjour', bodyPlain: 'x', date: new Date() },
    { folder: 'INBOX', uid: 3, messageId: MID(3), fromName: 'Client', fromAddress: 'client@exemple.invalid', subject: 'Litige commande 42', bodyPlain: 'x', date: new Date() },
  ]
  const source = {
    async folders() { return [{ path: 'INBOX', uidValidity: '1', total: MAILS.length }] },
    async uids() { return MAILS.map(m => m.uid) },
    async fetch(folder, afterUid, limit) { return MAILS.filter(m => m.uid > afterUid).slice(0, limit) },
    async fetchUids(folder, uids) { return MAILS.filter(m => uids.includes(m.uid)) },
  }
  const asked = []
  // Le faux moteur répond « réclamation » à `intention` pour les mails dont l'objet commence par
  // « Réclamation », la première valeur ailleurs — c'est ce qui rend le déclencheur vrai ou faux.
  const engine = {
    source: 'jev', auteur: { id: ENGINE_ID, nom: 'banc tq3' }, usdPerBillionInput: 42,
    async ask(state, posed) {
      asked.push({ objet: state.objet, questions: posed.map(q => q.id) })
      return { model: 'banc-1', rejected: [], inputTokens: assumedInputTokensPerMail(posed.length),
        tags: posed.map(q => ({ question: q.id, valeur: q.id === INT && /^Réclamation/.test(state.objet) ? RECL : questions.valuesOf(q)[0], probabilites: null, confiance: 0.8 })) }
    },
  }
  if (NEGATIVE) await pool.query(`UPDATE tag_question_groups SET conditions = $2::jsonb WHERE user_id = $1`, [U1, JSON.stringify([{ id: 'n', field: 'subject', operator: 'not_contains', value: '' }])])
  await runner.startBulk(A1)
  const pass = await runner.runPass({ accountId: A1, source, engine, budgetMs: 5_000 })
  check('D1 le passage traite les 3 mails sans erreur', pass.tagged === 3 && pass.errors === 0, JSON.stringify(pass))
  const calls = objet => asked.filter(a => a.objet === objet)
  const trunkIds = p1.trunk.map(q => q.id), supportIds = supportQs.map(q => q.id)
  check('D2 « Bonjour » (déclencheur faux) : UNE requête, le tronc seul', calls('Bonjour').length === 1 && JSON.stringify(calls('Bonjour')[0].questions) === JSON.stringify(trunkIds), `${calls('Bonjour').length} requête(s)`)
  check('D3 « Réclamation » (déclencheur vrai après la passe 1) : DEUX requêtes, la seconde = les questions du groupe seules', calls('Réclamation colis cassé').length === 2 && JSON.stringify(calls('Réclamation colis cassé')[1].questions) === JSON.stringify(supportIds), `${calls('Réclamation colis cassé').length} requête(s) : ${JSON.stringify(calls('Réclamation colis cassé').map(c => c.questions.length))}`)
  check('D4 la passe 1 de « Réclamation » = le tronc, aucune question du groupe', JSON.stringify(calls('Réclamation colis cassé')[0]?.questions) === JSON.stringify(trunkIds))
  const litige = calls('Litige commande 42')
  check('D5 « Litige » : la règle qui fait foi tranche `intention` → déclencheur vrai SANS que le moteur la repose : 2 requêtes, `intention` absente des deux', litige.length === 2 && !litige.some(c => c.questions.includes(INT)) && JSON.stringify(litige[1].questions) === JSON.stringify(supportIds), `${litige.length} requête(s)`)
  check('D6 le total des requêtes est 1 + 2 + 2 = 5, et `pass.calls` le dit', asked.length === 5 && pass.calls === 5, `${asked.length} / ${pass.calls}`)
  const rows = await pool.query(`SELECT message_id, question FROM message_tags WHERE account_id = $1 AND source = 'jev'`, [A1])
  check('D7 en base : « Réclamation » porte les questions du groupe, « Bonjour » aucune', rows.rows.some(r => r.message_id === MID(1) && supportIds.includes(r.question)) && !rows.rows.some(r => r.message_id === MID(2) && supportIds.includes(r.question)))
  check('D8 en base : « Bonjour » porte exactement le tronc', rows.rows.filter(r => r.message_id === MID(2)).length === trunkIds.length)

  // ---- E. découpage ------------------------------------------------------------------
  console.log('E. le découpage d’une passe au budget de jetons')
  const budget = NEGATIVE ? Infinity : PASS_TOKEN_BUDGET
  const total = estimateTokens(set1.enabled)
  check(`E0 le jeu de 49 questions tient en UNE requête (${total} jetons estimés < ${PASS_TOKEN_BUDGET})`, total < PASS_TOKEN_BUDGET && chunkByBudget(set1.enabled).length === 1)
  // Un jeu 5 × plus gros que le budget : 49 questions allongées, chacune sous une consigne longue.
  const long = 'a'.repeat(Math.ceil(PASS_TOKEN_BUDGET * g.CHARS_PER_TOKEN / 10))
  const big = questions.questionSet(set1.enabled.map(q => ({ ...q, instructions: q.instructions + ' ' + long })))
  const chunks = chunkByBudget(big.enabled, budget)
  const bigTotal = estimateTokens(big.enabled)
  check(`E1 un jeu de ${bigTotal} jetons estimés est coupé en ${Math.ceil(bigTotal / PASS_TOKEN_BUDGET)}+ requêtes (obtenu ${chunks.length})`, chunks.length >= Math.ceil(bigTotal / PASS_TOKEN_BUDGET) && chunks.length > 1, `${chunks.length}`)
  check('E2 chaque requête tient sous le budget', chunks.every(c => estimateTokens(c) <= PASS_TOKEN_BUDGET), JSON.stringify(chunks.map(c => estimateTokens(c))))
  check('E3 toutes les questions sont posées exactement une fois, dans l’ordre', JSON.stringify(chunks.flat().map(q => q.id)) === JSON.stringify(big.enabled.map(q => q.id)))
  const huge = questions.questionSet([{ ...set1.enabled[0], instructions: 'b'.repeat(PASS_TOKEN_BUDGET * g.CHARS_PER_TOKEN * 2) }])
  check('E4 une question qui dépasse à elle seule le budget part seule, jamais coupée', chunkByBudget(huge.enabled).length === 1)
  // Le trieur lui-même : la boîte de U2, un jeu allongé EN BASE, un mail → plusieurs requêtes.
  const set2raw = await loadQuestionSet(U2)
  for (const q of set2raw.enabled.slice(0, 10)) await updateQuestion(U2, q.id, { instructions: q.instructions + ' ' + long })
  for (const q of set2raw.enabled.slice(10)) await updateQuestion(U2, q.id, { enabled: false })
  const set2 = await loadQuestionSet(U2)
  const A2 = await makeAccount(U2)
  const eng2 = await pool.query(`INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc tq3 b', 'jev', 'http://banc.invalid/v1/systemone', 'banc-1', 42) RETURNING id`, [U2])
  created.engines.push(eng2.rows[0].id)
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd) VALUES ($1, $2, 1000)`, [A2, eng2.rows[0].id])
  const asked2 = []
  const engine2 = { ...engine, auteur: { id: eng2.rows[0].id, nom: 'banc tq3 b' }, async ask(state, posed) { asked2.push(posed.map(q => q.id)); return engine.ask(state, posed) } }
  const source2 = { ...source, async fetch(folder, afterUid, limit) { return MAILS.slice(1, 2).filter(m => m.uid > afterUid).slice(0, limit) }, async folders() { return [{ path: 'INBOX', uidValidity: '1', total: 1 }] } }
  await runner.startBulk(A2)
  const pass2 = await runner.runPass({ accountId: A2, source: source2, engine: engine2, budgetMs: 5_000 })
  const expected2 = chunkByBudget(set2.enabled).length
  check(`E5 le trieur envoie ${expected2} requêtes pour UN mail dont le jeu (${estimateTokens(set2.enabled)} jetons) dépasse le budget, et le compte en 1 tagué`, pass2.tagged === 1 && pass2.calls === expected2 && asked2.length === expected2 && expected2 > 1, JSON.stringify({ tagged: pass2.tagged, calls: pass2.calls, expected2 }))
  check('E6 les requêtes du trieur couvrent le jeu entier, chaque question une fois', JSON.stringify(asked2.flat()) === JSON.stringify(set2.enabled.map(q => q.id)))
  const rows2 = await pool.query(`SELECT COUNT(*)::int AS n FROM message_tags WHERE account_id = $1`, [A2])
  check('E7 en base : une étiquette par question, toutes requêtes confondues', rows2.rows[0].n === set2.enabled.length, `${rows2.rows[0].n}`)

  // ---- F. le coût AVANT --------------------------------------------------------------
  console.log('F. le coût visible avant de lancer')
  // Une boîte JAMAIS mesurée (input_mails = 0) : la constante par question, que le lot T8 a fixée.
  const A3 = await makeAccount(U1)
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd, total) VALUES ($1, $2, 1000, 1000)`, [A3, ENGINE_ID])
  const s3 = await readTaggingStatus(A3)
  const trunkN = p1.trunk.length
  check(`F1 tronc : ${trunkN} questions × ${ASSUMED_INPUT_TOKENS_PER_QUESTION} jetons = ${trunkN * ASSUMED_INPUT_TOKENS_PER_QUESTION} jetons par mail`, s3.passes.tokensPerMail.trunk === trunkN * ASSUMED_INPUT_TOKENS_PER_QUESTION, JSON.stringify(s3.passes.tokensPerMail))
  check(`F2 la constante est la mesure T8 : 49 × ${ASSUMED_INPUT_TOKENS_PER_QUESTION} = ${49 * ASSUMED_INPUT_TOKENS_PER_QUESTION} ≈ ${T8.tokens} / ${T8.mails} = ${(T8.tokens / T8.mails).toFixed(0)} jetons par mail (±1 %)`, near(49 * ASSUMED_INPUT_TOKENS_PER_QUESTION, T8.tokens / T8.mails))
  check('F3 requêtes par mail : 1 pour le tronc, 2 au plus (tronc + groupe)', s3.passes.requestsPerMail.trunk === 1 && s3.passes.requestsPerMail.max === 2, JSON.stringify(s3.passes.requestsPerMail))
  check('F4 sans étiquette pour renseigner le déclencheur, le coût « avec groupes » est `null` (pas inventé)', s3.passes.tokensPerMail.withGroups === null && s3.passes.groups[0]?.rate === null)
  // La boîte A1 a un échantillon tagué : `intention` = « réclamation » sur 2 mails sur 3 (le
  // moteur pour « Réclamation », la règle qui fait foi pour « Litige ») → taux 2/3. Sous
  // --negative le déclencheur est un champ du mail, compté pour 1 : le taux lu est 1, pas 2/3.
  const s1 = await readTaggingStatus(A1)
  const rate = s1.passes.groups.find(x => x.id === 'support')?.rate
  const expectedRate = 2 / 3
  check(`F5 le taux de déclenchement du groupe est lu dans la répartition : ${(expectedRate * 100).toFixed(0)} % (obtenu ${rate === null || rate === undefined ? 'null' : (rate * 100).toFixed(0)} %)`, rate !== null && rate !== undefined && Math.abs(rate - expectedRate) < 1e-9)
  const perQ = s1.inputTokens / s1.tagged / s1.questions
  check('F6 avec la mesure de la boîte : tronc = mesuré / questions actives × questions du tronc ; avec groupes = tronc + taux × questions du groupe', near(s1.passes.tokensPerMail.trunk, perQ * trunkN) && s1.passes.tokensPerMail.withGroups !== null && near(s1.passes.tokensPerMail.withGroups, perQ * trunkN + expectedRate * perQ * supportQs.length), JSON.stringify(s1.passes.tokensPerMail))
  check('F7 en dollars : par mail = jetons × 42 / 1e9 ; pour le reste de la boîte × mails restants', s1.passes.usdPerMail !== null && near(s1.passes.usdPerMail.trunk, s1.passes.tokensPerMail.trunk * 42 / 1e9) && s3.passes.usdRemaining !== null && near(s3.passes.usdRemaining.trunk, s3.passes.usdPerMail.trunk * 1000), JSON.stringify(s3.passes.usdRemaining))
  check('F8 `triggerRate` : `any` = 1 − ∏(1 − p) (0,25 ou 0,75 → 0,8125), `not_equals` = 1 − p', Math.abs(triggerRate({ conditionLogic: 'any', conditions: [{ field: 'tag', operator: 'equals', tagQuestion: 'a', value: 'x' }, { field: 'tag', operator: 'equals', tagQuestion: 'a', value: 'y' }] }, [{ question: 'a', values: [{ valeur: 'x', count: 1 }, { valeur: 'y', count: 3 }] }]) - 0.8125) < 1e-9
    && Math.abs(triggerRate({ conditionLogic: 'all', conditions: [{ field: 'tag', operator: 'not_equals', tagQuestion: 'a', value: 'x' }] }, [{ question: 'a', values: [{ valeur: 'x', count: 1 }, { valeur: 'y', count: 3 }] }]) - 0.75) < 1e-9)

  // Une boîte triée AVANT la colonne `input_mails` : des jetons d'historique (la mesure T8) et
  // 0 mail derrière. La migration rétro-remplit le dénominateur depuis `message_tags` ; sans cela,
  // le premier passage divisait 7,2 M de jetons par ses 2 mails (gate T-Q3 refusé, 01/10/2026).
  // Sous --negative, la colonne est remise à 0 après la migration (l'état d'avant) : F10 doit tomber.
  const A4 = await makeAccount(U1)
  const Q0 = p1.trunk[0]
  await pool.query(
    `INSERT INTO message_tags (account_id, message_id, question, valeur, source, modele, taxonomy_version, auteur_id, auteur_nom)
     SELECT $1, '<histo-' || n || '@banc-tq3.invalid>', $2, $3, 'jev', 'banc-1', $4, $5, 'banc tq3' FROM generate_series(1, $6::int) n`,
    [A4, Q0.id, questions.valuesOf(Q0)[0], taxonomyVersion(set1), ENGINE_ID, T8.mails])
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd, total, input_tokens, input_mails) VALUES ($1, $2, 1000, 1000, $3, 0)`, [A4, ENGINE_ID, T8.tokens])
  await initDb()
  const backfilled = Number((await pool.query(`SELECT input_mails FROM mailbox_tagging WHERE account_id = $1`, [A4])).rows[0].input_mails)
  check(`F9 la migration rétro-remplit \`input_mails\` depuis l'historique : ${T8.mails} mails tagués par le moteur (obtenu ${backfilled})`, backfilled === T8.mails)
  if (NEGATIVE) await pool.query(`UPDATE mailbox_tagging SET input_mails = 0 WHERE account_id = $1`, [A4])
  const source4 = { ...source, async fetch(folder, afterUid, limit) { return MAILS.slice(0, 2).filter(m => m.uid > afterUid).slice(0, limit) }, async folders() { return [{ path: 'INBOX', uidValidity: '1', total: 2 }] } }
  await runner.startBulk(A4)
  const pass4 = await runner.runPass({ accountId: A4, source: source4, engine, budgetMs: 5_000 })
  const row4 = (await pool.query(`SELECT input_tokens, input_mails FROM mailbox_tagging WHERE account_id = $1`, [A4])).rows[0]
  const avg4 = Number(row4.input_tokens) / Number(row4.input_mails)
  const truth = assumedInputTokensPerMail(set1.enabled.length)
  const s4 = await readTaggingStatus(A4)
  check(`F10 après un passage de ${pass4.tagged} mails sur cet historique, la moyenne reste dans [0,5×, 2×] de la vraie (${truth} jetons/mail) : ${avg4.toFixed(0)} = ${row4.input_tokens} / ${row4.input_mails}`, pass4.tagged === 2 && avg4 >= truth * 0.5 && avg4 <= truth * 2 && near(s4.passes.tokensPerMail.trunk, avg4 / set1.enabled.length * trunkN), JSON.stringify({ avg4, trunk: s4.passes.tokensPerMail.trunk }))
  check(`F11 la migration ne touche pas une boîte déjà mesurée : A1 garde input_mails = ${s1.tagged}`, Number((await pool.query(`SELECT input_mails FROM mailbox_tagging WHERE account_id = $1`, [A1])).rows[0].input_mails) === s1.tagged)
  check('F12 `measuredOn` dit sur combien de mails le taux est lu : les mails de l’échantillon qui répondent à la question du déclencheur (3 sur A1), 0 sans répartition', s1.passes.groups[0].measuredOn === 3 && s3.passes.groups[0].measuredOn === 0, JSON.stringify(s1.passes.groups))

  // Lot T-Q3b : la répartition est lue QUESTION PAR QUESTION sous sa définition courante, pas sous
  // la taxonomie entière — sinon (dés)activer n'importe quelle question ferait tomber le taux de
  // tous les groupes à « part inconnue » jusqu'au prochain échantillon.
  await updateQuestion(U1, NOUL_Q, { enabled: false })
  const s1b = await readTaggingStatus(A1)
  const rateB = s1b.passes.groups.find(x => x.id === 'support')?.rate
  check(`F13 après avoir DÉSACTIVÉ une autre question (${NOUL_Q}), le taux du groupe reste ${(expectedRate * 100).toFixed(0)} % sur 3 mails (obtenu ${rateB === null || rateB === undefined ? 'null' : (rateB * 100).toFixed(0)} % sur ${s1b.passes.groups[0]?.measuredOn})`, rateB !== null && rateB !== undefined && Math.abs(rateB - expectedRate) < 1e-9 && s1b.passes.groups[0].measuredOn === 3, JSON.stringify(s1b.passes.groups))
  const distB = await tagDistribution(A1)
  check(`F14 la répartition ne cite plus la question désactivée et garde les 3 réponses à \`${INT}\``, !distB.some(d => d.question === NOUL_Q) && distB.find(d => d.question === INT)?.values.reduce((n, v) => n + v.count, 0) === 3, JSON.stringify(distB.map(d => d.question)))
  await updateQuestion(U1, NOUL_Q, { enabled: true })
  // La contrepartie : une question dont la DÉFINITION change n'a plus de réponse valable — ses
  // anciennes lignes ne comptent pas (c'est exactement ce que `staleCounts` recense).
  const intWas = set1.questionById(INT).instructions
  await updateQuestion(U1, INT, { instructions: intWas + ' (redéfinie)' })
  const distC = await tagDistribution(A1)
  check(`F15 une question REDÉFINIE (\`${INT}\`) sort de la répartition : ses anciennes réponses ne valent plus, les autres questions gardent les leurs`, !distC.some(d => d.question === INT) && distC.some(d => d.question === NOUL_Q && d.values.reduce((n, v) => n + v.count, 0) === 3), JSON.stringify(distC.map(d => [d.question, d.values.reduce((n, v) => n + v.count, 0)]).slice(0, 4)))
  await updateQuestion(U1, INT, { instructions: intWas })
  check('F16 définition rétablie : la répartition retrouve les 3 réponses', (await tagDistribution(A1)).find(d => d.question === INT)?.values.reduce((n, v) => n + v.count, 0) === 3)
  // Le choix « Étiquette » d'un déclencheur ne propose que des questions ACTIVES (le filtre par
  // groupe seul laissait passer une question désactivée — gate T-Q3, remarque 4).
  const uiSrc = readFileSync(new URL('../components/settings/TagGroupsSection.tsx', import.meta.url), 'utf8')
  check('F17 `TagGroupsSection.tsx` filtre les questions proposées au déclencheur par `isEnabled(q)`', /tagQuestions=\{questions\.filter\(q => isEnabled\(q\) &&/.test(uiSrc))

  // ---- isolation + suppression ----------------------------------------------------------
  console.log('H. isolation et suppression')
  check('H1 U2 ne voit pas les groupes de U1 ; la boîte de U2 n’en reçoit aucun', (await listGroups(U2)).length === 0 && (await groupsForAccount(A2)).length === 0 && (await groupsForAccount(A1)).length === 1)
  const h2 = await updateGroup(U2, 'support', { name: 'volé' }, set2).then(() => null, e => e)
  check('H2 U2 ne peut pas modifier le groupe de U1 : `UnknownGroupError`', h2 instanceof UnknownGroupError)
  await deleteGroup(U1, 'support')
  check('H3 supprimer le groupe rend ses questions au tronc, sans en supprimer une', planPasses(set1, await groupsForAccount(A1)).trunk.length === all.length && (await loadQuestionSet(U1)).enabled.length === all.length)

  // ---- G. les routes -----------------------------------------------------------------
  const alive = BASE ? await fetch(`${BASE}/login`).then(r => r.status === 200).catch(() => false) : false
  if (!alive) {
    console.log(`G. les routes — SAUTÉ (pas de serveur de dev sur ${BASE ?? '<SYNAPMAIL_TEST_URL non renseigné>'})`)
  } else {
    console.log('G. les routes')
    const makeKey = async (userId, scopes) => {
      const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
      const row = await pool.query(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
         VALUES ($1, 'banc tq3', $2, $3, $4::text[], NOW(), NOW()) RETURNING id`,
        [userId, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest('hex'), NEGATIVE ? ALL_SCOPES : scopes])
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
    const P = '/api/tags/groups'
    const writer = await makeKey(U1, ['tags:read', 'tags:write'])
    const reader = await makeKey(U1, ['tags:read'])
    const ok = await call(P, { method: 'POST', key: writer, body: GOOD })
    check('G1 un POST valide est un 201 `{ data }` portant le slug', ok.status === 201 && ok.body?.data?.id === 'support', `${ok.status} ${ok.text.slice(0, 160)}`)
    const list = await call(P, { key: writer })
    check('G2 `GET /api/tags/groups` rend les groupes de l’appelant sous `{ data }`', list.status === 200 && list.body?.data?.length === 1 && list.body.data[0].conditions[0].tagQuestion === INT, `${list.status} ${list.text.slice(0, 120)}`)
    const bad = await call(P, { method: 'POST', key: writer, body: { ...GOOD, id: 'finance', conditions: [{ field: 'tag', operator: 'equals', tagQuestion: INT, value: 'hors_liste' }] } })
    check('G3 un POST avec une valeur hors liste est un 400 qui NOMME `conditions[0].value`', bad.status === 400 && bad.body?.field === 'conditions[0].value', `${bad.status} ${bad.text.slice(0, 160)}`)
    const dupe = await call(P, { method: 'POST', key: writer, body: GOOD })
    check('G4 un second POST sur le même slug est un 409', dupe.status === 409, `${dupe.status}`)
    const noWrite = await call(P, { method: 'POST', key: reader, body: { ...GOOD, id: 'finance' } })
    check('G5 une clé sans `tags:write` est refusée par un 403 qui nomme la portée', noWrite.status === 403 && noWrite.body?.missingScope === 'tags:write', `${noWrite.status} ${noWrite.text.slice(0, 120)}`)
    const patched = await call(`${P}/support`, { method: 'PATCH', key: writer, body: { name: 'SAV' } })
    check('G6 un PATCH partiel garde le déclencheur et applique le nom', patched.status === 200 && patched.body?.data?.name === 'SAV' && patched.body.data.conditions.length === 1, `${patched.status} ${patched.text.slice(0, 120)}`)
    const gone = await call(`${P}/inconnu`, { method: 'PATCH', key: writer, body: { name: 'x' } })
    check('G7 un PATCH sur un groupe inconnu est un 404 qui le nomme', gone.status === 404 && gone.body?.id === 'inconnu', `${gone.status}`)
    const other = await makeKey(U2, ['tags:read', 'tags:write'])
    const steal = await call(`${P}/support`, { method: 'DELETE', key: other })
    check('G8 la clé d’un autre utilisateur ne peut pas supprimer le groupe : 404', steal.status === 404 && (await listGroups(U1)).some(x => x.id === 'support'), `${steal.status}`)
    const del = await call(`${P}/support`, { method: 'DELETE', key: writer })
    check('G9 un DELETE retire le groupe', del.status === 200 && !(await listGroups(U1)).some(x => x.id === 'support'), `${del.status}`)
    const status = await call(`/api/tagging/status?account=${A1}`, { key: reader })
    check('G10 `GET /api/tagging/status` expose `passes` (requêtes par mail, jetons, dollars, groupes)', status.status === 200 && status.body?.data?.passes?.requestsPerMail?.trunk === 1 && Array.isArray(status.body.data.passes.groups) && typeof status.body.data.passes.usdPerMail?.trunk === 'number', `${status.status} ${status.text.slice(0, 160)}`)
  }
} finally {
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.engines) await pool.query('DELETE FROM decision_engines WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['D3', 'D5', 'D6', 'D7', 'E1', 'E2', 'F4', 'F5', 'F6', 'F10', 'F12', 'F13', 'G5']
  const fell = failures.map(f => f.split(' ')[0]).filter(k => expected.includes(k))
  const unexpected = failures.filter(f => !expected.includes(f.split(' ')[0]))
  const want = BASE ? expected : expected.filter(k => !k.startsWith('G'))
  if (fell.length === want.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif : attendu ${want.join(', ')}, tombés ${fell.join(', ') || 'aucun'}, inattendus ${unexpected.join(' | ') || 'aucun'}`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\ngroupes conditionnels : OK')
