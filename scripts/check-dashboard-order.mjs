#!/usr/bin/env node
/**
 * Auto-controle de la REGLE d'ordre des cartes du tableau de bord
 * (`lib/dashboardOrder.ts`) : ce qui se deplace, ce qui revient, et surtout ce
 * qu'une valeur enregistree abimee ne doit JAMAIS pouvoir faire disparaitre.
 *
 * Aucun reseau, aucun serveur, aucune base.
 *   node --experimental-strip-types scripts/check-dashboard-order.mjs
 *   node --experimental-strip-types scripts/check-dashboard-order.mjs --break   (controle negatif)
 */
const { DASHBOARD_CARDS, defaultCardOrder, normalizeCardOrder, moveCard, shiftCard,
        isDefaultCardOrder, cardSpan } =
  await import(new URL('../lib/dashboardOrder.ts', import.meta.url).href)

const BREAK = process.argv.includes('--break')

/**
 * La faute que ce banc doit voir : une normalisation qui se CONTENTE de ce qui
 * est enregistre, sans y remettre les cartes manquantes. Une carte ajoutee par
 * une mise a jour deviendrait alors invisible pour tout utilisateur ayant deja
 * range son tableau de bord — sans aucun moyen de la faire revenir.
 */
const droppingNormalize = stored =>
  Array.isArray(stored)
    ? stored.filter(v => defaultCardOrder().includes(v))
    : defaultCardOrder()
const normalize = BREAK ? droppingNormalize : normalizeCardOrder

let failed = 0
const ok = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  const pass = g === w
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${pass ? '' : `\n        attendu ${w}\n        obtenu  ${g}`}`)
}

const DEF = defaultCardOrder()

console.log('== la source unique ==')
ok('autant de cartes que de specs', DEF.length, DASHBOARD_CARDS.length)
ok('aucune identite en double', new Set(DEF).size, DEF.length)
ok('chaque carte porte une largeur', DASHBOARD_CARDS.every(c => typeof c.span === 'string' && c.span.length > 0), true)
ok('la largeur se lit par identite', cardSpan('quickCompose'), 'col-span-12')
ok('une identite inconnue retombe pleine largeur', cardSpan('nexistepas'), 'col-span-12')
ok('l ordre d origine EST l ordre d origine', isDefaultCardOrder(DEF), true)
ok('une copie neuve a chaque appel', defaultCardOrder() !== defaultCardOrder(), true)

console.log('\n== ce qui revient d une valeur enregistree ==')
ok('rien d enregistre -> ordre d origine', normalize(null), DEF)
ok('valeur qui n est pas une liste -> ordre d origine', normalize({ focus: 1 }), DEF)
ok('liste vide -> ordre d origine', normalize([]), DEF)
ok('un ordre complet est rendu tel quel', normalize([...DEF].reverse()), [...DEF].reverse())

const corrupt = ['quickCompose', 'inconnue', 'focus', 'focus', 42, null]
const fromCorrupt = normalize(corrupt)
ok('aucune carte perdue par une valeur abimee', [...fromCorrupt].sort(), [...DEF].sort())
ok('les identites retenues gardent leur ordre enregistre',
  fromCorrupt.filter(id => id === 'quickCompose' || id === 'focus'), ['quickCompose', 'focus'])
ok('une carte absente revient a son rang d origine',
  normalize(DEF.filter(id => id !== 'accounts')).indexOf('accounts'), DEF.indexOf('accounts'))

console.log('\n== deposer une carte sur une autre ==')
ok('descendre pose APRES la cible',
  moveCard(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd'])
ok('monter pose AVANT la cible',
  moveCard(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'])
ok('deposer sur soi-meme ne change rien',
  moveCard(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'])
ok('une identite inconnue ne change rien',
  moveCard(['a', 'b', 'c'], 'z', 'b'), ['a', 'b', 'c'])
ok('une cible inconnue ne change rien',
  moveCard(['a', 'b', 'c'], 'a', 'z'), ['a', 'b', 'c'])
ok('un deplacement ne perd ni ne duplique',
  moveCard(DEF, 'quickCompose', 'focus').length, DEF.length)
ok('et garde exactement les memes cartes',
  [...moveCard(DEF, 'quickCompose', 'focus')].sort(), [...DEF].sort())
ok('la liste d entree n est pas mutee', (() => {
  const src = ['a', 'b', 'c']
  moveCard(src, 'a', 'c')
  return src
})(), ['a', 'b', 'c'])

console.log('\n== deplacer au clavier ==')
ok('une fleche vers le bas avance d un rang',
  shiftCard(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c'])
ok('une fleche vers le haut recule d un rang',
  shiftCard(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b'])
ok('en tete, monter SATURE (pas de bouclage)',
  shiftCard(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c'])
ok('en queue, descendre SATURE (pas de bouclage)',
  shiftCard(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c'])
ok('un pas nul ne change rien', shiftCard(['a', 'b', 'c'], 'b', 0), ['a', 'b', 'c'])
ok('une identite inconnue ne change rien', shiftCard(['a', 'b', 'c'], 'z', 1), ['a', 'b', 'c'])

console.log('\n== remettre l ordre d origine ==')
const moved = moveCard(DEF, 'quickCompose', 'focus')
ok('un ordre deplace n est plus l ordre d origine', isDefaultCardOrder(moved), false)
ok('et la remise a zero le redonne exactement', defaultCardOrder(), DEF)

console.log('\n== la frontiere du serveur (lecture de la SOURCE) ==')
const { readFileSync } = await import('node:fs')
const ROUTE = readFileSync(new URL('../app/api/settings/route.ts', import.meta.url), 'utf8')
const DB = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')
ok('la colonne est creee sans toucher aux tableaux de bord existants',
  /ADD COLUMN IF NOT EXISTS dashboard_card_order JSONB/.test(DB), true)
ok('elle est relue par GET', /SETTINGS_COLUMNS = `[^`]*dashboard_card_order/.test(ROUTE), true)
ok('elle est acceptee par PATCH', /'dashboard_card_order',/.test(ROUTE), true)
ok('ce qui entre passe par la regle partagee', /normalizeCardOrder\(order\)/.test(ROUTE), true)
ok('et part en JSON, jamais en tableau Postgres',
  /JSON\.stringify\(normalizeCardOrder\(order\)\)/.test(ROUTE), true)
ok('remettre l ordre d origine s ecrit NULL', /order === null \? null/.test(ROUTE), true)

console.log(`\nordre du tableau de bord : ${failed === 0 ? 'toutes les verifications passent' : `${failed} echec(s)`}`)
if (BREAK) {
  if (failed === 0) { console.log('CONTROLE NEGATIF : la faute injectee n a PAS ete vue — le banc ne mesure rien'); process.exit(1) }
  console.log(`CONTROLE NEGATIF : rouge comme attendu (${failed} echec(s))`)
  process.exit(0)
}
process.exit(failed === 0 ? 0 : 1)
