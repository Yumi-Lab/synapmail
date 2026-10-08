/**
 * La connexion ne doit JAMAIS dépendre de la casse de l'identifiant.
 * Deux garde-fous : le normalisateur fait ce qu'il dit, et aucune comparaison
 * d'identifiant saisi ne revient à un `email = $1` sensible à la casse.
 */
import { readFileSync } from 'fs'
import { normalizeEmail } from '../lib/emailAddress.ts'

let failed = 0
const check = (ok, label) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failed++ }

check(normalizeEmail('Bruno@3D-Expert.FR') === 'bruno@3d-expert.fr', 'la casse tombe')
check(normalizeEmail('  bruno@3d-expert.fr  ') === 'bruno@3d-expert.fr', 'les espaces autour tombent')
check(normalizeEmail(normalizeEmail('BRUNO@X.FR')) === normalizeEmail('BRUNO@X.FR'), 'normaliser deux fois ne change rien')

// Toute recherche d'un utilisateur par une adresse TAPÉE compare en minuscules.
const sources = [
  'lib/auth.ts',
  'app/api/register/route.ts',
  'app/api/accounts/[id]/shares/route.ts',
]
for (const file of sources) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const sensibles = [...src.matchAll(/FROM users WHERE\s+email\s*=/gi)]
  check(sensibles.length === 0, `${file} : aucune comparaison d'identifiant sensible à la casse`)
}
// Le normalisateur est la seule source : personne ne recopie trim().toLowerCase() sur une adresse.
for (const file of [...sources, 'app/api/contacts/route.ts']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  check(!/email[^\n]*\.trim\(\)\.toLowerCase\(\)/.test(src), `${file} : pas de copie du normalisateur`)
}

console.log(failed ? `check-login-case : ${failed} echec(s)` : 'check-login-case : ok')
process.exit(failed ? 1 : 0)
