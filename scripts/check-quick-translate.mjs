#!/usr/bin/env node
/**
 * Self-check of the PURE half of the quick translation (`lib/quickTranslate.ts`):
 * how a message is cut up, what URL is built, and how an answer is read.
 *
 * No network, no server, no browser: the file under test is imported directly and
 * the fetch is injected, so a drift fails HERE rather than against a third-party
 * service that may be blocking us that day.
 *
 *   node --experimental-strip-types scripts/check-quick-translate.mjs
 *   node --experimental-strip-types scripts/check-quick-translate.mjs --negative
 *
 * `--negative` re-runs the cutting checks against a DELIBERATELY broken splitter
 * (a blind slice, the naive implementation) and demands they go RED — a bench that
 * cannot fail proves nothing.
 */
const NEGATIVE = process.argv.includes('--negative')

const {
  splitForTranslation, quickTranslateUrl, readTranslateResponse, quickTranslate,
  QUICK_TRANSLATE_CHUNK, QUICK_TRANSLATE_ENDPOINT,
  TRANSLATE_MODES, TRANSLATE_MODE_DEFAULT, TRANSLATE_MODE_LABEL, asTranslateMode,
  TRANSLATE_QUICK, TRANSLATE_MODEL, TRANSLATE_OFF,
} = await import(new URL('../lib/quickTranslate.ts', import.meta.url).href)

let failed = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`); return true }
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`)
  failed++
  return false
}
const throws = (label, fn) => {
  try { fn() } catch { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}\n       expected a throw, got a value`)
  failed++
}

/** The naive splitter the real one replaces: slices blindly, mid-word. */
const blindSplit = (text, limit = QUICK_TRANSLATE_CHUNK) => {
  const out = []
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit))
  return out
}
const split = NEGATIVE ? blindSplit : splitForTranslation

// A long text whose cut points are sentence ends AND line breaks, with a blank
// line every few sentences — a message, not one endless run.
const sentence = 'The invoice for the printer is attached to this message. '
const paragraph = sentence.repeat(6) + '\n\n'
const long = paragraph.repeat(Math.ceil(12000 / paragraph.length)).slice(0, 12000)

console.log(`splitting${NEGATIVE ? ' (NEGATIVE control — these must go red)' : ''}`)
check('short text stays one piece', split('Hello.'), ['Hello.'])
check('empty text yields nothing', split(''), [])
check('a text right at the ceiling is not cut', split('x'.repeat(QUICK_TRANSLATE_CHUNK)).length, 1)
check('every piece stays under the ceiling', split(long).every(c => c.length <= QUICK_TRANSLATE_CHUNK), true)
check('a 12 000-char text is cut', split(long).length > 1, true)
check('the pieces recombine into the input, byte for byte', split(long).join(''), long)
check('no piece starts or ends mid-word', split(long).every((c, i, all) =>
  i === all.length - 1 || /[\s.!?]$/.test(c)), true)
check('line breaks survive the cut', split(long).join('').includes('\n'), true)

const noBoundary = 'x'.repeat(QUICK_TRANSLATE_CHUNK * 2 + 17)
check('an unbroken run longer than the ceiling is still cut, not dropped',
  split(noBoundary).join(''), noBoundary)
check('an unbroken run keeps every piece under the ceiling',
  split(noBoundary).every(c => c.length <= QUICK_TRANSLATE_CHUNK), true)

if (NEGATIVE) {
  if (failed > 0) {
    console.log(`\ncheck-quick-translate --negative: OK (${failed} check(s) went red, as demanded)`)
    process.exit(0)
  }
  console.error('\nFAIL: the negative control passed — the bench cannot tell the two splitters apart')
  process.exit(1)
}

console.log('the url')
const url = new URL(quickTranslateUrl('Bonjour le monde', 'en'))
check('the endpoint is the single source', `${url.origin}${url.pathname}`, QUICK_TRANSLATE_ENDPOINT)
check('the target language is carried', url.searchParams.get('tl'), 'en')
check('the source language is detected, never guessed here', url.searchParams.get('sl'), 'auto')
check('the text travels encoded, unaltered', url.searchParams.get('q'), 'Bonjour le monde')
check('a text with & and = survives the encoding',
  new URL(quickTranslateUrl('a&b=c d', 'fr')).searchParams.get('q'), 'a&b=c d')

console.log('reading the answer')
check('the segments are concatenated in order',
  readTranslateResponse([[['Bonjour, ', 'Hello, '], ['ceci est un test.', 'this is a test.']]]),
  'Bonjour, ceci est un test.')
check('a single segment reads as itself', readTranslateResponse([[['Bonjour.', 'Hello.']]]), 'Bonjour.')
throws('an HTML block page is an error, never a half translation',
  () => readTranslateResponse('<html>Sorry...</html>'))
throws('an empty answer is an error', () => readTranslateResponse(null))
throws('a shape change is an error, never a silent empty string',
  () => readTranslateResponse([[[42]]]))

console.log('the whole path')
const calls = []
const fakeFetch = async (u) => {
  calls.push(u)
  const q = new URL(u).searchParams.get('q')
  return [[[`[${q.length}]`, q]]]
}
const translated = await quickTranslate(long, 'fr', fakeFetch)
check('one call per piece', calls.length, splitForTranslation(long).length)
check('every call names the same target language',
  calls.every(u => new URL(u).searchParams.get('tl') === 'fr'), true)
check('the pieces come back in the order they were cut',
  translated, splitForTranslation(long).map(c => `[${c.length}]`).join(''))
check('an empty message makes no call at all', (await quickTranslate('', 'fr', async () => {
  throw new Error('no call expected')
})), '')

console.log('the setting')
check('three modes, in the order the screen offers them',
  [...TRANSLATE_MODES], [TRANSLATE_QUICK, TRANSLATE_MODEL, TRANSLATE_OFF])
check('quick translation is the default', TRANSLATE_MODE_DEFAULT, TRANSLATE_QUICK)
check('every mode has its label key', TRANSLATE_MODES.every(m => !!TRANSLATE_MODE_LABEL[m]), true)
check('an unknown value falls back to the default', asTranslateMode('nonsense'), TRANSLATE_MODE_DEFAULT)
check('a missing value falls back to the default', asTranslateMode(undefined), TRANSLATE_MODE_DEFAULT)
check('a known value is kept as-is', asTranslateMode(TRANSLATE_OFF), TRANSLATE_OFF)

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\ncheck-quick-translate: OK')
