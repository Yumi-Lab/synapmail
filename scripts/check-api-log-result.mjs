#!/usr/bin/env node
/**
 * Banc du lot P11 : le journal d'une clé API dit CE QUI S'EST PASSÉ.
 *
 * Avant ce lot la ligne ne portait que méthode, chemin, IP et heure — « on voit juste
 * GET, on ne voit pas ce qui s'est passé ». Ce banc mesure, sur une instance qui
 * tourne et avec de vraies lignes en base, que chaque requête laisse désormais son
 * statut HTTP, sa durée, la boîte visée et le motif de son refus. Quatre bras :
 *
 *   A. une requête ACCORDÉE écrit statut, durée et la boîte sur laquelle elle a agi ;
 *   B. un refus de PORTÉE écrit 403 + le motif `scope` + la portée qui manque ;
 *      un refus de BOÎTE écrit 403 + le motif `account` + la boîte fermée ;
 *   C. une session HUMAINE n'écrit aucune ligne — le journal est celui des clés ;
 *   D. AUCUNE route ouverte au Bearer n'échappe à `withApiLog` : une route dont la
 *      réponse ne termine pas sa ligne laisserait un trou silencieux dans le journal.
 *      Ce bras lit la SOURCE et se compare à `ROUTE_SCOPES` — le bras qui compte,
 *      puisque l'oubli d'une seule route ne se voit sur aucune requête particulière.
 *
 * DANGER, respecté ici : la boîte d'essai vise un hôte VOLONTAIREMENT injoignable
 * (`.invalid`, jamais résolu — RFC 2606). Les bras qui mesurent un refus le mesurent
 * AVANT tout réseau. Aucune tentative de connexion ne part vers un vrai serveur :
 * une rafale d'échecs ferait blacklister l'IP.
 *
 *   node --experimental-strip-types scripts/check-api-log-result.mjs
 *   node --experimental-strip-types scripts/check-api-log-result.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les lignes sont relues en IGNORANT les colonnes
 * du lot (statut, durée, boîte, motif lus comme `null`) — c'est-à-dire l'état du
 * journal AVANT P11. Le banc DOIT alors virer au rouge sur A et B. Ce qu'il démontre :
 * les assertions portent bien sur les nouvelles colonnes et pas sur ce qui existait
 * déjà. Ce qu'il ne démontre PAS : le comportement d'un binaire dont on aurait retiré
 * `closeLog` — il mesure la ligne écrite, pas la suppression du code qui l'écrit.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { ALL_SCOPES, ROUTE_SCOPES } from '../lib/apiScopes.ts'

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
  return { status: res.status, text }
}

/**
 * Une boîte qui ne peut JOINDRE personne : `.invalid` n'est jamais résolu, et le
 * mot de passe est un littéral de banc.
 */
const mailbox = () => {
  const tag = crypto.randomBytes(4).toString('hex')
  return {
    name: `log-bench-${tag}`,
    email: `bench-${tag}@bench.invalid`,
    imapHost: 'imap.bench.invalid', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.bench.invalid', smtpPort: 587, smtpSecure: false,
    username: `bench-${tag}@bench.invalid`,
    password: 'not-a-real-password',
    verify: false,
  }
}

// ---- D. drift de source : chaque route Bearer est enveloppée ----
// Lu depuis `ROUTE_SCOPES`, la source unique de ce qui est ouvert aux clés : une
// route qui y entre sans être enveloppée tombe ici, le jour où elle est ajoutée.
const routeFiles = new Map()
for (const key of Object.keys(ROUTE_SCOPES)) {
  const [method, path] = key.split(' ')
  const file = new URL(`../app${path}/route.ts`, import.meta.url)
  if (!routeFiles.has(file.pathname)) routeFiles.set(file.pathname, { path, methods: [] })
  routeFiles.get(file.pathname).methods.push(method)
}
for (const [file, { path, methods }] of routeFiles) {
  if (!existsSync(file)) harness(`${path} est dans ROUTE_SCOPES mais ${file} n'existe pas`)
  const src = readFileSync(file, 'utf8')
  for (const method of methods) {
    const wrapped = new RegExp(`export const ${method}\\s*=\\s*withApiLog\\(`).test(src)
    const bare = new RegExp(`export async function ${method}\\s*\\(`).test(src)
    check(`D ${method} ${path} termine sa ligne de journal (withApiLog)`,
      wrapped && !bare,
      wrapped ? `${method} est aussi exportée nue` : `${method} n'est pas enveloppée dans ${path}/route.ts`)
  }
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [] }

/**
 * La DERNIÈRE ligne écrite pour cette clé sur ce chemin. En contrôle négatif les
 * colonnes du lot sont effacées à la lecture : le journal redevient celui d'avant.
 */
const lastLog = async (keyId, path) => {
  const { rows } = await pool.query(
    `SELECT method, path, status, duration_ms, account_id, denial_reason, denial_detail
       FROM api_key_requests WHERE api_key_id = $1 AND path = $2
      ORDER BY created_at DESC LIMIT 1`,
    [keyId, path]
  )
  if (!rows.length) return null
  const row = rows[0]
  if (NEGATIVE) return { ...row, status: null, duration_ms: null, account_id: null, denial_reason: null, denial_detail: null }
  return row
}

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  /** Pose une clé avec EXACTEMENT ces portées et ces boîtes cochées. */
  const makeKey = async (name, scopes, accountIds) => {
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW(), NOW()) RETURNING id`,
      [userId, `bench ${name}`, raw.slice(0, 12), hash, scopes]
    )
    created.keys.push(row.rows[0].id)
    for (const accountId of accountIds) {
      await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.rows[0].id, accountId])
    }
    return { raw, id: row.rows[0].id }
  }

  const insertMailbox = async () => {
    const m = mailbox()
    const row = await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [userId, m.name, m.email, m.imapHost, m.imapPort, m.imapSecure,
       m.smtpHost, m.smtpPort, m.smtpSecure, m.username, 'bench-not-a-real-secret']
    )
    created.accounts.push(row.rows[0].id)
    return row.rows[0].id
  }
  const allowedId = await insertMailbox()
  const closedId = await insertMailbox()

  const fullKey = await makeKey('journal-complet', ALL_SCOPES, [allowedId])
  const narrowKey = await makeKey('journal-etroit', ['accounts:read'], [allowedId])

  // ---- A. une requête accordée dit ce qu'elle a fait ----
  const listed = await call('/api/accounts', { key: fullKey.raw })
  const logList = await lastLog(fullKey.id, '/api/accounts')
  check('A1 la requête accordée a laissé une ligne',
    logList !== null, 'aucune ligne pour /api/accounts')
  check('A2 la ligne porte le statut HTTP réellement rendu',
    logList?.status === listed.status, `HTTP ${listed.status} vs ligne ${logList?.status ?? 'null'}`)
  check('A3 la ligne porte une durée mesurée (≥ 0 ms, pas nulle)',
    Number.isInteger(logList?.duration_ms) && logList.duration_ms >= 0,
    `duration_ms = ${logList?.duration_ms ?? 'null'}`)

  const onAllowed = await call(`/api/folders?account=${allowedId}`, { key: fullKey.raw })
  const logAllowed = await lastLog(fullKey.id, '/api/folders')
  check('A4 la ligne nomme la BOÎTE sur laquelle la clé a agi',
    logAllowed?.account_id === allowedId,
    `visée ${allowedId} vs ligne ${logAllowed?.account_id ?? 'null'} (HTTP ${onAllowed.status})`)
  check('A5 une requête accordée n\'a AUCUN motif de refus',
    logAllowed !== null && logAllowed.denial_reason === null,
    `denial_reason = ${logAllowed?.denial_reason ?? 'null'}`)

  // ---- B. un refus dit POURQUOI ----
  const scopeDenied = await call(`/api/folders?account=${allowedId}`, { key: narrowKey.raw })
  const logScope = await lastLog(narrowKey.id, '/api/folders')
  check('B1 un refus de PORTÉE est journalisé 403 + motif `scope`',
    scopeDenied.status === 403 && logScope?.status === 403 && logScope?.denial_reason === 'scope',
    `HTTP ${scopeDenied.status} — ligne ${JSON.stringify(logScope)}`)
  check('B2 il NOMME la portée qui manque',
    logScope?.denial_detail === 'folders:read', `denial_detail = ${logScope?.denial_detail ?? 'null'}`)

  const accountDenied = await call(`/api/folders?account=${closedId}`, { key: fullKey.raw })
  const logAccount = await lastLog(fullKey.id, '/api/folders')
  check('B3 un refus de BOÎTE est journalisé 403 + motif `account`',
    accountDenied.status === 403 && logAccount?.status === 403 && logAccount?.denial_reason === 'account',
    `HTTP ${accountDenied.status} — ligne ${JSON.stringify(logAccount)}`)
  check('B4 il NOMME la boîte fermée',
    logAccount?.denial_detail === closedId && logAccount?.account_id === closedId,
    `detail ${logAccount?.denial_detail ?? 'null'} / account ${logAccount?.account_id ?? 'null'}, attendu ${closedId}`)

  // ---- C. une session humaine n'est pas journalisée ----
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

  const before = await pool.query('SELECT COUNT(*)::int AS n FROM api_key_requests')
  await call(`/api/folders?account=${closedId}`, { cookie })
  await call('/api/accounts', { cookie })
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM api_key_requests')
  check('C1 deux requêtes de session humaine n\'écrivent AUCUNE ligne',
    after.rows[0].n === before.rows[0].n,
    `${before.rows[0].n} → ${after.rows[0].n} ligne(s)`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec.
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['bench-%@bench.invalid']).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : colonnes du lot ignorées, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\njournal des requêtes : OK')
