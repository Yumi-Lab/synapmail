#!/usr/bin/env node
/**
 * Self-check of lot C4b: WHICH password "Test connection" tries, and for WHOM.
 *
 * No database, no network, no browser, and — the point of the lot — NOT ONE real
 * authentication attempt against a mail host. Measured in production on 20/09/2026, the
 * button was sending whatever the password FIELD held: empty (the saved password never
 * leaves the server, so the field starts empty) gave "Missing fields"; filled in by the
 * browser's password manager, it sent the WEBMAIL password to the host, and every press
 * cost two failed logins that a provider eventually locks an account for.
 *
 * `lib/accountTest.ts` decides alone, so it is executed alone with an injected account
 * loader.
 *
 *   node --experimental-strip-types scripts/check-account-test.mjs
 */
import assert from 'node:assert/strict'
import {
  TEST_DECISION,
  TEST_FAILURE,
  classifyTestFailure,
  decideTestPassword,
  hasSubmittedPassword,
} from '../lib/accountTest.ts'

const ok = label => console.log(`  ok  ${label}`)

/** The account the loader hands back, and a ledger of what it was asked for. */
const loaderFor = (account, asked = []) => Object.assign(
  async id => { asked.push(id); return account },
  { asked }
)

const OWNED = { isOwner: true, oauthProvider: null, hasStoredPassword: true }

console.log('decideTestPassword — which password leaves the server')

// The bug itself: editing with the field left alone must test the SAVED password.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: '' }, loaderFor(OWNED)),
  TEST_DECISION.STORED
)
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: undefined }, loaderFor(OWNED)),
  TEST_DECISION.STORED
)
ok('editing, field left empty: the SAVED password is tested, not the empty field')

// A field of spaces is a field the user did not fill. Sending it would be one more
// failed login at the provider, for nothing.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: '   ' }, loaderFor(OWNED)),
  TEST_DECISION.STORED
)
assert.equal(hasSubmittedPassword('   '), false)
assert.equal(hasSubmittedPassword('s3cret'), true)
ok('a field holding only spaces counts as empty, not as a password to try')

// Changing password: what was typed wins, so it can be checked before saving.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: 'brand-new' }, loaderFor(OWNED)),
  TEST_DECISION.SUBMITTED
)
ok('editing, field filled: the TYPED password is tested, so a change can be checked first')

// A guest of a shared mailbox never tests credentials that are not theirs, and gets the
// same answer as for a mailbox that does not exist.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: '' },
    loaderFor({ ...OWNED, isOwner: false })),
  TEST_DECISION.DENIED
)
assert.equal(
  await decideTestPassword({ accountId: 'ghost', password: '' }, loaderFor(null)),
  TEST_DECISION.DENIED
)
ok('a guest, and an unknown mailbox, get the same refusal — existence is not revealed')

// A guest with a password of their own must not get it tried against someone else's
// mailbox either: the refusal comes before the field is ever read.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: 'guest-typed' },
    loaderFor({ ...OWNED, isOwner: false })),
  TEST_DECISION.DENIED
)
ok('a guest is refused even when they type a password — the refusal comes first')

// Token mailboxes have no password to try; saying so beats a red error.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: '' },
    loaderFor({ ...OWNED, oauthProvider: 'microsoft', hasStoredPassword: false })),
  TEST_DECISION.OAUTH
)
ok('a token mailbox reports "nothing to test", not a failure')

// Creation is untouched: no account, so nothing saved to fall back on.
assert.equal(
  await decideTestPassword({ password: 'typed-at-creation' }, loaderFor(null)),
  TEST_DECISION.SUBMITTED
)
assert.equal(await decideTestPassword({ password: '' }, loaderFor(null)), TEST_DECISION.MISSING)
ok('creating an account behaves exactly as before')

// A mailbox row with no stored password and no token has nothing to try.
assert.equal(
  await decideTestPassword({ accountId: 'acc-1', password: '' },
    loaderFor({ ...OWNED, hasStoredPassword: false })),
  TEST_DECISION.MISSING
)
ok('a mailbox with neither a saved password nor a token reports nothing to try')

// The decision never carries the secret: it names a source, and the route fetches it.
const returned = new Set()
for (const password of ['', 'brand-new']) {
  returned.add(await decideTestPassword({ accountId: 'acc-1', password }, loaderFor(OWNED)))
}
assert.deepEqual([...returned].sort(), [TEST_DECISION.STORED, TEST_DECISION.SUBMITTED].sort())
for (const value of returned) {
  assert.equal(typeof value, 'string')
  assert.ok(!value.includes('brand-new'), 'the decision must never echo a password')
}
ok('the decision returns a SOURCE, never a password')

// The loader is asked for exactly the mailbox the request named, never another.
const asked = []
await decideTestPassword({ accountId: 'acc-42', password: '' }, loaderFor(OWNED, asked))
assert.deepEqual(asked, ['acc-42'])
ok('the mailbox loaded is the one the request names')

// Creation must not hit the loader at all: there is no mailbox to load.
const askedAtCreation = []
await decideTestPassword({ password: 'x' }, loaderFor(OWNED, askedAtCreation))
assert.deepEqual(askedAtCreation, [])
ok('creating an account loads no mailbox')

console.log('classifyTestFailure — the cause, not the raw server line')

// The two real messages from the production report.
assert.equal(classifyTestFailure('Invalid login: 535 Authentication credentials invalid'),
  TEST_FAILURE.CREDENTIALS)
assert.equal(classifyTestFailure('Command failed: AUTHENTICATIONFAILED'), TEST_FAILURE.CREDENTIALS)
ok('the two failures seen in production read as "credentials refused"')

assert.equal(classifyTestFailure('getaddrinfo ENOTFOUND imap.example.invalid'),
  TEST_FAILURE.UNREACHABLE)
assert.equal(classifyTestFailure('connect ECONNREFUSED 127.0.0.1:993'), TEST_FAILURE.UNREACHABLE)
assert.equal(classifyTestFailure('Timed out while connecting'), TEST_FAILURE.UNREACHABLE)
ok('a host that never answered reads as "unreachable", a different thing to fix')

// Anything unrecognised must NOT be dressed up as one of the two known causes.
assert.equal(classifyTestFailure('self signed certificate in chain'), TEST_FAILURE.OTHER)
ok('an unrecognised failure stays "other" rather than being filed wrongly')

console.log('check-account-test: OK')
