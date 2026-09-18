#!/usr/bin/env node
/**
 * Self-check for the PURE part of lot S2: the order in which a progressive
 * "all folders" search opens the folders. No network, no database.
 *
 *   node --experimental-strip-types scripts/check-search-order.mjs
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
const { orderFoldersForSearch, parseNdjsonChunk } = await import(new URL('../lib/search.ts', import.meta.url).href)

let failed = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`)
  failed++
}

console.log('orderFoldersForSearch')

check('inbox comes first, sent second, whatever the input order',
  orderFoldersForSearch([
    { path: 'Archive', messages: 900 },
    { path: 'Sent', specialUse: '\\Sent', messages: 10 },
    { path: 'INBOX', specialUse: '\\Inbox', messages: 5 },
  ]),
  ['INBOX', 'Sent', 'Archive'])

check('a folder with no message at all is never opened',
  orderFoldersForSearch([
    { path: 'Empty', messages: 0 },
    { path: 'Full', messages: 3 },
  ]),
  ['Full'])

check('an unknown message count is kept (only a measured zero excludes)',
  orderFoldersForSearch([{ path: 'Unknown' }, { path: 'Empty', messages: 0 }]),
  ['Unknown'])

check('among plain folders, the freshest known message wins over the biggest',
  orderFoldersForSearch([
    { path: 'Big archive', messages: 5000, lastKnownDate: '2019-01-01T00:00:00Z' },
    { path: 'Small but live', messages: 12, lastKnownDate: '2026-09-01T00:00:00Z' },
  ]),
  ['Small but live', 'Big archive'])

check('with no date known anywhere, the biggest folder goes first',
  orderFoldersForSearch([
    { path: 'Small', messages: 3 },
    { path: 'Big', messages: 300 },
  ]),
  ['Big', 'Small'])

check('a dated folder outranks an undated one',
  orderFoldersForSearch([
    { path: 'Undated', messages: 900 },
    { path: 'Dated', messages: 2, lastKnownDate: '2026-01-01T00:00:00Z' },
  ]),
  ['Dated', 'Undated'])

check('an unparsable date is treated as unknown, not as now',
  orderFoldersForSearch([
    { path: 'Broken', messages: 2, lastKnownDate: 'not a date' },
    { path: 'Dated', messages: 2, lastKnownDate: '2020-01-01T00:00:00Z' },
  ]),
  ['Dated', 'Broken'])

check('ties break on the path, so the order is stable across runs',
  orderFoldersForSearch([{ path: 'b', messages: 5 }, { path: 'a', messages: 5 }]),
  ['a', 'b'])

check('the input array is not mutated',
  (() => {
    const input = [{ path: 'b', messages: 1 }, { path: 'a', messages: 1 }]
    orderFoldersForSearch(input)
    return input.map(f => f.path)
  })(),
  ['b', 'a'])

check('no folder at all yields no folder', orderFoldersForSearch([]), [])

console.log('parseNdjsonChunk')

check('a whole line yields its object and leaves nothing pending',
  parseNdjsonChunk('', '{"folder":"INBOX","total":3}\n'),
  { items: [{ folder: 'INBOX', total: 3 }], pending: '' })

check('a truncated line is held back until its end arrives',
  parseNdjsonChunk('', '{"folder":"INBOX"}\n{"fol'),
  { items: [{ folder: 'INBOX' }], pending: '{"fol' })

check('the held-back start is joined to the next chunk',
  parseNdjsonChunk('{"fol', 'der":"Sent"}\n'),
  { items: [{ folder: 'Sent' }], pending: '' })

check('several lines in one chunk come out in order',
  parseNdjsonChunk('', '{"n":1}\n{"n":2}\n{"n":3}\n').items,
  [{ n: 1 }, { n: 2 }, { n: 3 }])

check('blank lines are skipped, not turned into objects',
  parseNdjsonChunk('', '\n\n{"n":1}\n').items, [{ n: 1 }])

check('a line cut mid-stream is dropped rather than throwing',
  parseNdjsonChunk('', '{"broken\n{"n":1}\n').items, [{ n: 1 }])

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\ncheck-search-order: OK')
