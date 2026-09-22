#!/usr/bin/env node
/**
 * MEASURES lot S11 against REAL mailboxes: `scope=accounts` WITHOUT `stream=1` must
 * honour the scope it was given instead of silently falling back to the current
 * mailbox's inbox.
 *
 * The defect it pins down, measured in production on 2026-09-21:
 * `GET /api/messages/search?q=<address>&scope=accounts` without `stream=1` answered
 * HTTP 200, 0 results, in 26.7 s, while the same query aimed at the mailbox that
 * holds the message found it in 3.2 s. The multi-mailbox sweep only existed in the
 * `SCOPE_ACCOUNTS && stream` branch.
 *
 * The decisive arm is A-vs-B in the SAME run, so no absolute threshold is involved.
 * The term is a sender ADDRESS taken from a mailbox that is NOT the one a stream-less
 * call used to search — GOAL.md's "an address that exists only in a non-current
 * mailbox":
 *   A (reference) — `scope=all` aimed AT that mailbox: the same shape as Nicolas's
 *                   production reference arm ("the mailbox that holds it finds it in
 *                   3.2 s"). It establishes that the address IS findable there.
 *   B (subject)   — `scope=accounts` WITHOUT `stream=1`, aimed at the CURRENT mailbox.
 * B must return at least one message carrying that mailbox's id. Under the old
 * behaviour B searches one folder of the current mailbox and finds none of them —
 * which is exactly what the negative control shows.
 *
 * What is NOT asserted, and why: that every mailbox arm A reaches is represented
 * among arm B's messages. `SEARCH_RESULT_LIMIT` caps the aggregate at 200 sorted by
 * date, so a broad term truncates whole mailboxes out of the answer BY DESIGN — an
 * assertion demanding otherwise would contradict the documented cap, not measure the
 * sweep. Coverage is asserted on the `searched`/`sweptAccounts` fields instead, which
 * the cap does not touch.
 *
 * READ ONLY: GETs on the search route. Nothing is created, moved or deleted, and no
 * message body, address-local-part or password is printed — counts, timings and
 * mailbox domains only.
 *
 * Needs a running server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-search-accounts-nostream.mjs
 *   node scripts/check-search-accounts-nostream.mjs --negative
 *     Replays arm B the way the code behaved BEFORE the fix (scope dropped, one
 *     folder of the current mailbox) and EXPECTS it to fail: a bench that cannot go
 *     red proves nothing.
 */
import { readFileSync, existsSync } from 'node:fs'

for (const file of ['.env', '.env.local']) {
  const url = new URL(`../${file}`, import.meta.url)
  if (!existsSync(url)) continue
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) harness(`${k} is not set`)
}

const NEGATIVE = process.argv.includes('--negative')

// Parameter names, scopes and stop reasons come from the SHIPPED module: renaming
// one there fails this bench instead of letting it measure a contract the product
// no longer serves.
const SRC = readFileSync(new URL('../lib/search.ts', import.meta.url), 'utf8')
const constOf = name => SRC.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1]
const [Q_PARAM, SCOPE_P, SCOPE_ACC, STREAM_P, STOP_BUDGET, STOP_UNREACHABLE] =
  ['SEARCH_PARAM', 'SCOPE_PARAM', 'SCOPE_ACCOUNTS', 'STREAM_PARAM', 'SWEEP_STOP_BUDGET', 'SWEEP_STOP_UNREACHABLE'].map(constOf)
const BUDGET_MS = Number(SRC.match(/export const ACCOUNTS_SWEEP_BUDGET_MS = (\d+)/)?.[1])
if (!Q_PARAM || !SCOPE_P || !SCOPE_ACC || !STREAM_P || !STOP_BUDGET || !STOP_UNREACHABLE || !BUDGET_MS) {
  harness('cannot read the search contract from lib/search.ts')
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ── Session cookie, exactly as the browser obtains it ──
const jar = new Map()
const keep = res => {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}
const cookie = () => Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ')
const get = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...init?.headers, cookie: cookie() } })
  keep(res)
  return res
}

const csrfRes = await get('/api/auth/csrf')
if (!csrfRes.ok) harness(`GET /api/auth/csrf -> ${csrfRes.status}`)
const { csrfToken } = await csrfRes.json()
const login = await get('/api/auth/callback/credentials', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  redirect: 'manual',
})
keep(login)
if (!Array.from(jar.keys()).some(name => name.endsWith('session-token'))) {
  harness(`credentials login did not yield a session cookie (status ${login.status})`)
}

const accountsRes = await get('/api/accounts')
if (!accountsRes.ok) harness(`GET /api/accounts -> ${accountsRes.status}`)
const accounts = (await accountsRes.json()).data ?? []
if (accounts.length < 2) harness(`the measurement needs at least 2 mailboxes, the test user has ${accounts.length}`)

/** The mailbox the stream-less call searched under the OLD behaviour: the default one. */
const current = accounts.find(a => a.isDefault) ?? accounts[0]
/** A mailbox domain is not a secret and identifies an arm; a local part is not printed. */
const domainOf = email => String(email).split('@')[1] ?? '?'

console.log(`base           ${BASE}`)
console.log(`mailboxes      ${accounts.length}`)
console.log(`current        @${domainOf(current.email)}${current.isDefault ? ' (default)' : ''}`)
console.log(`sweep budget   ${BUDGET_MS} ms (lib/search.ts)`)
console.log(`mode           ${NEGATIVE ? 'NEGATIVE CONTROL (pre-fix behaviour replayed)' : 'product'}\n`)

const url = (q, extra = '') =>
  `/api/messages/search?${Q_PARAM}=${encodeURIComponent(q)}&${SCOPE_P}=${SCOPE_ACC}` +
  `&account=${encodeURIComponent(current.id)}${extra}`

/** A timed GET: elapsed ms is the proof the program ran, not the harness. */
const timed = async path => {
  const started = Date.now()
  const res = await get(path)
  const text = await res.text()
  return { status: res.status, ms: Date.now() - started, text }
}

// ── The term: an address that lives in a mailbox the OLD behaviour never searched ──
// Derived from the mailboxes themselves, so the bench keeps working as their content
// changes. Only the DOMAIN of an address is ever printed.
const target = accounts.find(a => a.id !== current.id)
if (!target) harness('no mailbox other than the current one: the measurement cannot be decisive')

const senders = async account => {
  const res = await get(`/api/messages?account=${encodeURIComponent(account.id)}&folder=INBOX&perPage=25`)
  if (!res.ok) return []
  const body = await res.json()
  const rows = body.messages ?? body.data ?? []
  return Array.from(new Set(rows.map(m => m.from?.address ?? m.from_address).filter(Boolean)))
}

// ── Arm A, the REFERENCE: the same query aimed AT the mailbox that holds the mail ──
// `scope=all` on one mailbox — the shape of Nicolas's production reference arm. It
// costs one mailbox, not seven, and it is what makes arm B's result attributable.
let term = null
let referenceMs = 0
let referenceHits = 0
for (const candidate of await senders(target)) {
  const started = Date.now()
  const res = await get(`/api/messages/search?${Q_PARAM}=${encodeURIComponent(candidate)}` +
    `&${SCOPE_P}=all&account=${encodeURIComponent(target.id)}`)
  if (!res.ok) harness(`arm A: GET search (scope=all on the target mailbox) -> ${res.status}`)
  const body = await res.json()
  const ms = Date.now() - started
  if ((body.messages ?? []).length > 0) { term = candidate; referenceMs = ms; referenceHits = body.messages.length; break }
}
if (!term) {
  harness('no address from the non-current mailbox is findable in it — ' +
    'the measurement would not be decisive; check that the test mailbox holds mail')
}

console.log(`term           an address @${domainOf(term)} read from @${domainOf(target.email)}`)
console.log(`arm A (ref)    scope=all on @${domainOf(target.email)}: ${referenceHits} result(s) in ${referenceMs} ms\n`)

// ── Arm B, the SUBJECT: the same scope, WITHOUT the stream ──
// The negative control replays what the code did before the fix: the scope silently
// dropped, so one folder of the current mailbox.
const armB = NEGATIVE
  ? await timed(`/api/messages/search?${Q_PARAM}=${encodeURIComponent(term)}&account=${encodeURIComponent(current.id)}&folder=INBOX`)
  : await timed(url(term))

if (armB.status !== 200) harness(`arm B: GET search (no stream) -> ${armB.status} in ${armB.ms} ms`)
let body
try { body = JSON.parse(armB.text) } catch { harness(`arm B: response is not JSON (${armB.text.slice(0, 120)})`) }

const found = (body.messages ?? []).length
const outside = new Set((body.messages ?? []).map(m => m.accountId).filter(id => id && id !== current.id))
console.log(`arm B (no stream) HTTP ${armB.status} in ${armB.ms} ms — ${found} result(s), ` +
  `${body.searched ?? '?'}/${body.folders ?? '?'} folders, ${body.sweptAccounts ?? '?'}/${body.accounts ?? '?'} mailboxes, ` +
  `${outside.size} mailbox(es) other than the current one\n`)

check('the scope is honoured: results come back at all', found > 0, `${found} result(s)`)
check('the scope is honoured: mail from a mailbox other than the current one is found',
  outside.size > 0, `${outside.size} other mailbox(es) represented`)
// LA mesure du lot : l'adresse qu'arm A a trouvée dans une boîte NON courante est
// rendue, avec l'identité de CETTE boîte. Sans le balayage, elle n'y était pas.
check('the address found in the non-current mailbox is returned, attributed to it',
  outside.has(target.id), `@${domainOf(target.email)} ${outside.has(target.id) ? 'represented' : 'ABSENT'}`)

// The coverage fields: a truncated sweep must SAY so. `0 results` without them is
// precisely the lie lot S11 is about.
check('the answer reports its coverage in folders', Number.isInteger(body.searched) && Number.isInteger(body.folders),
  `searched=${body.searched} folders=${body.folders}`)
check('the answer reports its coverage in mailboxes',
  body.accounts === accounts.length && Number.isInteger(body.sweptAccounts),
  `accounts=${body.accounts} of ${accounts.length}, swept=${body.sweptAccounts}`)
check('the answer says whether it is complete', typeof body.complete === 'boolean', `complete=${body.complete}`)
check('an incomplete sweep names its reason, a complete one claims none',
  body.complete
    ? body.stoppedBecause === undefined
    : Array.isArray(body.stoppedBecause) &&
      body.stoppedBecause.length > 0 &&
      body.stoppedBecause.every(r => r === STOP_BUDGET || r === STOP_UNREACHABLE),
  body.complete ? 'complete, no reason' : `stoppedBecause=${JSON.stringify(body.stoppedBecause)}`)
check('unreachable mailboxes are listed, never swallowed', Array.isArray(body.unreachable),
  body.unreachable?.length ? `${body.unreachable.length} unreachable` : 'none')
// Le plafond de temps est TENU, et c'est mesuré, pas promis. Marge de 5 s pour le
// dernier dossier en cours quand le signal tombe.
check('the sweep respects its own time budget', armB.ms < BUDGET_MS + 5000, `${armB.ms} ms < ${BUDGET_MS + 5000} ms`)

if (NEGATIVE) {
  if (failures.length) {
    console.log(`\ncheck-search-accounts-nostream: NEGATIVE CONTROL OK — ${failures.length} check(s) failed as expected`)
    process.exit(0)
  }
  console.error('\nNEGATIVE CONTROL FAILED: the pre-fix behaviour passed the bench, so the bench proves nothing')
  process.exit(1)
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\ncheck-search-accounts-nostream: OK')
