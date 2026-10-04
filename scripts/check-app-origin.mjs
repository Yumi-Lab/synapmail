#!/usr/bin/env node
/**
 * Bench for upstream review defect #9: the origin an invitation link is built from.
 *
 * `appOrigin()` (`lib/appOrigin.ts`) falls back to `X-Forwarded-Host` when the owner
 * has not configured `NEXT_PUBLIC_APP_URL`. That header is written by whoever reached
 * the app, and its value ends up in an invitation link sent from the account's real
 * SMTP. It must therefore be a plain host (name or address, optional port) and
 * nothing else — a path, credentials, a query string or a control character is
 * refused, and the link falls back to relative rather than carry a stranger's name.
 *
 * Pure bench — no database, no live instance, no network.
 *
 *   node --experimental-strip-types scripts/check-app-origin.mjs
 *   node --experimental-strip-types scripts/check-app-origin.mjs --negative
 *
 * NEGATIVE CONTROL (`--negative`): the origin is built the OLD way (header taken as
 * is). The bench MUST go red on every forged-host assertion. What it shows: the
 * assertions measure the refusal, not merely that a string came back. What it does
 * NOT show: that a proxy sets the header at all — an operator who sets
 * `NEXT_PUBLIC_APP_URL` (required by the README) never reaches this fallback.
 */
import './alias-resolver.mjs'

const NEGATIVE = process.argv.includes('--negative')

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const { appOrigin: realAppOrigin } = await import('../lib/appOrigin.ts')

/** The old reading: whatever the header says (the configured address still wins). */
const unvalidated = req => {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  const host = req?.headers.get('x-forwarded-host')
  if (host) return `${req.headers.get('x-forwarded-proto') ?? 'https'}://${host}`
  return ''
}
const appOrigin = NEGATIVE ? unvalidated : realAppOrigin

const proxied = (host, proto = 'https') =>
  new Request('http://a88ef164e023:3000/api/accounts', {
    headers: { 'x-forwarded-host': host, 'x-forwarded-proto': proto },
  })

// The fallback only runs without the configured address.
const configuredBefore = process.env.NEXT_PUBLIC_APP_URL
delete process.env.NEXT_PUBLIC_APP_URL
try {
  // ---- What a real proxy sends passes unchanged ----
  check('a host name is used as is', appOrigin(proxied('mail.example.test')) === 'https://mail.example.test')
  check('a host with a port is used as is', appOrigin(proxied('mail.example.test:8443')) === 'https://mail.example.test:8443')
  check('an IPv4 address with a port is accepted over http',
    appOrigin(proxied('192.0.2.1:3000', 'http')) === 'http://192.0.2.1:3000')
  check('a bracketed IPv6 address is accepted', appOrigin(proxied('[2001:db8::1]:3000')) === 'https://[2001:db8::1]:3000')
  check('a chain of hosts yields the FIRST one (what the outside reader typed)',
    appOrigin(proxied('mail.example.test, proxy.internal')) === 'https://mail.example.test')
  check('the configured address still wins over the header', (() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://mail.example.test/'
    try { return appOrigin(proxied('evil.example')) === 'https://mail.example.test' }
    finally { delete process.env.NEXT_PUBLIC_APP_URL }
  })())

  // ---- What a caller may forge is refused: relative links, never a stranger's name ----
  for (const forged of [
    'evil.example/phish', 'user@evil.example', 'evil.example?x=1', 'evil.example#frag',
    'a b.example', '-evil.example', 'evil.example\tx', 'evil.example;x',
  ]) {
    check(`a forged host ${JSON.stringify(forged)} is refused (relative links)`,
      appOrigin(proxied(forged)) === '', `got ${JSON.stringify(appOrigin(proxied(forged)))}`)
  }
  check('an unknown scheme in x-forwarded-proto is replaced by https',
    appOrigin(proxied('mail.example.test', 'javascript')) === 'https://mail.example.test',
    `got ${appOrigin(proxied('mail.example.test', 'javascript'))}`)
  check('no header at all: relative links', appOrigin(new Request('http://a88ef164e023:3000/x')) === '')
} finally {
  if (configuredBefore === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = configuredBefore
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\nnegative control: ${failures.length} assertion(s) fell, as expected`); process.exit(0) }
  console.error('\nSILENT NEGATIVE CONTROL: the header was used unvalidated and the bench stayed green — it measures nothing')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\napp origin (forwarded host validated): OK')
