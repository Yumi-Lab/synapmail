#!/usr/bin/env node
/**
 * Auto-contrôle de l'arbre des dossiers virtuels côté écran (`lib/ged/tree.ts`) : ordre
 * d'affichage, profondeur, orphelin remonté, « dans sa propre branche », chemin lisible,
 * compteur de branche. Fonction PURE : ni réseau, ni base — le module est importé tel quel.
 *
 *   node --experimental-strip-types --no-warnings scripts/check-ged-tree.mjs [--negative]
 */
import './alias-resolver.mjs'
const { flattenTree, isWithin, folderPath, branchCount } = await import('../lib/ged/tree.ts')

const NEGATIVE = process.argv.includes('--negative')
let fails = 0
const check = (label, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) fails++ }
const f = (id, parentId, nom, documents = 0) => ({ id, parentId, nom, position: 0, auto: false, creeLe: new Date(), documents, patterns: 0 })

// À plat, dans un ordre qui n'est PAS celui de l'arbre (l'enfant avant le parent) — c'est ce que le serveur peut rendre.
const folders = [
  f('fedex', 'fourn', 'FedEx', 3),
  f('fourn', null, 'Fournisseurs', 1),
  f('orphan', 'disparu', 'Orphelin', 2),
  f('clients', null, 'Clients', 0),
  f('fedex-us', NEGATIVE ? 'fedex-us' : 'fedex', 'FedEx US', 4),
]

const rows = flattenTree(folders)
check('T1 tous les dossiers sortent, une fois chacun', rows.length === 5 && new Set(rows.map(r => r.folder.id)).size === 5, rows.map(r => r.folder.id).join(','))
const pos = id => rows.findIndex(r => r.folder.id === id)
check('T2 un enfant suit son parent, à la profondeur +1', pos('fedex') > pos('fourn') && rows[pos('fedex')].depth === 1 && pos('fedex-us') > pos('fedex') && rows[pos('fedex-us')].depth === 2, JSON.stringify(rows.map(r => [r.folder.id, r.depth])))
check('T3 un orphelin (parent inconnu) remonte à la racine', rows[pos('orphan')].depth === 0)
check('T4 « dans sa propre branche » : soi-même et ses descendants, pas un frère', isWithin(folders, 'fourn', 'fourn') && isWithin(folders, 'fourn', 'fedex-us') && !isWithin(folders, 'fourn', 'clients') && !isWithin(folders, 'fedex', 'fourn'))
check('T5 chemin lisible', folderPath(folders, 'fedex-us') === 'Fournisseurs › FedEx › FedEx US' && folderPath(folders, null) === '', folderPath(folders, 'fedex-us'))
check('T6 compteur de branche = dossier + descendants', branchCount(folders, 'fourn') === 8 && branchCount(folders, 'clients') === 0, String(branchCount(folders, 'fourn')))

if (NEGATIVE) { console.log(fails ? `contrôle négatif : ${fails} refus tombés, comme attendu` : 'contrôle négatif : RIEN n’a échoué — le banc ne mesure pas'); process.exit(fails ? 0 : 1) }
console.log(fails ? `arbre GED : ${fails} FAIL` : 'arbre GED : OK')
process.exit(fails ? 1 : 0)
