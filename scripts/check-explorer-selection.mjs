#!/usr/bin/env node
/**
 * Auto-controle de la REGLE de selection facon explorateur
 * (`lib/explorerSelection.ts`), celle que partagent la liste des messages et la
 * liste des abonnements du tableau de bord.
 *
 * Aucun reseau, aucun serveur, aucun compte.
 *   node --experimental-strip-types scripts/check-explorer-selection.mjs
 *   node --experimental-strip-types scripts/check-explorer-selection.mjs --break   (controle negatif)
 */
const { explorerSelect, gestureOf, selectAll, isAllSelected } =
  await import(new URL('../lib/explorerSelection.ts', import.meta.url).href)

const BREAK = process.argv.includes('--break')

/**
 * La faute que ce banc doit voir : une plage qui DEPLACE l'ancre, si bien que
 * deux Maj-clics de suite ne partent plus du meme point (le second etend depuis
 * le bout du premier au lieu de la ligne cliquee au depart).
 */
const movingAnchor = (keys, current, key, gesture) => {
  const next = explorerSelect(keys, current, key, gesture)
  return gesture === 'range' ? { ...next, anchor: key } : next
}
const select = BREAK ? movingAnchor : explorerSelect

const KEYS = ['a', 'b', 'c', 'd', 'e']
const EMPTY = { selected: new Set(), anchor: null }
const sorted = s => [...s].sort().join(',')

let failed = 0
const ok = (label, got, want) => {
  const pass = got === want
  if (!pass) failed++
  console.log(`  ${pass ? 'ok  ' : 'KO  '}${label}${pass ? '' : ` (attendu ${JSON.stringify(want)}, obtenu ${JSON.stringify(got)})`}`)
}

console.log('== geste decrit par les touches ==')
ok('clic simple remplace', gestureOf({ metaKey: false, ctrlKey: false, shiftKey: false }), 'replace')
ok('Cmd-clic bascule', gestureOf({ metaKey: true, ctrlKey: false, shiftKey: false }), 'toggle')
ok('Ctrl-clic bascule aussi', gestureOf({ metaKey: false, ctrlKey: true, shiftKey: false }), 'toggle')
ok('Maj-clic etend', gestureOf({ metaKey: false, ctrlKey: false, shiftKey: true }), 'range')
ok('Cmd+Maj-clic bascule, il ne prend pas la plage', gestureOf({ metaKey: true, ctrlKey: false, shiftKey: true }), 'toggle')

console.log('== clic simple ==')
const one = select(KEYS, EMPTY, 'c', 'replace')
ok('ne garde que la ligne cliquee', sorted(one.selected), 'c')
ok('pose l ancre dessus', one.anchor, 'c')
const replaced = select(KEYS, { selected: new Set(['a', 'b']), anchor: 'a' }, 'd', 'replace')
ok('efface ce qui etait retenu', sorted(replaced.selected), 'd')

console.log('== Cmd/Ctrl-clic ==')
const added = select(KEYS, one, 'a', 'toggle')
ok('ajoute sans rien perdre', sorted(added.selected), 'a,c')
ok('deplace l ancre sur la ligne basculee', added.anchor, 'a')
const removed = select(KEYS, added, 'c', 'toggle')
ok('retire une ligne deja retenue', sorted(removed.selected), 'a')

console.log('== Maj-clic ==')
const down = select(KEYS, { selected: new Set(['b']), anchor: 'b' }, 'd', 'range')
ok('prend la plage vers le bas, bornes comprises', sorted(down.selected), 'b,c,d')
const up = select(KEYS, { selected: new Set(['d']), anchor: 'd' }, 'b', 'range')
ok('prend la plage vers le haut, meme contenu', sorted(up.selected), 'b,c,d')
ok('la plage NE deplace PAS l ancre', down.anchor, 'b')
const second = select(KEYS, down, 'e', 'range')
ok('un second Maj-clic repart de la MEME ancre', sorted(second.selected), 'b,c,d,e')
const shrunk = select(KEYS, down, 'c', 'range')
ok('un second Maj-clic peut RETRECIR la plage', sorted(shrunk.selected), 'b,c')

console.log('== Maj-clic sans point de depart ==')
const orphan = select(KEYS, EMPTY, 'c', 'range')
ok('sans ancre, la ligne seule (jamais tout)', sorted(orphan.selected), 'c')
ok('et l ancre se pose', orphan.anchor, 'c')
const stale = select(KEYS, { selected: new Set(['z']), anchor: 'z' }, 'c', 'range')
ok('ancre disparue de la liste, la ligne seule', sorted(stale.selected), 'c')

console.log('== tout selectionner ==')
ok('rien ne remplit', sorted(selectAll(KEYS, false).selected), 'a,b,c,d,e')
ok('tout vide', sorted(selectAll(KEYS, true).selected), '')
ok('une liste vide n est jamais "tout retenu"', isAllSelected([], new Set()), false)
ok('tout retenu se voit', isAllSelected(KEYS, new Set(KEYS)), true)
ok('une ligne manquante suffit a le nier', isAllSelected(KEYS, new Set(['a', 'b'])), false)

console.log(`\nselection explorateur : ${failed === 0 ? 'toutes les verifications passent' : `${failed} echec(s)`}`)
if (BREAK) {
  if (failed === 0) { console.log('CONTROLE NEGATIF : la faute injectee n a PAS ete vue — le banc ne mesure rien'); process.exit(1) }
  console.log(`CONTROLE NEGATIF : rouge comme attendu (${failed} echec(s))`)
  process.exit(0)
}
process.exit(failed === 0 ? 0 : 1)
