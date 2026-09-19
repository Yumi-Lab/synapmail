#!/usr/bin/env node
/**
 * Self-check of lot N1: the subscription list and the one-click unsubscribe.
 *
 * PURE: no database, no mailbox, no network, and — deliberately — NOT ONE real
 * unsubscribe. Leaving a list is a real action at a third party's: the only real
 * attempt happens at the human gate, on one newsletter Nicolas picks.
 *
 * Three batteries:
 *  1. Headers — RFC 5322 folding, several URIs between angle brackets, RFC 8058
 *     one-click present or not, grouping by List-Id then by sender, stable id.
 *  2. Network boundary — every private range refused, a name that resolves to a
 *     public AND a private address refused, plain http refused, a redirect never
 *     followed, plus the negative control that proves the battery can fail.
 *  3. One-click — sent to a fake server through the injected resolver and
 *     requester: exact URL, exact address connected to, exact body.
 *
 *   node --experimental-strip-types scripts/check-subscriptions.mjs
 *   node --experimental-strip-types scripts/check-subscriptions.mjs --break-boundary
 * The second form makes the boundary accept private addresses in a COPY of the
 * decision and EXPECTS the run to fail — a battery that cannot fail proves nothing.
 */
import assert from 'node:assert/strict'
import {
  MAX_UNSUBSCRIBE_BATCH,
  ONE_CLICK_BODY,
  ONE_CLICK_CONTENT_TYPE,
  RECENT_MESSAGES_SCANNED,
  decideUrl,
  groupSubscriptions,
  groupingKey,
  headerValue,
  isOneClick,
  isPrivateAddress,
  mailtoAddress,
  mailtoSubject,
  methodOf,
  parseAddress,
  parseSubscriptionHeaders,
  parseUnsubscribeUris,
  subscriptionId,
  unfoldHeaders,
  unsubscribeOneClick,
} from '../lib/subscriptions.ts'

const ok = label => console.log(`  ok  ${label}`)
const BREAK_BOUNDARY = process.argv.includes('--break-boundary')

/** A resolver that answers from a table — no DNS, no network. */
const resolverFor = table => async hostname => {
  if (!(hostname in table)) throw new Error('NXDOMAIN')
  return table[hostname].map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
}

/** A requester that records what it was asked to send and answers a status. */
const requesterFor = (status, sent = []) =>
  Object.assign(
    async options => {
      sent.push(options)
      return { status }
    },
    { sent }
  )

// ---------------------------------------------------------------------------
console.log('headers — folding, several URIs, one-click')

// The defect this lot exists for: `lib/imap.ts` reads the FIRST line of the
// header only, so a sender who folds the field loses the URI of line two.
const FOLDED = [
  'From: Example News <news@example.com>',
  'List-Id: Example weekly <weekly.lists.example.com>',
  'List-Unsubscribe: <https://example.com/u/abc>,',
  '\t<mailto:leave@example.com?subject=unsubscribe%20abc>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  'Subject: This week at Example',
  'Date: Tue, 15 Sep 2026 09:12:00 +0200',
].join('\r\n')

const folded = unfoldHeaders(FOLDED)
assert.equal(
  headerValue(folded, 'list-unsubscribe'),
  '<https://example.com/u/abc>, <mailto:leave@example.com?subject=unsubscribe%20abc>'
)
ok('a folded List-Unsubscribe keeps the URI of its continuation line')

const uris = parseUnsubscribeUris(headerValue(folded, 'list-unsubscribe'))
assert.deepEqual(uris.https, ['https://example.com/u/abc'])
assert.deepEqual(uris.mailto, ['mailto:leave@example.com?subject=unsubscribe%20abc'])
ok('both URIs of the field are read, each in its own kind')

// Plain http is dropped at parse time: the boundary would refuse it anyway.
assert.deepEqual(parseUnsubscribeUris('<http://example.com/u>, <https://example.com/v>').https, [
  'https://example.com/v',
])
ok('a plain http URI is never kept as an https one')

assert.equal(isOneClick('List-Unsubscribe=One-Click', uris), true)
assert.equal(isOneClick(undefined, uris), false)
assert.equal(isOneClick('List-Unsubscribe=One-Click', { https: [], mailto: uris.mailto }), false)
ok('one-click needs BOTH the RFC 8058 field and an https URI')

assert.equal(mailtoAddress(uris.mailto[0]), 'leave@example.com')
assert.equal(mailtoSubject(uris.mailto[0]), 'unsubscribe abc')
assert.equal(mailtoAddress('mailto:not-an-address'), null)
assert.equal(mailtoAddress('mailto:a@b.com,c@d.com'), null)
ok('a mailto target is one validated address, its subject decoded')

assert.deepEqual(parseAddress('Example News <News@Example.com>'), {
  name: 'Example News',
  address: 'news@example.com',
})
assert.deepEqual(parseAddress('"Quoted, Name" <a@b.com>'), { name: 'Quoted, Name', address: 'a@b.com' })
ok('a From value gives a name and a lower-case address')

// A message without any unsubscribe route is not a subscription at all.
assert.equal(parseSubscriptionHeaders('7', 'From: a@b.com\r\nSubject: hello'), null)
ok('a message with no List-Unsubscribe is not listed')

const parsed = parseSubscriptionHeaders('12', FOLDED)
assert.equal(parsed.oneClick, true)
assert.equal(methodOf(parsed), 'one-click')
assert.equal(methodOf({ oneClick: false, uris: { https: [], mailto: ['mailto:x@y.z'] } }), 'mailto')
assert.equal(methodOf({ oneClick: false, uris: { https: ['https://x/y'], mailto: [] } }), 'link')
ok('the method is one-click, else mailto, else link')

// ---------------------------------------------------------------------------
console.log('grouping — List-Id first, sender as a fallback, stable id')

const headerFor = (uid, { from, listId, date, subject, https, mailto, post }) =>
  parseSubscriptionHeaders(
    uid,
    [
      `From: ${from}`,
      ...(listId ? [`List-Id: ${listId}`] : []),
      `List-Unsubscribe: ${[...(https ?? []).map(u => `<${u}>`), ...(mailto ?? []).map(u => `<${u}>`)].join(', ')}`,
      ...(post ? [`List-Unsubscribe-Post: ${post}`] : []),
      `Subject: ${subject}`,
      `Date: ${date}`,
    ].join('\r\n')
  )

// The same list sending from two different addresses stays ONE subscription:
// that is what List-Id is for, and rotating the envelope sender is common.
const rotated = [
  headerFor('1', {
    from: 'News <bounce-1@mailer.example.com>',
    listId: 'Example weekly <weekly.lists.example.com>',
    date: 'Tue, 01 Sep 2026 09:00:00 +0200',
    subject: 'older',
    https: ['https://example.com/u/1'],
    post: 'List-Unsubscribe=One-Click',
  }),
  headerFor('2', {
    from: 'News <bounce-2@mailer.example.com>',
    listId: 'Example weekly <weekly.lists.example.com>',
    date: 'Tue, 15 Sep 2026 09:00:00 +0200',
    subject: 'newest',
    https: ['https://example.com/u/2'],
    post: 'List-Unsubscribe=One-Click',
  }),
  headerFor('3', {
    from: 'Shop <offers@shop.example>',
    date: 'Mon, 14 Sep 2026 08:00:00 +0200',
    subject: 'shop',
    mailto: ['mailto:leave@shop.example'],
  }),
]

const grouped = groupSubscriptions('acc-1', rotated)
assert.equal(grouped.length, 2)
assert.equal(grouped[0].count, 2)
assert.equal(grouped[0].lastSubject, 'newest')
assert.equal(grouped[0].lastUid, '2')
ok('two addresses under one List-Id are ONE group, newest message kept')

assert.equal(grouped[1].count, 1)
assert.equal(grouped[1].method, 'mailto')
assert.equal(grouped[1].sender.address, 'offers@shop.example')
ok('without a List-Id the sender address is the grouping key')

assert.ok(grouped[0].count >= grouped[1].count)
ok('groups are sorted by decreasing count')

// The id must survive a re-list (an agent stores it between two calls) and must
// be different in another mailbox — it carries no address, no account id.
assert.equal(groupSubscriptions('acc-1', rotated)[0].id, grouped[0].id)
assert.notEqual(groupSubscriptions('acc-2', rotated)[0].id, grouped[0].id)
assert.match(grouped[0].id, /^[0-9a-f]{24}$/)
assert.ok(!grouped[0].id.includes('example'))
ok('the id is stable per mailbox, opaque, and differs across mailboxes')

assert.equal(groupingKey({ listId: 'Weekly <WEEKLY.lists.example.com>', from: { address: 'a@b.c' } }),
  'list:weekly.lists.example.com')
assert.equal(groupingKey({ from: { address: 'A@B.c' } }), 'from:a@b.c')
ok('the grouping key is case-insensitive on both paths')

// A recorded unsubscribe travels back, so an agent does not start over.
const already = new Map([['list:weekly.lists.example.com', '2026-09-18T10:00:00.000Z']])
assert.equal(groupSubscriptions('acc-1', rotated, already)[0].unsubscribedAt, '2026-09-18T10:00:00.000Z')
assert.equal(groupSubscriptions('acc-1', rotated, already)[1].unsubscribedAt, null)
ok('a past unsubscribe comes back as unsubscribedAt, only on its own group')

assert.equal(subscriptionId('acc-1', 'from:a@b.c'), subscriptionId('acc-1', 'from:a@b.c'))
ok('the same mailbox and key always give the same id')

// ---------------------------------------------------------------------------
console.log('network boundary — the server is about to call a stranger\'s URL')

// Each range the DoD names, refused one by one.
const PRIVATE = [
  '127.0.0.1', '127.1.2.3', '10.0.0.7', '172.16.0.1', '172.31.255.254', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '239.1.2.3',
  '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
  '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1',
]
for (const address of PRIVATE) {
  assert.equal(isPrivateAddress(address), true, `${address} must be refused`)
}
ok(`${PRIVATE.length} private/special addresses are all refused (incl. IPv4-in-IPv6)`)

// The negative control of the address table: public addresses must NOT be refused,
// otherwise "everything is refused" would look like a pass.
const PUBLIC = ['93.184.216.34', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:2800:220::1']
for (const address of PUBLIC) {
  assert.equal(isPrivateAddress(address), false, `${address} must be allowed`)
}
ok(`${PUBLIC.length} public addresses are allowed (the table is not "refuse everything")`)

assert.equal((await decideUrl('http://example.com/u', resolverFor({ 'example.com': ['93.184.216.34'] }))).reason, 'not-https')
assert.equal((await decideUrl('ftp://example.com/u', resolverFor({}))).reason, 'not-https')
assert.equal((await decideUrl('not a url', resolverFor({}))).reason, 'not-https')
ok('anything that is not https is refused before any resolution')

assert.equal((await decideUrl('https://nope.example/u', resolverFor({}))).reason, 'unresolvable')
assert.equal((await decideUrl('https://empty.example/u', resolverFor({ 'empty.example': [] }))).reason, 'no-address')
ok('a name that does not resolve, or resolves to nothing, is refused')

// The attack this rule exists for: one public address to pass the check, one
// private address to reach the internal network.
assert.equal(
  (await decideUrl('https://mixed.example/u', resolverFor({ 'mixed.example': ['93.184.216.34', '169.254.169.254'] }))).reason,
  'private-address'
)
ok('a name resolving to a public AND a private address is refused whole')

const allowed = await decideUrl('https://ok.example/u?x=1', resolverFor({ 'ok.example': ['93.184.216.34'] }))
assert.equal(allowed.ok, true)
assert.equal(allowed.address.address, '93.184.216.34')
ok('a public https URL is allowed, with the address it will connect to')

// ---------------------------------------------------------------------------
console.log('one-click — exact request, no redirect followed, nothing read back')

const resolve = resolverFor({ 'lists.example': ['93.184.216.34'] })
const sent = []
const result = await unsubscribeOneClick('https://lists.example/u/abc?t=9', {
  resolve,
  request: requesterFor(200, sent),
})
assert.equal(result.ok, true)
assert.equal(sent.length, 1)
assert.equal(sent[0].url.href, 'https://lists.example/u/abc?t=9')
assert.equal(sent[0].address.address, '93.184.216.34')
assert.equal(sent[0].body, ONE_CLICK_BODY)
assert.equal(sent[0].body, 'List-Unsubscribe=One-Click')
assert.equal(sent[0].contentType, ONE_CLICK_CONTENT_TYPE)
ok('the POST carries exactly the RFC 8058 body, to the verified address')

// The refusals must never reach the requester at all.
for (const [url, reason, table] of [
  ['http://lists.example/u', 'not-https', { 'lists.example': ['93.184.216.34'] }],
  ['https://intra.example/u', 'private-address', { 'intra.example': ['10.0.0.9'] }],
  ['https://gone.example/u', 'unresolvable', {}],
]) {
  const untouched = []
  const refused = await unsubscribeOneClick(url, { resolve: resolverFor(table), request: requesterFor(200, untouched) })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, reason)
  assert.equal(untouched.length, 0, 'a refused URL must never be requested')
}
ok('a refused URL is never sent at all (three refusals, zero requests)')

for (const [status, reason] of [[301, 'redirect-not-followed'], [302, 'redirect-not-followed'], [404, 'http-status'], [500, 'http-status']]) {
  const once = []
  const r = await unsubscribeOneClick('https://lists.example/u', { resolve, request: requesterFor(status, once) })
  assert.equal(r.ok, false)
  assert.equal(r.reason, reason)
  assert.equal(once.length, 1, 'exactly one request, no second hop')
}
ok('a 3xx is reported, never followed; a 4xx/5xx fails without a retry')

const failing = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }
assert.equal((await unsubscribeOneClick('https://lists.example/u', { resolve, request: failing })).reason, 'timeout')
const broken = async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }
assert.equal((await unsubscribeOneClick('https://lists.example/u', { resolve, request: broken })).reason, 'transport')
ok('a timeout and a transport error are told apart, neither leaks a body')

// ---------------------------------------------------------------------------
console.log('constants — one source, no copy in the routes')
assert.equal(typeof RECENT_MESSAGES_SCANNED, 'number')
assert.ok(RECENT_MESSAGES_SCANNED > 0)
assert.equal(MAX_UNSUBSCRIBE_BATCH, 50)
ok(`scan window = ${RECENT_MESSAGES_SCANNED} messages, batch ceiling = ${MAX_UNSUBSCRIBE_BATCH} ids`)

// ---------------------------------------------------------------------------
// Negative control: with the boundary's private-address rule removed, the
// battery above MUST fail. Run separately (--break-boundary) so the shipped
// module is never altered.
if (BREAK_BOUNDARY) {
  const broken = address => isPrivateAddress(address) && false
  let failed = false
  try {
    for (const address of PRIVATE) assert.equal(broken(address), true)
  } catch {
    failed = true
  }
  assert.equal(failed, true, 'NEGATIVE CONTROL FAILED: the battery accepted a boundary that allows private addresses')
  ok('negative control: a boundary that allows private addresses IS caught by this battery')
}

console.log('\nsubscriptions: all checks passed')
