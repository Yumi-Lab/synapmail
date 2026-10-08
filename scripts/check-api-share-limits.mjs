#!/usr/bin/env node
/**
 * Auto-contrôle du lot P16 : la permission de partage qu'exige une route ne s'écrit
 * pas en DEUX endroits qui peuvent diverger.
 *
 * Une route ouverte au Bearer dit deux fois ce qu'elle exige d'un partage : dans son
 * handler (`getAccessibleAccount(..., ['delete'])`) et dans `ROUTE_ACCOUNT_PERMISSION`
 * (`lib/apiScopes.ts`), que lit la barrière. Les deux DOIVENT dire la même chose. Si
 * la table est plus PERMISSIVE que le handler, le refus tombe au mauvais endroit et
 * ne nomme plus le partage ; si elle est plus SÉVÈRE, une clé se voit refuser un geste
 * que son partage autorisait. Ce contrôle lit les sources et refuse l'écart.
 *
 * Un handler n'appelle pas forcément `getAccessibleAccount` lui-même : il peut passer
 * son `required` à un intermédiaire qui le transmet TEL QUEL (`resolveFolder`). Ce
 * contrôle suit donc l'argument, pas le nom de la fonction — sinon il appellerait
 * « écart » une indirection parfaitement correcte, et on finirait par le désarmer.
 *
 * Il ne touche ni le réseau, ni la base : c'est une lecture de fichiers.
 *
 *   node scripts/check-api-share-limits.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

let failed = 0
const ok = label => console.log(`  ok   ${label}`)
const ko = (label, detail) => { failed++; console.log(`  KO   ${label}\n       ${detail}`) }

/** La table déclarée, lue telle qu'elle est écrite — pas importée : ce banc lit du texte. */
const scopes = readFileSync(join(ROOT, 'lib/apiScopes.ts'), 'utf8')
const block = scopes.match(/ROUTE_ACCOUNT_PERMISSION[^=]*=\s*\{([\s\S]*?)\n\}/)
if (!block) { console.log('  KO   ROUTE_ACCOUNT_PERMISSION introuvable dans lib/apiScopes.ts'); process.exit(1) }

const declared = new Map()
for (const m of block[1].matchAll(/'([A-Z]+) (\/api\/[^']+)':\s*'(\w+)'/g)) {
  declared.set(`${m[1]} ${m[2]}`, m[3])
}
declared.size ? ok(`${declared.size} route(s) déclarent une permission de partage`)
  : ko('la table est vide', 'aucune route déclarée : la barrière ne borne plus rien')

/**
 * Le chemin du fichier de route qui sert `METHOD /api/x/[id]`. Un segment entre
 * crochets est un dossier dynamique, exactement comme dans l'arborescence Next.
 */
const routeFile = path => join(ROOT, 'app', path, 'route.ts')

/**
 * Les fonctions qui transmettent leur `required` TEL QUEL à `getAccessibleAccount`.
 * Une entrée ici est une affirmation VÉRIFIÉE par ce banc plus bas (elle doit vraiment
 * transmettre), pas une dispense accordée sur parole.
 */
const FORWARDERS = { resolveFolder: 'lib/folderResolve.ts' }

for (const [name, file] of Object.entries(FORWARDERS)) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const forwards = /required:\s*AccountPermission\[\]/.test(src) &&
    /getAccessibleAccount\([^)]*required/.test(src)
  forwards
    ? ok(`${name} transmet bien son « required » à getAccessibleAccount`)
    : ko(`${name} ne transmet plus son « required »`, `${file} : les routes qui passent par lui ne bornent plus rien`)
}

/**
 * Ce que le handler de cette méthode exige RÉELLEMENT : le `required` qu'il passe à
 * `getAccessibleAccount`, directement ou via un transmetteur. On lit la portion du
 * fichier qui commence à la fonction servant cette méthode, car un même fichier sert
 * GET, PATCH et DELETE avec des exigences différentes — c'est l'écart qu'on traque.
 */
const ENFORCERS = ['getAccessibleAccount', ...Object.keys(FORWARDERS)]

function requiredInHandler(source, method) {
  const start = source.search(new RegExp(`(export )?async function ${method.toLowerCase()}Handler|export async function ${method}\\b`))
  if (start < 0) return { found: false }
  const rest = source.slice(start)
  const next = rest.slice(1).search(/\n(export )?async function /)
  const body = next < 0 ? rest : rest.slice(0, next + 1)
  const perms = new Set()
  for (const fn of ENFORCERS) {
    for (const c of body.matchAll(new RegExp(`${fn}\\((?:[^()\\[\\]]|\\([^()]*\\))*\\[([^\\]]*)\\]`, 'g'))) {
      for (const p of c[1].matchAll(/'(\w+)'/g)) perms.add(p[1])
    }
  }
  return { found: true, perms }
}

for (const [key, permission] of declared) {
  const [method, path] = key.split(' ')
  let source
  try { source = readFileSync(routeFile(path), 'utf8') } catch {
    ko(`${key} : fichier de route introuvable`, routeFile(path)); continue
  }
  const { found, perms } = requiredInHandler(source, method)
  if (!found) { ko(`${key} : aucun handler pour cette méthode`, routeFile(path)); continue }
  if (perms.has(permission)) { ok(`${key} exige « ${permission} » des deux côtés`); continue }
  // Un handler qui n'exige RIEN n'est pas en écart : il porte sa propre vérification
  // (`WHERE user_id = $1`, qui suffit à une session humaine) et laisse la borne du
  // partage à la barrière, seule traversée par une clé. C'est le cas des routes qui
  // agissent sur un OBJET (règle, signature) plutôt que sur une boîte nommée.
  // L'écart, le vrai, c'est de dire DEUX choses DIFFÉRENTES.
  if (!perms.size) { ok(`${key} : borné par la seule barrière (« ${permission} »)`); continue }
  ko(`${key} : la table dit « ${permission} », le handler exige ${[...perms].map(p => `« ${p} »`).join(', ')}`,
    'les deux doivent dire la même chose, sinon le refus tombe au mauvais endroit')
}

if (failed) { console.error(`\n${failed} écart(s)`); process.exit(1) }
console.log('\nbornes de partage par route : OK')
