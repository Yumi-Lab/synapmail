#!/usr/bin/env node
/**
 * Self-check of lot N3: `docs/API.md` cannot drift away from the routes it describes.
 *
 * PURE: no database, no mailbox, no network, no dev server. It reads every
 * route file under `app` and the document from disk and compares them three ways:
 *
 *  1. Every HTTP method exported by a route file has its own heading.
 *  2. Every heading names a route and a method that really exist.
 *  3. The access mode announced by the heading is the one the code enforces,
 *     read INSIDE that method's own body — a sibling method calling
 *     `authenticate()` must never make its neighbour look Bearer-eligible.
 *
 *   node scripts/check-api-docs.mjs
 *   node scripts/check-api-docs.mjs --break=missing   (a route dropped from the doc)
 *   node scripts/check-api-docs.mjs --break=ghost     (a heading for a dead route)
 *   node scripts/check-api-docs.mjs --break=mode      (a mode the code contradicts)
 *   node scripts/check-api-docs.mjs --break=origin    (links built from the request host)
 *   node scripts/check-api-docs.mjs --break=prefix    (a public entry matched by prefix)
 * The `--break` forms damage a COPY of one input and EXPECT the run to fail: a
 * battery that cannot fail proves nothing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { API_DOC_PATH, LLMS_TXT_PATH } from '../lib/apiDocs.ts'
import { isPublicPath, PUBLIC_PATHS } from '../lib/publicPaths.ts'
import { appOrigin } from '../lib/appOrigin.ts'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const APP_DIR = join(ROOT, 'app')
const DOC_PATH = join(ROOT, 'docs', 'API.md')

/** The methods Next.js routes may export. Anything else is not a route method. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/**
 * The access modes, from the widest to the narrowest. Each carries the marker
 * the document writes and the evidence the code must show. ONE source: the
 * heading parser and the body reader both read this table.
 */
const MODES = {
  admin: { markers: ['👑 Admin'], detect: body => /\bisAdmin\s*\(|\brequireAdmin\b/.test(body) },
  bearer: { markers: ['🔑 Bearer', 'Bearer or session'], detect: body => /\bauthenticate\s*\(/.test(body) },
  session: { markers: ['session only'], detect: body => /\bauth\s*\(\s*\)/.test(body) },
  public: { markers: ['public, no auth', 'Auth.js v5 handler'], detect: () => true },
}
/** Narrowest first: a route calling both `isAdmin` and `auth()` is an admin route. */
const MODE_ORDER = ['admin', 'bearer', 'session', 'public']

const ok = label => console.log(`  ok  ${label}`)
const fail = []
const check = (condition, label, detail) => {
  if (condition) ok(label)
  else fail.push(detail ? `${label}\n      ${detail}` : label)
}

/**
 * `app/api/messages/[id]/route.ts` -> `/api/messages/[id]`. Posix separators only.
 * A route group — a segment in parentheses — shapes the source tree, not the URL,
 * so it drops out. Not every route lives under `/api`: `app/llms.txt` is one.
 */
const routePathOf = file =>
  '/' +
  relative(ROOT, file)
    .split(sep)
    .slice(1, -1)
    .filter(segment => !segment.startsWith('('))
    .join('/')

const routeFiles = dir =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return routeFiles(full)
    return name === 'route.ts' ? [full] : []
  })

/**
 * The source of one exported method, from its `export` keyword to the brace that
 * closes its body. Brace counting, so a sibling method never leaks into this body.
 * The parameter list is skipped FIRST: `({ params }: { params: { id: string } })`
 * carries braces of its own, and counting them would end the body on the signature
 * and report every such route as unauthenticated.
 * Returns null when the method is not exported as a function of its own.
 */
const methodBody = (source, method) =>
  functionBody(source, new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`))

function functionBody(source, pattern) {
  const opener = pattern.exec(source)
  if (!opener) return null
  let parens = 0
  let i = opener.index
  for (; i < source.length; i++) {
    if (source[i] === '(') parens++
    else if (source[i] === ')' && --parens === 0) break
  }
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(opener.index, i + 1)
  }
  return source.slice(opener.index)
}

/** The methods a route file exports, as functions or re-exported from a handler. */
function exportedMethods(source) {
  const found = new Set()
  for (const method of HTTP_METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`).test(source)) found.add(method)
  }
  for (const [, names] of source.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)) {
    for (const name of names.split(',')) {
      const clean = name.split(':')[0].trim()
      if (HTTP_METHODS.includes(clean)) found.add(clean)
    }
  }
  return [...found]
}

/**
 * The bodies of the file's own non-exported helper functions, by name. A route
 * often keeps its guard in one (`async function guard() { ... isAdmin ... }`),
 * and a method that only CALLS it would otherwise read as unauthenticated.
 */
function localHelpers(source) {
  const helpers = {}
  for (const [, name] of source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    if (HTTP_METHODS.includes(name)) continue
    helpers[name] = functionBody(source, new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`))
  }
  return helpers
}

/** The mode the CODE enforces for one method: narrowest evidence wins. */
const modeOf = (source, method) => {
  let body = methodBody(source, method) ?? source
  const helpers = localHelpers(source)
  // One hop is enough for the shape used here (a method calls its file's guard);
  // ponytail: a guard hidden two hops deep would read as public — widen only if
  // a route ever does that.
  for (const [name, helperBody] of Object.entries(helpers)) {
    if (helperBody && new RegExp(`\\b${name}\\s*\\(`).test(body)) body += '\n' + helperBody
  }
  return MODE_ORDER.find(name => MODES[name].detect(body))
}

/** Reads `app/api/**` into `{ 'GET /api/x': { file, mode } }`. */
function readCode(overrides = {}) {
  const routes = {}
  for (const file of routeFiles(APP_DIR)) {
    const source = overrides[file] ?? readFileSync(file, 'utf8')
    const path = routePathOf(file)
    for (const method of exportedMethods(source)) {
      routes[`${method} ${path}`] = { file: relative(ROOT, file), mode: modeOf(source, method) }
    }
  }
  return routes
}

/**
 * Reads the `### \`METHOD /api/path?query\` — mode` headings of the document.
 * Query strings and the optional-parameter brackets the prose uses (`[?account=…]`)
 * are stripped: they describe a call, not a route. Path segments in brackets
 * (`[id]`) are kept — those ARE the route.
 */
function readDoc(text) {
  const entries = {}
  for (const line of text.split('\n')) {
    const heading = /^###\s+`([^`]+)`(.*)$/.exec(line)
    if (!heading) continue
    const [, target, rest] = heading
    const spaced = target.trim().split(/\s+/)
    // A heading may name a bare path with no method (`/api/auth/[...nextauth]`),
    // which covers every method that path exports. `*` marks it; it expands below.
    const [method, raw] =
      spaced.length === 1 && spaced[0].startsWith('/') ? ['*', spaced[0]] : spaced
    if (!HTTP_METHODS.includes(method) && method !== '*') continue
    const path = raw.replace(/\[\?[^\]]*\]/g, '').split('?')[0].replace(/\/$/, '')
    const mode = MODE_ORDER.find(name => MODES[name].markers.some(marker => rest.includes(marker)))
    entries[`${method} ${path}`] = { mode, line: line.trim() }
  }
  return entries
}

const BREAK = (/--break=(\w+)/.exec(process.argv.join(' )')) || [])[1]

let docText = readFileSync(DOC_PATH, 'utf8')
let code = readCode()

if (BREAK === 'missing') {
  // Drop the first documented route from a COPY of the document.
  const victim = Object.values(readDoc(docText))[0].line
  docText = docText.replace(victim, '### `GET /api/nothing-here` — session only')
} else if (BREAK === 'ghost') {
  docText += '\n### `DELETE /api/ghost-route` — session only\nA route that does not exist.\n'
} else if (BREAK === 'mode') {
  // Announce a session-only route as Bearer-eligible, in a COPY of the document.
  const victim = Object.entries(readDoc(docText)).find(([key]) => code[key]?.mode === 'session')[1].line
  docText = docText.replace(victim, victim.replace('— session only', '🔑 Bearer'))
}

const doc = readDoc(docText)
// Expand a method-less heading into the methods its path really exports.
for (const [key, entry] of Object.entries(doc)) {
  if (!key.startsWith('* ')) continue
  delete doc[key]
  const path = key.slice(2)
  for (const method of Object.keys(code).filter(k => k.endsWith(` ${path}`))) doc[method] = entry
}
console.log(`api docs — ${Object.keys(code).length} method/route pairs in the code, ${Object.keys(doc).length} headings in the document`)

const undocumented = Object.keys(code).filter(key => !doc[key]).sort()
check(undocumented.length === 0, 'every exported method has its heading', undocumented.join('\n      '))

const ghosts = Object.keys(doc).filter(key => !code[key]).sort()
check(ghosts.length === 0, 'every heading names a route and a method that exist', ghosts.join('\n      '))

const wrongMode = Object.entries(doc)
  .filter(([key, entry]) => code[key] && entry.mode !== code[key].mode)
  .map(([key, entry]) => `${key}: the document says ${entry.mode ?? 'no mode'}, ${code[key].file} enforces ${code[key].mode}`)
check(wrongMode.length === 0, 'the announced access mode is the one the code enforces', wrongMode.join('\n      '))

// The mode reader must look inside the method, not across the file: a route file
// holding one Bearer method and one session method must report both truthfully.
const mixed = Object.entries(code).reduce((seen, [key, { file, mode }]) => {
  const modes = seen.get(file) ?? new Set()
  return seen.set(file, modes.add(mode)) && seen
}, new Map())
check(
  [...mixed.values()].some(modes => modes.size > 1),
  'at least one route file mixes two access modes, so the per-method read is exercised',
)

// ---- The document is SERVED, and packaged so it can be ----------------------
// A reference that only exists in the repository is a reference no agent reaches.
const source = file => readFileSync(join(ROOT, file), 'utf8')

check(
  source(join('lib', 'publicPaths.ts')).includes(`'${API_DOC_PATH}'`) &&
    source(join('lib', 'publicPaths.ts')).includes(`'${LLMS_TXT_PATH}'`),
  `${API_DOC_PATH} and ${LLMS_TXT_PATH} are public, so an agent can read them before it has a key`,
)

check(
  /COPY\s[^\n]*\/app\/docs\s/.test(source('Dockerfile')),
  'the image carries docs/, without which the served reference would 404',
)

// The served links must be built from the request, never from a host written here:
// every instance answers under the name its owner chose.
const docsModule = source(join('lib', 'apiDocs.ts'))
check(
  !/https?:\/\/[a-z0-9.-]+/i.test(docsModule.replace(/llmstxt\.org/g, '')),
  'no instance host is written into the served files',
)

const llms = (await import(new URL('../lib/apiDocs.ts', import.meta.url))).buildLlmsTxt('https://example.test')
check(llms.startsWith('# '), 'llms.txt opens with its title, as llmstxt.org asks')
check(/\n> /.test(llms), 'llms.txt carries the summary as a blockquote')
check(llms.includes(`https://example.test${API_DOC_PATH}`), 'llms.txt links the reference at the calling origin')
check(
  /untrusted/i.test(llms),
  'llms.txt tells a reader that mail content is untrusted, where it will read it first',
)

// ---- The public entries name ONE document each -------------------------------
// `startsWith` would hand `/api/docs-probe` to an anonymous caller too.
const prefixOnly = pathname => PUBLIC_PATHS.some(p => pathname.startsWith(p))
const publicPathOf = BREAK === 'prefix' ? prefixOnly : isPublicPath

for (const entry of [API_DOC_PATH, LLMS_TXT_PATH]) {
  check(publicPathOf(entry) === true, `${entry} itself is public`)
  check(publicPathOf(`${entry}?x=1`) === true, `${entry} stays public with a query string`)
  // Negative control: the neighbour must NOT inherit the exemption.
  check(publicPathOf(`${entry}-probe`) === false, `${entry}-probe is NOT public`)
}
// The prefix entries keep matching what lives under them.
check(publicPathOf('/api/auth/callback/credentials') === true, '/api/auth/* stays public')
check(publicPathOf('/api/messages') === false, 'a protected route is still not public')

// ---- The served links carry the PUBLIC origin, not the container's ----------
// Behind a reverse proxy `new URL(req.url).origin` is the container id and port:
// unreachable for an agent, and an internal name disclosed.
const brokenOrigin = req => new URL(req.url).origin
const originOf = BREAK === 'origin' ? brokenOrigin : appOrigin

/** What a proxied request looks like inside the container. */
const proxiedRequest = () =>
  new Request('http://a88ef164e023:3000/llms.txt', {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mail.example.test' },
  })

const configuredBefore = process.env.NEXT_PUBLIC_APP_URL
try {
  process.env.NEXT_PUBLIC_APP_URL = 'https://mail.example.test'
  check(
    originOf(proxiedRequest()) === 'https://mail.example.test',
    'the configured address wins over the host the container answers on',
    `got ${originOf(proxiedRequest())}`,
  )
  delete process.env.NEXT_PUBLIC_APP_URL
  check(
    originOf(proxiedRequest()) === 'https://mail.example.test',
    'without the configured address, the forwarded headers are used',
    `got ${originOf(proxiedRequest())}`,
  )
  // Negative control: the container's own host must never reach a reader.
  check(
    !originOf(proxiedRequest()).includes('a88ef164e023'),
    'the internal host is never served to a reader',
  )
} finally {
  if (configuredBefore === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = configuredBefore
}

// One source for that origin: no route may read the variable on its own again.
const readers = routeFiles(APP_DIR)
  .concat([join(ROOT, 'lib', 'msOAuth.ts')])
  .filter(file => /NEXT_PUBLIC_APP_URL/.test(readFileSync(file, 'utf8')))
  .map(file => relative(ROOT, file))
check(readers.length === 0, 'the public origin is read in ONE module', readers.join(', '))

if (BREAK) {
  if (fail.length === 0) {
    console.error(`\nKO: negative control --break=${BREAK} was NOT caught — this battery proves nothing`)
    process.exit(1)
  }
  console.log(`\n  ok  negative control: --break=${BREAK} IS caught by this battery`)
  console.log(`      (${fail.length} check(s) failed, as expected)`)
  console.log('\napi docs: negative control passed')
  process.exit(0)
}

if (fail.length) {
  console.error('\nKO: the document and the code disagree\n')
  for (const detail of fail) console.error(`  KO  ${detail}`)
  process.exit(1)
}
console.log('\napi docs: all checks passed')
