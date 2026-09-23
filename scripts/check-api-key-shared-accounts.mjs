#!/usr/bin/env node
/**
 * Banc du lot P16 : UNE CLÉ DOIT POUVOIR SERVIR SUR UNE BOÎTE PARTAGÉE.
 *
 * Le défaut mesuré ici : `grantAccounts` ne retenait que les boîtes POSSÉDÉES, donc
 * quelqu'un qui n'a QUE des partages ne pouvait accorder AUCUNE boîte à sa clé — elle
 * naissait inutilisable. Le banc travaille donc avec un utilisateur qui ne possède
 * RIEN : c'est la seule configuration où le défaut se voit.
 *
 * Mesuré sur une instance qui tourne, à travers la vraie barrière (`lib/apiAuth.ts`) :
 *
 *   A. la boîte PARTAGÉE est cochable : `PATCH /api/api-keys/<id>` la retient, alors
 *      que le porteur ne possède aucune boîte ;
 *   B. la clé LIT cette boîte (aucun 403 de boîte) ;
 *   C. elle est REFUSÉE sur une action que le partage n'autorise pas, par un 403 qui
 *      NOMME la raison (partage insuffisant) et la permission manquante — et cela
 *      MÊME avec la portée correspondante cochée : c'est le bras qui distingue « la
 *      clé ne peut pas » de « la clé n'a pas la portée » ;
 *   D. ce refus est INSCRIT au journal de la clé avec son motif `share` ;
 *   E. le partage RÉVOQUÉ ferme la clé sans qu'on ait touché à la clé : l'accès est
 *      relu à l'appel, jamais figé au moment où on a coché ;
 *   F. une boîte qu'on ne possède ni ne partage reste incochable — élargir aux boîtes
 *      ACCESSIBLES ne doit pas avoir ouvert la porte à n'importe quel identifiant.
 *
 *   node --experimental-strip-types scripts/check-api-key-shared-accounts.mjs
 *   node --experimental-strip-types scripts/check-api-key-shared-accounts.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le partage du banc est créé avec TOUTES les
 * permissions, c'est-à-dire l'état du produit si une clé ne se bornait pas au partage.
 * Le banc DOIT alors virer au rouge sur C1, C2 et D — les trois assertions qui portent
 * sur un refus de partage. C3 et E restent verts, et c'est COHÉRENT : C3 affirme une
 * ABSENCE de refus (elle ne peut pas tomber en élargissant), et E révoque le partage,
 * ce qui ferme la boîte quelles qu'aient été ses permissions. Ce qu'il démontre : les assertions de
 * refus portent bien sur la borne du partage et non sur la réponse de la route. Ce
 * qu'il ne démontre PAS : le comportement d'un binaire dont on aurait retiré le test.
 *
 * SÛRETÉ : la boîte partagée vise un hôte VOLONTAIREMENT injoignable (`.invalid`,
 * jamais résolu — RFC 2606). Aucune vraie boîte n'est touchée, aucune connexion ne
 * part. Utilisateur d'essai, partage et clé sont SUPPRIMÉS dans le `finally`.
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

/** Un 403 de PARTAGE est lisible s'il nomme la boîte ET le geste refusé. */
const refusesShare = (res, accountId, permission) =>
  res.status === 403 &&
  res.body?.missingAccountReason === 'share_permission' &&
  res.body?.missingAccount === accountId &&
  res.body?.missingSharePermission === permission

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [], users: [], shares: [] }

try {
  const owners = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!owners.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const ownerId = owners.rows[0].id

  const tag = crypto.randomBytes(4).toString('hex')

  // L'utilisateur du banc : il ne POSSÈDE rien, c'est tout l'intérêt.
  const delegateEmail = `bench-share-${tag}@bench.invalid`
  const delegate = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, status)
     VALUES ($1, $2, $3, 'user', 'active') RETURNING id`,
    [delegateEmail, `bench delegate ${tag}`, 'bench-not-a-real-hash']
  )
  const delegateId = delegate.rows[0].id
  created.users.push(delegateId)

  const ownedByDelegate = await pool.query('SELECT COUNT(*)::int AS n FROM email_accounts WHERE user_id = $1', [delegateId])
  check('0 l\'utilisateur du banc ne possède AUCUNE boîte (la configuration du défaut)',
    ownedByDelegate.rows[0].n === 0, `${ownedByDelegate.rows[0].n} boîte(s) possédée(s)`)

  // La boîte partagée, injoignable par construction, et une boîte témoin JAMAIS partagée.
  const insertMailbox = async label => {
    const row = await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure,
         smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ownerId, `share-bench-${label}-${tag}`, `bench-${label}-${tag}@bench.invalid`,
       'imap.bench.invalid', 993, true, 'smtp.bench.invalid', 587, false,
       `bench-${label}-${tag}@bench.invalid`, 'bench-not-a-real-secret']
    )
    created.accounts.push(row.rows[0].id)
    return row.rows[0].id
  }
  const sharedId = await insertMailbox('shared')
  const strangerId = await insertMailbox('stranger')

  // Le partage : lecture et rangement OUI, envoi NON. C'est précisément le cas de
  // Nicolas — « si le partage n'autorise pas l'envoi, la clé ne doit pas envoyer ».
  // En contrôle négatif il autorise TOUT : le produit sans la borne du partage.
  const share = await pool.query(
    `INSERT INTO account_shares (account_id, invited_by, invitee_user_id, status,
        can_send, can_delete, can_organize, can_manage_rules, can_manage_signatures, accepted_at)
     VALUES ($1, $2, $3, 'active', $4, $4, true, $4, $4, NOW()) RETURNING id`,
    [sharedId, ownerId, delegateId, NEGATIVE]
  )
  const shareId = share.rows[0].id
  created.shares.push(shareId)

  // Session HUMAINE du délégué : c'est par elle qu'il coche ses boîtes. Le mot de
  // passe d'essai est posé ici, jamais lu d'ailleurs.
  const bcrypt = (await import('bcryptjs')).default
  const delegatePassword = `bench-${crypto.randomBytes(8).toString('hex')}`
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(delegatePassword, 10), delegateId])

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const { csrfToken } = await csrfRes.json()
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email: delegateEmail, password: delegatePassword, json: 'true' }),
  })
  const cookie = [csrfCookie, ...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0])].join('; ')
  if (!/session-token/.test(cookie)) harness(`connexion du délégué refusée (${loginRes.status})`)

  // ---- A. la boîte partagée est COCHABLE ----
  const createdKey = await call('/api/api-keys', {
    method: 'POST', cookie,
    body: { name: `bench share ${tag}`, scopes: ALL_SCOPES, accountIds: [sharedId] },
  })
  if (createdKey.body?.data?.id) created.keys.push(createdKey.body.data.id)
  const rawKey = createdKey.body?.data?.key
  check('A1 une clé créée par un porteur SANS boîte retient la boîte PARTAGÉE',
    createdKey.status === 201 && (createdKey.body?.data?.accountIds ?? []).includes(sharedId),
    `reçu ${createdKey.status} — ${createdKey.text.slice(0, 200)}`)
  if (!rawKey) harness('la clé du banc n\'a pas été créée : rien à mesurer plus loin')

  // ---- F. une boîte étrangère reste incochable ----
  const withStranger = await call(`/api/api-keys/${created.keys[0]}`, {
    method: 'PATCH', cookie, body: { accountIds: [sharedId, strangerId] },
  })
  check('F la boîte ni possédée ni partagée est REJETÉE de la liste cochée',
    !((withStranger.body?.data?.accountIds ?? []).includes(strangerId)),
    `reçu ${withStranger.status} — ${withStranger.text.slice(0, 200)}`)

  // ---- B. la clé LIT la boîte partagée ----
  const listed = await call('/api/accounts', { key: rawKey })
  check('B1 la liste des boîtes de la clé montre la boîte partagée',
    listed.status === 200 && (listed.body?.data ?? []).some(a => a.id === sharedId),
    `reçu ${listed.status} — ${listed.text.slice(0, 200)}`)

  const readShared = await call(`/api/folders?account=${sharedId}`, { key: rawKey })
  check('B2 la clé atteint la boîte partagée (aucun 403)',
    readShared.status !== 403, `reçu ${readShared.status} — ${readShared.text.slice(0, 200)}`)

  // ---- C. la clé ne DÉPASSE pas le partage ----
  const send = await call('/api/messages/send', {
    method: 'POST', key: rawKey,
    body: { accountId: sharedId, to: ['x@bench.invalid'], subject: 'bench' },
  })
  check('C1 ENVOYER est refusé — le partage ne l\'autorise pas — en NOMMANT la raison',
    refusesShare(send, sharedId, 'send'), `reçu ${send.status} — ${send.text.slice(0, 200)}`)

  const drop = await call(`/api/messages/1?account=${sharedId}&folder=INBOX`, { method: 'DELETE', key: rawKey })
  check('C2 SUPPRIMER est refusé de la même façon (le partage ne l\'autorise pas)',
    refusesShare(drop, sharedId, 'delete'), `reçu ${drop.status} — ${drop.text.slice(0, 200)}`)

  const organize = await call(`/api/messages/1?account=${sharedId}&folder=INBOX`, {
    method: 'PATCH', key: rawKey, body: { isRead: true },
  })
  check('C3 RANGER, lui, n\'est PAS refusé par le partage (il l\'autorise)',
    !refusesShare(organize, sharedId, 'organize'), `reçu ${organize.status} — ${organize.text.slice(0, 200)}`)

  // ---- D. le refus est au journal, avec son motif ----
  const logged = await pool.query(
    `SELECT denial_reason, denial_detail FROM api_key_requests
      WHERE api_key_id = $1 AND denial_reason = 'share' ORDER BY created_at DESC LIMIT 5`,
    [created.keys[0]]
  )
  check('D le refus de partage est INSCRIT au journal de la clé avec son motif',
    logged.rows.length > 0 && logged.rows.some(r => r.denial_detail === sharedId),
    `${logged.rows.length} ligne(s) : ${JSON.stringify(logged.rows).slice(0, 200)}`)

  // ---- E. le partage révoqué ferme la clé, SANS qu'on touche la clé ----
  await pool.query(`UPDATE account_shares SET status = 'revoked', revoked_at = NOW() WHERE id = $1`, [shareId])
  const afterRevoke = await call(`/api/folders?account=${sharedId}`, { key: rawKey })
  check('E1 après RÉVOCATION du partage, la même clé est refusée sur cette boîte',
    afterRevoke.status === 403, `reçu ${afterRevoke.status} — ${afterRevoke.text.slice(0, 200)}`)

  const stillGranted = await pool.query(
    'SELECT COUNT(*)::int AS n FROM api_key_accounts WHERE api_key_id = $1 AND account_id = $2',
    [created.keys[0], sharedId]
  )
  check('E2 et la clé n\'a PAS été touchée : la boîte lui reste cochée, c\'est l\'ACCÈS qui est relu',
    stillGranted.rows[0].n === 1, `${stillGranted.rows[0].n} ligne(s) cochée(s)`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec.
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  for (const id of created.shares) await pool.query('DELETE FROM account_shares WHERE id = $1', [id]).catch(() => {})
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : partage tout-permis, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nclé sur boîte partagée : OK')
