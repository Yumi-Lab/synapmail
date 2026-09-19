#!/usr/bin/env node
/**
 * Défaut 1 du gate H3e : un refus des routes `/api/folders*` doit porter un corps
 * LISIBLE à chaque requête, pas seulement à la première de la vie du processus.
 *
 * Le corps d'une `Response` ne se lit qu'UNE fois. Une réponse gardée dans une
 * constante de module est donc vide dès le deuxième refus, et l'écran — qui affiche
 * `error` dans `data-folder-error` — n'a plus rien à montrer. Ce banc rejoue le MÊME
 * refus trois fois et exige les trois corps.
 *
 *   node --experimental-strip-types scripts/check-folder-refusals.mjs
 */
import assert from 'node:assert/strict'
import { FOLDER_REFUSALS, refuse } from '../lib/folderActions.ts'

const KINDS = Object.keys(FOLDER_REFUSALS)
assert.ok(KINDS.length > 0, 'aucun refus déclaré')

// Trois refus IDENTIQUES consécutifs : les trois portent le même JSON lisible.
for (const kind of KINDS) {
  const { error, status } = FOLDER_REFUSALS[kind]
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = refuse(kind)
    assert.equal(res.status, status, `${kind} #${attempt} : statut ${res.status}, attendu ${status}`)
    const body = await res.json()
    assert.deepEqual(body, { error }, `${kind} #${attempt} : corps ${JSON.stringify(body)}, attendu {"error":"${error}"}`)
  }
}

// Deux refus successifs sont bien deux objets DISTINCTS — sinon le corps est partagé.
assert.notEqual(refuse('notFound'), refuse('notFound'), 'refuse() rend deux fois la même réponse')

// Aucune route de dossier ne garde une réponse de refus dans une constante de module.
// C'est le motif exact qui a produit le défaut : on l'interdit à la source.
const { readFileSync } = await import('node:fs')
for (const file of ['../app/api/folders/route.ts', '../app/api/folders/actions/route.ts']) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
  const hoisted = src.match(/^const\s+\w+\s*=\s*NextResponse\.json\(/m)
  assert.equal(hoisted, null, `${file} garde une réponse dans une constante de module : ${hoisted?.[0]}`)
}

console.log(`check-folder-refusals: OK (${KINDS.length} refus × 3 requêtes)`)
