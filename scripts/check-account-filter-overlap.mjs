#!/usr/bin/env node
/**
 * Lot H4h — le champ de recherche des boîtes et les compteurs de non-lus ne se
 * recouvrent pas, et aucun compteur n'est rogné par un bord.
 *
 * Nicolas a signalé un recouvrement, puis mesuré 0 px à 1440 px, liste ouverte :
 * son propre relevé ne suffisait pas à conclure. Ce banc fait varier ce qu'il
 * n'avait PAS fait varier : largeur (bureau et tiroir mobile), ZOOM du navigateur,
 * barre repliée / dépliée, liste au repos / défilée, et la rangée du compte actif
 * SURVOLÉE (son compteur porte `top: -BADGE_OFFSET_PX`, il déborde vers le haut).
 *
 * Lecture seule : aucun message n'est ouvert, déplacé ni supprimé.
 *
 *   node scripts/check-account-filter-overlap.mjs
 *   node scripts/check-account-filter-overlap.mjs --negative   (contrôle négatif)
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { installVisible, openAccountList, visibleBox, VISIBLE } from './bench-visible.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// La réserve de débordement n'est pas retapée : elle est lue dans le produit au cours de
// CE passage, pour qu'une dérive fasse échouer le banc au lieu de lui faire mesurer autre chose.
const AVATAR_SRC = readFileSync(new URL('../components/layout/AccountAvatar.tsx', import.meta.url), 'utf8')
const offsetMatch = AVATAR_SRC.match(/BADGE_OFFSET_PX = (\d+)/)
if (!offsetMatch) { console.error('HARNESS: BADGE_OFFSET_PX illisible dans AccountAvatar.tsx'); process.exit(2) }
const BADGE_OFFSET_PX = Number(offsetMatch[1])

/**
 * Contrôle négatif : la réserve que le conteneur défilant se donne (`--synap-badge-pad`)
 * est remise à 0 et la liste est remontée sous le champ. Le banc DOIT alors compter un
 * compteur rogné ET un recouvrement — sinon il ne mesure ni l'un ni l'autre.
 */
const NEGATIVE = process.argv.includes('--negative')
const NEGATIVE_LIFT_PX = 2 * BADGE_OFFSET_PX

/** Ce que Nicolas n'avait pas fait varier. Le zoom du navigateur divise la viewport de MISE EN PAGE. */
const WIDTHS = [1280, 1440, 1728, 390]
const ZOOMS = [1, 1.1, 1.25]

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} n'est pas renseigné`); process.exit(2) }
}

/**
 * Mesure, dans la SEULE barre visible : le recouvrement champ / compteur, et le rognage
 * d'un compteur par un ancêtre qui coupe. À 390 px la barre de bureau est encore dans le
 * DOM mais `display:none` — mélanger les deux arbres fabriquait des recouvrements qui
 * n'existent sur AUCUN écran (mesuré : une puce du tiroir « recouvrant » le champ de la
 * barre cachée). Une seule barre, donc, et la liste doit être OUVERTE.
 */
/**
 * Instance VISIBLE, via le helper partage (lot H4h-bis) : sous `lg` la barre vit dans un
 * TIROIR et l'instance de bureau reste au DOM a 0 px — un `querySelector` nu attrape celle
 * que personne ne regarde. `vis` reste local pour les rangees DEJA prises dans la barre
 * choisie : une fois la bonne instance tenue, un test de taille suffit.
 */
const MEASURE = (name) => {
  const R = el => { const r = el.getBoundingClientRect(); return { t: +r.top.toFixed(1), l: +r.left.toFixed(1), b: +r.bottom.toFixed(1), r: +r.right.toFixed(1) } }
  const V = window[name]
  const vis = el => V.drawnRect(el).area >= 1
  let bar
  try { bar = V.one('[data-sidebar]') } catch (e) { return { error: e.message.split('\n')[0] } }
  const list = bar.querySelector('[data-account-list]')
  if (!list || list.getAttribute('data-account-list-open') !== 'true' || !vis(list)) return { error: 'liste des boîtes fermée' }
  const fieldEl = bar.querySelector('[data-account-filter]')
  const field = fieldEl && vis(fieldEl) ? R(fieldEl) : null
  const overlap = (a, z) => (Math.min(a.b, z.b) - Math.max(a.t, z.t)) > 0 && (Math.min(a.r, z.r) - Math.max(a.l, z.l)) > 0
    ? { y: +(Math.min(a.b, z.b) - Math.max(a.t, z.t)).toFixed(1), x: +(Math.min(a.r, z.r) - Math.max(a.l, z.l)).toFixed(1) }
    : null
  const out = { field, badges: [] }
  for (const el of bar.querySelectorAll('[data-unread-badge]')) {
    if (!vis(el)) continue
    const rect = R(el)
    // Le compteur n'est juge que si SA rangee est ENTIEREMENT visible dans chaque boite
    // qui coupe. Une rangee a demi defilee emporte son compteur hors du cadre : c'est le
    // defilement, pas un rognage (mesure : 9 etats ainsi comptes en echec, tous des
    // rangees deja sorties du cadre — le critere etait le defaut, pas le produit).
    const row = el.closest('[data-sidebar-row]')
    let cut = null
    for (let p = el.parentElement; p && p !== bar.parentElement; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (!/hidden|auto|scroll|clip/.test(cs.overflowX + cs.overflowY)) continue
      const c = R(p)
      if (row) {
        const rr = R(row)
        if (rr.t < c.t - 0.5 || rr.b > c.b + 0.5 || rr.l < c.l - 0.5 || rr.r > c.r + 0.5) continue
      }
      const sides = Object.entries({ left: c.l - rect.l, top: c.t - rect.t, right: rect.r - c.r, bottom: rect.b - c.b })
        .filter(([, v]) => v > 0.5).map(([k, v]) => [k, +v.toFixed(1)])
      if (sides.length && !cut) cut = { by: p.className.toString().slice(0, 40), sides: Object.fromEntries(sides) }
    }
    out.badges.push({ rect, cut, over: field ? overlap(rect, field) : null })
  }
  return out
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
  await installVisible(page)
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
    // Style en ligne, non géré par React : il survit aux rendus. La réserve tombe à 0 et
    // la liste remonte sous le champ — les deux défauts que le banc doit savoir voir.
    await page.evaluateOnNewDocument(lift => {
      const css = `[data-account-list]{--synap-badge-pad:0px}[data-account-list] [data-thin-scroll-viewport]{margin-top:-${lift}px}`
      const inject = () => {
        if (document.getElementById('synap-negative')) return
        if (!document.head) return
        const s = document.createElement('style')
        s.id = 'synap-negative'
        s.textContent = css
        document.head.appendChild(s)
      }
      setInterval(inject, 50)
    }, NEGATIVE_LIFT_PX)
  }

  const accounts = await page.evaluate(async base => {
    const b = await (await fetch(`${base}/api/accounts`)).json()
    return (b.data ?? []).length
  }, BASE)
  if (accounts < 2) { console.error(`HARNESS: ${accounts} boîte(s) — il en faut au moins 2`); process.exit(2) }
  console.log(`contexte : ${accounts} boîte(s) ; réserve de débordement lue dans le produit = ${BADGE_OFFSET_PX} px${NEGATIVE ? ' ; CONTRÔLE NÉGATIF' : ''}`)

  let measured = 0
  for (const width of WIDTHS) {
    for (const zoom of ZOOMS) {
      for (const collapsed of [false, true]) {
        // Un zoom de z % ne change pas la fenêtre : il divise la viewport de MISE EN PAGE
        // en px CSS. C'est donc la largeur qu'on divise, et non un `body.style.zoom`, qui
        // est un proxy CSS ne recalculant pas la même chose.
        await page.setViewport({ width: Math.round(width / zoom), height: Math.round(900 / zoom) })
        await page.evaluate(async ({ base, collapsed: c }) => {
          await fetch(`${base}/api/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sidebar_collapsed: c }),
          })
        }, { base: BASE, collapsed })
        await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(
          () => { const e = document.querySelector('[data-sidebar-row="account"], [data-omnibar-menu]'); return !!e && Object.keys(e).some(k => k.startsWith('__reactProps$')) },
          { timeout: 30000 },
        ).catch(() => {})

        // Instance VISIBLE + depliage, une seule fois pour les trois bancs (lot H4h-bis) :
        // sous `lg` la barre vit dans un TIROIR et l'instance de bureau reste au DOM a 0 px.
        const { surface } = await openAccountList(page, { width })

        // On SURVOLE ensuite la rangee du compte actif : son compteur deborde vers le haut,
        // c'est le suspect n°1 du chevauchement que ce banc cherche.
        const row = await visibleBox(page, '[data-sidebar-row="account"]')
        await page.mouse.move(row.x, row.y)
        await new Promise(r => setTimeout(r, 200))

        for (const state of ['repos', 'défilée']) {
          if (state === 'défilée') {
            await page.evaluate((name) => {
              const V = window[name]
              const vp = V.one('[data-sidebar]').querySelector('[data-account-list] [data-thin-scroll-viewport]')
              if (vp) vp.scrollTop = vp.scrollHeight
            }, VISIBLE)
            await new Promise(r => setTimeout(r, 250))
          }
          const m = await page.evaluate(MEASURE, VISIBLE)
          const where = `${width} px / zoom ${zoom} / replié=${collapsed} / ${state} / ${surface}`
          if (m.error) { console.error(`HARNESS: ${where} — ${m.error}`); process.exit(2) }
          if (!m.badges.length) { console.error(`HARNESS: ${where} — aucun compteur rendu`); process.exit(2) }
          measured++
          const overs = m.badges.filter(b => b.over)
          const cuts = m.badges.filter(b => b.cut)
          check(`${where} : 0 px de recouvrement compteur / champ`, overs.length === 0,
            overs.map(b => `compteur ${JSON.stringify(b.rect)} recouvre le champ de ${JSON.stringify(b.over)}`).join('\n       '))
          check(`${where} : aucun compteur rogné par un bord`, cuts.length === 0,
            cuts.map(b => `compteur ${JSON.stringify(b.rect)} coupé par ${b.cut.by} ${JSON.stringify(b.cut.sides)}`).join('\n       '))
        }
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
