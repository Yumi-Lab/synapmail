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
  ACCOUNTS_SWEEP_BUDGET_MS, SWEEP_STOP_BUDGET, SWEEP_STOP_REASONS, SWEEP_STOP_UNREACHABLE,
  readScope, isWideScope, buildSearchHref,
  splitFolderPasses, orderAccountsForSearch, mergeGenerators, sweepCompleteness,
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

console.log('\nmergeGenerators')

const delayed = (value, ms) => new Promise(res => setTimeout(() => res(value), ms))
const collect = async (sources, limit) => {
  const out = []
  for await (const v of mergeGenerators(sources, limit)) out.push(v)
  return out
}
// A source that yields its items after a delay, and records that it was OPENED.
const source = (items, ms, opened) => () => (async function* () {
  opened?.push(items[0])
  for (const i of items) { await delayed(null, ms); yield i }
})()

check('the concurrency cap is a measured constant, not a magic number',
  typeof ACCOUNT_CONCURRENCY === 'number' && ACCOUNT_CONCURRENCY >= 1, true)

check('items arrive in completion order, not source order',
  await collect([source(['slow'], 40), source(['fast'], 5)], 2),
  ['fast', 'slow'])

check('every item of every source is yielded exactly once',
  (await collect([source([1, 2], 1), source([3], 1), source([4, 5], 1)], 2)).sort(),
  [1, 2, 3, 4, 5])

check('a source is only OPENED when a slot frees up',
  await (async () => {
    const opened = []
    const sources = [source([1], 20, opened), source([2], 20, opened), source([3], 20, opened)]
    const it = mergeGenerators(sources, 1)
    await it.next()
    const afterFirst = opened.length
    // eslint-disable-next-line no-empty
    for await (const _ of it) {}
    return [afterFirst, opened.length]
  })(), [1, 3])

check('a source that throws stops alone and the others complete',
  (await collect([
    source([1], 1),
    () => (async function* () { throw new Error('boom') })(),
    source([3], 1),
  ], 3)).sort(),
  [1, 3])

check('a source that throws MID-stream keeps what it already yielded',
  (await collect([
    () => (async function* () { yield 'a'; throw new Error('boom') })(),
    source(['b'], 1),
  ], 2)).sort(),
  ['a', 'b'])

check('never more than `limit` sources are open at once',
  await (async () => {
    let open = 0, peak = 0
    const busy = () => (async function* () {
      open++; peak = Math.max(peak, open)
      await delayed(null, 5); yield 1
      open--
    })()
    await collect(Array.from({ length: 7 }, () => busy), 3)
    return peak
  })(), 3)

check('a limit wider than the list does not open phantom sources',
  await (async () => {
    let opened = 0
    await collect([1, 2].map(() => () => (async function* () { opened++; yield 1 })()), 10)
    return opened
  })(), 2)

check('an empty list yields nothing and terminates',
  (await collect([], 3)).length, 0)

check('abandoning the merge closes every open source',
  await (async () => {
    const closed = []
    const closeable = name => () => (async function* () {
      try { for (;;) { await delayed(null, 2); yield name } } finally { closed.push(name) }
    })()
    const it = mergeGenerators([closeable('a'), closeable('b')], 2)
    await it.next()
    await it.return(undefined)
    await delayed(null, 20)
    return closed.sort()
  })(), ['a', 'b'])


// ── Lot S11 : un balayage dit jusqu'où il est allé, et pourquoi il s'est arrêté ──
// Le défaut corrigé : `scope=accounts` SANS flux rendait 200 avec 0 résultat sans
// jamais dire qu'il n'avait cherché que dans un dossier. `sweepCompleteness` est la
// fonction PURE qui répond à cette question ; ce sont ses cas limites.

console.log('\nsweep completeness')

/** Un balayage COMPLET : la référence de tous les cas d'arrêt ci-dessous. */
const fullSweep = { searched: 12, folders: 12, sweptAccounts: 3, accounts: 3, unreachable: [], budgetExhausted: false }

check('a sweep that covered every folder of every mailbox is complete',
  sweepCompleteness(fullSweep), { complete: true, reasons: [] })

check('the time budget running out is named, not hidden',
  sweepCompleteness({ ...fullSweep, budgetExhausted: true }),
  { complete: false, reasons: [SWEEP_STOP_BUDGET] })

check('folders left uncovered say so even without the budget flag',
  sweepCompleteness({ ...fullSweep, searched: 4 }),
  { complete: false, reasons: [SWEEP_STOP_BUDGET] })

check('an unreachable mailbox is named even when every known folder was covered',
  sweepCompleteness({ ...fullSweep, sweptAccounts: 2, unreachable: ['b@x.test'] }),
  { complete: false, reasons: [SWEEP_STOP_UNREACHABLE] })

// Les raisons CUMULENT : inventer une précédence cacherait l'une des deux.
check('both reasons are reported together, neither shadows the other',
  sweepCompleteness({ ...fullSweep, searched: 4, budgetExhausted: true, unreachable: ['b@x.test'] }),
  { complete: false, reasons: [SWEEP_STOP_BUDGET, SWEEP_STOP_UNREACHABLE] })

// Contrôle négatif du piège : une boîte dont TOUS les dossiers sont vides ne
// rapporte aucun morceau, donc n'apparaît pas dans `sweptAccounts` — et elle est
// pourtant ENTIÈREMENT couverte. La lire comme injoignable serait un faux arrêt.
check('a mailbox that reported nothing because it holds nothing is not an incident',
  sweepCompleteness({ ...fullSweep, sweptAccounts: 1 }), { complete: true, reasons: [] })

// Aucune boîte accessible : rien à balayer, et c'est complet — pas un arrêt.
check('no mailbox to sweep is a complete sweep, not a stop',
  sweepCompleteness({ searched: 0, folders: 0, sweptAccounts: 0, accounts: 0, unreachable: [], budgetExhausted: false }),
  { complete: true, reasons: [] })

check('the stop reasons live in one list, so the route and the doc cannot drift',
  SWEEP_STOP_REASONS, [SWEEP_STOP_BUDGET, SWEEP_STOP_UNREACHABLE])

// Le plafond de temps est une valeur MESURÉE, pas un réglage libre : il doit rester
// au-dessus du constat de production du lot S11 (26,7 s pour une seule boîte) et
// sous le délai d'un mandataire inverse (60 s), sinon il ne protège plus personne.
check('the sweep budget stays between the measured worst mailbox and a proxy timeout',
  ACCOUNTS_SWEEP_BUDGET_MS > 26700 && ACCOUNTS_SWEEP_BUDGET_MS < 60000, true)

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\ncheck-search-accounts: OK')
