#!/usr/bin/env node
/**
 * Banc du lot T-Q : les questions de tri d'un utilisateur sont les SIENNES, validées par le
 * contrat JEV, versionnées quand leur sens change, et c'est ce jeu-là — pas `questions.ts` —
 * que le moteur, l'écran et les routes lisent.
 *
 * Banc DB (+ HTTP quand une instance vit). Il crée deux utilisateurs de banc (`@banc-tq.invalid`)
 * et les supprime dans son `finally` — `tag_questions` part avec eux (ON DELETE CASCADE). Aucune
 * connexion IMAP ; le seul « moteur » interrogé est un serveur HTTP du banc sur 127.0.0.1, qui
 * CAPTURE la requête et rend une réponse dictée. Aucun crédit dépensé.
 *
 *   node --experimental-strip-types scripts/check-tagging-questions.mjs
 *   node --experimental-strip-types scripts/check-tagging-questions.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. le validateur, par type et par forme invalide : chaque refus NOMME le champ ;
 *   B. les identifiants réservés (`RULE_QUESTION_IDS`) sont refusés en NOMMANT l'id, et
 *      `questions.ts` n'en porte aucun ;
 *   C. le jeu par défaut est inséré UNE fois (deux lectures concurrentes → 49 lignes, pas 98),
 *      et une lecture ultérieure ne le réinsère pas ;
 *   D. isolation : la question d'un utilisateur n'apparaît pas chez l'autre ; modifier chez l'un
 *      ne touche pas l'autre ;
 *   E. `version` avance sur la consigne et sur les critères, PAS sur `enabled`/`group`/`position` ;
 *   F. une question DÉSACTIVÉE est absente du corps envoyé au moteur (`posed()`), et
 *      `taxonomyVersion` change avec elle — le trieur repartira ;
 *   G. (HTTP) les routes : 400 qui nomme le champ, 400 qui nomme l'id réservé, 409 sur doublon,
 *      404 sur inconnue, 403 sans `tags:write`, et `POST …/[id]/test` pose UNE question au moteur
 *      de la boîte et rend sa réponse.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : `RESERVED_QUESTION_IDS` est vidé sur la copie chargée par
 * le banc et la clé de banc reçoit TOUTES les portées — B2 et G6 DOIVENT tomber. Ce qu'il
 * démontre : ces assertions mesurent la liste réservée et les portées, pas la présence des routes.
 * Ce qu'il ne démontre PAS : G3 (l'id réservé refusé par la ROUTE) tourne dans le processus du
 * serveur, que ce drapeau n'atteint pas — il reste vert sous `--negative`, et c'est attendu.
 */
import './alias-resolver.mjs'
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
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

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
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
const { DEFAULT_QUESTIONS, RULE_QUESTION_IDS, RESERVED_QUESTION_IDS, SCORE_LEVELS, CHOICE_MAX_OPTIONS, engineBodyFor } = questions
const uq = await import('../lib/tagging/userQuestions.ts')
const { validateQuestion, InvalidQuestionError, loadQuestionSet, listQuestions, createQuestion, updateQuestion, deleteQuestion, resetQuestions } = uq
const { taxonomyVersion } = await import('../lib/tagging/store.ts')
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')

if (NEGATIVE) RESERVED_QUESTION_IDS.length = 0

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { users: [], keys: [], accounts: [], engines: [] }
let fakeEngine = null

const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const makeUser = async tag => {
  const row = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, $2, $3, 'user', 'active') RETURNING id`,
    [`${tag}-${crypto.randomBytes(4).toString('hex')}@banc-tq.invalid`, `banc ${tag}`, bcryptPlaceholder]
  )
  created.users.push(row.rows[0].id)
  return row.rows[0].id
}

const CHOICE = { id: 'banc_choix', type: 'choice', instructions: 'Quel animal ?', options: [{ value: 'chat', definition: 'un chat' }, { value: 'chien', definition: 'un chien', notFor: 'un loup', examples: ['wouf'] }] }
const SCORE = { id: 'banc_score', type: 'score', instructions: 'Quelle chaleur ?', options: [{ value: 'froid', definition: 'froid' }, { value: 'tiede', definition: 'tiède' }, { value: 'chaud', definition: 'chaud' }] }
const NOUL = { id: 'banc_noul', type: 'noul', instructions: 'Est-ce urgent ?' }

const refusedField = input => {
  try { validateQuestion(input); return null } catch (e) { return e instanceof InvalidQuestionError ? e.field : `!${e.message}` }
}

console.log('\nbanc des questions de tri (lot T-Q)\n')
await initDb()

try {
  // ---- A. le validateur ------------------------------------------------------------
  console.log('A. le validateur, par type et par forme')
  check('A1 un choice, un score et un noul bien formés passent', [CHOICE, SCORE, NOUL].every(q => refusedField(q) === null))
  const A = [
    ['A2 un slug hors [a-z0-9_]{2,40} est refusé sur `id`', { ...NOUL, id: 'Mauvais-Id' }, 'id'],
    ['A3 un slug d’un caractère est refusé sur `id`', { ...NOUL, id: 'a' }, 'id'],
    ['A4 un type inconnu est refusé sur `type`', { ...NOUL, type: 'bool' }, 'type'],
    ['A5 une consigne vide est refusée sur `instructions`', { ...NOUL, instructions: '  ' }, 'instructions'],
    ['A6 un noul avec critères est refusé sur `options`', { ...NOUL, options: [{ value: 'x', definition: 'y' }] }, 'options'],
    ['A7 un choice sans liste est refusé sur `options`', { ...CHOICE, options: undefined }, 'options'],
    ['A8 un choice à 256 options est refusé sur `options`', { ...CHOICE, options: Array.from({ length: CHOICE_MAX_OPTIONS + 1 }, (_, i) => ({ value: `o${i}`, definition: `option ${i}` })) }, 'options'],
    ['A9 un score à 1 niveau est refusé sur `options`', { ...SCORE, options: SCORE.options.slice(0, 1) }, 'options'],
    ['A10 un score à 11 niveaux est refusé sur `options`', { ...SCORE, options: Array.from({ length: SCORE_LEVELS.max + 1 }, (_, i) => ({ value: `n${i}`, definition: `niveau ${i}` })) }, 'options'],
    ['A11 deux options de même valeur sont refusées sur `options`', { ...CHOICE, options: [CHOICE.options[0], CHOICE.options[0]] }, 'options'],
    ['A12 une option sans définition nomme `options[i].definition`', { ...CHOICE, options: [{ value: 'chat', definition: '' }, CHOICE.options[1]] }, 'options[0].definition'],
    ['A13 une option dont la valeur n’est pas un slug nomme `options[i].value`', { ...CHOICE, options: [{ value: 'Chat!', definition: 'x' }, CHOICE.options[1]] }, 'options[0].value'],
    ['A14 des exemples qui ne sont pas des chaînes nomment `options[i].examples`', { ...CHOICE, options: [{ ...CHOICE.options[0], examples: [1] }, CHOICE.options[1]] }, 'options[0].examples'],
    ['A15 un groupe hors slug est refusé sur `group`', { ...NOUL, group: 'Sécurité' }, 'group'],
    ['A16 `enabled` non booléen est refusé sur `enabled`', { ...NOUL, enabled: 'yes' }, 'enabled'],
    ['A17 `listBadge: true` sur un score est refusé sur `listBadge`', { ...SCORE, listBadge: true }, 'listBadge'],
    ['A18 un niveau de pastille inconnu est refusé sur `listBadge`', { ...SCORE, listBadge: 'brulant' }, 'listBadge'],
  ]
  for (const [label, input, field] of A) {
    const got = refusedField(input)
    check(label, got === field, `champ nommé : ${got}`)
  }
  const normalized = validateQuestion({ ...CHOICE, instructions: '  Quel animal ?  ', options: [{ value: 'chat', definition: ' un chat ', notFor: ' ', examples: [] }, CHOICE.options[1]] })
  check('A19 la validation NORMALISE : consigne rognée, `notFor` blanc et `examples` vide retirés',
    normalized.instructions === 'Quel animal ?' && normalized.options[0].definition === 'un chat' && !('notFor' in normalized.options[0]) && !('examples' in normalized.options[0]))
  check('A20 le corps moteur d’un choice à frontière passe en objet {what, not_for, examples}, l’autre reste une chaîne',
    typeof engineBodyFor([normalized])[CHOICE.id].criteria.chat === 'string' && engineBodyFor([normalized])[CHOICE.id].criteria.chien.not_for === 'un loup')

  // ---- B. les identifiants réservés --------------------------------------------------
  console.log('B. les identifiants réservés')
  check('B1 `RULE_QUESTION_IDS` porte les détecteurs de T11b, et aucun défaut de `questions.ts` ne les prend',
    RULE_QUESTION_IDS.length >= 5 && !DEFAULT_QUESTIONS.some(q => RULE_QUESTION_IDS.includes(q.id)))
  const reserved = RULE_QUESTION_IDS[0]
  let reservedMsg = null
  try { validateQuestion({ ...NOUL, id: reserved }) } catch (e) { reservedMsg = e instanceof InvalidQuestionError ? `${e.field}: ${e.message}` : `!${e.message}` }
  check('B2 un id réservé est refusé sur `id`, et le message NOMME cet id',
    reservedMsg !== null && reservedMsg.startsWith('id:') && reservedMsg.includes(reserved), String(reservedMsg))

  // ---- C. le jeu par défaut, une fois ------------------------------------------------
  console.log('C. le jeu par défaut est inséré une fois')
  const U1 = await makeUser('u1')
  const U2 = await makeUser('u2')
  const [setA, setB] = await Promise.all([loadQuestionSet(U1), loadQuestionSet(U1)])
  const [{ n: countAfter }] = await query('SELECT COUNT(*)::int AS n FROM tag_questions WHERE user_id = $1', [U1])
  check(`C1 deux lectures CONCURRENTES d’un utilisateur sans ligne laissent ${DEFAULT_QUESTIONS.length} lignes, pas le double`,
    countAfter === DEFAULT_QUESTIONS.length && setA.all.length === DEFAULT_QUESTIONS.length && setB.all.length === DEFAULT_QUESTIONS.length, `${countAfter} ligne(s)`)
  check('C2 le jeu reçu est celui de `questions.ts`, dans le même ordre, tout actif, version 1',
    setA.all.every((q, i) => q.id === DEFAULT_QUESTIONS[i].id && q.enabled === true && q.version === 1))
  await deleteQuestion(U1, setA.all[0].id)
  const after = await loadQuestionSet(U1)
  check('C3 une lecture ultérieure ne RÉINSÈRE pas une question supprimée : la base commande',
    after.all.length === DEFAULT_QUESTIONS.length - 1 && !after.questionById(setA.all[0].id))
  check('C4 `taxonomyVersion` du jeu de l’utilisateur diffère de celle du défaut dès qu’une question manque',
    taxonomyVersion(after) !== taxonomyVersion(setA))
  const restored = await resetQuestions(U1)
  check('C5 `reset` rend exactement le jeu par défaut', restored.length === DEFAULT_QUESTIONS.length && restored.every((q, i) => q.id === DEFAULT_QUESTIONS[i].id && q.version === 1))

  // ---- D. isolation ------------------------------------------------------------------
  console.log('D. isolation entre utilisateurs')
  const createdQ = await createQuestion(U1, CHOICE)
  const u2List = await listQuestions(U2)
  check('D1 la question ajoutée chez U1 est absente chez U2', createdQ.id === CHOICE.id && !u2List.some(q => q.id === CHOICE.id), `U2 : ${u2List.length} question(s)`)
  check('D2 elle est ajoutée EN FIN de jeu (position après la dernière)', (await listQuestions(U1)).at(-1).id === CHOICE.id)
  const commonId = DEFAULT_QUESTIONS[1].id
  await updateQuestion(U1, commonId, { instructions: 'consigne changée chez U1' })
  const u2Common = (await listQuestions(U2)).find(q => q.id === commonId)
  check('D3 modifier une question par défaut chez U1 ne touche pas la ligne de U2', u2Common.version === 1 && u2Common.instructions === DEFAULT_QUESTIONS[1].instructions)
  let dup = null
  try { await createQuestion(U1, CHOICE) } catch (e) { dup = e }
  check('D4 recréer un id déjà pris est un `DuplicateQuestionError` qui nomme l’id', dup instanceof uq.DuplicateQuestionError && dup.id === CHOICE.id, String(dup))
  let unknown = null
  try { await updateQuestion(U2, CHOICE.id, { enabled: false }) } catch (e) { unknown = e }
  check('D5 modifier chez U2 une question qui n’existe que chez U1 est un `UnknownQuestionError`', unknown instanceof uq.UnknownQuestionError && unknown.id === CHOICE.id)

  // ---- E. la version ----------------------------------------------------------------
  console.log('E. la version avance quand le sens change')
  const v1 = (await listQuestions(U1)).find(q => q.id === CHOICE.id)
  const vEnabled = await updateQuestion(U1, CHOICE.id, { enabled: false })
  const vGroup = await updateQuestion(U1, CHOICE.id, { group: 'support' })
  const vPos = await updateQuestion(U1, CHOICE.id, { position: 0 })
  check('E1 `enabled`, `group`, `position` ne font PAS avancer la version', v1.version === 1 && vEnabled.version === 1 && vGroup.version === 1 && vPos.version === 1,
    `${vEnabled.version}/${vGroup.version}/${vPos.version}`)
  const vInstr = await updateQuestion(U1, CHOICE.id, { instructions: 'Quel animal, vraiment ?' })
  check('E2 changer la consigne passe en version 2', vInstr.version === 2, String(vInstr.version))
  const vSame = await updateQuestion(U1, CHOICE.id, { instructions: 'Quel animal, vraiment ?' })
  check('E3 renvoyer la MÊME consigne ne fait pas avancer la version', vSame.version === 2, String(vSame.version))
  const vCrit = await updateQuestion(U1, CHOICE.id, { options: [...CHOICE.options, { value: 'poule', definition: 'une poule' }] })
  check('E4 changer les critères passe en version 3', vCrit.version === 3, String(vCrit.version))
  const vBadge = await updateQuestion(U1, CHOICE.id, { listBadge: true })
  check('E5 la pastille (affichage seul) ne fait pas avancer la version', vBadge.version === 3, String(vBadge.version))
  const vType = await updateQuestion(U1, CHOICE.id, { type: 'noul', options: [] })
  check('E6 changer le type (donc le corps envoyé) fait avancer la version', vType.version === 4 && vType.type === 'noul', String(vType.version))
  let renamed = null
  try { await updateQuestion(U1, CHOICE.id, { id: 'autre_id' }) } catch (e) { renamed = e }
  check('E7 l’identifiant d’une question ne se change pas (400 sur `id`)', renamed instanceof InvalidQuestionError && renamed.field === 'id')

  // ---- F. une question désactivée n'est pas posée ------------------------------------
  console.log('F. une question désactivée est absente de la requête moteur')
  await createQuestion(U2, NOUL)
  const before = await loadQuestionSet(U2)
  const posedBefore = engineBodyFor(before.posed())
  await updateQuestion(U2, NOUL.id, { enabled: false })
  const afterOff = await loadQuestionSet(U2)
  const posedAfter = engineBodyFor(afterOff.posed())
  check('F1 active, la question est dans le corps `questions` ; désactivée, elle n’y est plus',
    NOUL.id in posedBefore && !(NOUL.id in posedAfter) && afterOff.questionById(NOUL.id)?.enabled === false)
  check('F2 le nombre de questions posées baisse de un, le jeu complet (`all`) la garde', afterOff.posed().length === before.posed().length - 1 && afterOff.all.length === before.all.length)
  check('F3 `taxonomyVersion` change avec l’activation : le trieur saura repartir', taxonomyVersion(before) !== taxonomyVersion(afterOff))

  // ---- G. les routes ----------------------------------------------------------------
  const alive = BASE ? await fetch(`${BASE}/login`).then(r => r.status === 200).catch(() => false) : false
  if (!alive) {
    console.log(`G. les routes — SAUTÉ (pas de serveur de dev sur ${BASE ?? '<SYNAPMAIL_TEST_URL non renseigné>'})`)
  } else {
    console.log('G. les routes')
    const makeKey = async (userId, scopes, accountIds) => {
      const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
      const row = await pool.query(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
         VALUES ($1, 'banc tq', $2, $3, $4::text[], NOW(), NOW()) RETURNING id`,
        [userId, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest('hex'), NEGATIVE ? ALL_SCOPES : scopes]
      )
      created.keys.push(row.rows[0].id)
      for (const a of accountIds) await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2)', [row.rows[0].id, a])
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
    const P = '/api/tags/questions'

    const acc = await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1, 'banc tq', $2, 'imap.banc-tq.invalid', 993, true, 'smtp.banc-tq.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
      [U1, `tq-${crypto.randomBytes(4).toString('hex')}@banc-tq.invalid`]
    )
    const accountId = acc.rows[0].id
    created.accounts.push(accountId)
    const writer = await makeKey(U1, ['tags:read', 'tags:write', 'messages:read'], [accountId])
    const reader = await makeKey(U1, ['tags:read'], [accountId])

    const list = await call(P, { key: writer })
    check('G1 `GET /api/tags/questions` rend le jeu de l’appelant sous `{ data }`, avec `version` et `updatedAt`',
      list.status === 200 && Array.isArray(list.body?.data) && list.body.data.some(q => q.id === CHOICE.id && q.version === 4 && typeof q.updatedAt === 'string'), `${list.status} ${list.text.slice(0, 120)}`)
    const bad = await call(P, { method: 'POST', key: writer, body: { ...SCORE, id: 'banc_http_score', options: SCORE.options.slice(0, 1) } })
    check('G2 un POST invalide est un 400 qui NOMME le champ (`field: options`)', bad.status === 400 && bad.body?.field === 'options' && /options/.test(bad.body?.error ?? ''), `${bad.status} ${bad.text.slice(0, 160)}`)
    const res = await call(P, { method: 'POST', key: writer, body: { ...NOUL, id: reserved } })
    check('G3 un POST avec un id réservé est un 400 qui NOMME l’id', res.status === 400 && res.body?.field === 'id' && (res.body?.error ?? '').includes(reserved), `${res.status} ${res.text.slice(0, 160)}`)
    const ok = await call(P, { method: 'POST', key: writer, body: { ...SCORE, id: 'banc_http_score' } })
    check('G4 un POST valide est un 201 `{ data }` en version 1', ok.status === 201 && ok.body?.data?.id === 'banc_http_score' && ok.body.data.version === 1, `${ok.status} ${ok.text.slice(0, 160)}`)
    const dupHttp = await call(P, { method: 'POST', key: writer, body: { ...SCORE, id: 'banc_http_score' } })
    check('G5 le même id une seconde fois est un 409 qui le nomme', dupHttp.status === 409 && dupHttp.body?.id === 'banc_http_score', `${dupHttp.status}`)
    const noWrite = await call(P, { method: 'POST', key: reader, body: NOUL })
    check('G6 une clé sans `tags:write` est refusée par un 403 qui nomme la portée', noWrite.status === 403 && noWrite.body?.missingScope === 'tags:write', `${noWrite.status} ${noWrite.text.slice(0, 120)}`)
    const patched = await call(`${P}/banc_http_score`, { method: 'PATCH', key: writer, body: { instructions: 'changée par HTTP' } })
    check('G7 un PATCH de la consigne rend la question en version 2', patched.status === 200 && patched.body?.data?.version === 2, `${patched.status} ${patched.text.slice(0, 120)}`)
    const gone = await call(`${P}/inconnue_xyz`, { method: 'PATCH', key: writer, body: { enabled: false } })
    check('G8 un PATCH sur une question inconnue est un 404 qui la nomme', gone.status === 404 && gone.body?.id === 'inconnue_xyz', `${gone.status}`)
    const del = await call(`${P}/banc_http_score`, { method: 'DELETE', key: writer })
    check('G9 un DELETE retire la question du jeu', del.status === 200 && !(await call(P, { key: writer })).body.data.some(q => q.id === 'banc_http_score'), `${del.status}`)

    // « Tester sur un mail » : le moteur de la boîte est un serveur du banc qui capture la
    // requête. Le mail vient de l'IMAP : la boîte du banc est injoignable, donc le test s'arrête
    // APRÈS avoir résolu la question et le moteur, AVANT tout appel — on mesure donc ce qui
    // précède l'IMAP (question inconnue → 404, pas de moteur → 409) et, via le faux moteur,
    // qu'UNE seule question serait posée si le mail arrivait : c'est `askEngine` déjà mesuré
    // par le banc du moteur. ponytail: sans IMAP de banc, le chemin complet n'est mesurable
    // qu'à la main (gate visuel) ; voie d'amélioration : une `MailSource` injectable dans la route.
    const noEngine = await call(`${P}/${CHOICE.id}/test`, { method: 'POST', key: writer, body: { accountId, folder: 'INBOX', uid: 1 } })
    check('G10 tester une question sur une boîte SANS moteur est un 409, avant tout appel', noEngine.status === 409, `${noEngine.status} ${noEngine.text.slice(0, 120)}`)
    const unknownQ = await call(`${P}/inconnue_xyz/test`, { method: 'POST', key: writer, body: { accountId, folder: 'INBOX', uid: 1 } })
    check('G11 tester une question inconnue est un 404 qui la nomme', unknownQ.status === 404 && unknownQ.body?.id === 'inconnue_xyz', `${unknownQ.status}`)
    const missing = await call(`${P}/${CHOICE.id}/test`, { method: 'POST', key: writer, body: { accountId } })
    check('G12 sans `folder`/`uid` le test est un 400', missing.status === 400, `${missing.status}`)

    const captured = []
    fakeEngine = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        captured.push(JSON.parse(raw))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ model: 'banc-1', answers: { [CHOICE.id]: { noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 3 } }))
      })
    })
    await new Promise(r => fakeEngine.listen(0, '127.0.0.1', r))
    const engineUrl = `http://127.0.0.1:${fakeEngine.address().port}/v1/systemone`
    const eng = await pool.query(
      `INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc tq', 'jev', $2, 'banc-1', 1) RETURNING id`, [U1, engineUrl])
    created.engines.push(eng.rows[0].id)
    await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET engine_id = EXCLUDED.engine_id`, [accountId, eng.rows[0].id])
    const withEngine = await call(`${P}/${CHOICE.id}/test`, { method: 'POST', key: writer, body: { accountId, folder: 'INBOX', uid: 1 } })
    check('G13 avec un moteur, le test va chercher le mail (boîte `.invalid` → 500 IMAP) et n’appelle PAS le moteur sans mail',
      withEngine.status === 500 && captured.length === 0, `${withEngine.status} ${withEngine.text.slice(0, 120)} — ${captured.length} appel(s) moteur`)
    // Le corps que la route ENVERRAIT : `askEngine` avec la seule question du test, contre le faux moteur.
    const { askEngine, buildState } = await import('../lib/tagging/engine.ts')
    const only = (await loadQuestionSet(U1)).questionById(CHOICE.id)
    const answer = await askEngine({ url: engineUrl, apiKey: '', model: 'banc-1' }, buildState({ fromName: 'x', fromAddress: 'x@banc-tq.invalid', subject: 's', bodyPlain: 'b', bodyHtml: '' }), [only])
    check('G14 `askEngine` avec UNE question de l’utilisateur en pose exactement une, sous SA version courante (type changé en noul)',
      captured.length === 1 && Object.keys(captured[0].questions).length === 1 && captured[0].questions[CHOICE.id].type === 'noul' && answer.tags[0]?.valeur === 'oui',
      JSON.stringify(captured[0]?.questions ?? null).slice(0, 160))
  }
} finally {
  if (fakeEngine) await new Promise(r => fakeEngine.close(r))
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  for (const id of created.engines) await pool.query('DELETE FROM decision_engines WHERE id = $1', [id]).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.query("DELETE FROM users WHERE email LIKE '%@banc-tq.invalid'").catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['B2', 'G6']
  const fell = expected.filter(id => failures.some(f => f.startsWith(id)))
  if (fell.length === expected.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés (${failures.map(f => f.split(' ')[0]).join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\nCONTRÔLE NÉGATIF MUET : liste réservée vidée, et ${expected.filter(id => !fell.includes(id)).join(', ')} reste vert — le banc ne mesure pas la liste`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nquestions de tri : OK')
