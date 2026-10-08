#!/usr/bin/env node
/**
 * Lot H4h-bis — auto-controle du helper `bench-visible.mjs`, sans serveur ni produit.
 *
 * La page de test REPRODUIT les deux pieges mesures par Nicolas le 21/09 sur le staging :
 *   A. deux instances au DOM, l'une `display:none` (bureau sous `lg`), l'autre dessinee ;
 *   B. un champ dans un accordeon `grid-template-rows: 0fr` : sa PROPRE boite reste haute,
 *      mais rien n'est dessine — c'est le cas qu'un simple `width > 0 && height > 0` rate.
 *
 * Le controle NEGATIF est integre : la methode naive (`querySelector` + mesure telle
 * quelle) tourne sur la MEME page. Elle DOIT se tromper la ou le helper refuse — sinon la
 * page de test ne reproduit plus le piege et ce banc ne prouve plus rien.
 *
 *   node scripts/check-bench-visible.mjs
 */
import puppeteer from 'puppeteer-core'
import { installVisible, visibleBox, VISIBLE } from './bench-visible.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** La page reproduit la GEOMETRIE du produit, pas son code : le helper ne doit rien supposer. */
const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0 }
  .bar { width: 240px }
  .bar.desktop { display: none }              /* piege A : l'instance de bureau sous lg */
  .row { height: 40px }
  .accordion { display: grid; overflow: hidden; transition: none }
  .accordion.closed { grid-template-rows: 0fr }
  .accordion.open   { grid-template-rows: 1fr }
  .accordion > div { overflow: hidden }
  input { height: 28px; width: 200px; display: block }
</style>
<div class="bar desktop" data-sidebar data-which="bureau">
  <div class="row" data-sidebar-row="account" data-which="bureau">admin</div>
  <div class="accordion open"><div><input data-account-filter data-which="bureau"></div></div>
</div>
<div class="bar drawer" data-sidebar data-which="tiroir">
  <div class="row" data-sidebar-row="account" data-which="tiroir">admin</div>
  <div class="accordion closed" id="acc"><div><input data-account-filter data-which="tiroir"></div></div>
</div>
<button data-lonely>seul et visible</button>`

/**
 * Ce que faisaient les bancs AVANT ce lot : le premier `querySelector` venu, mesure tel
 * quel. Il ne rend jamais « rien » — c'est le point : il MESURE, meme une boite a 0 x 0,
 * et c'est ainsi que le « -2/-2 a 390 px » est ne (un rectangle vide dilate de l'epaisseur
 * de l'anneau donne exactement -epaisseur en haut ET en bas).
 */
const NAIVE = sel => {
  const el = document.querySelector(sel)
  if (!el) return { which: 'absent', w: 0, h: 0 }
  const r = el.getBoundingClientRect()
  return { which: el.dataset.which || 'sans marque', w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 120000 })
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 600 })
  await installVisible(page)
  await page.setContent(FIXTURE, { waitUntil: 'domcontentloaded' })
  await installVisible(page)

  const ask = sel => page.evaluate((s, n) => {
    try { return { ok: true, which: window[n].one(s).dataset.which || 'sans marque' } }
    catch (e) { return { ok: false, why: e.message } }
  }, sel, VISIBLE)

  // --- Piege A : deux instances, une seule dessinee -------------------------------------
  const barre = await ask('[data-sidebar]')
  check(`piege A — le helper choisit le TIROIR (a rendu : ${barre.ok ? barre.which : barre.why.split('\n')[0]})`,
    barre.ok && barre.which === 'tiroir')

  const naifA = await page.evaluate(NAIVE, '[data-sidebar]')
  check(`piege A — controle NEGATIF : la naive prend le BUREAU, a 0 px (a rendu : « ${naifA.which} » ${naifA.w} x ${naifA.h})`,
    naifA.which === 'bureau' && naifA.w * naifA.h < 1,
    'la page de test ne reproduit plus le piege : ce banc ne prouve plus rien')

  // --- Piege B : accordeon replie, boite propre non nulle mais rien de dessine ------------
  const filtreReplie = await ask('[data-account-filter]')
  check(`piege B — accordeon replie : le helper REFUSE de mesurer (a rendu : ${filtreReplie.ok ? `« ${filtreReplie.which} » !` : 'un echec'})`,
    !filtreReplie.ok && /AUCUNE dessinee|rognee a/.test(filtreReplie.why),
    filtreReplie.ok ? "il a rendu une instance alors qu'aucune n'est dessinee" : `message inattendu : ${filtreReplie.why}`)

  const naifB = await page.evaluate(NAIVE, '[data-account-filter]')
  check(`piege B — controle NEGATIF : la naive mesure une boite fantome (a rendu : « ${naifB.which} » ${naifB.w} x ${naifB.h})`,
    naifB.which === 'bureau' && naifB.w * naifB.h < 1,
    'la page de test ne reproduit plus le piege : ce banc ne prouve plus rien')

  check('piege B — le message nomme la cage et la boite rognee',
    !filtreReplie.ok && /0\.0/.test(filtreReplie.why),
    filtreReplie.ok ? '' : filtreReplie.why.replace(/\n/g, '\n       '))

  // --- L'accordeon s'ouvre : la MEME requete doit maintenant rendre le tiroir --------------
  await page.evaluate(() => { document.getElementById('acc').className = 'accordion open' })
  const filtreOuvert = await ask('[data-account-filter]')
  check(`accordeon ouvert — le helper rend le TIROIR (a rendu : ${filtreOuvert.ok ? filtreOuvert.which : filtreOuvert.why.split('\n')[0]})`,
    filtreOuvert.ok && filtreOuvert.which === 'tiroir')

  // --- Ambiguite : deux instances dessinees -> le banc doit trancher, pas le helper --------
  await page.evaluate(() => { document.querySelector('.bar.desktop').style.display = 'block' })
  const ambigu = await ask('[data-sidebar]')
  check(`deux instances dessinees — le helper refuse de choisir (a rendu : ${ambigu.ok ? `« ${ambigu.which} »` : 'un echec'})`,
    !ambigu.ok && /2 instances/.test(ambigu.why), ambigu.ok ? '' : ambigu.why)
  await page.evaluate(() => { document.querySelector('.bar.desktop').style.display = '' })

  // --- Selecteur absent -> echec bruyant, jamais un null silencieux ------------------------
  const absent = await ask('[data-ceci-nexiste-pas]')
  check('selecteur absent — echec bruyant', !absent.ok && /aucun element/.test(absent.why), absent.ok ? '' : absent.why)

  // --- `visibleBox` : centre utilisable pour un clic a la vraie souris ---------------------
  const box = await visibleBox(page, '[data-lonely]')
  check(`visibleBox — centre (${box.x.toFixed(1)}, ${box.y.toFixed(1)}) dans la fenetre, boite ${box.width.toFixed(1)} x ${box.height.toFixed(1)} non nulle`,
    box.x > 0 && box.y > 0 && box.width >= 1 && box.height >= 1)

  const ouvert = await visibleBox(page, '[data-account-filter]').then(() => null, e => e.message)
  await page.evaluate(() => { document.getElementById('acc').className = 'accordion closed' })
  const replie = await visibleBox(page, '[data-account-filter]').then(() => null, e => e.message)
  check("visibleBox — propage l'echec du helper au lieu de viser 0,0",
    ouvert === null && typeof replie === 'string' && /VISIBLE:/.test(replie),
    `ouvert -> ${ouvert === null ? 'ok' : ouvert} ; replie -> ${replie}`)
} finally {
  await browser.close()
}

if (failures.length) { console.error(`${failures.length} echec(s)`); process.exit(1) }
console.log('OK')
