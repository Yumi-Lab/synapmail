#!/usr/bin/env node
/**
 * Self-check of lot N6: counting a newsletter's WHOLE history, then moving it
 * to the trash.
 *
 * PURE: no database, no mailbox, no network. The mailbox is injected — a folder
 * list, a header search and a move, all three fakes — so every rule of the lot
 * is measured without a single real message being touched. The rule of the
 * repository is not negotiable here: a bench never modifies a real mailbox, and
 * this one cannot, by construction.
 *
 * What is measured:
 *  1. Criterion — a `List-Id` group searches `list-id`, a bare sender searches
 *     `from`. One identity, the existing `groupingKey`, no second naming.
 *  2. Scope — sent, drafts and trash are never opened; every other folder is.
 *  3. Counting — messages BEYOND the listing window are found (the fake folder
 *     holds more than `RECENT_MESSAGES_SCANNED`), the total and the date bounds
 *     span every folder, and nothing is moved.
 *  4. Purge — every uid found is moved to the trash and to nowhere else; a
 *     neighbouring newsletter is NOT touched (the negative control of the lot);
 *     a wrong `expected` refuses without moving anything; a mailbox with no
 *     trash refuses too.
 *
 *   node --experimental-strip-types scripts/check-subscriptions-history.mjs
 *   node --experimental-strip-types scripts/check-subscriptions-history.mjs --break-scope
 * The second form damages a COPY of the role detection so the trash reads as an
 * ordinary folder — what a server declaring no SPECIAL-USE flag would produce,
 * and the mistake that would make a purge shuffle the trash into itself — and
 * EXPECTS the run to fail: a battery that cannot fail proves nothing.
 */
import assert from 'node:assert/strict'
import {
  HISTORY_EXCLUDED_SPECIALS,
  RECENT_MESSAGES_SCANNED,
  countSubscriptionHistory,
  groupingKey,
  historyCriterion,
  parseSubscriptionHeaders,
  purgeSubscriptionHistory,
  subscriptionId,
} from '../lib/subscriptions.ts'
import { detectSpecials } from '../lib/specialFolders.ts'

const ok = label => console.log(`  ok  ${label}`)
const CRLF = '\r\n'
const BREAK_SCOPE = process.argv.includes('--break-scope')

const ACCOUNT = { id: 'acc-bench' }
const ACCOUNT_ID = 'acc-bench'

/** The mailbox of the bench: roles declared the way a server declares them. */
const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox' },
  { path: 'Archives', name: 'Archives', delimiter: '/', specialUse: '\\Archive' },
  { path: 'Archives/2021', name: '2021', delimiter: '/' },
  { path: 'Sent', name: 'Sent', delimiter: '/', specialUse: '\\Sent' },
  { path: 'Drafts', name: 'Drafts', delimiter: '/', specialUse: '\\Drafts' },
  { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: '\\Trash' },
]

/** Two newsletters seeded side by side. The second one is the negative control. */
const WEEKLY = [
  'From: Example News <news@example.com>',
  'List-Id: Example weekly <weekly.lists.example.com>',
  'List-Unsubscribe: <https://example.com/u/abc>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  'Subject: This week at Example',
  'Date: Tue, 15 Sep 2026 09:12:00 +0200',
].join(CRLF)

const NEIGHBOUR = [
  'From: Other Digest <digest@other.example>',
  'List-Id: Other digest <digest.lists.other.example>',
  'List-Unsubscribe: <https://other.example/u/xyz>',
  'Subject: Other digest',
  'Date: Tue, 15 Sep 2026 10:00:00 +0200',
].join(CRLF)

/** A sender with NO List-Id: the fallback branch of the criterion. */
const BARE = [
  'From: Shop <promo@shop.example>',
  'List-Unsubscribe: <mailto:leave@shop.example>',
  'Subject: Sale',
  'Date: Tue, 15 Sep 2026 11:00:00 +0200',
].join(CRLF)

const headerOf = (raw, uid) => parseSubscriptionHeaders(String(uid), raw)
const LISTED = [headerOf(WEEKLY, 1), headerOf(NEIGHBOUR, 2), headerOf(BARE, 3)]
const WEEKLY_ID = subscriptionId(ACCOUNT_ID, groupingKey(LISTED[0]))
const NEIGHBOUR_ID = subscriptionId(ACCOUNT_ID, groupingKey(LISTED[1]))
const BARE_ID = subscriptionId(ACCOUNT_ID, groupingKey(LISTED[2]))

/**
 * What each folder holds, per header criterion. The weekly list is seeded ABOVE
 * the listing window on purpose: `Archives` alone carries more messages than
 * `RECENT_MESSAGES_SCANNED`, which is precisely what the listing cannot see.
 */
const ARCHIVED = RECENT_MESSAGES_SCANNED + 137
const SEEDED = {
  'list-id:weekly.lists.example.com': {
    INBOX: { uids: ['11', '12'], oldest: '2026-09-01T08:00:00.000Z', newest: '2026-09-15T07:12:00.000Z' },
    Archives: {
      uids: Array.from({ length: ARCHIVED }, (_, i) => String(1000 + i)),
      oldest: '2019-02-03T06:00:00.000Z',
      newest: '2026-08-30T06:00:00.000Z',
    },
    'Archives/2021': { uids: ['7001'], oldest: '2021-05-05T05:00:00.000Z', newest: '2021-05-05T05:00:00.000Z' },
    // Seeded in the folders the scope must NEVER open. If they are read, the
    // total changes and the count assertions below fail.
    Sent: { uids: ['9001'], oldest: '2026-01-01T00:00:00.000Z', newest: '2026-01-01T00:00:00.000Z' },
    Drafts: { uids: ['9002'], oldest: '2026-01-02T00:00:00.000Z', newest: '2026-01-02T00:00:00.000Z' },
    Trash: { uids: ['9003'], oldest: '2026-01-03T00:00:00.000Z', newest: '2026-01-03T00:00:00.000Z' },
  },
  'list-id:digest.lists.other.example': {
    INBOX: { uids: ['21'], oldest: '2026-09-14T08:00:00.000Z', newest: '2026-09-14T08:00:00.000Z' },
    Archives: { uids: ['2001', '2002'], oldest: '2024-01-01T00:00:00.000Z', newest: '2024-06-01T00:00:00.000Z' },
  },
  'from:promo@shop.example': {
    INBOX: { uids: ['31'], oldest: '2026-09-13T08:00:00.000Z', newest: '2026-09-13T08:00:00.000Z' },
  },
}

const WEEKLY_TOTAL = 2 + ARCHIVED + 1

/** A run of the two functions with every mailbox effect recorded. */
function mailbox({ folders = FOLDERS, seeded = SEEDED } = {}) {
  const opened = []
  const moves = []
  return {
    opened,
    moves,
    deps: {
      // The REAL role detection, handed in explicitly: Node's type stripping
      // cannot resolve the module's own extensionless import, and faking the
      // detection would measure the fake instead of the rule.
      specials: detectSpecials,
      folders: async () => folders,
      read: async () => LISTED,
      search: async (_imap, paths, header, value) => {
        opened.push(...paths)
        const table = seeded[`${header}:${value}`] ?? {}
        return paths
          .filter(p => table[p])
          .map(p => ({ folder: p, uids: table[p].uids, oldest: table[p].oldest, newest: table[p].newest }))
      },
      move: async (_imap, folder, uids, destination) => {
        moves.push({ folder, uids, destination })
      },
    },
  }
}

// ---------------------------------------------------------------------------
console.log('criterion — one identity, the one that already exists')

assert.deepEqual(historyCriterion(groupingKey(LISTED[0])), {
  header: 'list-id',
  value: 'weekly.lists.example.com',
})
ok('a group with a List-Id is searched by List-Id, the stable identifier')

assert.deepEqual(historyCriterion(groupingKey(LISTED[2])), {
  header: 'from',
  value: 'promo@shop.example',
})
ok('a group without a List-Id falls back to its sender address')

// The criterion is DERIVED from the grouping key, so an id cannot name one
// newsletter to the list and another one to the purge.
assert.notEqual(WEEKLY_ID, NEIGHBOUR_ID)
assert.notEqual(WEEKLY_ID, BARE_ID)
ok('the three seeded groups have three distinct ids')

// ---------------------------------------------------------------------------
console.log('\nscope — what a cleaning must never open')

assert.deepEqual([...HISTORY_EXCLUDED_SPECIALS].sort(), ['drafts', 'sent', 'trash'])
ok('the excluded roles are exactly the sent, the drafts and the trash')

// ---------------------------------------------------------------------------
console.log('\ncounting — beyond the listing window, and read only')

const counting = mailbox()
const history = await countSubscriptionHistory({
  imap: ACCOUNT,
  accountId: ACCOUNT_ID,
  folder: 'INBOX',
  id: WEEKLY_ID,
  ...counting.deps,
})

assert.deepEqual([...new Set(counting.opened)].sort(), ['Archives', 'Archives/2021', 'INBOX'])
ok('only the folders of the scope are opened — never sent, drafts or trash')

assert.equal(history.total, WEEKLY_TOTAL)
ok(`the count spans every folder of the scope: ${history.total} messages`)

assert.ok(
  history.folders.find(f => f.folder === 'Archives').count > RECENT_MESSAGES_SCANNED,
  'the seeded archive must exceed the listing window, or this arm proves nothing'
)
ok(`one folder alone holds ${ARCHIVED} messages, past the ${RECENT_MESSAGES_SCANNED} the listing reads`)

assert.equal(history.oldest, '2019-02-03T06:00:00.000Z')
assert.equal(history.newest, '2026-09-15T07:12:00.000Z')
ok('the bounds are the oldest and the newest of the WHOLE mailbox, not of one folder')

assert.equal(history.header, 'list-id')
assert.equal(history.value, 'weekly.lists.example.com')
ok('the count answers the criterion it used, so the purge replays the same one')

assert.equal(counting.moves.length, 0)
ok('counting moved nothing: it is read only')

const unknown = await countSubscriptionHistory({
  imap: ACCOUNT,
  accountId: ACCOUNT_ID,
  folder: 'INBOX',
  id: 'f'.repeat(24),
  ...counting.deps,
})
assert.equal(unknown, null)
ok('an id no group of this mailbox produces answers nothing at all')

// ---------------------------------------------------------------------------
console.log('\npurge — to the trash, all of it, and only it')

const purging = mailbox()
const report = await purgeSubscriptionHistory({
  imap: ACCOUNT,
  accountId: ACCOUNT_ID,
  folder: 'INBOX',
  id: WEEKLY_ID,
  expected: WEEKLY_TOTAL,
  ...purging.deps,
})

assert.equal(report.refused, undefined, `the purge refused: ${JSON.stringify(report)}`)
assert.equal(report.moved, WEEKLY_TOTAL)
ok(`every counted message is moved: ${report.moved}`)

assert.deepEqual([...new Set(purging.moves.map(m => m.destination))], ['Trash'])
ok('every move goes to the trash — there is no other destination')

const movedUids = new Set(purging.moves.flatMap(m => m.uids))
assert.equal(movedUids.size, WEEKLY_TOTAL)
for (const folder of ['Sent', 'Drafts', 'Trash']) {
  assert.ok(!purging.moves.some(m => m.folder === folder), `${folder} was used as a source`)
}
ok('nothing is taken from the sent, the drafts or the trash')

// The negative control of the lot: the neighbour seeded alongside is untouched.
const neighbourUids = new Set(
  Object.values(SEEDED['list-id:digest.lists.other.example']).flatMap(f => f.uids)
)
for (const uid of neighbourUids) {
  assert.ok(!movedUids.has(uid), `a message of the OTHER newsletter was moved: uid ${uid}`)
}
ok('the newsletter seeded next to it is not touched — not one of its messages moves')

// ---------------------------------------------------------------------------
console.log('\nrefusals — never more than what was seen')

const stale = mailbox()
const refused = await purgeSubscriptionHistory({
  imap: ACCOUNT,
  accountId: ACCOUNT_ID,
  folder: 'INBOX',
  id: WEEKLY_ID,
  expected: WEEKLY_TOTAL - 1,
  ...stale.deps,
})
assert.equal(refused.refused, 'count_changed')
assert.equal(refused.total, WEEKLY_TOTAL)
assert.equal(stale.moves.length, 0)
ok('a total that no longer matches refuses, says the new one, and moves nothing')

const noTrash = mailbox({ folders: FOLDERS.filter(f => f.specialUse !== '\\Trash') })
const refusedTrash = await purgeSubscriptionHistory({
  imap: ACCOUNT,
  accountId: ACCOUNT_ID,
  folder: 'INBOX',
  id: WEEKLY_ID,
  expected: WEEKLY_TOTAL,
  ...noTrash.deps,
})
assert.equal(refusedTrash.refused, 'no_trash')
assert.equal(noTrash.moves.length, 0)
ok('a mailbox without a trash refuses rather than deleting anything')

const gone = mailbox()
const refusedId = await purgeSubscriptionHistory({
  imap: ACCOUNT,
  accountId: ACCOUNT_ID,
  folder: 'INBOX',
  id: 'f'.repeat(24),
  expected: 1,
  ...gone.deps,
})
assert.equal(refusedId.refused, 'not_found')
assert.equal(gone.moves.length, 0)
ok('an unknown id refuses and moves nothing')

// ---------------------------------------------------------------------------
if (BREAK_SCOPE) {
  console.log('\nnegative control — a trash not recognised as one IS caught')
  // The exclusion is by ROLE, not by folder name: handing the trash in the
  // folder list changes nothing, because `detectSpecials` still calls it a
  // trash. So the damage is applied where the rule actually rests — a COPY of
  // the role detection that reports the trash as an ordinary folder, which is
  // exactly what a server declaring no SPECIAL-USE flag and a name the matcher
  // misses would produce. The purge would then take messages OUT of the trash
  // and put them back into it, and the count would include messages already
  // thrown away.
  const blind = mailbox()
  const damaged = await countSubscriptionHistory({
    imap: ACCOUNT,
    accountId: ACCOUNT_ID,
    folder: 'INBOX',
    id: WEEKLY_ID,
    ...blind.deps,
    specials: folders => {
      const real = detectSpecials(folders)
      return new Map([...real].map(([path, role]) => [path, role === 'trash' ? null : role]))
    },
  })
  assert.ok(
    blind.opened.includes('Trash'),
    'NEGATIVE CONTROL FAILED: the damaged detection did not even open the trash'
  )
  assert.notEqual(
    damaged.total,
    WEEKLY_TOTAL,
    'NEGATIVE CONTROL FAILED: a trash read as an ordinary folder did NOT change the count, so this battery proves nothing'
  )
  ok(`negative control: an unrecognised trash IS caught (${damaged.total} instead of ${WEEKLY_TOTAL})`)
  console.error('\ncheck-subscriptions-history: --break-scope ran to the end, as expected')
  process.exit(1)
}

console.log('\ncheck-subscriptions-history: OK (no mailbox opened, no message moved)')
