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
  { id: 'account:1', section: 'accounts', label: 'Ada', hint: 'ada@example.com' },
]

/**
 * The THREE modes declared in the order of `lib/theme.ts` (light, dark, system),
 * with the keywords the real entries carry: that proximity is what once made the
 * dark keyword select the light entry from the keyboard, back when all three
 * shared a single keyword list.
 */
const THEME_ENTRIES = [
  { id: 'action:theme-light', section: 'actions', label: 'Thème clair', keywords: 'clair, light, jour, thème' },
  { id: 'action:theme-dark', section: 'actions', label: 'Thème sombre', keywords: 'sombre, dark, nuit, thème' },
  { id: 'action:theme-system', section: 'actions', label: 'Thème système', keywords: 'système, system, auto, automatique, thème' },
  { id: 'account:2', section: 'accounts', label: 'Ada', hint: 'ada@example.com' },
]
const ids = q => matchOmnibar(q, ENTRIES).map(e => e.id)

console.log('matchOmnibar')
check('vide ne propose rien', ids(''), [])
check('espaces seuls ne proposent rien', ids('   '), [])
check('mot-cle « api »', ids('api'), ['settings:api-keys'])
check('libelle accentue trouve sans accent', ids('theme'), ['action:theme-dark', 'settings:appearance'])
check('saisie accentuee trouve le mot-cle plat', ids('thème'), ['action:theme-dark', 'settings:appearance'])
check('compte par son nom', ids('ada'), ['account:1'])
check('compte par son adresse', ids('example'), ['account:1'])
check('deux mots, ordre indifferent', ids('api cles'), ['settings:api-keys'])
check('deux mots dont un absent', ids('api ada'), [])
check('casse indifferente', ids('CLÉS'), ['settings:api-keys'])
// "m" is present in all four entries (ada@example.coM, theMe, Mcp, theMe), so the
// order really is the SECTION order and not a side effect of the filter.
check('ordre des sections : comptes, actions, reglages',
  matchOmnibar('m', ENTRIES).map(e => e.section),
  ['accounts', 'actions', 'settings', 'settings'])
check('sections declarees dans cet ordre', [...OMNIBAR_SECTIONS], ['accounts', 'actions', 'settings'])

// --- Ce que la saisie NOMME passe en tete ---
// An entry whose LABEL carries the whole query comes before those matching by
// keyword only: otherwise "dark" + Enter would apply the LIGHT theme.
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
check('« ada » propose la boite en premier', themeIds('ada')[0], 'account:2')

// Label ranking is a rule IN ITS OWN RIGHT, not a side effect of keywords: here
// BOTH entries carry "sombre" among their keywords, so the filter keeps both and
// ONLY the label can order them.
const SHARED = [
  { id: 'a:premier', section: 'actions', label: 'Réglage clair', keywords: 'sombre, clair' },
  { id: 'a:second', section: 'actions', label: 'Réglage sombre', keywords: 'sombre, clair' },
]
check('a mots-cles egaux, le libelle qui NOMME la saisie passe devant',
  matchOmnibar('sombre', SHARED).map(e => e.id), ['a:second', 'a:premier'])

// --- Source UNIQUE des entrees de reglages ---
console.log('source des reglages')
const NAV_SRC = readFileSync(new URL('../components/settings/SettingsSidebar.tsx', import.meta.url), 'utf8')
const navBlock = NAV_SRC.slice(NAV_SRC.indexOf('export const SETTINGS_NAV'), NAV_SRC.indexOf('] as const', NAV_SRC.indexOf('export const SETTINGS_NAV')))
const navKeys = [...navBlock.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1])
check('la table de navigation est exportee et non vide', navKeys.length > 0, true)

const OMNIBAR_SRC = readFileSync(new URL('../components/layout/Omnibar.tsx', import.meta.url), 'utf8')
check('l\'omnibar lit SETTINGS_NAV au lieu de recopier les entrees',
  /SETTINGS_NAV/.test(OMNIBAR_SRC), true)

for (const code of ['en', 'fr', 'zh']) {
  const L = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'))
  const missingLabel = navKeys.filter(k => !L.settings?.nav?.[k])
  check(`${code} : chaque entree a son libelle`, missingLabel, [])
  const missingKeywords = navKeys.filter(k => !L.omnibar?.keywords?.[k])
  check(`${code} : chaque entree a ses mots-cles`, missingKeywords, [])
  // Chaque mode de theme a SA liste : une liste partagee reintroduirait le defaut.
  const themeKeywordKeys = ['themeLightKeywords', 'themeDarkKeywords', 'themeSystemKeywords']
  const lists = themeKeywordKeys.map(k => L.omnibar?.[k])
  check(`${code} : chaque theme a ses propres mots-cles`, lists.filter(Boolean).length, 3)
  check(`${code} : les trois listes de theme sont distinctes`, new Set(lists).size, 3)
}

console.log(failed ? `\nKO (${failed})` : '\nOK')
process.exit(failed ? 1 : 0)
