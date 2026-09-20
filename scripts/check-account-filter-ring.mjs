#!/usr/bin/env node
/**
 * Lot H4h — l'anneau de focus du champ de filtre des boîtes n'est PAS rogné.
 *
 * Nicolas : « la div de recherche de compte est derrière la div du compte sélectionné,
 * du coup il y a un ou deux pixels coupés, le contour de ta div violette est coupé sur
 * le haut ». Ce n'est pas un empilement : l'accordéon rend son contenu dans un
 * `overflow-hidden` (nécessaire à l'animation `0fr → 1fr`) et l'anneau (`focus:ring-1`)
 * se dessine À L'EXTÉRIEUR de la bordure du champ. Sans marge en haut, il est coupé.
 *
 * Le banc met le champ AU FOCUS, lit l'épaisseur réelle de l'anneau dans le produit
 * (`--tw-ring-width`), et compare la boîte du champ DILATÉE de cette épaisseur à CHAQUE
 * ancêtre qui coupe. Critère : anneau entièrement dedans, avec une marge ≥ MIN_MARGIN_PX.
 * Mesure aussi la PREMIÈRE et la DERNIÈRE rangée de la liste (même conteneur rogneur).
 *
 * Lecture seule : aucun message n'est ouvert, déplacé ni supprimé.
 *
 *   node scripts/check-account-filter-ring.mjs
 *   node scripts/check-account-filter-ring.mjs --negative   (contrôle négatif)
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Marge exigée entre l'anneau et le bord rogneur. Ce n'est pas un seuil mesuré sur un banc :
 * c'est le critère de la DoD du lot H4h (« l'anneau entièrement à l'intérieur, marge ≥ 1 px »),
 * repris tel quel. Le bras de référence est le contrôle négatif : `--negative` restaure
 * `px-1.5 pb-1.5` et DOIT échouer sur ce même critère.
 */
const MIN_MARGIN_PX = 1

/** Épaisseur d'anneau supposée si le produit ne l'expose pas (cf. DoD : « 1 px à défaut »). */
const RING_FALLBACK_PX = 1

const NEGATIVE = process.argv.includes('--negative')

const WIDTHS = [1440, 390]
const THEMES = ['light', 'dark']

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} n'est pas renseigné`); process.exit(2) }
}

/**
 * Dans la SEULE barre visible (à 390 px la barre de bureau est encore dans le DOM mais
 * `display:none` — mélanger les deux arbres mesure un écran qui n'existe pas) : met le
 * champ au focus et rend, pour le champ et pour les rangées extrêmes, la plus petite
 * marge entre leur boîte dilatée de l'anneau et chaque ancêtre qui coupe.
 */
const MEASURE = fallback => {
  const R = el => { const r = el.getBoundingClientRect(); return { t: +r.top.toFixed(1), l: +r.left.toFixed(1), b: +r.bottom.toFixed(1), r: +r.right.toFixed(1) } }
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const bar = [...document.querySelectorAll('[data-sidebar]')].find(vis)
  if (!bar) return { error: 'aucune barre visible' }
  const list = bar.querySelector('[data-account-list]')
  if (!list || list.getAttribute('data-account-list-open') !== 'true' || !vis(list)) return { error: 'liste des boîtes fermée' }
  const field = bar.querySelector('[data-account-filter]')
  if (!field || !vis(field)) return { error: 'champ de filtre absent (moins de boîtes que le seuil ?)' }

  field.focus()
  if (document.activeElement !== field) {
    const a = document.activeElement
    return { error: `le champ refuse le focus (actif = ${a ? a.tagName + '.' + a.className.toString().slice(0, 40) : 'aucun'}, hasFocus=${document.hasFocus()})` }
  }

  // L'épaisseur est LUE dans le produit : une dérive fait échouer le banc au lieu de lui
  // faire mesurer autre chose qu'un anneau.
  const cs = getComputedStyle(field)
  const declared = parseFloat(cs.getPropertyValue('--tw-ring-width'))
  const ring = Number.isFinite(declared) && declared > 0 ? declared : fallback

  /**
   * Marge minimale entre la boîte de `el`, DILATÉE de `grow`, et chaque ancêtre qui coupe.
   * `grow` vaut l'épaisseur de l'anneau pour le champ au focus, et 0 pour une rangée — une
   * rangée ne porte aucun anneau, la dilater fabriquait un rognage latéral de -1 px qui
   * n'existe sur aucun écran (mesuré : 8 états ainsi comptés en échec, tous d'origine
   * arithmétique).
   *
   * Un ancêtre ne juge que si l'élément y est ENTIÈREMENT contenu AVANT dilatation — même
   * règle que `check-account-filter-overlap.mjs` : une rangée à demi défilée sort de son
   * cadre par le DÉFILEMENT, ce n'est pas un rognage (mesuré : 3 états ainsi comptés en
   * échec, tous des dernières rangées à demi défilées). Le défaut du lot, lui, survit à ce
   * filtre : le champ est entièrement dans l'accordéon, c'est son ANNEAU qui en sort.
   */
  const clipMargin = (el, grow) => {
    const r = R(el)
    const box = { t: r.t - grow, l: r.l - grow, b: r.b + grow, r: r.r + grow }
    let worst = null
    for (let p = el.parentElement; p && p !== bar.parentElement; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (!/hidden|auto|scroll|clip/.test(s.overflowX + s.overflowY)) continue
      const c = R(p)
      if (r.t < c.t - 0.5 || r.b > c.b + 0.5 || r.l < c.l - 0.5 || r.r > c.r + 0.5) continue
      const sides = { top: box.t - c.t, left: box.l - c.l, right: c.r - box.r, bottom: c.b - box.b }
      const min = Math.min(...Object.values(sides))
      if (!worst || min < worst.min) {
        worst = { min: +min.toFixed(1), by: p.className.toString().slice(0, 48), sides: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, +v.toFixed(1)])) }
      }
    }
    return worst
  }

  const rows = [...list.querySelectorAll('[data-sidebar-row]')].filter(vis)
  return {
    ring,
    field: { rect: R(field), clip: clipMargin(field, ring) },
    firstRow: rows.length ? { rect: R(rows[0]), clip: clipMargin(rows[0], 0) } : null,
    lastRow: rows.length ? { rect: R(rows[rows.length - 1]), clip: clipMargin(rows[rows.length - 1], 0) } : null,
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 })
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

try {
  const page = await browser.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) { console.error('HARNESS: connexion refusée'); process.exit(2) }

  if (NEGATIVE) {
    // Restaure LITTÉRALEMENT l'état d'avant le correctif : `px-1.5 pb-1.5`, c'est-à-dire
    // l'enveloppe du champ sans marge en haut. Une variante par `margin-top` négative sur
    // le champ ne déplaçait que 3 px sur les 6 attendus (mesuré) : elle ne reproduisait pas
    // le défaut, elle en fabriquait un autre. Style injecté, non géré par React : il survit
    // aux rendus.
    await page.evaluateOnNewDocument(() => {
      const css = '[data-account-list] div[class~="p-1.5"]{padding-top:0}'
      const inject = () => {
        if (document.getElementById('synap-negative') || !document.head) return
        const s = document.createElement('style')
        s.id = 'synap-negative'
        s.textContent = css
        document.head.appendChild(s)
      }
      setInterval(inject, 50)
    })
  }

  const accounts = await page.evaluate(async base => {
    const b = await (await fetch(`${base}/api/accounts`)).json()
    return (b.data ?? []).length
  }, BASE)
  console.log(`contexte : ${accounts} boîte(s) ; marge exigée = ${MIN_MARGIN_PX} px${NEGATIVE ? ' ; CONTRÔLE NÉGATIF' : ''}`)

  let measured = 0
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      await page.setViewport({ width, height: 900 })
      await page.evaluate(async ({ base }) => {
        await fetch(`${base}/api/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sidebar_collapsed: false }),
        })
      }, { base: BASE })
      await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
      await page.evaluate(t => document.documentElement.classList.toggle('dark', t === 'dark'), theme)

      // La page doit être HYDRATÉE avant tout clic : sans cette attente, le clic sur le
      // hamburger part dans le vide et le tiroir ne s'ouvre jamais (mesuré à 390 px).
      await page.waitForFunction(
        () => { const e = document.querySelector('[data-sidebar-row="account"], [data-omnibar-menu]'); return !!e && Object.keys(e).some(k => k.startsWith('__reactProps$')) },
        { timeout: 30000 },
      ).catch(() => {})

      // Sous `lg`, la barre vit dans un tiroir : il faut l'ouvrir avant de mesurer.
      if (width < 1024) {
        const menu = await page.$('[data-omnibar-menu]')
        if (menu) {
          const m = await menu.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
          await page.mouse.click(m.x, m.y)
          await new Promise(r => setTimeout(r, 500))
        }
      }

      // La barre arrive avec ses comptes (SWR) : on l'ATTEND, sinon on lit le squelette.
      await page.waitForFunction(() => {
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
        const bar = [...document.querySelectorAll('[data-sidebar]')].find(vis)
        const el = bar && bar.querySelector('[data-sidebar-row="account"]')
        return !!el && vis(el) && Object.keys(el).some(k => k.startsWith('__reactProps$'))
      }, { timeout: 30000 }).catch(() => {})

      const row = await page.evaluate(() => {
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
        const bar = [...document.querySelectorAll('[data-sidebar]')].find(vis)
        const el = bar && bar.querySelector('[data-sidebar-row="account"]')
        if (!el || !vis(el)) return null
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      if (!row) { console.error(`HARNESS: aucune rangée de compte visible à ${width} px / ${theme}`); process.exit(2) }
      await page.mouse.click(row.x, row.y)
      // L'accordéon anime sa hauteur : on lit quand la mesure est STABLE, pas après un délai fixe.
      await page.waitForFunction(() => {
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
        const bar = [...document.querySelectorAll('[data-sidebar]')].find(vis)
        const f = bar && bar.querySelector('[data-account-filter]')
        if (!f || !vis(f)) return false
        const now = f.getBoundingClientRect().top.toFixed(1)
        const prev = window.__synapPrevTop
        window.__synapPrevTop = now
        return prev === now
      }, { polling: 120, timeout: 30000 }).catch(() => {})

      const m = await page.evaluate(MEASURE, RING_FALLBACK_PX)
      const where = `${width} px / ${theme}`
      if (m.error) { console.error(`HARNESS: ${where} — ${m.error}`); process.exit(2) }
      measured++
      check(`${where} : anneau du champ (${m.ring} px) entièrement dedans, marge ${m.field.clip ? m.field.clip.min : 'n/a'} px ≥ ${MIN_MARGIN_PX}`,
        !!m.field.clip && m.field.clip.min >= MIN_MARGIN_PX,
        m.field.clip ? `coupé par ${m.field.clip.by} ${JSON.stringify(m.field.clip.sides)}` : 'aucun ancêtre rogneur trouvé — le banc ne mesure rien')
      for (const [name, item] of [['première rangée', m.firstRow], ['dernière rangée', m.lastRow]]) {
        if (!item) { console.error(`HARNESS: ${where} — aucune rangée dans la liste`); process.exit(2) }
        // Pas d'ancêtre juge = rangée sortie du cadre par le défilement : rien à juger.
        check(`${where} : ${name} non rognée, marge ${item.clip ? item.clip.min : 'hors cadre (défilement)'} px ≥ 0`,
          !item.clip || item.clip.min >= 0,
          item.clip ? `coupée par ${item.clip.by} ${JSON.stringify(item.clip.sides)}` : '')
      }
    }
  }
  console.log(`${measured} état(s) mesuré(s)`)
} finally {
  await browser.close()
}

if (NEGATIVE) {
  if (failures.length === 0) { console.error('CONTRÔLE NÉGATIF: aucun échec — le banc ne mesure rien'); process.exit(1) }
  console.log(`contrôle négatif : ${failures.length} échec(s), le banc voit bien le défaut`)
  process.exit(0)
}
if (failures.length) { console.error(`${failures.length} échec(s)`); process.exit(1) }
console.log('OK')
