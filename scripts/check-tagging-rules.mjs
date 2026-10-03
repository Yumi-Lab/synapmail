#!/usr/bin/env node
/**
 * Banc du lot T-Q2 : les règles d'étiquetage SANS moteur (décision 24.1). Une règle est aux
 * conditions des règles de courrier, évaluée par la MÊME fonction, pose des étiquettes signées
 * d'elle (source `regle`) AVANT le moteur, et — si elle fait foi — retire ses questions de la
 * requête moteur.
 *
 * Banc DB (+ HTTP quand une instance vit). Il crée deux utilisateurs de banc (`@banc-tq2.invalid`),
 * une boîte et un moteur de banc, et les supprime dans son `finally` (`tag_rules`, `tag_questions`
 * et les étiquettes partent en cascade). Aucune connexion IMAP ; la source est fausse, le moteur
 * est un objet du banc qui CAPTURE les questions qu'on lui pose. Aucun crédit dépensé.
 *
 *   node --experimental-strip-types scripts/check-tagging-rules.mjs
 *   node --experimental-strip-types scripts/check-tagging-rules.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. `evalCondition` est PARTAGÉE : `lib/tagging/tagRules.ts` importe `lib/rules.ts` et ne
 *      contient aucun `switch (cond.operator)` ; la lecture d'une règle passe par `evaluateRule` ;
 *   B. le validateur : une valeur hors liste est refusée en nommant `actions[i].valeur`, une
 *      question inconnue `actions[i].question`, une condition mal formée `conditions[i].field`,
 *      deux actions sur la même question, pas de condition, pas d'action ;
 *   C. `applyTagRules` : la règle qui matche pose ses étiquettes, celle qui ne matche pas rien ;
 *      la première par priorité l'emporte sur une même question ; `authoritative` remplit
 *      `settled`, une règle d'avis non ; une valeur devenue étrangère au jeu est ignorée ;
 *   D. le TRIEUR (fausse source, faux moteur) : les étiquettes de règle sont en base en source
 *      `regle` signées de la règle ; une règle qui fait foi RETIRE sa question de la requête
 *      moteur pour les mails qu'elle tranche, et pas pour les autres ; un mail entièrement
 *      tranché ne coûte AUCUN appel ; une règle d'avis laisse la question posée ;
 *   E. isolation : les règles d'un utilisateur n'apparaissent pas chez l'autre, ne s'appliquent
 *      pas à sa boîte, et son PATCH/DELETE sur l'id d'autrui est un 404 ;
 *   F. (HTTP) les routes : 400 qui nomme le champ, 404 sur inconnue, 403 sans `tags:write`.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : `authoritative` est forcé à faux EN BASE avant le passage du
 * trieur (le trieur lit les règles lui-même, on ne peut pas l'intercepter de l'extérieur) et la
 * clé de banc reçoit TOUTES les portées — D2/D3/D7/D9 et F3 DOIVENT tomber : le moteur est alors
 * interrogé sur tout, la newsletter porte aussi ses réponses, et l'effective redevient la ligne la
 * plus récente (celle du moteur). Ce qu'il démontre : ces assertions mesurent bien le retrait des
 * questions tranchées et les portées, pas la présence du code.
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
const { loadQuestionSet } = await import('../lib/tagging/userQuestions.ts')
const tr = await import('../lib/tagging/tagRules.ts')
const { validateTagRule, InvalidTagRuleError, UnknownTagRuleError, createTagRule, updateTagRule, deleteTagRule, listTagRules, rulesForAccount, remainingQuestions } = tr
const { RULE_SOURCE, TAG_SOURCES, assumedInputTokensPerMail } = await import('../lib/tagging/engine.ts')
const store = await import('../lib/tagging/store.ts')
const runner = await import('../lib/tagging/runner.ts')
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { users: [], keys: [], engines: [] }
const bcryptPlaceholder = '$2a$12$' + 'x'.repeat(53)
const makeUser = async tag => {
  const row = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, $2, $3, 'user', 'active') RETURNING id`,
    [`${tag}-${crypto.randomBytes(4).toString('hex')}@banc-tq2.invalid`, `banc ${tag}`, bcryptPlaceholder]
  )
  created.users.push(row.rows[0].id)
  return row.rows[0].id
}
const makeAccount = async userId => (await pool.query(
  `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
   VALUES ($1, 'banc tq2', $2, 'imap.banc-tq2.invalid', 993, true, 'smtp.banc-tq2.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`,
  [userId, `tq2-${crypto.randomBytes(4).toString('hex')}@banc-tq2.invalid`])).rows[0].id

console.log(`\nbanc des règles d'étiquetage (lot T-Q2)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (aucune règle ne fait foi)' : ''}\n`)
await initDb()

try {
  // ---- A. la fonction est partagée -----------------------------------------------
  console.log('A. `evalCondition` est partagée, pas copiée')
  const src = readFileSync(new URL('../lib/tagging/tagRules.ts', import.meta.url), 'utf8')
  check('A1 `tagRules.ts` importe `evaluateRule` de `lib/rulesEval.ts` (celle que `lib/rules.ts` ré-exporte)', /import \{[^}]*evaluateRule[^}]*\} from '\.\.\/rulesEval'/.test(src))
  check('A2 `tagRules.ts` ne réécrit aucun opérateur (`contains`, `starts_with`, `includes(`) hors du validateur', !/case 'contains'|\.startsWith\(|\.endsWith\(|fieldVal/.test(src))
  const evalSrc = readFileSync(new URL('../lib/rulesEval.ts', import.meta.url), 'utf8')
  const rulesSrc = readFileSync(new URL('../lib/rules.ts', import.meta.url), 'utf8')
  check('A3 `evalCondition` n’a qu’UNE définition (`lib/rulesEval.ts`), ré-exportée par `lib/rules.ts` pour le courrier',
    /export function evalCondition\(/.test(evalSrc) && !/function evalCondition\(/.test(src) && !/function evalCondition\(/.test(rulesSrc) && /export \{[^}]*evaluateRule[^}]*\} from '\.\/rulesEval'/.test(rulesSrc))
  check(`A4 \`${RULE_SOURCE}\` est une source d'étiquette comme les autres (CHECK SQL dérivé de TAG_SOURCES)`, TAG_SOURCES.includes(RULE_SOURCE))

  // ---- B. le validateur --------------------------------------------------------------
  console.log('B. le validateur')
  const U1 = await makeUser('u1'), U2 = await makeUser('u2')
  const set1 = await loadQuestionSet(U1)
  const CHOICE_Q = questions.DEFAULT_QUESTIONS.find(q => q.type === 'choice').id
  const NOUL_Q = questions.DEFAULT_QUESTIONS.find(q => q.type === 'noul').id
  const OTHER_Q = questions.DEFAULT_QUESTIONS.find(q => q.type === 'choice' && q.id !== CHOICE_Q).id
  const v = (id, i = 0) => questions.valuesOf(set1.questionById(id))[i]
  const GOOD = { name: 'Factures', conditions: [{ field: 'subject', operator: 'contains', value: 'facture' }], actions: [{ question: CHOICE_Q, valeur: v(CHOICE_Q) }] }
  const refused = input => { try { validateTagRule(input, set1); return null } catch (e) { return e instanceof InvalidTagRuleError ? e.field : `!${e.message}` } }
  check('B1 une règle bien formée passe, avec ses défauts (all, active, priorité 0, avis)', (() => { const r = validateTagRule(GOOD, set1); return r.conditionLogic === 'all' && r.enabled && r.priority === 0 && r.authoritative === false && r.accountId === null })())
  for (const [label, input, field] of [
    ['B2 une valeur hors liste est refusée en nommant `actions[0].valeur`', { ...GOOD, actions: [{ question: CHOICE_Q, valeur: 'pas_une_valeur' }] }, 'actions[0].valeur'],
    ['B3 une question inconnue est refusée en nommant `actions[0].question`', { ...GOOD, actions: [{ question: 'question_fantome', valeur: 'x' }] }, 'actions[0].question'],
    ['B4 un champ de condition inconnu est refusé en nommant `conditions[0].field`', { ...GOOD, conditions: [{ field: 'couleur', operator: 'contains', value: 'x' }] }, 'conditions[0].field'],
    ['B5 un opérateur inconnu est refusé en nommant `conditions[0].operator`', { ...GOOD, conditions: [{ field: 'subject', operator: 'ressemble', value: 'x' }] }, 'conditions[0].operator'],
    ['B6 sans condition : refus sur `conditions`', { ...GOOD, conditions: [] }, 'conditions'],
    ['B7 sans action : refus sur `actions`', { ...GOOD, actions: [] }, 'actions'],
    ['B8 deux actions sur la même question : refus sur `actions`', { ...GOOD, actions: [GOOD.actions[0], { question: CHOICE_Q, valeur: v(CHOICE_Q, 1) }] }, 'actions'],
    ['B9 un nom vide : refus sur `name`', { ...GOOD, name: ' ' }, 'name'],
    ['B10 une logique inconnue : refus sur `conditionLogic`', { ...GOOD, conditionLogic: 'xor' }, 'conditionLogic'],
    ['B11 `authoritative` non booléen : refus sur `authoritative`', { ...GOOD, authoritative: 'oui' }, 'authoritative'],
  ]) check(label, refused(input) === field, `champ refusé : ${refused(input)}`)

  // ---- C. l'application pure ---------------------------------------------------------
  console.log('C. `applyTagRules` sur un mail')
  const mk = (over = {}) => ({ id: crypto.randomUUID(), accountId: null, name: 'r', enabled: true, priority: 0, conditionLogic: 'all', conditions: GOOD.conditions, actions: GOOD.actions, authoritative: false, createdAt: '', updatedAt: '', ...over })
  const facture = { fromName: 'Compta', fromAddress: 'compta@exemple.invalid', subject: 'Votre facture n°12', bodyPlain: 'Merci de régler.' }
  const autre = { ...facture, subject: 'Bonjour' }
  const rAvis = mk({ name: 'avis' })
  const rFoi = mk({ name: 'foi', authoritative: true, actions: [{ question: NOUL_Q, valeur: 'oui' }] })
  const c1 = tr.applyTagRules([rAvis, rFoi], facture, set1)
  check('C1 les deux règles matchent le mail « facture » : deux étiquettes, une par règle', c1.tags.length === 2 && c1.tags[0].rule === rAvis && c1.tags[1].rule === rFoi, JSON.stringify(c1.tags.map(t => t.question)))
  check('C2 seule la règle qui fait foi remplit `settled`', c1.settled.size === 1 && c1.settled.has(NOUL_Q) && !c1.settled.has(CHOICE_Q))
  const c2 = tr.applyTagRules([rAvis, rFoi], autre, set1)
  check('C3 un mail qui ne matche pas ne reçoit rien et ne tranche rien', c2.tags.length === 0 && c2.settled.size === 0)
  const rSecond = mk({ name: 'second', priority: 5, actions: [{ question: CHOICE_Q, valeur: v(CHOICE_Q, 1) }] })
  const c3 = tr.applyTagRules([rAvis, rSecond], facture, set1)
  check('C4 deux règles sur la même question : la première par priorité l’emporte, une seule étiquette', c3.tags.length === 1 && c3.tags[0].valeur === v(CHOICE_Q) && c3.tags[0].rule === rAvis)
  const rStale = mk({ name: 'stale', actions: [{ question: CHOICE_Q, valeur: 'valeur_disparue' }] })
  check('C5 une valeur devenue étrangère au jeu est ignorée, jamais écrite', tr.applyTagRules([rStale], facture, set1).tags.length === 0)
  const posed = set1.posed()
  const rest = remainingQuestions(posed, c1.settled)
  check('C6 `remainingQuestions` retire exactement la question tranchée du jeu posé', rest.length === posed.length - 1 && !rest.some(q => q.id === NOUL_Q))
  const anyRule = mk({ name: 'any', conditionLogic: 'any', conditions: [{ field: 'subject', operator: 'contains', value: 'zzz' }, { field: 'from', operator: 'contains', value: 'compta' }] })
  check('C7 la logique `any` passe par `evaluateRule` : une condition vraie suffit', tr.applyTagRules([anyRule], facture, set1).tags.length === 1)
  const withAtt = mk({ name: 'pj', conditions: [{ field: 'has_attachments', operator: 'is_true', value: '' }] })
  check('C8 `has_attachments` lit le champ du mail du trieur', tr.applyTagRules([withAtt], { ...facture, hasAttachments: true }, set1).tags.length === 1 && tr.applyTagRules([withAtt], facture, set1).tags.length === 0)

  // ---- D. le trieur ------------------------------------------------------------------
  console.log('D. le trieur : les règles passent avant le moteur')
  const A1 = await makeAccount(U1)
  const eng = await pool.query(`INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, 'banc tq2', 'jev', 'http://banc.invalid/v1/systemone', 'banc-1', 1) RETURNING id`, [U1])
  const ENGINE_ID = eng.rows[0].id
  created.engines.push(ENGINE_ID)
  await pool.query(`INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd) VALUES ($1, $2, 1000)`, [A1, ENGINE_ID])
  const ruleFoi = await createTagRule(U1, { name: 'Facture fait foi', authoritative: true, conditions: [{ field: 'subject', operator: 'contains', value: 'facture' }], actions: [{ question: NOUL_Q, valeur: 'oui' }] }, set1)
  const ruleAvis = await createTagRule(U1, { name: 'Compta avis', accountId: A1, conditions: [{ field: 'from', operator: 'contains', value: 'compta' }], actions: [{ question: CHOICE_Q, valeur: v(CHOICE_Q) }] }, set1)
  const ruleTout = await createTagRule(U1, { name: 'Tout tranché', authoritative: true, priority: 1, conditions: [{ field: 'subject', operator: 'starts_with', value: 'newsletter' }],
    actions: set1.enabled.map(q => ({ question: q.id, valeur: questions.valuesOf(q)[0] })) }, set1)
  const MID = n => `<banc-tq2-${n}@exemple.invalid>`
  const MAILS = [
    { folder: 'INBOX', uid: 1, messageId: MID(1), fromName: 'Compta', fromAddress: 'compta@exemple.invalid', subject: 'Votre facture n°12', bodyPlain: 'x', date: new Date() },
    { folder: 'INBOX', uid: 2, messageId: MID(2), fromName: 'Ami', fromAddress: 'ami@exemple.invalid', subject: 'Bonjour', bodyPlain: 'x', date: new Date() },
    { folder: 'INBOX', uid: 3, messageId: MID(3), fromName: 'Liste', fromAddress: 'news@exemple.invalid', subject: 'Newsletter de la semaine', bodyPlain: 'x', date: new Date() },
  ]
  const source = {
    async folders() { return [{ path: 'INBOX', uidValidity: '1', total: MAILS.length }] },
    async uids() { return MAILS.map(m => m.uid) },
    async fetch(folder, afterUid, limit) { return MAILS.filter(m => m.uid > afterUid).slice(0, limit) },
    async fetchUids(folder, uids) { return MAILS.filter(m => uids.includes(m.uid)) },
  }
  const asked = []
  const engine = {
    source: 'jev', auteur: { id: ENGINE_ID, nom: 'banc tq2' }, usdPerBillionInput: 1,
    async ask(state, posed) {
      asked.push({ objet: state.objet, questions: posed.map(q => q.id) })
      return { model: 'banc-1', rejected: [], inputTokens: assumedInputTokensPerMail(posed.length),
        tags: posed.map(q => ({ question: q.id, valeur: questions.valuesOf(q)[0], probabilites: null, confiance: 0.8 })) }
    },
  }
  // Le runner lit les règles par `rulesForAccount` : sous --negative on ne peut pas l'intercepter
  // de l'extérieur, alors on neutralise `authoritative` EN BASE le temps du passage.
  if (NEGATIVE) await pool.query(`UPDATE tag_rules SET authoritative = false WHERE user_id = $1`, [U1])
  await runner.startBulk(A1)
  const pass = await runner.runPass({ accountId: A1, source, engine, budgetMs: 5_000 })
  check('D1 le passage traite les 3 mails (tagués = 3) sans erreur', pass.tagged === 3 && pass.errors === 0, JSON.stringify(pass))
  const byObjet = Object.fromEntries(asked.map(a => [a.objet, a.questions]))
  const all = set1.enabled.map(q => q.id)
  check(`D2 le mail « facture » (règle qui fait foi) est posé au moteur SANS ${NOUL_Q}`, byObjet['Votre facture n°12']?.length === all.length - 1 && !byObjet['Votre facture n°12'].includes(NOUL_Q), JSON.stringify(byObjet['Votre facture n°12']?.length))
  check('D3 le mail « newsletter » (toutes les questions tranchées) ne coûte AUCUN appel moteur', !('Newsletter de la semaine' in byObjet) && asked.length === 2, `${asked.length} appel(s) : ${Object.keys(byObjet)}`)
  check('D4 le mail « Bonjour » (aucune règle) est posé au moteur avec TOUTES les questions', byObjet['Bonjour']?.length === all.length)
  const rows = await pool.query(`SELECT message_id, question, valeur, source, auteur_id, auteur_nom FROM message_tags WHERE account_id = $1 ORDER BY id`, [A1])
  // Les DÉTECTEURS (lot T11b) écrivent aussi en `regle`, signés de leur id, sur TOUT mail :
  // ce banc mesure les règles d'étiquetage, il les écarte.
  const ofRule = rows.rows.filter(r => r.source === RULE_SOURCE && !questions.isRuleQuestionId(r.question))
  check(`D5 les étiquettes de règle sont en source \`${RULE_SOURCE}\`, signées de la règle (id + nom)`,
    ofRule.some(r => r.message_id === MID(1) && r.question === NOUL_Q && r.valeur === 'oui' && r.auteur_id === ruleFoi.id && r.auteur_nom === ruleFoi.name)
    && ofRule.some(r => r.message_id === MID(1) && r.question === CHOICE_Q && r.auteur_id === ruleAvis.id), JSON.stringify(ofRule.slice(0, 3)))
  check('D6 la règle d’AVIS laisse le moteur répondre aussi : deux lignes pour la même question (règle + moteur)',
    rows.rows.filter(r => r.message_id === MID(1) && r.question === CHOICE_Q).length === 2)
  check('D7 le mail « newsletter » porte une étiquette de règle par question active, aucune du moteur',
    rows.rows.filter(r => r.message_id === MID(3) && !questions.isRuleQuestionId(r.question)).every(r => r.source === RULE_SOURCE && r.auteur_id === ruleTout.id) && rows.rows.filter(r => r.message_id === MID(3) && !questions.isRuleQuestionId(r.question)).length === all.length)
  check('D8 le mail « Bonjour » n’a aucune étiquette de règle', !ofRule.some(r => r.message_id === MID(2)))
  const { effective } = await store.readTags(A1, MID(1))
  check('D9 lecture : l’effective d’une question tranchée par règle est la ligne de la règle', effective.find(t => t.question === NOUL_Q)?.source === RULE_SOURCE)

  // ---- E. isolation ------------------------------------------------------------------
  console.log('E. isolation par utilisateur')
  const set2 = await loadQuestionSet(U2)
  const A2 = await makeAccount(U2)
  const mine = await listTagRules(U1), theirs = await listTagRules(U2)
  check('E1 U1 voit ses 3 règles, U2 aucune', mine.length === 3 && theirs.length === 0)
  check('E2 la boîte de U2 ne reçoit aucune règle de U1 (même celles « toutes boîtes »)', (await rulesForAccount(A2)).length === 0)
  check('E3 la boîte de U1 reçoit ses règles « toutes boîtes » ET celle bornée à elle', (await rulesForAccount(A1)).length === 3)
  const e4 = await updateTagRule(U2, ruleFoi.id, { name: 'volée' }, set2).then(() => null, e => e)
  check('E4 U2 ne peut pas modifier une règle de U1 : `UnknownTagRuleError`', e4 instanceof UnknownTagRuleError)
  const e5 = await deleteTagRule(U2, ruleFoi.id).then(() => null, e => e)
  check('E5 U2 ne peut pas supprimer une règle de U1', e5 instanceof UnknownTagRuleError && (await listTagRules(U1)).length === 3)
  const e6 = await createTagRule(U2, { ...GOOD, accountId: A1 }, set2).then(() => null, e => e)
  check('E6 U2 ne peut pas borner une règle à la boîte de U1 : 400 sur `accountId`', e6 instanceof InvalidTagRuleError && e6.field === 'accountId')
  const off = await updateTagRule(U1, ruleAvis.id, { enabled: false }, set1)
  check('E7 une règle désactivée sort de `rulesForAccount`', !off.enabled && (await rulesForAccount(A1)).length === 2)

  // ---- F. les routes -----------------------------------------------------------------
  const alive = BASE ? await fetch(`${BASE}/login`).then(r => r.status === 200).catch(() => false) : false
  if (!alive) {
    console.log(`F. les routes — SAUTÉ (pas de serveur de dev sur ${BASE ?? '<SYNAPMAIL_TEST_URL non renseigné>'})`)
  } else {
    console.log('F. les routes')
    const makeKey = async (userId, scopes) => {
      const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
      const row = await pool.query(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
         VALUES ($1, 'banc tq2', $2, $3, $4::text[], NOW(), NOW()) RETURNING id`,
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
    const P = '/api/tags/rules'
    const writer = await makeKey(U1, ['tags:read', 'tags:write'])
    const reader = await makeKey(U1, ['tags:read'])
    const list = await call(P, { key: writer })
    check('F1 `GET /api/tags/rules` rend les règles de l’appelant sous `{ data }`, `authoritative` compris', list.status === 200 && Array.isArray(list.body?.data) && list.body.data.length === 3 && list.body.data.some(r => r.id === ruleFoi.id && typeof r.authoritative === 'boolean'), `${list.status} ${list.text.slice(0, 120)}`)
    const bad = await call(P, { method: 'POST', key: writer, body: { ...GOOD, actions: [{ question: CHOICE_Q, valeur: 'hors_liste' }] } })
    check('F2 un POST avec une valeur hors liste est un 400 qui NOMME `actions[0].valeur`', bad.status === 400 && bad.body?.field === 'actions[0].valeur', `${bad.status} ${bad.text.slice(0, 160)}`)
    const noWrite = await call(P, { method: 'POST', key: reader, body: GOOD })
    check('F3 une clé sans `tags:write` est refusée par un 403 qui nomme la portée', noWrite.status === 403 && noWrite.body?.missingScope === 'tags:write', `${noWrite.status} ${noWrite.text.slice(0, 120)}`)
    const before = (await listTagRules(U1)).length
    const ok = await call(P, { method: 'POST', key: writer, body: GOOD })
    check('F4 un POST valide est un 201 `{ data }` avec un id', ok.status === 201 && typeof ok.body?.data?.id === 'string', `${ok.status} ${ok.text.slice(0, 160)}`)
    const patched = await call(`${P}/${ok.body?.data?.id}`, { method: 'PATCH', key: writer, body: { authoritative: true } })
    check('F5 un PATCH partiel garde le reste et applique le champ', patched.status === 200 && patched.body?.data?.authoritative === true && patched.body.data.name === GOOD.name, `${patched.status} ${patched.text.slice(0, 120)}`)
    const gone = await call(`${P}/${crypto.randomUUID()}`, { method: 'PATCH', key: writer, body: { enabled: false } })
    check('F6 un PATCH sur une règle inconnue est un 404 qui la nomme', gone.status === 404 && typeof gone.body?.id === 'string', `${gone.status}`)
    const del = await call(`${P}/${ok.body?.data?.id}`, { method: 'DELETE', key: writer })
    check('F7 un DELETE retire la règle', del.status === 200 && (await call(P, { key: writer })).body.data.length === before, `${del.status}`)
    const other = await makeKey(U2, ['tags:read', 'tags:write'])
    const steal = await call(`${P}/${ruleFoi.id}`, { method: 'DELETE', key: other })
    check('F8 la clé d’un autre utilisateur ne peut pas supprimer la règle : 404', steal.status === 404 && (await listTagRules(U1)).length === before, `${steal.status}`)
  }
} finally {
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.engines) await pool.query('DELETE FROM decision_engines WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['D2', 'D3', 'D7', 'D9', 'F3']
  const fell = failures.map(f => f.split(' ')[0]).filter(k => expected.includes(k))
  const unexpected = failures.filter(f => !expected.includes(f.split(' ')[0]))
  const alive = !!BASE
  const want = alive ? expected : expected.filter(k => !k.startsWith('F'))
  if (fell.length === want.length && !unexpected.length) { console.log(`\ncontrôle négatif : ${fell.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\ncontrôle négatif : attendu ${want.join(', ')}, tombés ${fell.join(', ') || 'aucun'}, inattendus ${unexpected.join(' | ') || 'aucun'}`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nrègles d’étiquetage : OK')
