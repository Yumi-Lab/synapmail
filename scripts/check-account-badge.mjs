#!/usr/bin/env node
/**
 * VERROU anti-rechute du lot M7c : la couleur et la bulle d'une boîte ont UNE source.
 *
 * PUR : aucun réseau, aucun serveur, aucune base. Le script lit les fichiers de `app/`
 * et `components/` et échoue si, HORS des trois fichiers qui ont le droit de les
 * porter, un fichier :
 *   1. écrit une couleur de boîte en dur (`#6366f1`, le vieux repli) ;
 *   2. porte sa PROPRE palette de couleurs de boîte (plusieurs hex dans un tableau) ;
 *   3. lit la VIEILLE colonne `color` d'une boîte (`a.color`, `account.color`, `SELECT … color`) ;
 *   4. dessine une bulle de boîte à la main au lieu d'`AccountAvatar`.
 *
 *   node scripts/check-account-badge.mjs
 *   node scripts/check-account-badge.mjs --break   (contrôle négatif : réinjecte l'ancien
 *                                                   sélecteur du tableau de bord → rouge)
 *
 * Le `--break` n'écrit RIEN sur le disque : il ajoute en mémoire un faux fichier portant
 * exactement ce que le lot a supprimé. Une batterie qui ne peut pas échouer ne prouve rien.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SCANNED = ['app', 'components']

/**
 * Les SEULS fichiers autorisés à porter une couleur de boîte ou à dessiner sa bulle.
 * Toute autre surface passe par eux — c'est la définition de « une seule source ».
 */
const OWNERS = [
  join('components', 'layout', 'AccountAvatar.tsx'),
  join('components', 'settings', 'AccountColorPicker.tsx'),
]

/** Le vieux repli codé en dur, supprimé par le lot : il ne doit jamais revenir. */
const LEGACY_FALLBACK = '#6366f1'

const RULES = [
  {
    id: 'repli codé en dur',
    test: src => src.includes(LEGACY_FALLBACK),
    hint: `\`${LEGACY_FALLBACK}\` : la couleur vient d'\`accountColor()\`, jamais d'un repli local`,
  },
  {
    id: 'palette locale',
    // Trois hex ou plus dans un même tableau : c'est une palette, pas une nuance isolée.
    test: src => /\[\s*'#[0-9a-fA-F]{6}'\s*,\s*'#[0-9a-fA-F]{6}'\s*,\s*'#[0-9a-fA-F]{6}'/.test(src),
    hint: 'palette de couleurs de boîte : réutiliser `ACCOUNT_PALETTE` (`lib/accountColor.ts`)',
  },
  {
    id: 'vieille colonne `color`',
    // La colonne RESTE en base, mais plus aucun écran ne la lit. Le motif SQL est
    // borné À LA LIGNE : sur le fichier entier, `[^;]*` sautait d'un `SELECT` à un
    // `color` distant de trente lignes et accusait `SELECT id FROM email_accounts`.
    test: src => /\b(?:account|acc|a|ea)\.color\b/.test(src)
      || /\bemail_accounts\.color\b/.test(src)
      || src.split('\n').some(line =>
        /SELECT[^\n]*\bcolor\b[^\n]*FROM\s+email_accounts/i.test(line)
        || /\bemail_accounts\b[^\n]*\bSET\b[^\n]*\bcolor\s*=/i.test(line)),
    hint: 'lecture de `email_accounts.color` : lire `badge_color` et passer par `accountColor()`',
  },
  {
    id: 'bulle dessinée à la main',
    // Un rond coloré par un style en ligne dont la couleur vient d'une boîte.
    test: src => /rounded-full[^\n]*style=\{\{\s*(?:background|backgroundColor)[^\n]*(?:account|acc)\w*\.(?:color|badgeColor)/i.test(src),
    hint: 'bulle de boîte dessinée à la main : utiliser `<AccountAvatar>`',
  },
]

const files = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (/\.(?:tsx|ts)$/.test(entry)) files.push(full)
  }
}
for (const dir of SCANNED) walk(join(ROOT, dir))

const BREAK = process.argv.includes('--break')
const sources = files.map(full => ({ path: relative(ROOT, full), src: readFileSync(full, 'utf8') }))

if (BREAK) {
  // Ce que le lot a SUPPRIMÉ du tableau de bord, remis tel quel : le verrou doit le voir.
  sources.push({
    path: join('app', '(app)', 'dashboard', '__break__.tsx'),
    src: `const dot = <span className="h-2 w-2 rounded-full" style={{ background: a.color ?? '${LEGACY_FALLBACK}' }} />\n`
      + `const q = \`SELECT id, name, color FROM email_accounts WHERE user_id = $1\`\n`,
  })
}

const owners = new Set(OWNERS)
const failures = []
for (const { path, src } of sources) {
  if (owners.has(path)) continue
  // Le verrou se lit lui-même sans se déclencher : ses propres motifs sont des chaînes.
  if (path.split(sep).includes('scripts')) continue
  for (const rule of RULES) {
    if (rule.test(src)) failures.push(`${path} — ${rule.id} : ${rule.hint}`)
  }
}

for (const owner of OWNERS) {
  if (!sources.some(f => f.path === owner)) {
    console.error(`HARNESS: ${owner} est introuvable — le verrou surveillerait une source qui n'existe plus`)
    process.exit(2)
  }
}

console.log(`check-account-badge : ${sources.length} fichier(s) lus, ${OWNERS.length} source(s) autorisée(s)`)
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`)
  if (BREAK) {
    console.log(`check-account-badge --break : rouge comme attendu (${failures.length} échec(s))`)
    process.exit(0)
  }
  process.exit(1)
}
if (BREAK) {
  console.error('check-account-badge --break : VERT alors que l\'ancien sélecteur est réinjecté — le verrou ne verrouille rien')
  process.exit(1)
}
console.log('check-account-badge : OK')
