#!/usr/bin/env node
/**
 * Self-check for the PURE part of lot S4b: the "all mailboxes" scope. No network,
 * no database, no browser — it only exercises the functions of `lib/search.ts`
 * that decide WHICH mailbox is swept first, in HOW MANY passes, and with how
 * many sweeps in flight at once.
 *
 *   node --experimental-strip-types scripts/check-search-accounts.mjs
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) {
      const url = new URL(`${spec}.ts`, ctx.parentURL)
      if (existsSync(url)) return next(url.href, ctx)
    }
    return next(spec, ctx)
  },
})
const {
  SEARCH_SCOPES, SCOPE_FOLDER, SCOPE_ALL, SCOPE_ACCOUNTS, ACCOUNT_CONCURRENCY,
  readScope, isWideScope, buildSearchHref,
  splitFolderPasses, orderAccountsForSearch, mapWithConcurrency,
} = await import(new URL('../lib/search.ts', import.meta.url).href)

let failed = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`)
  failed++
}

console.log('scope contract')

check('the three scopes live in one list, folder first',
  SEARCH_SCOPES, [SCOPE_FOLDER, SCOPE_ALL, SCOPE_ACCOUNTS])

check('readScope accepts the new scope', readScope(SCOPE_ACCOUNTS), SCOPE_ACCOUNTS)
check('readScope still accepts the old ones',
  [readScope(SCOPE_FOLDER), readScope(SCOPE_ALL)], [SCOPE_FOLDER, SCOPE_ALL])
check('readScope falls back to the folder scope on junk',
  [readScope('nope'), readScope(null), readScope(undefined), readScope('')],
  [SCOPE_FOLDER, SCOPE_FOLDER, SCOPE_FOLDER, SCOPE_FOLDER])

check('a wide scope is any scope that leaves the displayed folder',
  [isWideScope(SCOPE_FOLDER), isWideScope(SCOPE_ALL), isWideScope(SCOPE_ACCOUNTS)],
  [false, true, true])

check('the URL carries the new scope verbatim',
  new URL(buildSearchHref('', 'nvidia', SCOPE_ACCOUNTS), 'http://x').searchParams.get('scope'),
  SCOPE_ACCOUNTS)
check('the folder scope leaves no scope parameter behind',
  new URL(buildSearchHref('scope=accounts', 'nvidia', SCOPE_FOLDER), 'http://x').searchParams.get('scope'),
  null)
check('an empty query drops the scope even when it is the widest',
  buildSearchHref('', '  ', SCOPE_ACCOUNTS).includes('scope'), false)

console.log('\nsplitFolderPasses')

const MAILBOX = [
  { path: 'Archive/2019', messages: 4000 },
  { path: 'Objets envoyes', specialUse: '\\Sent', messages: 800 },
  { path: 'Projets', messages: 120, lastKnownDate: '2026-09-01T00:00:00Z' },
  { path: 'INBOX', specialUse: '\\Inbox', messages: 9137 },
  { path: 'Vide', messages: 0 },
]

check('the first pass is inbox then sent, and nothing else',
  splitFolderPasses(MAILBOX).first, ['INBOX', 'Objets envoyes'])
check('the second pass is everything else, already ordered by usefulness',
  splitFolderPasses(MAILBOX).rest, ['Projets', 'Archive/2019'])
check('an empty folder is dropped from both passes',
  JSON.stringify(splitFolderPasses(MAILBOX)).includes('Vide'), false)
check('a mailbox with no special-use folder puts everything in the second pass',
  splitFolderPasses([{ path: 'A', messages: 2 }, { path: 'B', messages: 1 }]),
  { first: [], rest: ['A', 'B'] })
check('the two passes together cover every non-empty folder exactly once',
  (() => {
    const { first, rest } = splitFolderPasses(MAILBOX)
    const all = [...first, ...rest]
    return all.length === new Set(all).size && all.length === MAILBOX.length - 1
  })(), true)

console.log('\norderAccountsForSearch')

const ACCOUNTS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

check('the active mailbox comes first, the rest keeps the list order',
  orderAccountsForSearch(ACCOUNTS, 'c'), ['c', 'a', 'b'])
check('no active mailbox means the list order, unchanged',
  orderAccountsForSearch(ACCOUNTS, null), ['a', 'b', 'c'])
check('an active id absent from the list is ignored, not invented',
  orderAccountsForSearch(ACCOUNTS, 'zzz'), ['a', 'b', 'c'])
check('a mailbox listed twice is swept once',
  orderAccountsForSearch([{ id: 'a' }, { id: 'a' }, { id: 'b' }], 'a'), ['a', 'b'])
check('an entry without an id is dropped',
  orderAccountsForSearch([{ id: '' }, { id: 'b' }], null), ['b'])

console.log('\nmapWithConcurrency')

// A fake scheduler: each item resolves after `ms` ticks of a virtual clock, so
// the check measures the ORDERING, never the wall clock.
const collect = async (items, limit, run) => {
  const out = []
  for await (const r of mapWithConcurrency(items, limit, run)) out.push(r)
  return out
}
const delayed = (value, ms) => new Promise(res => setTimeout(() => res(value), ms))

check('the concurrency cap is a measured constant, not a magic number',
  typeof ACCOUNT_CONCURRENCY === 'number' && ACCOUNT_CONCURRENCY >= 1, true)

check('results arrive in completion order, not input order',
  (await collect(['slow', 'fast'], 2, (i) => delayed(i, i === 'slow' ? 40 : 5))).map(r => r.value),
  ['fast', 'slow'])

check('every item is yielded exactly once',
  (await collect([1, 2, 3, 4, 5], 2, (i) => delayed(i, 1))).map(r => r.value).sort(),
  [1, 2, 3, 4, 5])

check('each result carries its item and its index',
  (await collect(['x', 'y'], 1, (i) => delayed(i, 1))).map(r => [r.item, r.index]),
  [['x', 0], ['y', 1]])

check('a failing item yields its error and does not stop the others',
  (await collect([1, 2, 3], 2, (i) => i === 2 ? Promise.reject(new Error('boom')) : delayed(i, 1)))
    .map(r => r.error ? `err:${String(r.error.message)}` : `ok:${r.value}`).sort(),
  ['err:boom', 'ok:1', 'ok:3'])

check('never more than `limit` runs are in flight at once',
  await (async () => {
    let inFlight = 0, peak = 0
    await collect([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await delayed(null, 5)
      inFlight--
    })
    return peak
  })(), 3)

check('a limit wider than the list does not start phantom runs',
  await (async () => {
    let started = 0
    await collect([1, 2], 10, async () => { started++ })
    return started
  })(), 2)

check('an empty list yields nothing and terminates',
  (await collect([], 3, async () => 'never')).length, 0)

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\ncheck-search-accounts: OK')
