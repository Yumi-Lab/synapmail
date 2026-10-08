#!/usr/bin/env node
/**
 * Auto-controle de la moitie PURE du panneau de l'omnibar (`lib/omnibarCommands.ts`) :
 * ce qui correspond a une saisie, insensible a la casse ET aux accents, et dans quel
 * ordre les sections sortent.
 *
 * Verifie aussi que la source des entrees de reglages est UNIQUE : la table exportee
 * par `components/settings/SettingsSidebar.tsx` (SETTINGS_NAV), et que chaque entree
 * a bien son libelle dans les TROIS langues, faute de quoi elle serait introuvable
 * dans l'une d'elles.
 *
 * Aucun reseau, aucun serveur, aucun compte.
 *   node --experimental-strip-types scripts/check-omnibar-commands.mjs
 */
import { readFileSync } from 'node:fs'

const { matchOmnibar, foldText, OMNIBAR_SECTIONS } =
  await import(new URL('../lib/omnibarCommands.ts', import.meta.url).href)

let failed = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}\n       attendu ${e}\n       obtenu  ${a}`)
  failed++
}

console.log('foldText')
check('accents retires', foldText('Thème'), 'theme')
check('casse repliee', foldText('Clés API'), 'cles api')
check('deja plat', foldText('api'), 'api')

const ENTRIES = [
  { id: 'settings:api-keys', section: 'settings', label: 'Clés API', hint: '/settings/api-keys', keywords: 'api, clé, token, bearer, mcp' },
  { id: 'settings:appearance', section: 'settings', label: 'Apparence', hint: '/settings/appearance', keywords: 'thème, theme, dark, sombre, clair, langue' },
  { id: 'action:theme-dark', section: 'actions', label: 'Thème sombre', keywords: 'dark, sombre' },
  { id: 'account:1', section: 'accounts', label: 'Bruno', hint: 'bruno@yumi-lab.com' },
]

/**
 * Les TROIS modes declares dans l'ordre de `lib/theme.ts` (clair, sombre, systeme),
 * avec les mots-cles que portent les vraies entrees : c'est ce voisinage qui a
 * produit le defaut du lot H3f (« sombre » designait « Thème clair » au clavier,
 * les trois partageant alors une seule liste de mots-cles).
 */
const THEME_ENTRIES = [
  { id: 'action:theme-light', section: 'actions', label: 'Thème clair', keywords: 'clair, light, jour, thème' },
  { id: 'action:theme-dark', section: 'actions', label: 'Thème sombre', keywords: 'sombre, dark, nuit, thème' },
  { id: 'action:theme-system', section: 'actions', label: 'Thème système', keywords: 'système, system, auto, automatique, thème' },
  { id: 'account:2', section: 'accounts', label: 'Bruno', hint: 'bruno@yumi-lab.com' },
]
const ids = q => matchOmnibar(q, ENTRIES).map(e => e.id)

console.log('matchOmnibar')
check('vide ne propose rien', ids(''), [])
check('espaces seuls ne proposent rien', ids('   '), [])
check('mot-cle « api »', ids('api'), ['settings:api-keys'])
check('libelle accentue trouve sans accent', ids('theme'), ['action:theme-dark', 'settings:appearance'])
check('saisie accentuee trouve le mot-cle plat', ids('thème'), ['action:theme-dark', 'settings:appearance'])
check('compte par son nom', ids('bruno'), ['account:1'])
check('compte par son adresse', ids('yumi-lab'), ['account:1'])
check('deux mots, ordre indifferent', ids('api cles'), ['settings:api-keys'])
check('deux mots dont un absent', ids('api bruno'), [])
check('casse indifferente', ids('CLÉS'), ['settings:api-keys'])
// « m » est present dans les quatre entrees (bruno@yumi-lab.coM, theMe, Mcp, theMe),
// donc le tri est bien celui des SECTIONS et non un effet du filtre.
check('ordre des sections : comptes, actions, reglages',
  matchOmnibar('m', ENTRIES).map(e => e.section),
  ['accounts', 'actions', 'settings', 'settings'])
check('sections declarees dans cet ordre', [...OMNIBAR_SECTIONS], ['accounts', 'actions', 'settings'])

// --- Ce que la saisie NOMME passe en tete ---
// Une entree dont le LIBELLE porte toute la saisie precede celles qui ne
// correspondent que par mot-cle : sinon « sombre » + Entree applique le theme CLAIR.
console.log('ce que la saisie nomme passe en tete')
const themeIds = q => matchOmnibar(q, THEME_ENTRIES).map(e => e.id)
check('« sombre » propose le theme sombre en premier', themeIds('sombre')[0], 'action:theme-dark')
check('« dark » propose le theme sombre en premier', themeIds('dark')[0], 'action:theme-dark')
check('« clair » propose le theme clair en premier', themeIds('clair')[0], 'action:theme-light')
check('« light » propose le theme clair en premier', themeIds('light')[0], 'action:theme-light')
check('« systeme » propose le theme systeme en premier', themeIds('systeme')[0], 'action:theme-system')
check('« theme » garde l\'ordre de declaration',
  themeIds('theme'), ['action:theme-light', 'action:theme-dark', 'action:theme-system'])
// Le rang par libelle ne prime JAMAIS la section : une boite reste avant une action.
check('« bruno » propose la boite en premier', themeIds('bruno')[0], 'account:2')

// Le rang par libelle est une regle A PART ENTIERE, pas un effet des mots-cles :
// ici les DEUX entrees portent « sombre » dans leurs mots-cles, donc le filtre les
// garde toutes les deux et SEUL le libelle peut les departager.
const SHARED = [
  { id: 'a:premier', section: 'actions', label: 'Réglage clair', keywords: 'sombre, clair' },
  { id: 'a:second', section: 'actions', label: 'Réglage sombre', keywords: 'sombre, clair' },
]
check('a mots-cles egaux, le libelle qui NOMME la saisie passe devant',
  matchOmnibar('sombre', SHARED).map(e => e.id), ['a:second', 'a:premier'])

// --- Source UNIQUE des entrees de reglages ---
console.log('source des reglages')
const NAV_SRC = readFileSync(new URL('../components/settings/SettingsSidebar.tsx', import.meta.url), 'utf8')
/** Les cles d'une table `… = [ … ] as const` de la barre des reglages. */
const navTableKeys = name => {
  const from = NAV_SRC.indexOf(`export const ${name}`)
  const block = NAV_SRC.slice(from, NAV_SRC.indexOf('] as const', from))
  return [...block.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1])
}
const navKeys = navTableKeys('SETTINGS_NAV')
check('la table de navigation est exportee et non vide', navKeys.length > 0, true)

// Lot H3h : les entrees d'administration vivent dans LEUR table, meme forme et meme
// role de source unique — la barre des reglages les rend, l'omnibar les propose.
const adminKeys = navTableKeys('ADMIN_NAV')
check('la table d\'administration est exportee et non vide', adminKeys.length > 0, true)
check('« nom et icone de l\'onglet » y figure', adminKeys.includes('branding'), true)

const OMNIBAR_SRC = readFileSync(new URL('../components/layout/Omnibar.tsx', import.meta.url), 'utf8')
check('l\'omnibar lit SETTINGS_NAV au lieu de recopier les entrees',
  /SETTINGS_NAV/.test(OMNIBAR_SRC), true)
check('l\'omnibar lit ADMIN_NAV au lieu de recopier les entrees admin',
  /ADMIN_NAV/.test(OMNIBAR_SRC), true)
// Ces entrees ne sont PROPOSEES qu'a un administrateur : le rendu est garde par le role.
check('les entrees admin de l\'omnibar sont gardees par le role',
  /isAdmin \? ADMIN_NAV : \[\]/.test(OMNIBAR_SRC), true)

// L'ancre de la section reglee est PARTAGEE, jamais recopiee : la barre batit son
// lien avec `BRANDING_ANCHOR`, que la section porte.
check('la barre des reglages batit le lien admin avec l\'ancre partagee',
  /BRANDING_ANCHOR/.test(NAV_SRC), true)
const BRANDING_SRC = readFileSync(new URL('../components/admin/BrandingSection.tsx', import.meta.url), 'utf8')
check('la section porte l\'ancre qu\'elle exporte',
  /export const BRANDING_ANCHOR/.test(BRANDING_SRC) && /id=\{BRANDING_ANCHOR\}/.test(BRANDING_SRC), true)

// --- Lot H4a : l'identite d'instance se regle dans APPARENCE, en UN seul exemplaire ---
console.log('identite d\'instance (lot H4a)')
const APPEARANCE_SRC = readFileSync(new URL('../app/(app)/settings/appearance/page.tsx', import.meta.url), 'utf8')
check('Apparence rend la section d\'identite',
  /<BrandingSection \/>/.test(APPEARANCE_SRC), true)
// Nicolas l'a cherchee deux fois dans Apparence : l'entree admin doit y MENER,
// pas vers la page d'administration ou rien ne la nomme.
check('l\'entree « nom et icone de l\'onglet » mene a Apparence',
  /key: 'branding'/.test(NAV_SRC) && /\$\{APPEARANCE_HREF\}#\$\{BRANDING_ANCHOR\}/.test(NAV_SRC), true)
check('le chemin d\'Apparence s\'ecrit en UN seul endroit',
  (NAV_SRC.match(/'\/settings\/appearance'/g) ?? []).length, 1)
// « JAMAIS deux copies » : une seule surface monte le composant.
const MOUNTS = ['app/(app)/settings/appearance/page.tsx', 'app/(app)/admin/users/page.tsx']
  .filter(f => /<BrandingSection \/>/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')))
check('la section n\'est montee qu\'a UN endroit', MOUNTS, ['app/(app)/settings/appearance/page.tsx'])
// Un non-administrateur ne voit rien de plus dans Apparence : le rendu est garde par le role.
check('le rendu dans Apparence est garde par le role',
  /isAdmin && <BrandingSection \/>/.test(APPEARANCE_SRC), true)
// Le role se lit par le hook partage, jamais recopie surface par surface.
check('Apparence lit le role par le hook partage', /useIsAdmin\(\)/.test(APPEARANCE_SRC), true)
for (const f of ['components/layout/Omnibar.tsx', 'components/settings/SettingsModal.tsx']) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  check(`${f} lit le role par le hook partage`,
    /useIsAdmin\(\)/.test(src) && !/role\?: string/.test(src), true)
}

for (const code of ['en', 'fr', 'zh']) {
  const L = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'))
  // Les deux tables passent le MEME controle : une entree admin sans libelle ou
  // sans mots-cles serait invisible a la saisie, exactement le defaut du lot H3h.
  const allKeys = [...navKeys, ...adminKeys]
  const missingLabel = allKeys.filter(k => !L.settings?.nav?.[k])
  check(`${code} : chaque entree a son libelle`, missingLabel, [])
  const missingKeywords = allKeys.filter(k => !L.omnibar?.keywords?.[k])
  check(`${code} : chaque entree a ses mots-cles`, missingKeywords, [])
  // Chaque mode de theme a SA liste : une liste partagee reintroduirait le defaut.
  const themeKeywordKeys = ['themeLightKeywords', 'themeDarkKeywords', 'themeSystemKeywords']
  const lists = themeKeywordKeys.map(k => L.omnibar?.[k])
  check(`${code} : chaque theme a ses propres mots-cles`, lists.filter(Boolean).length, 3)
  check(`${code} : les trois listes de theme sont distinctes`, new Set(lists).size, 3)
}

console.log(failed ? `\nKO (${failed})` : '\nOK')
process.exit(failed ? 1 : 0)
