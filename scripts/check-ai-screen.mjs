#!/usr/bin/env node
/**
 * Measures the house rules on the assistant settings screen, as RENDERED:
 * no emoji and no em dash in what the user actually reads, and the step
 * titles coming from the locale files rather than from the component.
 *
 * Reading the rendered text is the point: the previous gate found emoji and
 * em dashes that `check-locales` could not see, because they were written
 * straight into the JSX instead of going through a locale file.
 *
 * Negative control:
 *   node scripts/check-ai-screen.mjs --break=<case>
 *
 *   node scripts/check-ai-screen.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
const EM_DASH = '\u2014'
/** Anything outside the plane of ordinary text: pictographs, flags, symbols. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u

const BREAKAGES = {
  'emoji-in-screen': 'an emoji in the rendered screen goes unnoticed',
  'em-dash-in-screen': 'an em dash in the rendered screen goes unnoticed',
}
const BREAK = process.argv.find(a => a.startsWith('--break='))?.slice('--break='.length) ?? null
if (BREAK && !BREAKAGES[BREAK]) {
  console.error(`HARNESS: --break=${BREAK} is not one of ${Object.keys(BREAKAGES).join(', ')}`)
  process.exit(1)
}

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const locales = Object.fromEntries(['en', 'fr', 'zh'].map(code =>
  [code, JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'))]))

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) { console.error('HARNESS: credentials login failed'); process.exit(2) }

  await page.goto(`${BASE}/settings/ai`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('button', { timeout: 15000 })

  let text = await page.evaluate(() => document.body.innerText)
  if (BREAK === 'emoji-in-screen') text += '\n\u{1F916}'
  if (BREAK === 'em-dash-in-screen') text += `\n1 ${EM_DASH} Fournisseur`

  const emoji = text.match(new RegExp(EMOJI, 'gu')) ?? []
  check(emoji.length === 0, `no emoji in the rendered screen (found ${JSON.stringify(emoji)})`)
  check(!text.includes(EM_DASH), 'no em dash in the rendered screen')

  // The step titles must come from a locale file: their presence in the page
  // for the served language is what proves the component stopped hardcoding
  // them, and check-locales then covers the other two languages. The titles
  // are uppercased by CSS, which innerText reports, so the case is dropped.
  const flat = text.toLowerCase()
  const served = ['en', 'fr', 'zh'].filter(code =>
    flat.includes(locales[code].settings.ai.stepProvider.toLowerCase())
    && flat.includes(locales[code].settings.ai.stepAccess.toLowerCase()))
  check(served.length > 0, `the step titles come from a locale file (matched: ${served.join(', ') || 'none'})`)

  // Each provider card carries an icon (an svg), not a character.
  const cardsWithIcon = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter(b => b.querySelector('p.text-sm.font-semibold'))
      .map(b => !!b.querySelector('svg')))
  check(cardsWithIcon.length >= 5, `the five provider cards are on screen (found ${cardsWithIcon.length})`)
  check(cardsWithIcon.every(Boolean), 'every provider card carries an icon')
} finally {
  await browser.close()
}

if (BREAK) {
  if (failures > 0) { console.log(`\ncheck-ai-screen: negative control OK, "${BREAKAGES[BREAK]}" produced ${failures} failure(s)`); process.exit(0) }
  console.log(`\ncheck-ai-screen: negative control FAILED, "${BREAKAGES[BREAK]}" went unnoticed`)
  process.exit(1)
}
if (failures > 0) { console.log(`\ncheck-ai-screen: ${failures} failure(s)`); process.exit(1) }
console.log('\ncheck-ai-screen: OK')
