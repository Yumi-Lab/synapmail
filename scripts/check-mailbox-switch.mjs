#!/usr/bin/env node
/**
 * Auto-contrôle de l'URL écrite quand on CHANGE de boîte aux lettres
 * (`app/(app)/mail/mailboxUrl.ts`) : la nouvelle boîte s'ouvre sur SA réception,
 * et une recherche ne survit que si elle couvrait déjà toutes les boîtes.
 *
 * Fonction PURE : ni réseau, ni serveur, ni compte — le fichier testé est importé.
 *
 *   node --experimental-strip-types scripts/check-mailbox-switch.mjs
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'

// Le module testé, comme `lib/search.ts`, importe ses voisins SANS extension
// (résolution du bundler). Le résolveur de Node veut l'extension : ce crochet
// l'ajoute. Il appartient au banc, jamais au produit — même crochet que
// `scripts/check-search-parse.mjs`.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) {
      const url = new URL(`${spec}.ts`, ctx.parentURL)
      if (existsSync(url)) return next(url.href, ctx)
    }
    return next(spec, ctx)
  },
})

const { mailboxSwitchHref, FOLDER_PARAM, DEFAULT_FOLDER, ACCOUNT_CHANGE_EVENT } =
  await import(new URL('../app/(app)/mail/mailboxUrl.ts', import.meta.url).href)
const { SCOPE_PARAM, SEARCH_PARAM, SCOPE_ACCOUNTS, SCOPE_ALL, SCOPE_FOLDER, MIN_QUERY_LENGTH } =
  await import(new URL('../lib/search.ts', import.meta.url).href)
const { MAIL_PATH } = await import(new URL('../lib/compose.ts', import.meta.url).href)

let failed = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`)
  failed++
}

/** Les paramètres de l'URL rendue, pour juger sur le CONTENU et non sur l'ordre. */
const paramsOf = href => Object.fromEntries(new URL(href, 'http://x').searchParams)

console.log('le dossier part, quelle que soit sa forme')
check('un dossier personnalisé est retiré',
  mailboxSwitchHref(`${FOLDER_PARAM}=Clients%2F2026`), MAIL_PATH)
check('la réception explicite est retirée aussi (URL nue)',
  mailboxSwitchHref(`${FOLDER_PARAM}=${DEFAULT_FOLDER}`), MAIL_PATH)
check('une URL déjà nue reste nue', mailboxSwitchHref(''), MAIL_PATH)
check('un dossier accentué est retiré',
  mailboxSwitchHref(`${FOLDER_PARAM}=${encodeURIComponent('Objets envoyés')}`), MAIL_PATH)
check('accepte un URLSearchParams comme une chaîne',
  mailboxSwitchHref(new URLSearchParams({ [FOLDER_PARAM]: 'Archive' })), MAIL_PATH)
check('un « ? » de tête ne fabrique pas un paramètre vide',
  mailboxSwitchHref(`?${FOLDER_PARAM}=Archive`), MAIL_PATH)

console.log('la recherche ne survit que si elle couvrait déjà toutes les boîtes')
check('portée « toutes les boîtes » : gardée, sans le dossier',
  paramsOf(mailboxSwitchHref(`${FOLDER_PARAM}=Clients&${SEARCH_PARAM}=facture&${SCOPE_PARAM}=${SCOPE_ACCOUNTS}`)),
  { [SEARCH_PARAM]: 'facture', [SCOPE_PARAM]: SCOPE_ACCOUNTS })
check('portée « tous les dossiers » : retirée avec le dossier',
  mailboxSwitchHref(`${FOLDER_PARAM}=Clients&${SEARCH_PARAM}=facture&${SCOPE_PARAM}=${SCOPE_ALL}`), MAIL_PATH)
check('portée « ce dossier » explicite : retirée',
  mailboxSwitchHref(`${SEARCH_PARAM}=facture&${SCOPE_PARAM}=${SCOPE_FOLDER}`), MAIL_PATH)
check('portée absente (donc « ce dossier ») : retirée',
  mailboxSwitchHref(`${SEARCH_PARAM}=facture`), MAIL_PATH)
check('portée inconnue : traitée comme « ce dossier », donc retirée',
  mailboxSwitchHref(`${SEARCH_PARAM}=facture&${SCOPE_PARAM}=galaxie`), MAIL_PATH)
check('une portée « toutes les boîtes » SANS requête ne laisse rien derrière elle',
  mailboxSwitchHref(`${SCOPE_PARAM}=${SCOPE_ACCOUNTS}`), MAIL_PATH)
check('une requête trop courte pour chercher ne survit pas',
  mailboxSwitchHref(`${SEARCH_PARAM}=${'a'.repeat(MIN_QUERY_LENGTH - 1)}&${SCOPE_PARAM}=${SCOPE_ACCOUNTS}`), MAIL_PATH)
check('une requête faite d\'espaces ne survit pas',
  mailboxSwitchHref(`${SEARCH_PARAM}=${encodeURIComponent('   ')}&${SCOPE_PARAM}=${SCOPE_ACCOUNTS}`), MAIL_PATH)

console.log('les autres paramètres sont conservés tels quels')
check('un paramètre étranger traverse, le dossier non',
  paramsOf(mailboxSwitchHref(`${FOLDER_PARAM}=Clients&compose=1`)), { compose: '1' })

console.log('l\'événement et le dossier par défaut sont ceux du reste du dépôt')
check('événement du sélecteur de comptes', ACCOUNT_CHANGE_EVENT, 'synapmail:account-change')
check('dossier par défaut', DEFAULT_FOLDER, 'INBOX')

console.log(failed === 0 ? 'check-mailbox-switch : OK' : `check-mailbox-switch : ${failed} ÉCHEC(S)`)
process.exit(failed === 0 ? 0 : 1)
