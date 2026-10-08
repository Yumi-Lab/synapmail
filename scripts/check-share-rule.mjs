#!/usr/bin/env node
/**
 * Auto-contrôle du lot S6 : « un partage donne accès MAINTENANT » ne s'écrit
 * qu'UNE fois.
 *
 * La règle vivait en quatre exemplaires (`lib/accountAccess.ts`, la liste des
 * comptes, la recherche « Toutes les boîtes », `lib/subscriptions.ts`). Un
 * partage qui gagnerait un état ou une date demandait quatre corrections, et
 * celle qu'on oublie ouvre une boîte qu'on croyait fermée. Ce contrôle lit les
 * sources et REFUSE toute nouvelle copie.
 *
 * Il ne touche ni le réseau, ni la base : c'est une lecture de fichiers.
 *
 *   node scripts/check-share-rule.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
/** Le seul fichier autorisé à ÉPELER la condition d'un partage actif. */
const SOURCE = 'lib/accountAccess.ts'
/** Le nom sous lequel les autres la réutilisent. */
const EXPORT_NAME = 'ACTIVE_SHARE_SQL'

/**
 * Ce qu'on traque : le test d'état d'un partage écrit à la main, sous l'une ou
 * l'autre de ses formes (guillemets simples ou doubles, alias quelconque).
 */
const COPY = /\.status\s*=\s*['"]active['"]|expires_at\s+IS\s+NULL\s+OR/i
/** Le nom sous lequel la seule clause de date se réutilise. */
const EXPIRY_EXPORT = 'SHARE_NOT_EXPIRED_SQL'

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

let failed = 0
const ok = label => console.log(`  ok   ${label}`)
const ko = (label, detail) => { failed++; console.log(`  KO   ${label}\n       ${detail}`) }

const files = ['app', 'lib', 'components'].flatMap(d => sources(join(ROOT, d)))

// 1. La source existe et exporte la règle.
const source = readFileSync(join(ROOT, SOURCE), 'utf8')
for (const name of [EXPORT_NAME, EXPIRY_EXPORT]) {
  if (source.includes(`export const ${name}`)) ok(`${SOURCE} exporte ${name}`)
  else ko(`${SOURCE} doit exporter ${name}`, 'la règle n\'a plus de source unique')
}

// 2. La règle épelée ne se trouve NULLE PART ailleurs.
const copies = []
for (const file of files) {
  const rel = relative(ROOT, file)
  if (rel === SOURCE) continue
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    if (COPY.test(line)) copies.push(`${rel}:${i + 1}: ${line.trim()}`)
  })
}
if (!copies.length) ok('la condition « partage actif » ne s\'écrit nulle part ailleurs')
else ko('copie(s) de la règle trouvée(s)', copies.join('\n       '))

// 3. Contrôle NÉGATIF : le détecteur reconnaîtrait bien une copie réintroduite.
const REINTRODUCED = [
  "WHERE sh.invitee_user_id = $1 AND sh.status = 'active'",
  'AND (s.expires_at IS NULL OR s.expires_at > NOW())',
  'AND x.status = "active"',
]
const missed = REINTRODUCED.filter(line => !COPY.test(line))
if (!missed.length) ok('contrôle négatif : une copie réintroduite serait bien vue')
else ko('contrôle négatif RATÉ', `non détecté : ${missed.join(' | ')}`)

// 4. Les trois consommateurs passent bien par la source.
const CONSUMERS = {
  'app/api/accounts/route.ts': EXPORT_NAME,
  'app/api/messages/search/route.ts': 'listAccessibleAccounts',
  'lib/subscriptions.ts': 'listAccessibleAccounts',
  // Une invitation EN ATTENTE n'est pas un accès : elle garde son propre état,
  // mais ne réécrit pas la clause de date.
  'app/api/invites/[token]/route.ts': EXPIRY_EXPORT,
}
for (const [file, symbol] of Object.entries(CONSUMERS)) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  if (text.includes(symbol)) ok(`${file} réutilise ${symbol}`)
  else ko(`${file} devrait réutiliser ${symbol}`, 'il a probablement réécrit la règle')
}

console.log(failed ? `check-share-rule: ${failed} KO` : 'check-share-rule: OK')
process.exit(failed ? 1 : 0)
