#!/usr/bin/env node
/**
 * Lot H4h, bras d'ARBITRAGE — quelle CAGE rogne l'anneau du filtre de boîtes ?
 *
 * Deux bancs ont rendu deux verdicts opposés sur le MÊME écran (20/09) : « +5 px de marge »
 * ici, « -2 px en haut ET en bas à 390 px » chez un banc tiers. Une marge négative SYMÉTRIQUE
 * et exactement égale à l'épaisseur de l'anneau n'est pas un rognage : c'est ce qu'on obtient
 * en comparant la boîte du champ à ELLE-MÊME dilatée de l'anneau. Or un `input` porte
 * `overflow: clip` par défaut du navigateur : une marche d'ancêtres qui part de l'élément au
 * lieu de son PARENT le retient donc comme sa propre cage, sur tout écran et toute largeur.
 *
 * Ce banc mesure les DEUX marches côte à côte et fige l'invariant :
 *   - marche depuis le PARENT  -> cage réelle (l'`overflow-hidden` de l'accordéon), marge ≥ 1 px ;
 *   - marche depuis le CHAMP   -> se retient lui-même, et rend -épaisseur des deux côtés.
 * Le second n'est pas un échec du produit : c'est la signature à reconnaître avant de conclure.
 *
 * Lecture seule : aucun message n'est ouvert, déplacé ni supprimé.
 *
 *   node scripts/check-account-filter-ring-cage.mjs
 *   SYNAPMAIL_TEST_URL=https://… node scripts/check-account-filter-ring-cage.mjs   (autre surface)
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { installVisible, waitVisible, visibleBox, VISIBLE } from './bench-visible.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Critère de la DoD du lot H4h : « l'anneau entièrement à l'intérieur, marge ≥ 1 px ». */
const MIN_MARGIN_PX = 1

/** Épaisseur d'anneau supposée si le produit ne l'expose pas (cf. DoD : « 1 px à défaut »). */
const RING_FALLBACK_PX = 1

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
 * Les deux marches, dans la seule instance REELLEMENT DESSINEE (helper partage). Avant le
 * lot H4h-bis ce banc choisissait la barre avec son propre `find(vis)` : un test de taille
 * qui ne voit PAS un champ retenu a 0 px par l'accordeon replie. Le helper, lui, intersecte
 * la boite avec ses cages et ECHOUE plutot que de rendre un element que personne ne regarde.
 */
const MEASURE = (fallback, name) => {
  const V = window[name]
  const bar = V.one('[data-sidebar]')
  const field = V.one('[data-account-filter]', bar)

  field.focus()
  if (document.activeElement !== field) throw new Error('VISIBLE: le champ refuse le focus')

  const cs = getComputedStyle(field)
  const declared = parseFloat(cs.getPropertyValue('--tw-ring-width'))
  const ring = Number.isFinite(declared) && declared > 0 ? declared : fallback
  const r = field.getBoundingClientRect()

  /** Première cage rogneuse à partir de `start`, et la marge de l'anneau à l'intérieur. */
  const walk = start => {
    for (let n = start; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (!/hidden|auto|scroll|clip/.test(s.overflowX + s.overflowY)) continue
      const c = n.getBoundingClientRect()
      return {
        cage: n === field ? 'LE CHAMP LUI-MÊME' : (n.className.toString() || n.tagName).slice(0, 40),
        estLeChamp: n === field,
        haut: +((r.top - ring) - c.top).toFixed(1),
        bas: +(c.bottom - (r.bottom + ring)).toFixed(1),
      }
    }
    return null
  }

  return {
    ring,
    surface: bar.closest('[data-sidebar-drawer]') ? 'TIROIR' : 'BUREAU',
    overflowDuChamp: cs.overflowX + '/' + cs.overflowY,
    depuisLeChamp: walk(field),
    depuisLeParent: walk(field.parentElement),
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

  console.log(`surface : ${BASE} ; marge exigée = ${MIN_MARGIN_PX} px`)
  let measured = 0
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const where = `${String(width).padEnd(4)} px / ${theme.padEnd(5)}`
      await page.setViewport({ width, height: 900 })
      await page.evaluate(async base => {
        await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sidebar_collapsed: false }) })
      }, BASE)
      await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
      await page.evaluate(t => document.documentElement.classList.toggle('dark', t === 'dark'), theme)

      // Rien ne se clique avant l'hydratation : sinon le clic part dans le vide et le tiroir
      // ne s'ouvre jamais (mesuré à 390 px).
      await page.waitForFunction(
        () => { const e = document.querySelector('[data-sidebar-row="account"], [data-omnibar-menu]'); return !!e && Object.keys(e).some(k => k.startsWith('__reactProps$')) },
        { timeout: 30000 },
      ).catch(() => {})

      // Sous `lg`, la barre vit dans un TIROIR superposé au contenu, tandis que l'instance de
      // bureau reste au DOM à 0 px : c'est elle qu'un `querySelector` nu attrape (Nicolas,
      // 21/09). On ouvre donc le tiroir, puis TOUT passe par le helper d'instance visible.
      if (width < 1024) {
        const menu = await visibleBox(page, '[data-omnibar-menu]').catch(() => null)
        if (menu) {
          await page.mouse.click(menu.x, menu.y)
          await waitVisible(page, '[data-sidebar-drawer]').catch(() => {})
        }
      }

      // La barre arrive avec ses comptes (SWR) : on l'ATTEND, sinon on lit le squelette.
      await page.waitForFunction((name) => {
        try {
          const el = window[name].one('[data-sidebar-row="account"]', window[name].one('[data-sidebar]'))
          return Object.keys(el).some(k => k.startsWith('__reactProps$'))
        } catch { return false }
      }, { timeout: 30000, polling: 120 }, VISIBLE).catch(() => {})

      let row
      try {
        row = await page.evaluate((name) => {
          const V = window[name]
          const d = V.drawnRect(V.one('[data-sidebar-row="account"]', V.one('[data-sidebar]')))
          return { x: d.left + d.width / 2, y: d.top + d.height / 2, surface: d.width }
        }, VISIBLE)
      } catch (e) {
        console.error(`HARNESS: ${where} — ${e.message.split('\n')[0]}`); process.exit(2)
      }
      await page.mouse.click(row.x, row.y)

      // L'accordéon anime sa hauteur : on lit quand la mesure est STABLE, pas après un délai
      // fixe — et « stable » exige d'abord que le champ soit RÉELLEMENT dessiné (replié, sa
      // boîte propre reste haute de 28 px alors que rien n'est peint).
      await page.waitForFunction((name) => {
        let f
        try { f = window[name].one('[data-account-filter]', window[name].one('[data-sidebar]')) } catch { return false }
        const now = f.getBoundingClientRect().top.toFixed(1)
        const prev = window.__synapPrevTop
        window.__synapPrevTop = now
        return prev === now
      }, { polling: 120, timeout: 30000 }, VISIBLE).catch(() => {})

      let m
      try { m = await page.evaluate(MEASURE, RING_FALLBACK_PX, VISIBLE) }
      catch (e) { console.error(`HARNESS: ${where} — ${e.message.split('\n').slice(0, 4).join('\n         ')}`); process.exit(2) }
      measured++
      console.log(`  --   ${where} : instance mesurée = ${m.surface}`)

      const parent = m.depuisLeParent
      check(`${where} : cage réelle « ${parent ? parent.cage : 'aucune'} » — marge haut ${parent ? parent.haut : 'n/a'} px, bas ${parent ? parent.bas : 'n/a'} px ≥ ${MIN_MARGIN_PX} (anneau ${m.ring} px)`,
        !!parent && parent.haut >= MIN_MARGIN_PX && parent.bas >= MIN_MARGIN_PX,
        parent ? '' : 'aucun ancêtre rogneur — le banc ne mesure rien')

      // L'invariant à retenir : partir du champ le retient LUI-MÊME (`overflow: clip` par
      // défaut du navigateur) et rend -épaisseur des deux côtés. Si un jour ce n'est plus
      // vrai, c'est cette explication du -2/-2 tiers qui tombe, et il faut la réécrire.
      // Contrôle NÉGATIF sur le PRODUIT, à la largeur où les deux instances coexistent : la
      // méthode naive (premier `querySelector`, mesuré tel quel) doit tomber sur l'instance
      // de BUREAU, cachée, et rendre une boîte nulle. C'est le défaut que ce lot ferme ; le
      // jour où il ne se reproduit plus, la garde ci-dessus ne protège plus de rien et ce
      // banc doit le dire au lieu de rester vert par habitude.
      if (width < 1024) {
        const naif = await page.evaluate(() => {
          const el = document.querySelector('[data-account-filter]')
          if (!el) return null
          const r = el.getBoundingClientRect()
          const drawer = !!el.closest('[data-sidebar-drawer]')
          return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), surface: drawer ? 'TIROIR' : 'BUREAU' }
        })
        check(`${where} : contrôle négatif — la méthode naive prend « ${naif ? naif.surface : 'rien'} » en ${naif ? `${naif.w} x ${naif.h}` : 'n/a'} px (donc mesurable à tort)`,
          !!naif && naif.surface === 'BUREAU' && naif.w * naif.h < 1,
          'les deux instances ne se distinguent plus : le piège a disparu OU le sélecteur a changé — relire ce banc avant de le croire')
      }

      const self = m.depuisLeChamp
      check(`${where} : marche depuis le champ = artefact connu (champ ${m.overflowDuChamp}, rend ${self ? `${self.haut}/${self.bas}` : 'rien'} pour un anneau de ${m.ring} px)`,
        !!self && self.estLeChamp && self.haut === -m.ring && self.bas === -m.ring,
        self ? `attendu ${-m.ring}/${-m.ring} depuis « LE CHAMP LUI-MÊME »` : 'le champ ne se retient plus lui-même')
    }
  }
  console.log(`${measured} état(s) mesuré(s)`)
} finally {
  await browser.close()
}

if (failures.length) { console.error(`${failures.length} échec(s)`); process.exit(1) }
console.log('OK')
