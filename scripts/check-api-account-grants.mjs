#!/usr/bin/env node
/**
 * Banc du lot P10 : une clé API ne peut agir que sur les boîtes qu'elle a le droit
 * d'atteindre. Les portées disent QUELLE capacité, ce banc mesure SUR QUELLE boîte.
 *
 * Mesure sur une instance qui tourne, avec de vraies requêtes HTTP et de vraies
 * lignes en base — pas une lecture de source. Cinq bras :
 *
 *   A. une clé à qui on a COCHÉ la boîte A la lit, et se voit REFUSER la boîte B
 *      par un 403 QUI NOMME la boîte ;
 *   B. AUCUNE route Bearer prenant une boîte en paramètre n'échappe à la barrière —
 *      le bras qui compte : l'oubli d'une seule route rend la fonction inutile ;
 *   C. une boîte CONNECTÉE par une clé lui appartient : elle la lit, la modifie et
 *      la supprime sans qu'on ait rien coché ;
 *   D. une session humaine n'est limitée ni par une portée ni par cette liste ;
 *   E. une clé d'avant la migration garde les boîtes qu'elle atteignait déjà.
 *
 * DANGER, respecté ici : la boîte d'essai vise un hôte VOLONTAIREMENT injoignable
 * (`.invalid`, jamais résolu — RFC 2606) avec un faux mot de passe, et elle est
 * supprimée dans le `finally`. Les boîtes RÉELLES de la base ne servent qu'à être
 * REFUSÉES : un refus est rendu AVANT tout réseau, donc aucune tentative de
 * connexion ne part vers IONOS. Une rafale d'échecs ferait blacklister l'IP.
 *
 *   node --experimental-strip-types scripts/check-api-account-grants.mjs
 *   node --experimental-strip-types scripts/check-api-account-grants.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les mêmes bras, mais chaque clé du banc reçoit
 * TOUTES les boîtes — l'état du produit si la liste par boîte ne restreignait rien.
 * Le banc DOIT alors virer au rouge sur les refus attendus. D2 y tombe aussi, et
 * c'est COHÉRENT : sans barrière, le bras B `DELETE /api/accounts/[id]` aboutit
 * vraiment et supprime la boîte que D2 cherchait ensuite. C'est la preuve que le
 * bras B atteint bien la suppression, pas un défaut du banc. Ce qu'il démontre : les
 * assertions sont sensibles à l'état des autorisations. Ce qu'il ne démontre PAS :
 * le comportement d'un binaire dont on aurait retiré `keyReachesAccount`.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { ALL_SCOPES } from '../lib/apiScopes.ts'

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

/** Un 403 de boîte est lisible s'il NOMME la boîte qui manque. */
const refusesAccount = (res, accountId) =>
  res.status === 403 && res.body?.missingAccount === accountId &&
  String(res.body?.error ?? '').includes(accountId)

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
 * Une boîte qui ne peut JOINDRE personne : `.invalid` n'est jamais résolu, et le
 * mot de passe est un littéral de banc.
 */
const mailbox = () => {
  const tag = crypto.randomBytes(4).toString('hex')
  return {
    name: `grant-bench-${tag}`,
    email: `bench-${tag}@bench.invalid`,
    imapHost: 'imap.bench.invalid', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.bench.invalid', smtpPort: 587, smtpSecure: false,
    username: `bench-${tag}@bench.invalid`,
    password: 'not-a-real-password',
    verify: false,
  }
}

/**
 * L'INVENTAIRE des routes Bearer qui désignent une boîte, et comment chacune la
 * désigne : paramètre d'URL, corps JSON, ou segment de chemin. C'est le bras B —
 * chacune doit REFUSER une boîte non cochée, en la nommant. Une route ajoutée à
 * `ROUTE_SCOPES` sans passer par la barrière tomberait ici.
 *
 * Chaque entrée porte la portée qu'il lui faut, pour que la clé du bras B les ait
 * TOUTES : sans elles le refus viendrait de la portée manquante et non de la boîte,
 * et le banc croirait mesurer la barrière alors qu'il mesurerait l'autre.
 */
const ACCOUNT_ROUTES = [
  { label: 'GET /api/messages', path: id => `/api/messages?account=${id}` },
  { label: 'GET /api/messages/[id]', path: id => `/api/messages/1?account=${id}&folder=INBOX` },
  { label: 'GET /api/messages/search', path: id => `/api/messages/search?account=${id}&q=x` },
  { label: 'GET /api/messages/thread', path: id => `/api/messages/thread?account=${id}&subject=x` },
  { label: 'PATCH /api/messages/[id]', method: 'PATCH', path: id => `/api/messages/1?account=${id}&folder=INBOX`, body: { isRead: true } },
  { label: 'DELETE /api/messages/[id]', method: 'DELETE', path: id => `/api/messages/1?account=${id}&folder=INBOX` },
  { label: 'PATCH /api/messages/bulk', method: 'PATCH', path: () => '/api/messages/bulk', body: id => ({ uids: ['1'], action: 'read', accountId: id, folder: 'INBOX' }) },
  { label: 'DELETE /api/messages/bulk', method: 'DELETE', path: () => '/api/messages/bulk', body: id => ({ uids: ['1'], accountId: id, folder: 'INBOX' }) },
  { label: 'POST /api/messages/send', method: 'POST', path: () => '/api/messages/send', body: id => ({ accountId: id, to: ['x@bench.invalid'], subject: 'x' }) },
  { label: 'GET /api/folders', path: id => `/api/folders?account=${id}` },
  { label: 'POST /api/folders', method: 'POST', path: () => '/api/folders', body: id => ({ accountId: id, name: 'x' }) },
  { label: 'PATCH /api/folders', method: 'PATCH', path: () => '/api/folders', body: id => ({ accountId: id, path: 'x', name: 'y' }) },
  { label: 'DELETE /api/folders', method: 'DELETE', path: id => `/api/folders?account=${id}&path=x` },
  { label: 'POST /api/folders/actions', method: 'POST', path: () => '/api/folders/actions', body: id => ({ accountId: id, path: 'INBOX', action: 'markRead' }) },
  { label: 'GET /api/contacts', path: id => `/api/contacts?account=${id}` },
  { label: 'POST /api/ai/action', method: 'POST', path: () => '/api/ai/action', body: id => ({ accountId: id, action: 'summarize', content: 'x' }) },
  { label: 'PATCH /api/accounts/[id]', method: 'PATCH', path: id => `/api/accounts/${id}`, body: { name: 'renamed' } },
  { label: 'DELETE /api/accounts/[id]', method: 'DELETE', path: id => `/api/accounts/${id}` },
]

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  /** Pose une clé avec toutes les portées et EXACTEMENT ces boîtes cochées. */
  const makeKey = async (name, accountIds) => {
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW(), NOW()) RETURNING id`,
      [userId, `bench ${name}`, raw.slice(0, 12), hash, ALL_SCOPES]
    )
    const keyId = row.rows[0].id
    created.keys.push(keyId)
    const granted = NEGATIVE ? (await pool.query('SELECT id FROM email_accounts WHERE user_id = $1', [userId])).rows.map(r => r.id) : accountIds
    for (const accountId of granted) {
      await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [keyId, accountId])
    }
    return { raw, id: keyId }
  }

  // Deux boîtes d'essai, injoignables par construction : l'une sera cochée, l'autre
  // JAMAIS. On ne coche jamais une vraie boîte de la base à une clé de banc.
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

  const scopedKey = await makeKey('granted', [allowedId])

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

  // ---- A. cochée d'un côté, fermée de l'autre ----
  const listed = await call('/api/accounts', { key: scopedKey.raw })
  const visible = (listed.body?.data ?? []).map(a => a.id)
  check('A1 la liste des boîtes ne montre QUE celle qui est cochée',
    listed.status === 200 && visible.includes(allowedId) && !visible.includes(closedId),
    `reçu ${listed.status} — ${visible.length} boîte(s) : ${JSON.stringify(visible).slice(0, 160)}`)

  const openFolders = await call(`/api/folders?account=${allowedId}`, { key: scopedKey.raw })
  check('A2 elle atteint la boîte cochée (pas de 403 de boîte)',
    openFolders.status !== 403, `reçu ${openFolders.status} — ${openFolders.text.slice(0, 160)}`)

  const closedFolders = await call(`/api/folders?account=${closedId}`, { key: scopedKey.raw })
  check('A3 elle est REFUSÉE sur la boîte non cochée, 403 qui NOMME la boîte',
    refusesAccount(closedFolders, closedId), `reçu ${closedFolders.status} — ${closedFolders.text.slice(0, 160)}`)

  // ---- B. aucune route ne contourne la barrière ----
  for (const route of ACCOUNT_ROUTES) {
    const body = typeof route.body === 'function' ? route.body(closedId) : route.body
    const res = await call(route.path(closedId), { method: route.method, key: scopedKey.raw, body })
    check(`B ${route.label} refuse une boîte non cochée en la nommant`,
      refusesAccount(res, closedId), `reçu ${res.status} — ${res.text.slice(0, 160)}`)
  }

  // ---- C. la boîte qu'une clé connecte lui appartient ----
  const ownerKey = await makeKey('owner', [])
  const mine = await call('/api/accounts', { method: 'POST', key: ownerKey.raw, body: mailbox() })
  if (mine.body?.data?.id) created.accounts.push(mine.body.data.id)
  check('C1 une clé sans aucune boîte cochée peut en CONNECTER une (201)',
    mine.status === 201, `reçu ${mine.status} — ${mine.text.slice(0, 160)}`)

  if (mine.body?.data?.id) {
    const mineId = mine.body.data.id
    const readMine = await call(`/api/folders?account=${mineId}`, { key: ownerKey.raw })
    check('C2 elle atteint SA boîte sans qu\'on ait rien coché',
      readMine.status !== 403, `reçu ${readMine.status} — ${readMine.text.slice(0, 160)}`)

    const renameMine = await call(`/api/accounts/${mineId}`, { method: 'PATCH', key: ownerKey.raw, body: { name: 'renamed-by-owner-key' } })
    check('C3 elle MODIFIE sa boîte (200)',
      renameMine.status === 200, `reçu ${renameMine.status} — ${renameMine.text.slice(0, 160)}`)

    const otherKeyOnMine = await call(`/api/folders?account=${mineId}`, { key: scopedKey.raw })
    check('C4 une AUTRE clé reste fermée sur cette boîte',
      refusesAccount(otherKeyOnMine, mineId), `reçu ${otherKeyOnMine.status} — ${otherKeyOnMine.text.slice(0, 160)}`)

    const dropMine = await call(`/api/accounts/${mineId}`, { method: 'DELETE', key: ownerKey.raw })
    check('C5 elle SUPPRIME sa boîte (200)',
      dropMine.status === 200, `reçu ${dropMine.status} — ${dropMine.text.slice(0, 160)}`)
  }

  // ---- D. la session humaine n'est jamais limitée ----
  const bySession = await call(`/api/folders?account=${closedId}`, { cookie })
  check('D1 la session humaine atteint une boîte qu\'aucune clé n\'a cochée',
    bySession.status !== 403, `reçu ${bySession.status} — ${bySession.text.slice(0, 160)}`)

  const listedBySession = await call('/api/accounts', { cookie })
  check('D2 elle voit TOUTES ses boîtes, sans filtre',
    (listedBySession.body?.data ?? []).some(a => a.id === closedId),
    `reçu ${listedBySession.status} — ${(listedBySession.body?.data ?? []).length} boîte(s)`)

  // ---- E. la migration n'a cassé aucune clé d'avant ----
  // Sur TOUTES les clés réelles de la base, pas seulement celles du compte d'essai :
  // les clés de production (`yumi-ai`, `scripts-import`) appartiennent à un autre
  // utilisateur que celui qui sert à se connecter ici, et ce sont précisément
  // celles-là qu'il ne faut pas casser. Chacune est comparée aux boîtes de SON
  // propriétaire, jamais à un total global.
  const legacy = await pool.query(
    `SELECT ak.name,
            (SELECT COUNT(*) FROM api_key_accounts g WHERE g.api_key_id = ak.id)::int AS granted,
            (SELECT COUNT(*) FROM email_accounts a WHERE a.user_id = ak.user_id)::int AS owned
       FROM api_keys ak
      WHERE ak.revoked_at IS NULL AND ak.name NOT LIKE 'bench %'`
  )
  check('E1 chaque clé d\'avant la migration garde TOUTES les boîtes qu\'elle atteignait',
    legacy.rows.length > 0 && legacy.rows.every(r => r.granted === r.owned),
    `${legacy.rows.length} clé(s) : ${JSON.stringify(legacy.rows).slice(0, 200)}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec.
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['bench-%@bench.invalid']).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : toutes boîtes accordées, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nboîtes autorisées par clé : OK')
