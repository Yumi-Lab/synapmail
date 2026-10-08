#!/usr/bin/env node
/**
 * Auto-controle de la moitie PURE du filtre de boites (`lib/accountFilter.ts`) :
 * expression reguliere valide, expression invalide qui retombe sur le texte simple,
 * accents, casse, bornage de la saisie.
 *
 * Aucun reseau, aucun serveur, aucun compte.
 *   node --experimental-strip-types scripts/check-account-filter.mjs
 *   node --experimental-strip-types scripts/check-account-filter.mjs --break   (controle negatif)
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'

// `lib/accountFilter.ts` imports './omnibarCommands' without an extension (bundler
// resolution). Node's resolver needs it — ce crochet est du BANC, jamais du produit.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) {
      const url = new URL(`${spec}.ts`, ctx.parentURL)
      if (existsSync(url)) return next(url.href, ctx)
    }
    return next(spec, ctx)
  },
})

const { filterAccounts, ACCOUNT_FILTER_MAX } =
  await import(new URL('../lib/accountFilter.ts', import.meta.url).href)

const BREAK = process.argv.includes('--break')

/** Le filtre d'AVANT le lot : `includes` sur l'adresse et le nom, sans repli d'accent. */
const legacyFilter = (q, accounts) => {
  const needle = q.trim().toLowerCase()
  return accounts.filter(a => !needle || a.email.toLowerCase().includes(needle) || (a.name ?? '').toLowerCase().includes(needle))
}
const filter = BREAK ? legacyFilter : filterAccounts

const ACCOUNTS = [
  { email: 'bruno@yumi-lab.com', name: 'Bruno' },
  { email: 'marie@yumi-lab.com', name: 'Marie Thérèse' },
  { email: 'contact@yumi-lab.com', name: null },
  { email: 'qa@example.org', name: 'QA' },
]

let failed = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}\n       attendu ${e}\n       obtenu  ${a}`)
  failed++
}
const mails = res => res.map(a => a.email)

console.log('expression reguliere')
check('ancrage + alternative `^m|bru`', mails(filter('^m|bru', ACCOUNTS)), ['bruno@yumi-lab.com', 'marie@yumi-lab.com'])
check('classe `[bq]`', mails(filter('^[bq]', ACCOUNTS)), ['bruno@yumi-lab.com', 'qa@example.org'])
check('fin de chaine `org$`', mails(filter('org$', ACCOUNTS)), ['qa@example.org'])

console.log('repli casse et accents')
check('casse repliee `BRUNO`', mails(filter('BRUNO', ACCOUNTS)), ['bruno@yumi-lab.com'])
check('accent tape sans accent `therese`', mails(filter('therese', ACCOUNTS)), ['marie@yumi-lab.com'])
check('accent tape avec accent `Thérèse`', mails(filter('Thérèse', ACCOUNTS)), ['marie@yumi-lab.com'])

console.log('expression invalide -> texte simple')
check('`bruno(` retombe sur le texte', mails(filter('bruno(', ACCOUNTS)), [])
check('`yumi(` ne jette pas', mails(filter('yumi(', ACCOUNTS)), [])
check('`qa@example.org` litteral', mails(filter('qa@example.org', ACCOUNTS)), ['qa@example.org'])

console.log('saisie vide et bornage')
check('vide rend tout', mails(filter('', ACCOUNTS)), mails(ACCOUNTS))
check('espaces seuls rendent tout', mails(filter('   ', ACCOUNTS)), mails(ACCOUNTS))
check(`saisie bornee a ${ACCOUNT_FILTER_MAX}`, mails(filter('bruno' + 'x'.repeat(ACCOUNT_FILTER_MAX), ACCOUNTS)), [])
check('nom absent ne jette pas', mails(filter('contact', ACCOUNTS)), ['contact@yumi-lab.com'])

if (BREAK) {
  if (failed === 0) { console.error('check-account-filter --break : ROUGE ATTENDU, tout est passe'); process.exit(1) }
  console.log(`check-account-filter --break : rouge comme attendu (${failed} echecs)`)
  process.exit(0)
}
if (failed > 0) { console.error(`check-account-filter : ${failed} echec(s)`); process.exit(1) }
console.log('check-account-filter: OK')
