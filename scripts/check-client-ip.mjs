#!/usr/bin/env node
/**
 * Bench for upstream review defect #2: WHICH address a request is attributed to.
 *
 * `X-Forwarded-For` is a chain, one hop per proxy, each APPENDING what it saw. Only the
 * LAST entry was written by the trusted reverse proxy in front of the app; anything
 * before it came in the caller's own request. Reading the first entry let a caller put
 * an allowed address there and walk past a key's allowlist.
 *
 * Pure bench — no database, no live instance, no network: it calls `clientIp()`
 * (`lib/apiLog.ts`, the single source) on hand-built requests, then greps the source
 * tree so that NO other module reads the header on its own (the tracking pixel used to).
 *
 *   node --experimental-strip-types scripts/check-client-ip.mjs
 *   node --experimental-strip-types scripts/check-client-ip.mjs --negative
 *
 * NEGATIVE CONTROL (`--negative`): the address is read the OLD way (first hop) and a
 * second reader of the header is pretended to exist. The bench MUST go red on the
 * forged-chain assertions and on the single-reader assertion. What it shows: the
 * assertions measure the hop actually chosen, not merely "some address came back".
 * What it does NOT show: the behaviour of a proxy that fails to append its own hop —
 * that is the deployment caveat written at the top of `clientIp()`, not code.
 */
import './alias-resolver.mjs'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NEGATIVE = process.argv.includes('--negative')

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

// `lib/apiLog.ts` pulls `lib/db.ts`, whose pool only connects on first query: importing
// is safe without a database, and nothing here ever queries.
process.env.DATABASE_URL ??= 'postgresql://unused@localhost/unused'
const { clientIp: realClientIp } = await import('../lib/apiLog.ts')

/** The old reading: first hop, the one the caller controls. */
const firstHop = req => {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
  return forwarded || req.headers.get('x-real-ip')?.trim() || null
}
const clientIp = NEGATIVE ? firstHop : realClientIp

const withHeaders = headers => new Request('http://app.internal:3000/api/accounts', { headers })

/** RFC 5737 documentation addresses: nobody's. */
const FORGED = '203.0.113.7'      // what the caller wrote, hoping it is on the allowlist
const PROXY_SAW = '198.51.100.42' // what the trusted proxy appended: the real source

check('a single hop is read as is',
  clientIp(withHeaders({ 'x-forwarded-for': PROXY_SAW })) === PROXY_SAW)
check('a forged first hop is IGNORED: the last hop (the trusted proxy) wins',
  clientIp(withHeaders({ 'x-forwarded-for': `${FORGED}, ${PROXY_SAW}` })) === PROXY_SAW,
  `got ${clientIp(withHeaders({ 'x-forwarded-for': `${FORGED}, ${PROXY_SAW}` }))}`)
check('a three-hop chain still yields the last one',
  clientIp(withHeaders({ 'x-forwarded-for': `${FORGED},192.0.2.1 , ${PROXY_SAW}` })) === PROXY_SAW)
check('x-real-ip is the fallback when x-forwarded-for is absent',
  clientIp(withHeaders({ 'x-real-ip': PROXY_SAW })) === PROXY_SAW)
check('no header at all: null, never a guess',
  clientIp(withHeaders({})) === null)

// ---- ONE reader of the header in the whole app -----------------------------------
// A second reader would compare a restriction to one address and log another. The
// grep excludes comments (`*`, `//`) so that documenting the header is not a hit.
const grep = () => {
  try {
    return execFileSync('grep', ['-rniE', '--include=*.ts', '--include=*.tsx',
      "headers\\.get\\(['\"]x-(forwarded-for|real-ip)['\"]\\)", 'app', 'lib', 'components', 'middleware.ts'],
      { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch (err) {
    if (err.status === 1) return []
    throw err
  }
}
const readers = grep()
  .filter(line => !/^[^:]+:\d+:\s*(\/\/|\*|\/\*)/.test(line))
  .map(line => line.split(':')[0])
const uniqueReaders = [...new Set(NEGATIVE ? [...readers, 'app/api/track/[token]/route.ts'] : readers)]
check('the header is read in ONE module only (lib/apiLog.ts)',
  uniqueReaders.length === 1 && uniqueReaders[0] === 'lib/apiLog.ts', uniqueReaders.join(', '))

// The pixel tracker must go through that module, not carry its own copy.
const tracker = readFileSync(join(ROOT, 'app/api/track/[token]/route.ts'), 'utf8')
check('the tracking pixel attributes the open through clientIp()',
  /import \{[^}]*\bclientIp\b[^}]*\} from '@\/lib\/apiLog'/.test(tracker) && /clientIp\(req\)/.test(tracker))

if (NEGATIVE) {
  if (failures.length) { console.log(`\nnegative control: ${failures.length} assertion(s) fell, as expected`); process.exit(0) }
  console.error('\nSILENT NEGATIVE CONTROL: the first hop was read and the bench stayed green — it measures nothing')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nclient address (last trusted hop): OK')
