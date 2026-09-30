/**
 * Ce qui permet à un banc d'importer un module de `lib/` tel qu'il est écrit.
 *
 * L'application est compilée par un bundler, qui résout `./html` en `./html.ts` ; le
 * résolveur ESM de Node, lui, exige l'extension. Sans ce crochet, un banc ne pourrait
 * importer un module de `lib/` qu'en l'obligeant à écrire ses propres imports autrement
 * que le reste du code — le banc dicterait sa forme au produit qu'il mesure, et ce qui
 * serait mesuré ne serait plus tout à fait ce qui tourne.
 *
 * À importer AVANT le module à mesurer, donc à charger en premier, et le module à mesurer
 * par `await import(...)` : un `import` statique serait résolu avant que ce crochet ne soit
 * posé.
 *
 *   import './lib/ts-resolve.mjs'
 *   const { askEngine } = await import('../lib/tagging/engine.ts')
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'

const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js']

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of EXTENSIONS) {
        if (existsSync(new URL(specifier + ext, context.parentURL))) return nextResolve(specifier + ext, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
