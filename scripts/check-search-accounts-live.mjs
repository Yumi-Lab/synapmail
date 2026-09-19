#!/usr/bin/env node
/**
 * MEASURES the "all mailboxes" scope against REAL mailboxes, then checks the two
 * numbers lot S4b is defined by: a first result within `FIRST_RESULT_BUDGET_MS`,
 * and no more IMAP sockets than the caps of `lib/search.ts` + `lib/imap.ts`
 * promise. Every other figure (mailboxes, folders, full sweep, chunks, matches)
 * is REPORTED, not asserted: they describe the bench subject, they are not a
 * contract.
 *
 * The socket count comes from `lsof` on the server process, sampled while the
 * stream runs — the caps are a PROMISE, this is what the machine actually opens.
 * It is compared against a BASELINE taken in the SAME run, because the app holds
 * IMAP connections a search knows nothing about (background inbox sync, IDLE
 * watchers): without that reference arm, those would be charged to the sweep and
 * the cap would look breached by construction.
 *
 * READ ONLY: one GET on the search route. Nothing is created, moved or deleted,
 * and no message body is printed — only counts and timings.
 *
 * Needs a running server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-search-accounts-live.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

for (const file of ['.env', '.env.local']) {
  const url = new URL(`../${file}`, import.meta.url)
  if (!existsSync(url)) continue
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

// Parameter names come from the shipped module: a rename there fails this bench
// instead of making it measure a URL the product no longer serves.
const SRC = readFileSync(new URL('../lib/search.ts', import.meta.url), 'utf8')
const constOf = name => SRC.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1]
const [Q_PARAM, SCOPE_P, SCOPE_ACC, STREAM_P] =
  ['SEARCH_PARAM', 'SCOPE_PARAM', 'SCOPE_ACCOUNTS', 'STREAM_PARAM'].map(constOf)
if (!Q_PARAM || !SCOPE_P || !SCOPE_ACC || !STREAM_P) { console.error('HARNESS: cannot read the search params from lib/search.ts'); process.exit(2) }
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

// Budget du premier résultat, tel que le lot S4b le pose : « 1er résultat < 10 s ».
// Calibré le 20/09/2026 sur le compte de test (7 boîtes, 185 dossiers, serveur de
// dev local, IONOS) : mesuré 1,8 s et 3,6 s sur deux passages — la marge est large,
// et le bras de RÉFÉRENCE d'un dépassement serait la même requête en portée « tous
// les dossiers » sur une seule boîte.
const FIRST_RESULT_BUDGET_MS = 10000

const failures = []
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// Les plafonds viennent des modules livrés : les relever ici ferait mesurer un
// plafond que le produit n'applique pas.
const IMAP_SRC = readFileSync(new URL('../lib/imap.ts', import.meta.url), 'utf8')
const numOf = (src, name) => Number(src.match(new RegExp(`export const ${name} = (\\d+)`))?.[1])
const ACCOUNT_CONCURRENCY = numOf(SRC, 'ACCOUNT_CONCURRENCY')
const SEARCH_CONNECTIONS = numOf(IMAP_SRC, 'SEARCH_CONNECTIONS')
if (!ACCOUNT_CONCURRENCY || !SEARCH_CONNECTIONS) harness('cannot read the concurrency caps from lib/search.ts / lib/imap.ts')
const SOCKET_CAP = ACCOUNT_CONCURRENCY * SEARCH_CONNECTIONS

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
// The cookie prefix depends on the Auth.js major and on https: match on the
// SUFFIX rather than pinning a name that changes with the deployment.
if (!Array.from(jar.keys()).some(name => name.endsWith('session-token'))) {
  harness(`credentials login did not yield a session cookie (status ${login.status}, cookies: ${Array.from(jar.keys()).join(', ') || 'none'})`)
}

const accountsRes = await get('/api/accounts')
if (!accountsRes.ok) harness(`GET /api/accounts -> ${accountsRes.status}`)
const accounts = (await accountsRes.json()).data ?? []
if (!accounts.length) harness('no email account configured for the test user')

// One LIST per mailbox, to report the real folder count of the bench subject.
let folderTotal = 0
const perAccount = []
for (const a of accounts) {
  const res = await get(`/api/folders?account=${encodeURIComponent(a.id)}`)
  const n = res.ok ? ((await res.json()).data ?? []).length : -1
  perAccount.push({ email: a.email, folders: n, shared: !!a.isShared })
  if (n > 0) folderTotal += n
}

// The term is DERIVED from the mailbox, so the bench keeps finding results after
// the test account's content changes.
const term = accounts[0].email.split('@')[1]
if (!term) harness(`cannot derive a search term from ${accounts[0].email}`)

console.log(`base           ${BASE}`)
console.log(`mailboxes      ${accounts.length}`)
for (const a of perAccount) console.log(`  ${a.email}${a.shared ? ' (shared)' : ''} — ${a.folders} folders`)
console.log(`folders total  ${folderTotal}`)
console.log(`term           ${term}\n`)

// ── Peak IMAP sockets held by the server, sampled during the sweep ──
const serverPid = (() => {
  const port = new URL(BASE).port || '80'
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    return out.trim().split('\n')[0] || null
  } catch { return null }
})()
const imapSockets = () => {
  if (!serverPid) return -1
  try {
    const out = execFileSync('lsof', ['-nP', '-p', serverPid, '-iTCP', '-sTCP:ESTABLISHED'], { encoding: 'utf8' })
    return out.split('\n').filter(l => /:(993|143)\b/.test(l)).length
  } catch { return -1 }
}
// REFERENCE ARM, same run: the app holds IMAP connections that have nothing to do
// with a search (background inbox sync, IDLE watchers). Counting only the peak
// would attribute those to the sweep and make the declared cap look breached.
// What the sweep costs is peak MINUS this baseline.
const baseline = imapSockets()
let peak = baseline
const sampler = setInterval(() => { peak = Math.max(peak, imapSockets()) }, 200)

const url = `${BASE}/api/messages/search?${Q_PARAM}=${encodeURIComponent(term)}` +
  `&folder=INBOX&${SCOPE_P}=${SCOPE_ACC}&${STREAM_P}=1&account=${encodeURIComponent(accounts[0].id)}`
const started = Date.now()
let firstResultMs = null, firstChunkMs = null, chunks = 0, results = 0, total = 0
const mailboxesSeen = new Set()
const unreachable = []
const res = await get(url.slice(BASE.length))
if (!res.ok) { clearInterval(sampler); harness(`GET search -> ${res.status}`) }
const reader = res.body.getReader()
const decoder = new TextDecoder()
let pending = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  const lines = (pending + decoder.decode(value, { stream: true })).split('\n')
  pending = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let item
    try { item = JSON.parse(line) } catch { continue }
    chunks++
    if (firstChunkMs === null) firstChunkMs = Date.now() - started
    if (item.unreachable) { unreachable.push(...item.unreachable); continue }
    if (item.accountId) mailboxesSeen.add(item.accountId)
    total += item.total ?? 0
    const n = (item.messages ?? []).length
    if (n && firstResultMs === null) firstResultMs = Date.now() - started
    results += n
  }
}
const sweepMs = Date.now() - started
clearInterval(sampler)

console.log(`first chunk    ${firstChunkMs} ms`)
console.log(`first result   ${firstResultMs === null ? 'none' : `${firstResultMs} ms`}`)
console.log(`full sweep     ${sweepMs} ms`)
console.log(`chunks         ${chunks}`)
console.log(`mailboxes hit  ${mailboxesSeen.size} / ${accounts.length}`)
console.log(`results        ${results} kept, ${total} matches announced`)
console.log(`unreachable    ${unreachable.length ? unreachable.join(', ') : 'none'}`)
const after = imapSockets()
const attributable = peak - baseline
console.log(`IMAP sockets   baseline ${baseline}, peak ${peak}, after ${after}` +
  (serverPid ? ` (pid ${serverPid})` : ' (server pid not found)'))
console.log(`               attributable to the sweep: ${attributable}\n`)

console.log('checks')
check('a first result lands within budget',
  firstResultMs !== null && firstResultMs < FIRST_RESULT_BUDGET_MS,
  `${firstResultMs === null ? 'no result' : `${firstResultMs} ms`} < ${FIRST_RESULT_BUDGET_MS} ms`)
check('every accessible mailbox reports or is named unreachable',
  mailboxesSeen.size + unreachable.length >= accounts.length,
  `${mailboxesSeen.size} reported + ${unreachable.length} unreachable / ${accounts.length}`)
if (baseline < 0) {
  console.log('  skip the socket cap — lsof could not find the server process (HARNESS, not a product result)')
} else {
  check('the sweep opens no more sockets than the caps allow',
    attributable <= SOCKET_CAP,
    `${attributable} <= ${ACCOUNT_CONCURRENCY} x ${SEARCH_CONNECTIONS} = ${SOCKET_CAP}`)
  check('every socket the sweep opened is closed when it ends',
    after <= baseline, `${after} <= ${baseline}`)
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\ncheck-search-accounts-live: OK')
