#!/usr/bin/env node
/**
 * Banc du lot P8 : une clé API ne peut QUE ce que son propriétaire lui a coché.
 *
 * Mesure sur une instance qui tourne, avec de vraies requêtes HTTP et de vraies
 * lignes en base — pas une lecture de source. Quatre bras :
 *
 *   A. une clé qui a `accounts:create` AJOUTE une boîte (201) et se voit REFUSER
 *      sa suppression par un 403 QUI NOMME `accounts:delete` ;
 *   B. une clé sans `accounts:create` est refusée à la création (403 nommant la
 *      portée), et refusée de même sur `/api/accounts/test` ;
 *   C. une clé d'AVANT la migration — celle que `LEGACY_SCOPES` décrit — garde
 *      l'accès aux routes qu'elle avait, et n'a PAS reçu l'écriture sur les boîtes ;
 *   D. une session humaine crée ET supprime, sans aucune portée.
 *
 * DANGER, respecté ici : la boîte d'essai vise un hôte VOLONTAIREMENT injoignable
 * (`.invalid`, jamais résolu par construction — RFC 2606) avec un faux mot de passe,
 * et elle est supprimée dans le `finally`. Aucune tentative de connexion ne part
 * vers un vrai serveur : `POST /api/accounts` n'ouvre aucune session IMAP, et le
 * seul appel à `/api/accounts/test` est celui qu'une portée manquante refuse AVANT
 * tout réseau. Une rafale d'échecs d'authentification ferait blacklister l'IP.
 *
 *   node --experimental-strip-types scripts/check-api-scopes.mjs
 *   node --experimental-strip-types scripts/check-api-scopes.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les mêmes bras, mais chaque clé du banc reçoit
 * TOUTES les portées — c'est-à-dire l'état du produit si la vérification ne
 * restreignait rien. Le banc DOIT alors virer au rouge sur les refus attendus.
 * Ce qu'il démontre : les assertions sont sensibles à l'état des portées. Ce qu'il
 * ne démontre PAS : le comportement d'un binaire dont on aurait retiré le code de
 * `scopeForRequest` — il mesure la décision, pas sa suppression.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { ALL_SCOPES, API_SCOPES, LEGACY_SCOPES } from '../lib/apiScopes.ts'

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

/** Un 403 de portée est lisible s'il NOMME la portée qui manque. */
const refusesScope = (res, scope) =>
  res.status === 403 && res.body?.missingScope === scope &&
  String(res.body?.error ?? '').includes(scope) && res.body?.missingScopeLabel === API_SCOPES[scope]

const call = async (path, { method = 'GET', key, cookie, body } = {}) => {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* reported through `text` */ }
  return { status: res.status, body: parsed, text }
}

/**
 * Une boîte qui ne peut JOINDRE personne : `.invalid` n'est jamais résolu, et le
 * mot de passe est un littéral de banc. Un suffixe unique par passage pour qu'un
 * passage interrompu ne bloque pas le suivant.
 */
const mailbox = () => {
  const tag = crypto.randomBytes(4).toString('hex')
  return {
    name: `scope-bench-${tag}`,
    email: `bench-${tag}@bench.invalid`,
    imapHost: 'imap.bench.invalid', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.bench.invalid', smtpPort: 587, smtpSecure: false,
    username: `bench-${tag}@bench.invalid`,
    password: 'not-a-real-password',
  }
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  /** Pose une clé avec exactement ces portées, et rend la clé en clair. */
  const makeKey = async (name, scopes) => {
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    const granted = NEGATIVE ? ALL_SCOPES : scopes
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW()) RETURNING id`,
      [userId, `bench ${name}`, raw.slice(0, 12), hash, granted]
    )
    created.keys.push(row.rows[0].id)
    return raw
  }

  const creatorKey = await makeKey('creator', ['accounts:read', 'accounts:create'])
  const readerKey = await makeKey('reader', ['accounts:read'])
  const legacyKey = await makeKey('legacy', LEGACY_SCOPES)

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

  const remember = res => { if (res.body?.data?.id) created.accounts.push(res.body.data.id) }

  // ---- A. la clé qui a le droit d'ajouter ajoute, et ne peut pas supprimer ----
  const createdByKey = await call('/api/accounts', { method: 'POST', key: creatorKey, body: mailbox() })
  remember(createdByKey)
  check('A1 une clé `accounts:create` ajoute une boîte (201)',
    createdByKey.status === 201, `reçu ${createdByKey.status} — ${createdByKey.text.slice(0, 160)}`)

  if (createdByKey.body?.data?.id) {
    const id = createdByKey.body.data.id
    const refused = await call(`/api/accounts/${id}`, { method: 'DELETE', key: creatorKey })
    check('A2 la même clé est REFUSÉE à la suppression, 403 nommant `accounts:delete`',
      refusesScope(refused, 'accounts:delete'), `reçu ${refused.status} — ${refused.text.slice(0, 160)}`)

    const patched = await call(`/api/accounts/${id}`, { method: 'PATCH', key: creatorKey, body: { name: 'renamed' } })
    check('A3 la même clé est REFUSÉE à la modification, 403 nommant `accounts:update`',
      refusesScope(patched, 'accounts:update'), `reçu ${patched.status} — ${patched.text.slice(0, 160)}`)
  }

  // ---- B. la clé sans le droit d'ajouter ne peut pas ajouter ----
  const refusedCreate = await call('/api/accounts', { method: 'POST', key: readerKey, body: mailbox() })
  remember(refusedCreate)
  check('B1 une clé sans `accounts:create` est refusée à la création',
    refusesScope(refusedCreate, 'accounts:create'), `reçu ${refusedCreate.status} — ${refusedCreate.text.slice(0, 160)}`)

  // Refusé AVANT tout réseau : aucune connexion ne part de cet appel.
  const refusedTest = await call('/api/accounts/test', { method: 'POST', key: readerKey, body: mailbox() })
  check('B2 la même clé est refusée sur `/api/accounts/test`',
    refusesScope(refusedTest, 'accounts:create'), `reçu ${refusedTest.status} — ${refusedTest.text.slice(0, 160)}`)

  const listedByReader = await call('/api/accounts', { key: readerKey })
  check('B3 elle garde la lecture qu\'on lui a donnée (200)',
    listedByReader.status === 200, `reçu ${listedByReader.status} — ${listedByReader.text.slice(0, 160)}`)

  // ---- C. la clé d'avant la migration n'a rien perdu, et n'a rien gagné ----
  const legacyRead = await call('/api/accounts', { key: legacyKey })
  check('C1 une clé d\'avant la migration lit toujours les boîtes (200)',
    legacyRead.status === 200, `reçu ${legacyRead.status} — ${legacyRead.text.slice(0, 160)}`)

  const legacyContacts = await call('/api/contacts', { key: legacyKey })
  check('C2 elle lit toujours les contacts (200)',
    legacyContacts.status === 200, `reçu ${legacyContacts.status} — ${legacyContacts.text.slice(0, 160)}`)

  const legacyCreate = await call('/api/accounts', { method: 'POST', key: legacyKey, body: mailbox() })
  remember(legacyCreate)
  check('C3 elle n\'a PAS reçu l\'écriture sur les boîtes (403 nommant `accounts:create`)',
    refusesScope(legacyCreate, 'accounts:create'), `reçu ${legacyCreate.status} — ${legacyCreate.text.slice(0, 160)}`)

  // ---- D. la session humaine n'est jamais limitée par une portée ----
  const bySession = await call('/api/accounts', { method: 'POST', cookie, body: mailbox() })
  remember(bySession)
  check('D1 la session humaine ajoute une boîte (201)',
    bySession.status === 201, `reçu ${bySession.status} — ${bySession.text.slice(0, 160)}`)

  if (bySession.body?.data?.id) {
    const removed = await call(`/api/accounts/${bySession.body.data.id}`, { method: 'DELETE', cookie })
    check('D2 la session humaine supprime la boîte (200)',
      removed.status === 200, `reçu ${removed.status} — ${removed.text.slice(0, 160)}`)
  }

  // ---- E. aucune clé n'échappe à la table des portées ----
  const unknownScoped = await call('/api/settings', { key: creatorKey })
  check('E1 une route hors table reste fermée aux clés (401)',
    unknownScoped.status === 401, `reçu ${unknownScoped.status} — ${unknownScoped.text.slice(0, 160)}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec.
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['bench-%@bench.invalid']).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : toutes portées accordées, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nportées des clés API : OK')
