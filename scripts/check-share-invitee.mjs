#!/usr/bin/env node
/**
 * Review defect #4 (lot P4): inviting someone to a mailbox looks the invitee up by
 * address, case-insensitively. Two accounts that differ only by case (rows created
 * before addresses were normalised) make that lookup AMBIGUOUS — `lib/auth.ts`
 * already refuses to log such a user in rather than guess. The share route must
 * apply the same rule: refuse, and write NOTHING.
 *
 * Measured on a running instance, through the real route, as the owner's session:
 *   A. one matching user  → 201, the share is written for THAT user;
 *   B. two users differing only by case → 409, and NO share row exists for either.
 *
 *   node --experimental-strip-types scripts/check-share-invitee.mjs
 *   node --experimental-strip-types scripts/check-share-invitee.mjs --negative
 *
 * NEGATIVE CONTROL (`--negative`): the ambiguous case is judged the OLD way — by
 * whatever the route returns for a single match, i.e. as if the route still picked
 * `existingUsers[0]`. The bench MUST then go red on B. What it shows: the assertion
 * measures the REFUSAL, not merely that the route answered.
 *
 * SAFETY: the mailbox is the bench's own, with `.invalid` hosts — no real SMTP is
 * reached, so no email leaves; the notification send fails and is reported as
 * `emailSent: false`, which is not what is measured. Users, mailbox and shares are
 * deleted in `finally`. Needs a running dev server and SYNAPMAIL_TEST_* (see .env).
 */
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
const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
} = process.env
const NEGATIVE = process.argv.includes('--negative')
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
})) if (!v) harness(`${k} is not set`)

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const call = async (path, { method = 'GET', cookie, body } = {}) => {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* reported via `text` */ }
  return { status: res.status, body: parsed, text }
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { accounts: [], users: [] }

try {
  const owners = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [EMAIL])
  if (owners.rows.length !== 1) harness(`expected exactly one user ${EMAIL} in this database`)
  const ownerId = owners.rows[0].id
  const tag = crypto.randomBytes(4).toString('hex')

  // The owner's session — the only principal allowed to invite.
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const { csrfToken } = await csrfRes.json()
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  })
  const cookie = [csrfCookie, ...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0])].join('; ')
  if (!/session-token/.test(cookie)) harness(`owner login refused (${loginRes.status})`)

  // The bench's mailbox: `.invalid` hosts, so the notification mail can never leave.
  const mailbox = await pool.query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure,
       smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ownerId, `invitee-bench-${tag}`, `bench-owner-${tag}@bench.invalid`,
     'imap.bench.invalid', 993, true, 'smtp.bench.invalid', 587, false,
     `bench-owner-${tag}@bench.invalid`, 'bench-not-a-real-secret']
  )
  const accountId = mailbox.rows[0].id
  created.accounts.push(accountId)

  const insertUser = async email => {
    const row = await pool.query(
      `INSERT INTO users (email, name, password_hash, role, status)
       VALUES ($1, $2, 'bench-not-a-real-hash', 'user', 'active') RETURNING id`,
      [email, `bench invitee ${tag}`]
    )
    created.users.push(row.rows[0].id)
    return row.rows[0].id
  }
  const invite = email => call(`/api/accounts/${accountId}/shares`, { method: 'POST', cookie, body: { email } })
  const sharesFor = async userId => (await pool.query(
    'SELECT COUNT(*)::int AS n FROM account_shares WHERE account_id = $1 AND invitee_user_id = $2',
    [accountId, userId]
  )).rows[0].n

  // ---- A. one match: the share lands on that user ----
  const single = `bench-single-${tag}@bench.invalid`
  const singleId = await insertUser(single)
  const a = await invite(single.toUpperCase())
  check('A one matching user: 201 and the share is written for that user',
    a.status === 201 && (await sharesFor(singleId)) === 1,
    `got ${a.status} — ${a.text.slice(0, 200)}`)

  // ---- B. two users differing only by case: refused, nothing written ----
  const lower = `bench-twin-${tag}@bench.invalid`
  const upper = `Bench-Twin-${tag}@bench.invalid`
  const lowerId = await insertUser(lower)
  const upperId = await insertUser(upper)
  const twins = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = lower($1)', [lower])
  if (twins.rows[0].n !== 2) harness(`the two colliding users were not created (${twins.rows[0].n})`)

  const b = await invite(lower)
  const written = (await sharesFor(lowerId)) + (await sharesFor(upperId))
  // Negative control: judge the collision as a single match would be judged.
  const expectedStatus = NEGATIVE ? 201 : 409
  const expectedWritten = NEGATIVE ? 1 : 0
  check(`B two users differing only by case: ${expectedStatus}, ${expectedWritten} share row written`,
    b.status === expectedStatus && written === expectedWritten,
    `got ${b.status}, ${written} share row(s) — ${b.text.slice(0, 200)}`)
  check('B the refusal names the ambiguity, not a generic failure',
    NEGATIVE ? b.status === 201 : /ambiguous/i.test(b.body?.error ?? ''),
    `got ${b.text.slice(0, 200)}`)
} finally {
  for (const id of created.accounts) await pool.query('DELETE FROM account_shares WHERE account_id = $1', [id]).catch(() => {})
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  for (const id of created.users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\nnegative control: ${failures.length} assertion(s) fell, as expected`); process.exit(0) }
  console.error('\nSILENT NEGATIVE CONTROL: the collision judged as a single match, and the bench stays green — it measures nothing')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nshare invitee lookup: OK')
