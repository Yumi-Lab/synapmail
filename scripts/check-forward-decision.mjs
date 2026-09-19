#!/usr/bin/env node
/**
 * Self-check of the forward trust boundary (lot M5), with no database, no
 * network and no browser: `lib/forward.ts` decides ALONE what the send route
 * accepts, so it can be executed alone.
 *
 * Two questions, both raised against the code by review:
 *  1. can a hand-written body reach IMAP unchecked (`1:*`, a huge selection)?
 *  2. are the sources read in the mailbox the SELECTION came from, or in the
 *     one the "From" picker happens to point at?
 *
 *   node --experimental-strip-types scripts/check-forward-decision.mjs
 */
import assert from 'node:assert/strict'
import {
  FORWARD_ERROR,
  FORWARD_MAX_MESSAGES,
  FORWARD_MAX_TOTAL_BYTES,
  parseForwardedMessages,
  resolveForwardOrigin,
} from '../lib/forward.ts'

const ok = (label) => console.log(`  ok  ${label}`)

console.log('parseForwardedMessages — what the boundary refuses')

const valid = { accountId: 'acc-a', folder: 'INBOX', uids: ['12', '7', '3'] }
const parsed = parseForwardedMessages(valid)
assert.equal(parsed.ok, true)
assert.deepEqual(parsed.value.uids, ['12', '7', '3'], 'selection order is kept')
ok('a plain selection passes, in the order it was clicked')

for (const [label, body] of [
  ['an IMAP sequence set (`1:*` would read the WHOLE folder)', { ...valid, uids: ['1:*'] }],
  ['a range', { ...valid, uids: ['1:500'] }],
  ['a wildcard', { ...valid, uids: ['*'] }],
  ['a negative uid', { ...valid, uids: ['-1'] }],
  ['a non-string uid', { ...valid, uids: [12] }],
  ['an empty selection', { ...valid, uids: [] }],
  ['a missing origin account', { folder: 'INBOX', uids: ['1'] }],
  ['a blank folder', { ...valid, folder: '   ' }],
  ['an array instead of an object', ['INBOX', '1']],
  ['null', null],
]) {
  const r = parseForwardedMessages(body)
  assert.equal(r.ok, false, label)
  assert.equal(r.status, 400)
  assert.equal(r.code, FORWARD_ERROR.invalid)
  ok(`400 on ${label}`)
}

const many = parseForwardedMessages({ ...valid, uids: Array.from({ length: FORWARD_MAX_MESSAGES + 1 }, (_, i) => String(i + 1)) })
assert.equal(many.ok, false)
assert.equal(many.code, FORWARD_ERROR.tooMany)
assert.equal(many.detail, FORWARD_MAX_MESSAGES)
ok(`400 past ${FORWARD_MAX_MESSAGES} messages, and the limit travels with the refusal`)

const dup = parseForwardedMessages({ ...valid, uids: ['5', '5', '9', '5'] })
assert.deepEqual(dup.value.uids, ['5', '9'], 'duplicates collapse, first position wins')
ok('a repeated uid is attached once, not three times')

assert.ok(FORWARD_MAX_TOTAL_BYTES > 0 && FORWARD_MAX_TOTAL_BYTES <= 25 * 1024 * 1024)
ok(`total size ceiling is ${Math.round(FORWARD_MAX_TOTAL_BYTES / (1024 * 1024))} MB, at or under the common SMTP limit`)

console.log('resolveForwardOrigin — WHICH mailbox the sources are read from')

const sender = { id: 'acc-sender' }
const originA = { id: 'acc-a' }
// The only account the acting user may read, besides the sender's.
const load = async (id) => (id === originA.id ? originA : null)

const same = await resolveForwardOrigin(sender, sender.id, async () => {
  throw new Error('must not be loaded: the origin IS the sender')
})
assert.equal(same.ok, true)
assert.equal(same.value.id, sender.id)
ok('origin === sender: the already-checked account is reused, no second lookup')

const crossed = await resolveForwardOrigin(sender, originA.id, load)
assert.equal(crossed.ok, true)
assert.equal(crossed.value.id, originA.id, 'sources come from the SELECTION mailbox')
assert.notEqual(crossed.value.id, sender.id, 'never from the "From" mailbox')
ok('origin !== sender: sources are read in the origin, not in the sender')

const denied = await resolveForwardOrigin(sender, 'acc-someone-elses', load)
assert.equal(denied.ok, false)
assert.equal(denied.status, 404)
assert.equal(denied.code, FORWARD_ERROR.originDenied)
ok('an origin the user cannot read: 404, nothing is sent')

console.log('check-forward-decision: OK')
