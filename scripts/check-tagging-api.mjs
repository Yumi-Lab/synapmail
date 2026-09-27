#!/usr/bin/env node
/**
 * Banc du lot T4 : les routes d'étiquetage tiennent leurs refus, et l'export ne laisse pas
 * fuir une étiquette de moteur dans un jeu d'entraînement.
 *
 * Mesure sur une instance qui tourne, avec de vraies requêtes HTTP et de vraies lignes en
 * base — pas une lecture de source. Huit bras :
 *
 *   A. une clé SANS `tags:read` est refusée par un 403 QUI NOMME la portée ;
 *   B. une clé à qui la boîte n'est PAS cochée est refusée par un 403 qui NOMME la boîte ;
 *   C. une clé `tags:write` écrit une source de MOTEUR, mais `humain` lui est refusé par un
 *      403 qui nomme la source — c'est la décision 7 : un agent ne signe pas une réponse de
 *      moteur comme validée par une main ;
 *   D. une valeur hors liste est refusée par un 422 QUI LA NOMME, et rien n'est écrit ;
 *   E. une SESSION écrit `humain` avec `valide_par`, la ligne du moteur reste visible, et
 *      c'est l'humaine qui devient l'effective (décision 5) ;
 *   F. le filtre par étiquette rend le mail sous sa valeur EFFECTIVE, et la lecture par
 *      LISTE d'identifiants rend les effectives de plusieurs mails en UNE requête ;
 *   H. `GET /api/tagging/settings` et `/api/tagging/status` ne rendent JAMAIS la clé du
 *      moteur, ni en clair ni chiffrée ; et un Message-ID contenant `/ + % =` fait
 *      l'aller-retour intact (décision 6, mesure exigée par le lot).
 *
 * DANGER, respecté ici : la boîte d'essai vise un hôte VOLONTAIREMENT injoignable
 * (`.invalid`, jamais résolu — RFC 2606) et elle est supprimée dans le `finally`. Aucune
 * route touchée ici n'ouvre de connexion IMAP : les étiquettes vivent en base, et les ordres
 * de tri n'écrivent qu'un état (le travail reste au planificateur). AUCUN appel au vrai
 * moteur : le seul moteur créé porte une URL `.invalid` et n'est jamais interrogé.
 *
 *   node --experimental-strip-types scripts/check-tagging-api.mjs
 *   node --experimental-strip-types scripts/check-tagging-api.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les clés du banc reçoivent TOUTES les portées et TOUTES
 * les boîtes — l'état du produit si les portées et la liste par boîte ne restreignaient rien.
 * Le banc DOIT alors virer au rouge sur A et B. Ce qu'il démontre : ces assertions sont
 * sensibles à l'état des autorisations. Ce qu'il ne démontre PAS : le comportement d'un
 * binaire dont on aurait retiré `keyReachesAccount`.
 */
import './alias-resolver.mjs'
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

// Après `alias-resolver`, jamais avant : un import STATIQUE se résout avant que le crochet
// de résolution ne soit posé, et la chaîne `engine.ts -> '../html'` (sans extension) échoue.
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')
const { HUMAN_SOURCE } = await import('../lib/tagging/engine.ts')

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
} = process.env

const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
})) if (!v) harness(`${k} n'est pas renseigné`)

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const call = async (path, { method = 'GET', key, cookie, body } = {}) => {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* rapporté via `text` */ }
  return { status: res.status, body: parsed, text }
}

/**
 * Les trois questions du banc, une par TYPE, lues de `questions.ts` — jamais recopiées :
 * renommer une valeur là-bas doit casser ici, sinon le banc mesurerait une taxonomie morte.
 */
const { QUESTIONS, valuesOf } = await import('../lib/tagging/questions.ts')
const pick = type => {
  const q = QUESTIONS.find(x => x.type === type)
  if (!q) harness(`aucune question de type ${type} dans questions.ts`)
  return { id: q.id, values: valuesOf(q) }
}
const CHOICE = pick('choice')
const SCORE = pick('score')
const NOUL = pick('noul')

/**
 * Un Message-ID qui porte les quatre caractères que l'encodage d'URL traite à part
 * (`/ + % =`). C'est la mesure exigée par la décision 6 : s'il ne fait pas l'aller-retour, le
 * lot s'arrête et l'orchestrateur tranche.
 */
const TRICKY_ID = '<a/b+c%d=e@bench.invalid>'
const PLAIN_ID = `<plain-${crypto.randomBytes(4).toString('hex')}@bench.invalid>`

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [], engines: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  const health = await call('/login')
  if (health.status !== 200) harness(`le serveur de dev ne répond pas sur ${BASE}/login (${health.status})`)

  /** Une clé portant EXACTEMENT ces portées et EXACTEMENT ces boîtes. */
  const makeKey = async (name, scopes, accountIds) => {
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW(), NOW()) RETURNING id`,
      [userId, `bench ${name}`, raw.slice(0, 12), hash, NEGATIVE ? ALL_SCOPES : scopes]
    )
    const keyId = row.rows[0].id
    created.keys.push(keyId)
    const granted = NEGATIVE
      ? (await pool.query('SELECT id FROM email_accounts WHERE user_id = $1', [userId])).rows.map(r => r.id)
      : accountIds
    for (const accountId of granted) {
      await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [keyId, accountId])
    }
    return raw
  }

  /** Une boîte qui ne peut JOINDRE personne : `.invalid` n'est jamais résolu. */
  const insertMailbox = async () => {
    const tag = crypto.randomBytes(4).toString('hex')
    const row = await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [userId, `tag-bench-${tag}`, `tagbench-${tag}@bench.invalid`, 'imap.bench.invalid', 993, true,
        'smtp.bench.invalid', 587, false, `tagbench-${tag}@bench.invalid`, 'bench-not-a-real-secret']
    )
    created.accounts.push(row.rows[0].id)
    return row.rows[0].id
  }
  const accountId = await insertMailbox()
  const closedId = await insertMailbox()

  // Un moteur avec une clé CHIFFRÉE en base : c'est ce qui rend le bras H mesurable — on
  // cherche la clé en clair ET son chiffré dans les réponses. Son URL est injoignable et
  // aucune route de ce banc ne l'interroge.
  const ENGINE_KEY_PLAIN = `bench-engine-key-${crypto.randomBytes(8).toString('hex')}`
  const { encrypt } = await import('../lib/encrypt.ts')
  const engineKeyEncrypted = encrypt(ENGINE_KEY_PLAIN)
  const engineRow = await pool.query(
    `INSERT INTO decision_engines (user_id, name, kind, url, key_encrypted, model, usd_per_billion_input)
     VALUES ($1, 'bench engine', 'jev', 'https://engine.bench.invalid/v1/systemone', $2, 'jev-bench', 42) RETURNING id`,
    [userId, engineKeyEncrypted]
  )
  const engineId = engineRow.rows[0].id
  created.engines.push(engineId)

  const readerKey = await makeKey('tags reader', ['tags:read'], [accountId])
  const writerKey = await makeKey('tags writer', ['tags:read', 'tags:write'], [accountId])
  const blindKey = await makeKey('no tags scope', ['messages:read'], [accountId])

  // Session humaine : cookie NextAuth obtenu comme le ferait un navigateur.
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const { csrfToken } = await csrfRes.json()
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  })
  const cookie = [csrfCookie, ...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0])].join('; ')
  if (!/session-token/.test(cookie)) harness(`connexion par identifiants refusée (${loginRes.status})`)

  const tagsPath = (mid, q = '') => `/api/messages/${encodeURIComponent(mid)}/tags${q}`

  // ---- A. la portée ----------------------------------------------------------------
  const noScope = await call(tagsPath(PLAIN_ID, `?account=${accountId}`), { key: blindKey })
  check('A1 une clé sans `tags:read` est refusée par un 403 qui NOMME la portée',
    noScope.status === 403 && noScope.body?.missingScope === 'tags:read' && String(noScope.body?.error ?? '').includes('tags:read'),
    `reçu ${noScope.status} — ${noScope.text.slice(0, 200)}`)

  const noWriteScope = await call(tagsPath(PLAIN_ID), {
    method: 'PUT', key: readerKey,
    body: { accountId, source: 'jev', tags: [{ question: CHOICE.id, valeur: CHOICE.values[0] }] },
  })
  check('A2 une clé sans `tags:write` ne peut pas écrire, et le 403 nomme la portée',
    noWriteScope.status === 403 && noWriteScope.body?.missingScope === 'tags:write',
    `reçu ${noWriteScope.status} — ${noWriteScope.text.slice(0, 200)}`)

  // ---- B. la boîte -----------------------------------------------------------------
  const closed = await call(tagsPath(PLAIN_ID, `?account=${closedId}`), { key: readerKey })
  check('B1 une clé sans la boîte est refusée par un 403 qui NOMME la boîte',
    closed.status === 403 && closed.body?.missingAccount === closedId && String(closed.body?.error ?? '').includes(closedId),
    `reçu ${closed.status} — ${closed.text.slice(0, 200)}`)

  // ---- C. qui écrit quelle source --------------------------------------------------
  const engineWrite = await call(tagsPath(PLAIN_ID), {
    method: 'PUT', key: writerKey,
    body: {
      accountId, source: 'jev', model: 'jev-bench', folder: 'INBOX', uid: 4242,
      subject: 'bench subject', fromAddress: 'sender@bench.invalid', date: new Date().toISOString(),
      tags: [
        { question: CHOICE.id, valeur: CHOICE.values[0], confiance: 0.81 },
        { question: SCORE.id, valeur: SCORE.values[1] },
        { question: NOUL.id, valeur: NOUL.values[0], confiance: 0.62 },
      ],
    },
  })
  check('C1 une clé `tags:write` écrit les étiquettes d\'un MOTEUR',
    engineWrite.status === 200 && engineWrite.body?.data?.written === 3 && engineWrite.body?.data?.source === 'jev',
    `reçu ${engineWrite.status} — ${engineWrite.text.slice(0, 200)}`)

  const laundering = await call(tagsPath(PLAIN_ID), {
    method: 'PUT', key: writerKey,
    body: { accountId, source: HUMAN_SOURCE, tags: [{ question: CHOICE.id, valeur: CHOICE.values[1] }] },
  })
  check('C2 une clé NE PEUT PAS écrire `humain` — le 403 nomme la source refusée',
    laundering.status === 403 && laundering.body?.source === HUMAN_SOURCE,
    `reçu ${laundering.status} — ${laundering.text.slice(0, 200)}`)

  // ---- D. une valeur hors liste ----------------------------------------------------
  const bogus = 'valeur-que-la-question-ne-prevoit-pas'
  const refused = await call(tagsPath(PLAIN_ID), {
    method: 'PUT', key: writerKey,
    body: { accountId, source: 'jev', tags: [{ question: CHOICE.id, valeur: bogus }] },
  })
  check('D1 une valeur hors liste est refusée par un 422 qui NOMME la question et la valeur',
    refused.status === 422 && refused.body?.question === CHOICE.id && refused.body?.valeur === bogus,
    `reçu ${refused.status} — ${refused.text.slice(0, 200)}`)

  const stored = await pool.query(
    'SELECT COUNT(*)::int AS n FROM message_tags WHERE account_id = $1 AND valeur = $2',
    [accountId, bogus]
  )
  check('D2 la valeur refusée n\'est PAS en base', stored.rows[0].n === 0, `${stored.rows[0].n} ligne(s)`)

  // ---- E. la correction humaine ----------------------------------------------------
  const corrected = CHOICE.values[1]
  const humanWrite = await call(tagsPath(PLAIN_ID), {
    method: 'PUT', cookie,
    body: { accountId, tags: [{ question: CHOICE.id, valeur: corrected }] },
  })
  const humanRow = (humanWrite.body?.data?.tags ?? []).find(t => t.source === HUMAN_SOURCE && t.question === CHOICE.id)
  const engineRowStill = (humanWrite.body?.data?.tags ?? []).find(t => t.source === 'jev' && t.question === CHOICE.id)
  const effective = (humanWrite.body?.data?.effective ?? []).find(t => t.question === CHOICE.id)
  check('E1 une session écrit `humain`, avec `valide_par`',
    humanWrite.status === 200 && humanWrite.body?.data?.source === HUMAN_SOURCE
      && humanRow?.valeur === corrected && humanRow?.validePar === userId,
    `reçu ${humanWrite.status} — ${JSON.stringify(humanRow ?? null).slice(0, 200)}`)
  check('E2 la ligne du moteur reste visible à côté de la correction',
    engineRowStill?.valeur === CHOICE.values[0],
    `ligne moteur : ${JSON.stringify(engineRowStill ?? null).slice(0, 160)}`)
  check('E3 l\'effective est l\'humaine',
    effective?.source === HUMAN_SOURCE && effective?.valeur === corrected,
    `effective : ${JSON.stringify(effective ?? null).slice(0, 200)}`)

  // ---- F. le filtre et la lecture par liste ----------------------------------------
  const oldValue = await call(`/api/tags?account=${accountId}&question=${CHOICE.id}&valeur=${CHOICE.values[0]}`, { key: readerKey })
  const newValue = await call(`/api/tags?account=${accountId}&question=${CHOICE.id}&valeur=${corrected}`, { key: readerKey })
  const ids = m => (m.body?.data?.messages ?? []).map(x => x.messageId)
  check('F1 le filtre rend le mail sous la valeur CORRIGÉE, plus sous celle du moteur',
    newValue.status === 200 && ids(newValue).includes(PLAIN_ID) && !ids(oldValue).includes(PLAIN_ID),
    `ancienne ${oldValue.status}:${JSON.stringify(ids(oldValue)).slice(0, 80)} — nouvelle ${newValue.status}:${JSON.stringify(ids(newValue)).slice(0, 80)}`)

  const positioned = (newValue.body?.data?.messages ?? []).find(m => m.messageId === PLAIN_ID)
  check('F2 le mail filtré porte sa position connue (dossier, uid, objet)',
    positioned?.folder === 'INBOX' && positioned?.uid === 4242 && positioned?.subject === 'bench subject',
    `position : ${JSON.stringify(positioned ?? null).slice(0, 200)}`)

  const unknownValue = await call(`/api/tags?account=${accountId}&question=${CHOICE.id}&valeur=${bogus}`, { key: readerKey })
  check('F3 une valeur que la question ne prévoit pas est un 422, pas une page vide',
    unknownValue.status === 422 && unknownValue.body?.valeur === bogus,
    `reçu ${unknownValue.status} — ${unknownValue.text.slice(0, 160)}`)

  // Un second mail, pour que la lecture par liste porte sur PLUSIEURS identifiants.
  await call(tagsPath(TRICKY_ID), {
    method: 'PUT', key: writerKey,
    body: { accountId, source: 'jev', model: 'jev-bench', folder: 'INBOX', uid: 4243, tags: [{ question: NOUL.id, valeur: NOUL.values[1] }] },
  })
  const listed = await call(
    `/api/tags?account=${accountId}&id=${encodeURIComponent(PLAIN_ID)}&id=${encodeURIComponent(TRICKY_ID)}`,
    { key: readerKey }
  )
  const byId = listed.body?.data?.effective ?? {}
  check('F4 une SEULE requête rend les effectives de plusieurs mails',
    listed.status === 200 && Array.isArray(byId[PLAIN_ID]) && Array.isArray(byId[TRICKY_ID])
      && byId[PLAIN_ID].some(t => t.question === CHOICE.id && t.valeur === corrected),
    `reçu ${listed.status} — clés ${JSON.stringify(Object.keys(byId)).slice(0, 200)}`)

  // ---- H. la clé du moteur, et l'aller-retour du Message-ID -------------------------
  await call('/api/tagging/settings', { method: 'PUT', cookie, body: { accountId, engineId, budgetUsd: 3 } })
  const settings = await call(`/api/tagging/settings?account=${accountId}`, { cookie })
  const status = await call(`/api/tagging/status?account=${accountId}`, { key: readerKey })
  const leaks = body => body.includes(ENGINE_KEY_PLAIN) || body.includes(engineKeyEncrypted) || /key_encrypted|"key"/.test(body)
  check('H1 les réglages disent `hasKey` sans JAMAIS rendre la clé du moteur',
    settings.status === 200 && settings.body?.data?.engine?.hasKey === true && !leaks(settings.text),
    `reçu ${settings.status} — ${settings.text.slice(0, 200)}`)
  check('H2 l\'état du tri ne rend pas la clé non plus, et porte le plafond réglé',
    status.status === 200 && status.body?.data?.budgetUsd === 3 && !leaks(status.text),
    `reçu ${status.status} — ${status.text.slice(0, 200)}`)

  const keyOnSettings = await call(`/api/tagging/settings?account=${accountId}`, { key: writerKey })
  check('H3 aucune clé API n\'atteint les réglages (ils désignent une clé de moteur)',
    keyOnSettings.status === 401, `reçu ${keyOnSettings.status} — ${keyOnSettings.text.slice(0, 160)}`)

  const roundTrip = await call(tagsPath(TRICKY_ID, `?account=${accountId}`), { key: readerKey })
  check('H4 un Message-ID contenant `/ + % =` fait l\'aller-retour intact',
    roundTrip.status === 200 && roundTrip.body?.data?.messageId === TRICKY_ID
      && (roundTrip.body?.data?.effective ?? []).some(t => t.question === NOUL.id),
    `reçu ${roundTrip.status} — messageId ${JSON.stringify(roundTrip.body?.data?.messageId ?? null)}`)

  const run = await call('/api/tagging/run', { method: 'POST', key: writerKey, body: { accountId, action: 'start' } })
  check('H5 `run` change l\'état sans trier lui-même (le travail reste au planificateur)',
    run.status === 200 && run.body?.data?.bulkState === 'running' && !leaks(run.text),
    `reçu ${run.status} — ${run.text.slice(0, 200)}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec. Les étiquettes et la
  // ligne de tri partent avec la boîte (ON DELETE CASCADE).
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['tagbench-%@bench.invalid']).catch(() => {})
  for (const id of created.engines) await pool.query('DELETE FROM decision_engines WHERE id = $1', [id]).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : tout accordé, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nroutes d\'étiquetage : OK')
