#!/usr/bin/env node
/**
 * Banc du lot W4 : les routes de webhooks tiennent leurs refus, et le secret ne sort qu'aux
 * deux moments où il DOIT sortir.
 *
 * Mesure sur une instance qui tourne, avec de vraies requêtes HTTP et de vraies lignes en
 * base — pas une lecture de source. Six bras :
 *
 *   A. une clé `webhooks:write` CRÉE un webhook, et le secret n'est rendu QU'ICI : ni la
 *      liste, ni la lecture, ni la modification ne le rendent ensuite ;
 *   B. la régénération rend un secret NEUF, une fois, et différent du premier ;
 *   C. une clé SANS la portée est refusée par un 403 QUI LA NOMME — sur la lecture comme sur
 *      l'écriture, et jusque dans les sous-chemins (`/secret`, `/test`, `/deliveries`), sans
 *      quoi la portée se contournerait par un suffixe ;
 *   D. une clé à qui la boîte n'est PAS cochée est refusée par un 403 qui NOMME la boîte —
 *      y compris sur `/api/webhooks/deliveries/<id>/retry`, dont la boîte se lit à travers
 *      la LIGNE de journal et non l'URL ;
 *   E. une URL privée est refusée par un 422 à la création ET à la modification, et rien
 *      n'est écrit : une ligne enregistrée ne porte jamais une adresse que le serveur
 *      refuserait ensuite d'appeler ;
 *   F. une RÈGLE ne vise qu'un webhook de SA boîte : viser celui d'une autre boîte est un
 *      422 qui nomme l'action fautive, à la création comme à la modification.
 *
 * DANGER, respecté ici : les boîtes d'essai visent un hôte VOLONTAIREMENT injoignable
 * (`.invalid`, jamais résolu — RFC 2606) et sont supprimées dans le `finally`. AUCUN appel
 * sortant réel : les URL acceptées par ce banc pointent sur `127.0.0.1` (autorisé par
 * `WEBHOOK_ALLOWED_HOSTS` le temps du banc) et personne n'écoute — aucun envoi n'est
 * déclenché ici, `POST /{id}/test` n'est pas appelé, le planificateur ne tourne pas.
 *
 *   node --experimental-strip-types scripts/check-webhooks-api.mjs
 *   node --experimental-strip-types scripts/check-webhooks-api.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les clés du banc reçoivent TOUTES les portées et TOUTES
 * les boîtes — l'état du produit si les portées et la liste par boîte ne restreignaient rien.
 * Le banc DOIT alors virer au rouge sur C et D. Ce qu'il démontre : ces assertions sont
 * sensibles à l'état des autorisations. Ce qu'il ne démontre PAS : le comportement d'un
 * binaire dont on aurait retiré `keyReachesAccount` ou la table `ROUTE_SCOPES`.
 */
import './alias-resolver.mjs'
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

// Après `alias-resolver`, jamais avant : un import STATIQUE se résout avant que le crochet
// de résolution ne soit posé.
const { ALL_SCOPES } = await import('../lib/apiScopes.ts')
const { SECRET_PREFIX } = await import('../lib/webhooks.ts')

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
 * Une URL que le serveur ACCEPTE d'enregistrer : `WEBHOOK_ALLOWED_HOSTS=127.0.0.1` est posé
 * dans l'environnement du serveur de dev. Le port est fermé et ce banc ne déclenche aucun
 * envoi, donc rien ne sort de la machine.
 */
const OK_URL = 'http://127.0.0.1:9/bench-w4'
/** Une adresse privée que l'anti-SSRF DOIT refuser (décision 6). */
const PRIVATE_URL = 'https://10.0.0.7/hook'

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [], rules: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  const health = await call('/login')
  if (health.status !== 200) harness(`le serveur de dev ne répond pas sur ${BASE}/login (${health.status})`)

  const allowed = await call('/api/webhooks', { method: 'POST' })
  if (allowed.status !== 401) harness(`/api/webhooks sans clé devrait répondre 401, reçu ${allowed.status}`)

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
      [userId, `hook-bench-${tag}`, `hookbench-${tag}@bench.invalid`, 'imap.bench.invalid', 993, true,
        'smtp.bench.invalid', 587, false, `hookbench-${tag}@bench.invalid`, 'bench-not-a-real-secret']
    )
    created.accounts.push(row.rows[0].id)
    return row.rows[0].id
  }
  const accountId = await insertMailbox()
  const closedId = await insertMailbox()

  const writerKey = await makeKey('webhooks writer', ['webhooks:read', 'webhooks:write', 'rules:read', 'rules:write'], [accountId])
  const readerKey = await makeKey('webhooks reader', ['webhooks:read'], [accountId])
  const blindKey = await makeKey('no webhooks scope', ['messages:read'], [accountId])
  // La MÊME clé complète, mais sur l'autre boîte : le refus mesuré en D est celui de la
  // boîte, pas celui de la portée.
  const otherBoxKey = await makeKey('webhooks elsewhere', ['webhooks:read', 'webhooks:write'], [closedId])

  // ---- A. créer, et le secret une seule fois ---------------------------------------
  const createdHook = await call('/api/webhooks', {
    method: 'POST', key: writerKey,
    body: { accountId, name: 'banc-w4', url: OK_URL },
  })
  check('A1 une clé `webhooks:write` crée un webhook (201) et reçoit le secret EN CLAIR',
    createdHook.status === 201 && typeof createdHook.body?.data?.secret === 'string'
      && createdHook.body.data.secret.startsWith(SECRET_PREFIX),
    `reçu ${createdHook.status} — ${createdHook.text.slice(0, 200)}`)

  const hookId = createdHook.body?.data?.id
  if (!hookId) harness(`la création n'a rendu aucun identifiant — ${createdHook.text.slice(0, 200)}`)
  const firstSecret = createdHook.body.data.secret

  const listed = await call(`/api/webhooks?account=${accountId}`, { key: readerKey })
  const listedHook = (listed.body?.data ?? []).find(h => h.id === hookId)
  check('A2 la LISTE montre le webhook et ne porte AUCUN secret',
    listed.status === 200 && !!listedHook && !('secret' in (listedHook ?? {}))
      && !listed.text.includes(firstSecret) && !listed.text.includes(SECRET_PREFIX),
    `reçu ${listed.status} — ${listed.text.slice(0, 200)}`)

  const read = await call(`/api/webhooks/${hookId}`, { key: readerKey })
  check('A3 la LECTURE ne rend pas le secret non plus',
    read.status === 200 && read.body?.data?.id === hookId && !read.text.includes(firstSecret)
      && !read.text.includes(SECRET_PREFIX),
    `reçu ${read.status} — ${read.text.slice(0, 200)}`)

  const patched = await call(`/api/webhooks/${hookId}`, {
    method: 'PATCH', key: writerKey, body: { name: 'banc-w4 renommé' },
  })
  check('A4 la MODIFICATION applique le changement sans rendre le secret',
    patched.status === 200 && patched.body?.data?.name === 'banc-w4 renommé'
      && !patched.text.includes(firstSecret) && !patched.text.includes(SECRET_PREFIX),
    `reçu ${patched.status} — ${patched.text.slice(0, 200)}`)

  // ---- B. régénérer ----------------------------------------------------------------
  const rotated = await call(`/api/webhooks/${hookId}/secret`, { method: 'POST', key: writerKey })
  check('B1 la régénération rend un secret NEUF, une fois, différent du premier',
    rotated.status === 200 && typeof rotated.body?.data?.secret === 'string'
      && rotated.body.data.secret.startsWith(SECRET_PREFIX)
      && rotated.body.data.secret !== firstSecret,
    `reçu ${rotated.status} — ${rotated.text.slice(0, 200)}`)

  const afterRotate = await call(`/api/webhooks/${hookId}`, { key: readerKey })
  check('B2 et la lecture SUIVANTE ne le rend toujours pas',
    afterRotate.status === 200 && !afterRotate.text.includes(rotated.body?.data?.secret ?? SECRET_PREFIX),
    `reçu ${afterRotate.status} — ${afterRotate.text.slice(0, 200)}`)

  // ---- C. la portée ----------------------------------------------------------------
  const noRead = await call(`/api/webhooks?account=${accountId}`, { key: blindKey })
  check('C1 une clé sans `webhooks:read` est refusée par un 403 qui NOMME la portée',
    noRead.status === 403 && noRead.body?.missingScope === 'webhooks:read'
      && String(noRead.body?.error ?? '').includes('webhooks:read'),
    `reçu ${noRead.status} — ${noRead.text.slice(0, 200)}`)

  const noWrite = await call('/api/webhooks', {
    method: 'POST', key: readerKey, body: { accountId, name: 'refusé', url: OK_URL },
  })
  check('C2 une clé sans `webhooks:write` ne peut pas créer, et le 403 nomme la portée',
    noWrite.status === 403 && noWrite.body?.missingScope === 'webhooks:write',
    `reçu ${noWrite.status} — ${noWrite.text.slice(0, 200)}`)

  // Les sous-chemins : sans cela la portée se contournerait par un suffixe.
  const subPaths = [
    ['POST', `/api/webhooks/${hookId}/secret`, 'webhooks:write', readerKey],
    ['POST', `/api/webhooks/${hookId}/test`, 'webhooks:write', readerKey],
    ['GET', `/api/webhooks/${hookId}/deliveries`, 'webhooks:read', blindKey],
  ]
  for (const [method, path, scope, key] of subPaths) {
    const res = await call(path, { method, key })
    check(`C3 ${method} ${path.replace(hookId, '<id>')} exige « ${scope} » et le NOMME`,
      res.status === 403 && res.body?.missingScope === scope,
      `reçu ${res.status} — ${res.text.slice(0, 200)}`)
  }

  // ---- D. la boîte -----------------------------------------------------------------
  const otherBoxRead = await call(`/api/webhooks/${hookId}`, { key: otherBoxKey })
  check('D1 une clé sans la boîte du webhook est refusée par un 403 qui NOMME la boîte',
    otherBoxRead.status === 403 && otherBoxRead.body?.missingAccount === accountId
      && String(otherBoxRead.body?.error ?? '').includes(accountId),
    `reçu ${otherBoxRead.status} — ${otherBoxRead.text.slice(0, 200)}`)

  const otherBoxSecret = await call(`/api/webhooks/${hookId}/secret`, { method: 'POST', key: otherBoxKey })
  check('D2 le sous-chemin `/secret` passe par la MÊME barrière de boîte',
    otherBoxSecret.status === 403 && otherBoxSecret.body?.missingAccount === accountId,
    `reçu ${otherBoxSecret.status} — ${otherBoxSecret.text.slice(0, 200)}`)

  // La boîte d'un « renvoyer » se lit à travers la LIGNE de journal, pas l'URL : on en écrit
  // une pour que la barrière ait quelque chose à résoudre.
  const delivery = await pool.query(
    `INSERT INTO webhook_deliveries (webhook_id, rule_id, account_id, message_id, payload, status)
     VALUES ($1, NULL, $2, $3, $4::jsonb, 'failed') RETURNING id`,
    [hookId, accountId, '<banc-w4@bench.invalid>', JSON.stringify({ event: 'webhook.test' })]
  )
  const deliveryId = delivery.rows[0].id
  const otherBoxRetry = await call(`/api/webhooks/deliveries/${deliveryId}/retry`, { method: 'POST', key: otherBoxKey })
  check('D3 « renvoyer » résout sa boîte par la LIGNE de journal, et la barrière tient',
    otherBoxRetry.status === 403 && otherBoxRetry.body?.missingAccount === accountId,
    `reçu ${otherBoxRetry.status} — ${otherBoxRetry.text.slice(0, 200)}`)

  // ---- E. l'anti-SSRF --------------------------------------------------------------
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM webhooks WHERE account_id = $1', [accountId])
  const privateCreate = await call('/api/webhooks', {
    method: 'POST', key: writerKey, body: { accountId, name: 'privé', url: PRIVATE_URL },
  })
  check('E1 une URL privée est refusée à la CRÉATION par un 422 qui dit pourquoi',
    privateCreate.status === 422 && typeof privateCreate.body?.error === 'string' && privateCreate.body.error.length > 0,
    `reçu ${privateCreate.status} — ${privateCreate.text.slice(0, 200)}`)

  const after = await pool.query('SELECT COUNT(*)::int AS n FROM webhooks WHERE account_id = $1', [accountId])
  check('E2 et RIEN n\'a été écrit : le compte de webhooks n\'a pas bougé',
    after.rows[0].n === before.rows[0].n,
    `avant ${before.rows[0].n}, après ${after.rows[0].n}`)

  const privatePatch = await call(`/api/webhooks/${hookId}`, {
    method: 'PATCH', key: writerKey, body: { url: PRIVATE_URL },
  })
  const stillOk = await pool.query('SELECT url FROM webhooks WHERE id = $1', [hookId])
  check('E3 une URL privée est refusée à la MODIFICATION aussi, et l\'ancienne reste',
    privatePatch.status === 422 && stillOk.rows[0].url === OK_URL,
    `reçu ${privatePatch.status}, url en base ${stillOk.rows[0].url}`)

  // ---- F. une règle ne vise qu'un webhook de SA boîte ------------------------------
  const elsewhere = await pool.query(
    `INSERT INTO webhooks (user_id, account_id, name, url, secret_encrypted, enabled)
     VALUES ($1, $2, 'banc-w4 ailleurs', $3, 'bench-not-a-real-secret', true) RETURNING id`,
    [userId, closedId, OK_URL]
  )
  const elsewhereId = elsewhere.rows[0].id

  const crossRule = await call('/api/rules', {
    method: 'POST', key: writerKey,
    body: {
      accountId, name: 'banc-w4 règle croisée', conditions: [{ field: 'subject', operator: 'contains', value: 'x' }],
      actions: [{ type: 'webhook', value: elsewhereId }],
    },
  })
  check('F1 une règle visant le webhook d\'une AUTRE boîte est refusée par un 422 qui nomme l\'action',
    crossRule.status === 422 && String(crossRule.body?.error ?? '').includes('webhook')
      && String(crossRule.body?.error ?? '').includes(elsewhereId),
    `reçu ${crossRule.status} — ${crossRule.text.slice(0, 200)}`)

  const goodRule = await call('/api/rules', {
    method: 'POST', key: writerKey,
    body: {
      accountId, name: 'banc-w4 règle', conditions: [{ field: 'subject', operator: 'matches', value: 'facture|invoice' }],
      actions: [{ type: 'webhook', value: hookId }],
    },
  })
  if (goodRule.body?.data?.id) created.rules.push(goodRule.body.data.id)
  check('F2 une règle regex visant le webhook de SA boîte est acceptée',
    (goodRule.status === 200 || goodRule.status === 201) && !!goodRule.body?.data?.id,
    `reçu ${goodRule.status} — ${goodRule.text.slice(0, 200)}`)

  const ruleId = goodRule.body?.data?.id
  if (ruleId) {
    const crossPatch = await call(`/api/rules/${ruleId}`, {
      method: 'PATCH', key: writerKey, body: { actions: [{ type: 'webhook', value: elsewhereId }] },
    })
    const stillMine = await pool.query('SELECT actions FROM email_rules WHERE id = $1', [ruleId])
    check('F3 la MODIFICATION ne laisse pas entrer par la porte de côté ce que la création refuse',
      crossPatch.status === 422 && JSON.stringify(stillMine.rows[0].actions).includes(hookId),
      `reçu ${crossPatch.status} — ${crossPatch.text.slice(0, 200)}`)
  }

  const deliveries = await call(`/api/webhooks/${hookId}/deliveries`, { key: readerKey })
  check('F4 le journal du webhook se lit avec `webhooks:read` et porte la ligne du banc',
    deliveries.status === 200 && (deliveries.body?.data ?? []).some(d => d.id === deliveryId),
    `reçu ${deliveries.status} — ${deliveries.text.slice(0, 200)}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec. Les webhooks, leurs
  // lignes de journal et les règles partent avec la boîte (ON DELETE CASCADE).
  for (const id of created.rules) await pool.query('DELETE FROM email_rules WHERE id = $1', [id]).catch(() => {})
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['hookbench-%@bench.invalid']).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : tout accordé, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nroutes de webhooks : OK')
