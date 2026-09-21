#!/usr/bin/env node
/**
 * Banc du lot P12 : les routes manquantes sont ouvertes aux agents, chacune DERRIÈRE
 * sa portée, et pas une de plus.
 *
 * Avant ce lot, une clé ne pouvait ni lire une signature, ni poser un modèle, ni
 * toucher une règle de tri : tout cela répondait 401, quelles que soient ses portées.
 * Ce banc mesure, sur une instance qui tourne, que chacune des routes nouvellement
 * ouvertes distingue trois cas — et que l'ouverture n'a pas débordé.
 *
 *   A. une clé PORTANT la portée obtient la ressource (2xx) ;
 *   B. une clé SANS la portée reçoit 403 qui NOMME la portée manquante — pas un 401
 *      muet : un agent doit pouvoir dire à son propriétaire ce qu'il faut lui cocher ;
 *   C. une session HUMAINE fait tout, sans portée — les portées ne visent que les clés ;
 *   D. les routes EXCLUES par décision (administration, gestion des clés API) restent
 *      fermées à une clé qui porte pourtant TOUTES les portées : une clé ne doit
 *      pouvoir ni se donner des droits, ni en fabriquer d'autres ;
 *   E. une règle visant une boîte FERMÉE à la clé est refusée alors même que la
 *      requête ne nomme aucune boîte — la barrière suit l'objet, sinon l'identifiant
 *      de la règle serait un chemin de contournement ;
 *   F. les portées ouvertes ici ne sont accordées à AUCUNE clé existante (lecture de
 *      la base, pas de la source) : ouvrir une route ne distribue pas son droit.
 *
 * DANGER, respecté ici : la boîte d'essai vise un hôte VOLONTAIREMENT injoignable
 * (`.invalid`, jamais résolu — RFC 2606) et elle est INSÉRÉE en base, donc aucune
 * connexion ne part vers un vrai serveur. Une rafale d'échecs ferait blacklister l'IP.
 *
 *   node --experimental-strip-types scripts/check-api-open-routes.mjs
 *   node --experimental-strip-types scripts/check-api-open-routes.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : la clé étroite du bras B reçoit TOUTES les portées.
 * Le banc DOIT alors virer au rouge sur B — si le refus reste mesuré identique, c'est
 * que B ne mesurait pas la portée. Ce qu'il ne démontre PAS : le comportement d'un
 * binaire dont on aurait retiré la vérification elle-même ; il mesure la réponse
 * rendue, pas la suppression du code qui la rend.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { ALL_SCOPES, OPT_IN_SCOPES, ROUTE_SCOPES } from '../lib/apiScopes.ts'

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
  let json = null
  try { json = JSON.parse(text) } catch { /* une réponse non-JSON reste lisible via `text` */ }
  return { status: res.status, text, json }
}

/**
 * Les routes que CE lot ouvre, chacune avec la portée que le code exige — lue dans
 * `ROUTE_SCOPES`, jamais recopiée ici : une portée changée dans la source unique
 * change ce que le banc exige, et un couple ajouté sans portée tombe en HARNESS.
 */
const OPENED = [
  { key: 'GET /api/signatures', path: '/api/signatures' },
  { key: 'GET /api/templates', path: '/api/templates' },
  { key: 'GET /api/rules', path: '/api/rules' },
  { key: 'GET /api/settings', path: '/api/settings' },
]
for (const route of OPENED) {
  route.scope = ROUTE_SCOPES[route.key]
  if (!route.scope) harness(`${route.key} n'a pas de portée dans lib/apiScopes.ts`)
}

/**
 * Ce que le lot n'ouvre PAS, et qui doit rester fermé à une clé toute-portées :
 * l'administration et la gestion des clés. Décision assumée, mesurée ici plutôt que
 * simplement écrite — une clé qui fabriquerait des clés annulerait tout le modèle.
 */
/**
 * Les routes d'ÉCRITURE que ce lot ouvre, avec de quoi créer une ressource jetable.
 * Aucune ne nomme de boîte : la portée est alors la seule barrière mesurée, ce qui
 * est exactement l'objet du bras G.
 */
const WRITTEN = [
  { path: '/api/signatures', body: { name: 'bench-signature', contentHtml: '<p>bench</p>' } },
  { path: '/api/templates', body: { name: 'bench-modele', subject: 'bench', bodyHtml: '<p>bench</p>' } },
]

const EXCLUDED = [
  { path: '/api/admin/users', method: 'GET' },
  { path: '/api/api-keys', method: 'GET' },
  { path: '/api/api-keys', method: 'POST', body: { name: 'bench-ne-doit-pas-exister' } },
]

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [], rules: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  /** Pose une clé avec EXACTEMENT ces portées et ces boîtes cochées. */
  const makeKey = async (name, scopes, accountIds = []) => {
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

  /** Une boîte qui ne peut JOINDRE personne : `.invalid` n'est jamais résolu. */
  const insertMailbox = async () => {
    const tag = crypto.randomBytes(4).toString('hex')
    const row = await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [userId, `open-bench-${tag}`, `bench-${tag}@bench.invalid`,
       'imap.bench.invalid', 993, true, 'smtp.bench.invalid', 587, false,
       `bench-${tag}@bench.invalid`, 'bench-not-a-real-secret']
    )
    created.accounts.push(row.rows[0].id)
    return row.rows[0].id
  }

  const allowedId = await insertMailbox()
  const closedId = await insertMailbox()

  const fullKey = await makeKey('toutes-portees', ALL_SCOPES, [allowedId, closedId])
  // Le contrôle négatif élargit CETTE clé : si le bras B reste identique, il ne
  // mesurait pas la portée mais autre chose.
  const narrowKey = await makeKey('sans-les-nouvelles', NEGATIVE ? ALL_SCOPES : ['accounts:read'], [allowedId])

  // ---- A + B. chaque route ouverte distingue la clé qui porte de celle qui ne porte pas ----
  for (const { path, scope } of OPENED) {
    const granted = await call(path, { key: fullKey.raw })
    check(`A ${path} répond à une clé portant ${scope}`,
      granted.status >= 200 && granted.status < 300,
      `HTTP ${granted.status} — ${granted.text.slice(0, 160)}`)

    const refused = await call(path, { key: narrowKey.raw })
    check(`B ${path} refuse 403 une clé sans ${scope}`,
      refused.status === 403,
      `HTTP ${refused.status} — ${refused.text.slice(0, 160)}`)
    check(`B ${path} NOMME la portée qui manque`,
      refused.json?.missingScope === scope,
      `missingScope = ${JSON.stringify(refused.json?.missingScope ?? null)}, attendu ${scope}`)
  }

  // ---- G. l'ÉCRITURE aussi distingue la clé qui porte de celle qui ne porte pas ----
  // Les bras A/B ne mesurent que la lecture. Une portée d'écriture accordée à tort ne
  // se verrait nulle part ailleurs : la ressource est CRÉÉE, puis SUPPRIMÉE par le même
  // chemin — ce qui mesure du même coup la route `[id]`, jamais atteinte autrement.
  for (const { path, body } of WRITTEN) {
    const scope = ROUTE_SCOPES[`POST ${path}`]
    if (!scope) harness(`POST ${path} n'a pas de portée dans lib/apiScopes.ts`)

    const refused = await call(path, { method: 'POST', key: narrowKey.raw, body })
    check(`G POST ${path} refuse 403 une clé sans ${scope}`,
      refused.status === 403 && refused.json?.missingScope === scope,
      `HTTP ${refused.status} — ${refused.text.slice(0, 160)}`)

    const written = await call(path, { method: 'POST', key: fullKey.raw, body })
    check(`G POST ${path} crée pour une clé portant ${scope}`,
      written.status >= 200 && written.status < 300,
      `HTTP ${written.status} — ${written.text.slice(0, 160)}`)

    const id = written.json?.data?.id
    if (!id) { check(`G POST ${path} rend l'identifiant du créé`, false, written.text.slice(0, 160)); continue }

    const removeScope = ROUTE_SCOPES[`DELETE ${path}/[id]`]
    if (!removeScope) harness(`DELETE ${path}/[id] n'a pas de portée dans lib/apiScopes.ts`)
    const removeRefused = await call(`${path}/${id}`, { method: 'DELETE', key: narrowKey.raw })
    check(`G DELETE ${path}/[id] refuse 403 une clé sans ${removeScope}`,
      removeRefused.status === 403 && removeRefused.json?.missingScope === removeScope,
      `HTTP ${removeRefused.status} — ${removeRefused.text.slice(0, 160)}`)

    const removed = await call(`${path}/${id}`, { method: 'DELETE', key: fullKey.raw })
    check(`G DELETE ${path}/[id] supprime pour une clé portant ${removeScope}`,
      removed.status >= 200 && removed.status < 300,
      `HTTP ${removed.status} — ${removed.text.slice(0, 160)}`)
  }

  // ---- D. l'administration et les clés restent fermées à une clé toute-portées ----
  for (const { path, method, body } of EXCLUDED) {
    const res = await call(path, { method, key: fullKey.raw, body })
    check(`D ${method} ${path} reste fermée à une clé portant TOUTES les portées`,
      res.status === 401 || res.status === 403,
      `HTTP ${res.status} — ${res.text.slice(0, 160)}`)
  }

  // ---- E. la barrière suit l'objet : une règle porte la boîte qu'elle vise ----
  const ruleRow = await pool.query(
    `INSERT INTO email_rules (account_id, user_id, name, enabled, condition_logic, conditions, actions, priority)
     VALUES ($1, $2, $3, true, 'all', $4::jsonb, $5::jsonb, 0) RETURNING id`,
    [closedId, userId, 'bench-regle-boite-fermee',
     JSON.stringify([{ field: 'from', operator: 'contains', value: 'bench' }]),
     JSON.stringify([{ type: 'star' }])]
  )
  created.rules.push(ruleRow.rows[0].id)
  const ruleId = ruleRow.rows[0].id

  // `narrowKey` ne coche QUE `allowedId` : la règle vise `closedId`. La requête ne
  // nomme aucune boîte — seul l'objet la porte.
  const objectKey = await makeKey('regles-boite-ouverte', ['rules:read', 'rules:write'], [allowedId])
  const throughObject = await call(`/api/rules/${ruleId}`, { key: objectKey.raw })
  check('E une règle visant une boîte fermée est refusée 403',
    throughObject.status === 403,
    `HTTP ${throughObject.status} — ${throughObject.text.slice(0, 160)}`)
  check('E le refus NOMME la boîte fermée',
    throughObject.json?.missingAccount === closedId,
    `missingAccount = ${JSON.stringify(throughObject.json?.missingAccount ?? null)}, attendu ${closedId}`)

  const throughObjectAllowed = await call(`/api/rules/${ruleId}`, { key: fullKey.raw })
  check('E la même règle est lisible par une clé qui a cette boîte',
    throughObjectAllowed.status === 200,
    `HTTP ${throughObjectAllowed.status} — ${throughObjectAllowed.text.slice(0, 160)}`)

  // ---- F. ouvrir une route ne distribue pas son droit ----
  // Mesuré en BASE, pas dans la source : c'est l'état réel des clés qui compte.
  const spread = await pool.query(
    `SELECT COUNT(*)::int AS n FROM api_keys
      WHERE revoked_at IS NULL AND id <> ALL($2::uuid[]) AND scopes && $1::text[]`,
    [OPT_IN_SCOPES, created.keys]
  )
  check('F aucune clé préexistante n\'a reçu une portée optionnelle',
    spread.rows[0].n === 0,
    `${spread.rows[0].n} clé(s) portent déjà une portée de OPT_IN_SCOPES`)

  // ---- C. une session humaine fait tout, sans portée ----
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

  for (const { path } of OPENED) {
    const res = await call(path, { cookie })
    check(`C ${path} répond à une session humaine, sans aucune portée`,
      res.status >= 200 && res.status < 300,
      `HTTP ${res.status} — ${res.text.slice(0, 160)}`)
  }
  const humanRule = await call(`/api/rules/${ruleId}`, { cookie })
  check('C la session humaine lit la règle de la boîte qu\'aucune clé n\'atteint',
    humanRule.status === 200,
    `HTTP ${humanRule.status} — ${humanRule.text.slice(0, 160)}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec.
  for (const id of created.rules) await pool.query('DELETE FROM email_rules WHERE id = $1', [id]).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['bench-%@bench.invalid']).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : la clé étroite a toutes les portées, et le banc reste vert — B ne mesure pas la portée')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nroutes ouvertes aux agents : OK')
