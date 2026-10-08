#!/usr/bin/env node
/**
 * Review defect #10 (lot P4): in the streamed "all mailboxes" search (NDJSON, one
 * chunk per folder), the prompt-injection guard flag must be the one of the
 * mailbox EACH chunk comes from. It used to be a cumulative `bool_or` that stuck
 * to the first `true` met: once a guarded mailbox had reported, every later chunk
 * of every unguarded mailbox carried `aiSafety` too.
 *
 * Measured on a running instance with the test user's REAL mailboxes, read only:
 * among the mailboxes the user OWNS exactly one keeps the guard on (the others are
 * switched off for the run, restored in `finally`); mailboxes SHARED with the user
 * keep their owner's setting, which is the one that applies to them. A Bearer key
 * sweeps them all, and every chunk received must carry `aiSafety` if and only if
 * its own mailbox's `prompt_guard` is on. Chunks from unguarded mailboxes that
 * arrive AFTER a guarded one are counted: that is the only ordering in which the
 * old defect is visible.
 *
 *   node --experimental-strip-types scripts/check-search-stream-guard.mjs
 *   node --experimental-strip-types scripts/check-search-stream-guard.mjs --negative
 *
 * NEGATIVE CONTROL (`--negative`): the chunks are judged the OLD way — a chunk is
 * expected guarded as soon as ANY earlier chunk was (cumulative). The bench MUST
 * then go red on the unguarded chunks that follow a guarded one. What it shows:
 * the assertion is per-chunk, not "some chunk had aiSafety".
 *
 * SAFETY: one GET on the search route, nothing created, moved or deleted in any
 * mailbox; only `prompt_guard` flags are flipped and restored. The bench key is
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
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, DATABASE_URL: DB_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, DATABASE_URL: DB_URL })) {
  if (!v) harness(`${k} is not set`)
}

// Parameter names come from the shipped module, never retyped.
const SRC = readFileSync(new URL('../lib/search.ts', import.meta.url), 'utf8')
const constOf = name => SRC.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1]
const [Q_PARAM, SCOPE_P, SCOPE_ACC, STREAM_P] = ['SEARCH_PARAM', 'SCOPE_PARAM', 'SCOPE_ACCOUNTS', 'STREAM_PARAM'].map(constOf)
if (!Q_PARAM || !SCOPE_P || !SCOPE_ACC || !STREAM_P) harness('cannot read the search params from lib/search.ts')

/** A term wide enough to hit folders in several mailboxes; the bench only counts chunks. */
const QUERY = 'the'
/** The stream is cut once enough chunks have been seen to judge the ordering. */
const ENOUGH_CHUNKS = 40

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }
let previousGuards = []

try {
  const users = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [EMAIL])
  if (users.rows.length !== 1) harness(`expected exactly one user ${EMAIL}`)
  const userId = users.rows[0].id

  const owned = await pool.query(
    'SELECT id, email, prompt_guard FROM email_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC',
    [userId]
  )
  if (owned.rows.length < 2) harness('the test user needs at least two mailboxes to show a per-mailbox flag')
  previousGuards = owned.rows.map(r => [r.id, r.prompt_guard])

  // Exactly one guarded mailbox, the FIRST in sweep order: its chunks come early,
  // so the unguarded chunks that follow are the ones the old defect would mark.
  const guardedId = owned.rows[0].id
  await pool.query('UPDATE email_accounts SET prompt_guard = (id = $2) WHERE user_id = $1', [userId, guardedId])

  const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
  const key = await pool.query(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
     VALUES ($1, $2, $3, $4, $5::text[], NOW(), NOW()) RETURNING id`,
    [userId, 'bench stream guard', raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest('hex'), ['messages:read']]
  )
  created.keys.push(key.rows[0].id)
  for (const r of owned.rows) {
    await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key.rows[0].id, r.id])
  }

  const url = `${BASE}/api/messages/search?${Q_PARAM}=${encodeURIComponent(QUERY)}&account=${guardedId}&${SCOPE_P}=${SCOPE_ACC}&${STREAM_P}=1`
  const ctrl = new AbortController()
  const res = await fetch(url, { headers: { authorization: `Bearer ${raw}` }, signal: ctrl.signal })
  if (res.status !== 200) harness(`GET search stream -> ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const chunks = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (chunks.length < ENOUGH_CHUNKS) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        const item = JSON.parse(line)
        if (item.accountId) chunks.push(item)
      }
    }
  } finally {
    ctrl.abort()
  }

  // What each chunk's OWN mailbox asks for — shared mailboxes included, whose flag
  // is their owner's and was not touched above.
  const swept = [...new Set(chunks.map(c => c.accountId))]
  const flags = await pool.query('SELECT id, prompt_guard FROM email_accounts WHERE id = ANY($1::uuid[])', [swept])
  const guardOf = new Map(flags.rows.map(r => [r.id, r.prompt_guard]))
  const isGuarded = c => guardOf.get(c.accountId) === true

  const fromGuarded = chunks.filter(isGuarded)
  const firstGuardedAt = chunks.findIndex(isGuarded)
  const unguardedAfter = firstGuardedAt < 0 ? [] : chunks.slice(firstGuardedAt + 1).filter(c => !isGuarded(c))
  console.log(`  ${chunks.length} chunk(s) from ${swept.length} mailbox(es): ${fromGuarded.length} from guarded mailboxes, ${unguardedAfter.length} from unguarded ones after the first guarded chunk`)
  if (!fromGuarded.length || !unguardedAfter.length) {
    harness('the ordering needed to judge the defect did not occur (no guarded chunk, or no unguarded chunk after it)')
  }

  check('every chunk of a guarded mailbox carries aiSafety, and as its first key',
    fromGuarded.every(c => c.aiSafety?.promptInjectionGuard === true && Object.keys(c)[0] === 'aiSafety'),
    `${fromGuarded.filter(c => !c.aiSafety).length} guarded chunk(s) without aiSafety`)

  // The judgement under test. Negative control: cumulative, the OLD reading.
  let seenGuarded = false
  const wrong = []
  for (const c of chunks) {
    seenGuarded = seenGuarded || isGuarded(c)
    const expected = NEGATIVE ? seenGuarded : isGuarded(c)
    if ((c.aiSafety !== undefined) !== expected) wrong.push(`${c.accountEmail}/${c.folder}`)
  }
  check(`chunks carry aiSafety ${NEGATIVE ? 'from the first guarded chunk on (old cumulative reading)' : 'if and only if their own mailbox is guarded'}`,
    wrong.length === 0, `${wrong.length} chunk(s) judged wrong: ${wrong.slice(0, 5).join(', ')}`)
} finally {
  for (const [id, guard] of previousGuards) await pool.query('UPDATE email_accounts SET prompt_guard = $2 WHERE id = $1', [id, guard]).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\nnegative control: ${failures.length} assertion(s) fell, as expected`); process.exit(0) }
  console.error('\nSILENT NEGATIVE CONTROL: the old cumulative reading passes too — the bench does not see the defect')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nstreamed search guard per mailbox: OK')
