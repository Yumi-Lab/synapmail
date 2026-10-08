#!/usr/bin/env node
/**
 * Self-check of the desktop-notification decision, with no browser (headless
 * Chrome never grants `Notification`): `arrival()` in
 * `hooks/useEmailNotifications.ts` decides ALONE what is announced, so it can be
 * executed alone.
 *
 * The hook observes the list AS DISPLAYED, i.e. after the user's filter. A
 * filter (unread, starred…) or a deletion can LOWER the top UID; coming back
 * raises it to a UID already seen. Neither is an arrival — only a strictly
 * higher UID in the same scope is.
 *
 *   node --experimental-strip-types scripts/check-notification-arrival.mjs
 */
import assert from 'node:assert/strict'
import { arrival } from '../hooks/useEmailNotifications.ts'

const msg = (uid) => ({ uid: String(uid), from: { address: `${uid}@x` }, subject: `#${uid}` })
const list = (...uids) => uids.map(msg)

let mark = null
let announced = 0
const look = (messages, scope = 'acc|INBOX') => {
  const r = arrival(messages, scope, mark)
  mark = r.mark
  if (r.announce) announced++
  return r.announce
}

// filter 'all' newest=100 → 'unread' newest=90 → back to 'all' newest=100 ⇒ 0 notifications
assert.equal(look(list(98, 100, 99)), null, 'first look is never an arrival')
assert.equal(look([]), null, 'the list is emptied on a filter change')
assert.equal(look(list(90, 85)), null, 'filter lowers the top UID: silent')
assert.equal(look([]), null)
assert.equal(look(list(98, 100, 99)), null, 'back to a UID already seen: silent')
assert.equal(look(list(98, 99)), null, 'newest deleted/moved: silent')
assert.equal(announced, 0, `0 notifications expected across the filter round trip, got ${announced}`)
console.log('  ok  filter all→unread→all and a deletion: 0 notifications')

// newest=101 ⇒ 1, once
assert.equal(look(list(98, 101, 100, 99))?.uid, '101', 'a strictly higher UID is announced')
assert.equal(look(list(98, 101, 100, 99)), null, 'the same list again: announced once')
assert.equal(announced, 1, `exactly 1 notification expected, got ${announced}`)
console.log('  ok  a strictly higher UID is announced exactly once')

// scope change starts over: the first message of the other folder is not new
assert.equal(look(list(5000), 'acc|Sent'), null, 'first look in another scope: silent')
assert.equal(look(list(101), 'acc|INBOX'), null, 'back to INBOX: the watermark was replaced, nothing above it')
assert.equal(announced, 1)
console.log('  ok  a scope change starts over')

console.log('check-notification-arrival: OK')
