#!/usr/bin/env node
/**
 * Lot H4h-bis — choisir l'instance qu'un HUMAIN regarde, jamais la premiere venue.
 *
 * Nicolas, 21/09 : « a 390 px la barre laterale devient un TIROIR qui se superpose au
 * contenu… `[data-sidebar]` mesure 0 px de large, `[data-account-chevron]` EXISTE mais
 * mesure 0 px de large, `[data-account-filter]` existe et mesure 0 x 0 … ces selecteurs
 * tombent sur l'instance de BUREAU, cachee, pas sur celle que l'utilisateur voit dans le
 * tiroir. Nous aurions tous les deux mesure un element que personne ne regarde. »
 *
 * Deux pieges, et le second ne se voit PAS avec un simple test de taille :
 *   1. DEUX instances au DOM (bureau `hidden lg:flex` + tiroir) : `querySelector` rend la
 *      premiere, qui est celle a 0 px sous `lg`.
 *   2. L'accordeon de comptes anime `grid-template-rows: 0fr → 1fr` : replie, le conteneur
 *      fait 0 px de haut, mais l'`input` a l'interieur garde sa PROPRE hauteur dans son
 *      `getBoundingClientRect()` — `r.height > 0` passe alors que RIEN n'est dessine.
 *      Seule l'intersection avec les cages rogneuses le revele.
 *
 * D'ou la regle appliquee ici : un element est VISIBLE si le navigateur le dit rendu
 * (`checkVisibility`) ET si sa boite, INTERSECTEE avec toutes ses cages rogneuses, garde
 * une aire non nulle. Sinon le helper ECHOUE BRUYAMMENT (throw, donc HARNESS cote banc)
 * plutot que de rendre une instance a 0 px qu'un banc mesurerait sans rien remarquer.
 *
 * Usage cote banc :
 *   import { installVisible, visibleBox, VISIBLE } from './bench-visible.mjs'
 *   await installVisible(page)                       // avant toute mesure
 *   const box = await visibleBox(page, '[data-account-filter]')   // centre pour la vraie souris
 *   await page.evaluate(() => window[VISIBLE].one('[data-sidebar]').getBoundingClientRect())
 */

/** Nom de la fonction posee sur `window` — une seule source, cote Node comme cote page. */
export const VISIBLE = '__synapVisible'

/** Aire minimale, en px², au-dessous de laquelle un element est tenu pour non dessine. */
const MIN_VISIBLE_AREA_PX2 = 1

/**
 * Source injectee dans la page. Ecrite en chaine (et non en fonction serialisee) pour
 * pouvoir etre posee par `evaluateOnNewDocument` : elle survit alors a chaque navigation,
 * ce qu'une `page.evaluate` unique ne fait pas.
 */
const SOURCE = `(() => {
  const NAME = ${JSON.stringify(VISIBLE)}
  const MIN_AREA = ${MIN_VISIBLE_AREA_PX2}
  if (window[NAME]) return

  const CLIPPING = /hidden|auto|scroll|clip/

  /** Boite REELLEMENT dessinee : celle de l'element, rognee par chacune de ses cages. */
  const drawnRect = el => {
    const r = el.getBoundingClientRect()
    let top = r.top, right = r.right, bottom = r.bottom, left = r.left
    let cage = null
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (!CLIPPING.test(s.overflowX + s.overflowY)) continue
      const c = n.getBoundingClientRect()
      const t = Math.max(top, c.top), b = Math.min(bottom, c.bottom)
      const l = Math.max(left, c.left), g = Math.min(right, c.right)
      if ((b - t) * (g - l) < (bottom - top) * (right - left)) cage = n
      top = t; bottom = b; left = l; right = g
      if (bottom - top <= 0 || right - left <= 0) break
    }
    const width = Math.max(0, right - left), height = Math.max(0, bottom - top)
    return { top, right, bottom, left, width, height, area: width * height, cage }
  }

  const label = el => (el.getAttribute('data-sidebar-row') || el.className.toString() || el.tagName).slice(0, 48)

  /** Pourquoi cette instance n'est pas celle que l'utilisateur regarde — ou null. */
  const hiddenBecause = el => {
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) {
      return 'le navigateur ne la rend pas (display/visibility/content-visibility/opacite)'
    }
    const r = el.getBoundingClientRect()
    if (r.width * r.height < MIN_AREA) return \`boite propre \${r.width.toFixed(1)} x \${r.height.toFixed(1)}\`
    const d = drawnRect(el)
    if (d.area < MIN_AREA) {
      return \`rognee a \${d.width.toFixed(1)} x \${d.height.toFixed(1)} par « \${d.cage ? label(d.cage) : '?'} » (accordeon replie ?)\`
    }
    return null
  }

  /** Toutes les instances reellement dessinees, dans l'ordre du document. */
  const all = (selector, within) => [...(within || document).querySelectorAll(selector)].filter(el => !hiddenBecause(el))

  /**
   * L'unique instance visible. Echoue BRUYAMMENT si elle manque ou s'il y en a plusieurs :
   * un banc doit s'arreter sur un HARNESS, jamais mesurer un element que personne ne voit.
   */
  const one = (selector, within) => {
    const candidates = [...(within || document).querySelectorAll(selector)]
    if (!candidates.length) throw new Error(\`VISIBLE: aucun element ne repond a « \${selector} »\`)
    const shown = candidates.filter(el => !hiddenBecause(el))
    if (shown.length === 1) return shown[0]
    if (!shown.length) {
      const why = candidates.map((el, i) => \`  #\${i} \${label(el)} — \${hiddenBecause(el)}\`).join('\\n')
      throw new Error(\`VISIBLE: « \${selector} » existe en \${candidates.length} instance(s), AUCUNE dessinee :\\n\${why}\`)
    }
    throw new Error(\`VISIBLE: « \${selector} » est dessine en \${shown.length} instances — le banc doit lever l'ambiguite\`)
  }

  window[NAME] = { one, all, hiddenBecause, drawnRect }
})()`

/** Pose le helper sur la page ET sur chaque document suivant (il survit aux navigations). */
export async function installVisible(page) {
  await page.evaluateOnNewDocument(SOURCE)
  await page.evaluate(SOURCE).catch(() => {})
}

/**
 * Centre + boite DESSINEE de l'unique instance visible, pour un clic a la vraie souris.
 * Propage l'echec du helper : le banc appelant meurt en HARNESS au lieu de viser 0,0.
 */
export async function visibleBox(page, selector) {
  return page.evaluate((sel, name) => {
    const el = window[name].one(sel)
    const d = window[name].drawnRect(el)
    return { x: d.left + d.width / 2, y: d.top + d.height / 2, width: d.width, height: d.height, top: d.top, left: d.left, bottom: d.bottom, right: d.right }
  }, selector, VISIBLE)
}

/** Attend que l'instance visible existe (hydratation, SWR, animation d'accordeon). */
export async function waitVisible(page, selector, { timeout = 30000 } = {}) {
  await page.waitForFunction(
    (sel, name) => { try { return !!window[name].one(sel) } catch { return false } },
    { timeout, polling: 120 }, selector, VISIBLE,
  )
}

/**
 * Deplie la liste de boites dans l'instance VISIBLE, a la vraie souris, et rend la main
 * quand la geometrie est STABLE (l'accordeon anime `0fr → 1fr`). Les trois bancs du filtre
 * de comptes repetaient ce meme preambule mot pour mot, chacun avec sa copie d'un test de
 * taille qui ne distingue pas le tiroir de l'instance de bureau a 0 px.
 *
 * Rend `{ surface }` — « TIROIR » ou « BUREAU » — pour que le banc PUISSE DIRE ce qu'il a
 * mesure. Leve (donc HARNESS cote banc) si aucune rangee de compte n'est dessinee.
 */
export async function openAccountList(page, { width, timeout = 30000 } = {}) {
  // Rien ne se clique avant l'hydratation : sinon le clic part dans le vide et le tiroir
  // ne s'ouvre jamais (mesure a 390 px).
  await page.waitForFunction(
    () => { const e = document.querySelector('[data-sidebar-row="account"], [data-omnibar-menu]'); return !!e && Object.keys(e).some(k => k.startsWith('__reactProps$')) },
    { timeout },
  ).catch(() => {})

  // Sous `lg`, la barre vit dans un TIROIR superpose au contenu tandis que l'instance de
  // bureau reste au DOM a 0 px : il faut l'ouvrir AVANT de chercher quoi que ce soit.
  if (typeof width === 'number' && width < 1024) {
    const menu = await visibleBox(page, '[data-omnibar-menu]').catch(() => null)
    if (menu) {
      await page.mouse.click(menu.x, menu.y)
      await waitVisible(page, '[data-sidebar-drawer]', { timeout }).catch(() => {})
    }
  }

  // La barre arrive avec ses comptes (SWR) : on l'ATTEND, sinon on lit le squelette.
  await page.waitForFunction((name) => {
    try {
      const V = window[name]
      return Object.keys(V.one('[data-sidebar-row="account"]', V.one('[data-sidebar]'))).some(k => k.startsWith('__reactProps$'))
    } catch { return false }
  }, { timeout, polling: 120 }, VISIBLE).catch(() => {})

  const row = await page.evaluate((name) => {
    const V = window[name]
    const bar = V.one('[data-sidebar]')
    const d = V.drawnRect(V.one('[data-sidebar-row="account"]', bar))
    return { x: d.left + d.width / 2, y: d.top + d.height / 2, surface: bar.closest('[data-sidebar-drawer]') ? 'TIROIR' : 'BUREAU' }
  }, VISIBLE)
  await page.mouse.click(row.x, row.y)

  // « Stable » exige d'abord que le champ soit REELLEMENT dessine : replie, sa boite propre
  // reste haute de 28 px alors que rien n'est peint.
  await page.waitForFunction((name) => {
    let f
    try { f = window[name].one('[data-account-filter]', window[name].one('[data-sidebar]')) } catch { return false }
    const now = f.getBoundingClientRect().top.toFixed(1)
    const prev = window.__synapPrevTop
    window.__synapPrevTop = now
    return prev === now
  }, { polling: 120, timeout }, VISIBLE).catch(() => {})

  return { surface: row.surface }
}
