#!/usr/bin/env node
/**
 * Self-check of the attachment trust boundary (lot M9), with no database, no
 * mailbox, no network and no browser: `lib/attachments.ts` decides ALONE what
 * `POST /api/messages/send` accepts, so it can be executed alone.
 *
 * Three questions, all raised by the fact that the caller is an AGENT holding
 * an API key — every byte below comes from the network:
 *  1. can a hand-written `filename` name a PATH (`../../etc/passwd`)?
 *  2. can a broken `content` reach the recipient SILENTLY truncated?
 *     (`Buffer.from(x, 'base64')` never complains: it drops what it cannot read.)
 *  3. is every ceiling NAMED in the refusal, or does the caller only get a 413?
 *
 * Plus the wiring itself: the route must FEED the existing `attachments` array
 * that already carries forwarded `.eml` messages, not open a second path to
 * `sendMail`.
 *
 *   node --experimental-strip-types scripts/check-send-attachments.mjs
 *   node --experimental-strip-types scripts/check-send-attachments.mjs --break=path
 *   node --experimental-strip-types scripts/check-send-attachments.mjs --break=base64
 *   node --experimental-strip-types scripts/check-send-attachments.mjs --break=total
 *   node --experimental-strip-types scripts/check-send-attachments.mjs --break=wiring
 * The `--break` forms damage ONE expectation and EXPECT the run to fail: a
 * battery that cannot fail proves nothing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTACHMENT_DEFAULT_CONTENT_TYPE,
  ATTACHMENT_ERROR,
  ATTACHMENT_FALLBACK_NAME,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_NAME_LENGTH,
  MESSAGE_MAX_TOTAL_BYTES,
  base64DecodedSize,
  checkTotalSize,
  parseAttachments,
  safeAttachmentName,
} from '../lib/attachments.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BREAK = (process.argv.find(a => a.startsWith('--break=')) ?? '').slice('--break='.length)
const ok = label => console.log(`  ok  ${label}`)
const b64 = s => Buffer.from(s).toString('base64')

console.log('safeAttachmentName — a name is a NAME, never a path')

for (const [raw, why] of [
  ['../../etc/passwd', 'a relative path escaping upwards'],
  ['/etc/passwd', 'an absolute path'],
  ['..\\..\\windows\\system32\\cmd.exe', 'a Windows path'],
  ['....//....//secret.txt', 'doubled-up traversal'],
  ['.hidden', 'a leading dot'],
]) {
  const name = safeAttachmentName(raw)
  const traversal = BREAK === 'path' ? /NEVER-MATCHES/ : /[/\\]|\.\./
  assert.ok(!traversal.test(name), `${why}: "${raw}" still yields a path as "${name}"`)
  assert.ok(name.length > 0, `${why}: a name must never come out empty`)
  ok(`"${raw}" becomes "${name}"`)
}

assert.equal(safeAttachmentName(''), ATTACHMENT_FALLBACK_NAME)
assert.equal(safeAttachmentName('   '), ATTACHMENT_FALLBACK_NAME)
assert.equal(safeAttachmentName(42), ATTACHMENT_FALLBACK_NAME)
assert.equal(safeAttachmentName(null), ATTACHMENT_FALLBACK_NAME)
ok(`nothing usable left → "${ATTACHMENT_FALLBACK_NAME}"`)

const long = safeAttachmentName(`${'a'.repeat(400)}.pdf`)
assert.ok(long.length <= ATTACHMENT_MAX_NAME_LENGTH, 'a name is bounded')
ok(`a 404-character name is cut to ${long.length} (ceiling ${ATTACHMENT_MAX_NAME_LENGTH})`)

assert.equal(safeAttachmentName('rapport final.pdf'), 'rapport final.pdf')
assert.equal(safeAttachmentName('facture-2026.pdf'), 'facture-2026.pdf')
ok('an ordinary name goes through untouched')

console.log('parseAttachments — what the boundary refuses')

const one = { filename: 'note.txt', contentType: 'text/plain', content: b64('hello') }
const good = parseAttachments([one])
assert.equal(good.ok, true)
assert.equal(good.value.length, 1)
assert.equal(good.value[0].filename, 'note.txt')
assert.equal(good.value[0].contentType, 'text/plain')
assert.equal(good.value[0].content.toString(), 'hello')
ok('a plain attachment passes, decoded byte for byte')

for (const [label, body] of [
  ['an empty list', []],
  ['a bare object instead of a list', { filename: 'a', content: b64('x') }],
  ['null', null],
  ['a string', 'note.txt'],
  ['a missing filename', [{ content: b64('x') }]],
  ['a blank filename', [{ filename: '   ', content: b64('x') }]],
  ['a missing content', [{ filename: 'a.txt' }]],
  ['an empty content', [{ filename: 'a.txt', content: '' }]],
  ['a non-string content', [{ filename: 'a.txt', content: 123 }]],
  ['a nested list', [['a.txt', b64('x')]]],
]) {
  const r = parseAttachments(body)
  assert.equal(r.ok, false, label)
  assert.equal(r.status, 400)
  assert.equal(r.code, ATTACHMENT_ERROR.invalid)
  ok(`400 on ${label}`)
}

// `Buffer.from(x,'base64')` NEVER throws: it silently drops what it cannot read.
// Without this check the recipient would get a truncated file and no warning.
for (const [label, content] of [
  ['plain text mistaken for base64', 'hello world!'],
  ['a character outside the alphabet', `${b64('hello')}$$$`],
  ['a length that is not a multiple of 4', 'aGVsbG8'],
  ['padding in the middle', 'aGV=sbG8='],
  ['a data: URL pasted whole', 'data:text/plain;base64,aGVsbG8='],
]) {
  const r = parseAttachments([{ filename: 'a.txt', content }])
  const expected = BREAK === 'base64' ? ATTACHMENT_ERROR.invalid : ATTACHMENT_ERROR.badBase64
  assert.equal(r.ok, false, label)
  assert.equal(r.code, expected, `${label}: got ${r.code}`)
  assert.equal(r.status, 400)
  assert.equal(r.detail, 'a.txt', 'the refusal names the file it is about')
  ok(`400 on ${label}, naming "${r.detail}"`)
}

// Base64 written in RFC 2045 columns is legitimate — a file exported by most
// tools arrives wrapped, and refusing it would refuse ordinary attachments.
const wrapped = parseAttachments([{ filename: 'a.txt', content: b64('x'.repeat(200)).replace(/(.{76})/g, '$1\n') }])
assert.equal(wrapped.ok, true, 'base64 in columns must be accepted')
assert.equal(wrapped.value[0].content.length, 200)
ok('base64 wrapped at 76 columns is accepted and decodes whole')

console.log('parseAttachments — the ceilings, each NAMED in its refusal')

const tooMany = parseAttachments(Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, i) => ({
  filename: `f${i}.txt`,
  content: b64('x'),
})))
assert.equal(tooMany.ok, false)
assert.equal(tooMany.code, ATTACHMENT_ERROR.tooMany)
assert.equal(tooMany.limit, ATTACHMENT_MAX_COUNT, 'the count ceiling travels with the refusal')
ok(`400 past ${ATTACHMENT_MAX_COUNT} attachments, and the limit travels with the refusal`)

const atCount = parseAttachments(Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, i) => ({
  filename: `f${i}.txt`,
  content: b64('x'),
})))
assert.equal(atCount.ok, true, 'exactly the ceiling must still pass')
ok(`exactly ${ATTACHMENT_MAX_COUNT} attachments still pass (the ceiling is inclusive)`)

// The size is judged on the base64 BEFORE decoding: an oversized attachment
// must be refused without ever being allocated.
const oversizedB64 = 'A'.repeat(Math.ceil(((ATTACHMENT_MAX_BYTES + 1024) / 3) * 4 / 4) * 4)
assert.ok(base64DecodedSize(oversizedB64) > ATTACHMENT_MAX_BYTES)
const tooLarge = parseAttachments([{ filename: 'huge.bin', content: oversizedB64 }])
assert.equal(tooLarge.ok, false)
assert.equal(tooLarge.code, ATTACHMENT_ERROR.tooLarge)
assert.equal(tooLarge.status, 413)
assert.equal(tooLarge.limit, ATTACHMENT_MAX_BYTES, 'the per-file ceiling travels with the refusal')
assert.equal(tooLarge.detail, 'huge.bin')
ok(`413 past ${ATTACHMENT_MAX_BYTES} bytes for one file, naming "${tooLarge.detail}" and its ceiling`)

assert.equal(base64DecodedSize(b64('hello')), 5, 'the announced size matches the real one (1 pad)')
assert.equal(base64DecodedSize(b64('hell')), 4, 'the announced size matches the real one (2 pads)')
assert.equal(base64DecodedSize(b64('hel')), 3, 'the announced size matches the real one (no pad)')
ok('the announced size equals the decoded size, with 0, 1 and 2 padding characters')

console.log('checkTotalSize — the ceiling of the MESSAGE, forwarded messages included')

const big = n => ({ filename: 'x.bin', content: Buffer.alloc(n), contentType: 'application/octet-stream' })
const under = checkTotalSize([big(1024), big(2048)])
assert.equal(under.ok, true)
assert.equal(under.value, 3072, 'the total is the sum of the decoded sizes')
ok('a small message passes, and the total is the sum of the decoded sizes')

const overTotal = BREAK === 'total'
  ? checkTotalSize([big(1)])
  : checkTotalSize([big(MESSAGE_MAX_TOTAL_BYTES - 10), big(1024)])
assert.equal(overTotal.ok, false, 'past the total ceiling the message must be refused')
assert.equal(overTotal.code, ATTACHMENT_ERROR.messageTooLarge)
assert.equal(overTotal.status, 413)
assert.equal(overTotal.limit, MESSAGE_MAX_TOTAL_BYTES, 'the total ceiling travels with the refusal')
ok(`413 past ${MESSAGE_MAX_TOTAL_BYTES} bytes for the whole message, naming its ceiling`)

// The total ceiling must sit BELOW what the SMTP provider accepts once the
// bytes are re-encoded in base64 (+1/3). IONOS refuses past 25 MB.
const IONOS_LIMIT = 25 * 1000 * 1000
assert.ok(
  MESSAGE_MAX_TOTAL_BYTES * (4 / 3) < IONOS_LIMIT,
  `${MESSAGE_MAX_TOTAL_BYTES} decoded bytes become ${Math.round(MESSAGE_MAX_TOTAL_BYTES * 4 / 3)} on the wire, above IONOS's ${IONOS_LIMIT}`,
)
assert.ok(ATTACHMENT_MAX_BYTES <= MESSAGE_MAX_TOTAL_BYTES, 'one file can never exceed the whole message')
ok(`${MESSAGE_MAX_TOTAL_BYTES} decoded → ${Math.round(MESSAGE_MAX_TOTAL_BYTES * 4 / 3)} on the wire, under IONOS's ${IONOS_LIMIT}`)

console.log('contentType — a default that is never a guess')

for (const [label, contentType] of [
  ['absent', undefined],
  ['a number', 12],
  ['a bare word', 'pdf'],
  ['a header injection', 'text/plain\r\nBcc: victim@example.com'],
  ['an empty string', ''],
]) {
  const r = parseAttachments([{ filename: 'a.bin', content: b64('x'), contentType }])
  assert.equal(r.ok, true, label)
  assert.equal(r.value[0].contentType, ATTACHMENT_DEFAULT_CONTENT_TYPE, `${label} must fall back`)
  ok(`${label} → ${ATTACHMENT_DEFAULT_CONTENT_TYPE}`)
}

for (const valid of ['application/pdf', 'image/png', 'text/csv; charset=utf-8']) {
  const r = parseAttachments([{ filename: 'a', content: b64('x'), contentType: valid }])
  assert.equal(r.value[0].contentType, valid, `${valid} must be kept`)
  ok(`"${valid}" is kept as announced`)
}

console.log('the route FEEDS the existing array — no second path to sendMail')

const route = readFileSync(join(ROOT, 'app/api/messages/send/route.ts'), 'utf8')
const routeSource = BREAK === 'wiring' ? route.replace(/parseAttachments/g, 'somethingElse') : route

assert.ok(routeSource.includes('parseAttachments'), 'the route must validate through lib/attachments.ts')
assert.ok(routeSource.includes('checkTotalSize'), 'the route must apply the ceiling of the whole message')
// ONE `sendMail` call, ONE `attachments` argument: forwarded messages and
// request attachments must converge, or one of the two would escape the ceiling.
assert.equal((routeSource.match(/await sendMail\(/g) ?? []).length, 1, 'exactly one send path')
assert.equal((routeSource.match(/let attachments\b/g) ?? []).length, 1, 'exactly one attachments array')
assert.ok(
  /attachments = \[\.\.\.\(attachments \?\? \[\]\), \.\.\.parsed\.value\]/.test(routeSource),
  'request attachments must JOIN the forwarded ones, not replace them',
)
ok('one array, one sendMail call: both kinds of attachment share the same ceiling')

const docs = readFileSync(join(ROOT, 'docs/API.md'), 'utf8')
for (const named of [String(ATTACHMENT_MAX_COUNT), String(ATTACHMENT_MAX_BYTES), String(MESSAGE_MAX_TOTAL_BYTES)]) {
  assert.ok(docs.includes(named), `docs/API.md must name the ceiling ${named}`)
}
for (const code of Object.values(ATTACHMENT_ERROR)) {
  assert.ok(docs.includes(code), `docs/API.md must document the refusal code ${code}`)
}
ok('docs/API.md names every ceiling and every refusal code')

if (BREAK) {
  console.error(`check-send-attachments: --break=${BREAK} was expected to FAIL and did not`)
  process.exit(1)
}
console.log('check-send-attachments: OK')
