/**
 * Le résolveur d'alias `@/…` pour les BANCS.
 *
 * Next.js résout `@/lib/x` via `tsconfig.json` (`paths`), mais `node` ne lit pas ce
 * fichier : un module de `lib/` qui utilise l'alias est donc IMPORTABLE par l'application
 * et PAS par un banc. Plutôt que de changer la convention d'import du code produit pour
 * complaire au banc — ce serait laisser l'outil de mesure dicter la forme du code mesuré —
 * c'est le banc qui apprend l'alias, ici, en un seul endroit.
 *
 * Le préfixe est lu dans `tsconfig.json` : il n'est écrit nulle part ailleurs, donc le
 * jour où il change, les bancs suivent sans qu'on y touche.
 *
 *   import './alias-resolver.mjs'   // AVANT tout import de `lib/…` qui utilise l'alias
 */
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { compilerOptions } = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))

/** `{"@/*": ["./*"]}` -> `[['@/', './']]`, la seule lecture de cette configuration. */
const ALIASES = Object.entries(compilerOptions?.paths ?? {})
  .filter(([from, to]) => from.endsWith('/*') && to?.[0]?.endsWith('/*'))
  .map(([from, to]) => [from.slice(0, -1), to[0].slice(0, -1)])

registerHooks({
  resolve(specifier, context, next) {
    for (const [prefix, target] of ALIASES) {
      if (!specifier.startsWith(prefix)) continue
      const base = join(ROOT, target, specifier.slice(prefix.length))
      // `node` exige l'extension ; l'alias n'en porte pas, comme dans le code produit.
      const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(existsSync)
      if (!resolved) break
      return next(pathToFileURL(resolved).href, context)
    }
    return next(specifier, context)
  },
})
