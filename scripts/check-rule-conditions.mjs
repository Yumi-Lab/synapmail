#!/usr/bin/env node
/**
 * Banc du lot W1 : ce qu'une condition `matches` / `not_matches` et une condition `tag`
 * valent, à l'écriture comme à l'évaluation.
 *
 * Banc PUR : aucune base, aucun réseau, aucun IMAP. Il n'importe que `lib/rules.ts` et
 * `lib/tagging/questions.ts`, et ne lui donne que des objets qu'il construit lui-même.
 *
 *   node --experimental-strip-types scripts/check-rule-conditions.mjs
 *   node --experimental-strip-types scripts/check-rule-conditions.mjs --negative
 *
 * Ce qu'il mesure :
 *   A. un motif sur l'OBJET et sur l'EXPÉDITEUR retrouve le mail, `not_matches` fait l'inverse ;
 *   B. la casse est ignorée PAR LE DRAPEAU `i` — un motif qui distingue `\W` de `\w` garde son
 *      sens (c'est le piège du `toLowerCase()` déjà présent dans la branche texte) ;
 *   C. une regex invalide est refusée À L'ÉCRITURE, en NOMMANT la condition fautive ;
 *   D. un motif de plus de 200 caractères est refusé, en disant sa longueur ;
 *   E. le texte confronté au motif est BORNÉ (1 000 car. hors corps, 10 000 pour le corps) :
 *      une occurrence au-delà de la borne ne déclenche pas ;
 *   F. la condition `tag` lit la valeur EFFECTIVE (humain > moteur, déjà résolue en amont),
 *      refuse une question inconnue et une valeur hors liste ;
 *   G. l'export Sieve n'ABANDONNE jamais en silence : une condition regex/tag y devient un
 *      commentaire qui la nomme, et une règle entièrement inexprimable est signalée.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : `validateConditions` est remplacée par une fonction qui
 * accepte TOUT, et l'évaluation d'un motif par une confrontation SANS borne et SANS drapeau
 * `i` (le produit tel qu'il serait sans les décisions du lot). Le banc DOIT alors virer au
 * rouge sur B, C, D et E. Ce qu'il démontre : les assertions sont sensibles à ces décisions.
 * Ce qu'il ne démontre PAS : le comportement d'un binaire dont on aurait retiré le code.
 */
import './alias-resolver.mjs'
import { createRequire } from 'node:module'

// `lib/rules.ts` importe `lib/smtp.ts` (l'action « transférer »), qui charge son composeur par
// `require` — légal dans le module compilé par le bundler, absent du contexte ESM d'un banc.
// Poser le `require` de ce fichier suffit ; aucune connexion n'est ouverte pour autant : le
// banc n'appelle ni SMTP, ni IMAP, ni la base.
globalThis.require ??= createRequire(import.meta.url)

const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

const {
  REGEX_BODY_MAX, REGEX_PATTERN_MAX, REGEX_TEXT_MAX,
  compileRulePattern, evaluateRule, generateSieveScript, needsTags, testRule, validateConditions,
} = await import('../lib/rules.ts')
const { QUESTIONS, valuesOf } = await import('../lib/tagging/questions.ts')

if (typeof validateConditions !== 'function') harness('validateConditions absente de lib/rules.ts')
if (!QUESTIONS?.length) harness('aucune question dans lib/tagging/questions.ts')

let failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  ok  ${label}`)
  else { failed++; console.log(`  KO  ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** Le contrôle négatif : rien n'est refusé à l'écriture. */
const acceptAnything = () => null
const validate = NEGATIVE ? acceptAnything : validateConditions

let idSeq = 0
const cond = c => ({ id: `c${++idSeq}`, ...c })
const rule = (conditions, extra = {}) => ({
  id: 'r1', userId: 'u', accountId: 'a', name: extra.name ?? 'règle du banc',
  enabled: true, priority: 0, conditionLogic: extra.conditionLogic ?? 'all',
  conditions, actions: extra.actions ?? [{ id: 'a1', type: 'mark_read' }],
  stopProcessing: false, createdAt: '', updatedAt: '',
})
const mail = (over = {}) => ({
  uid: '1', messageId: '<m@exemple-invalid.test>', folder: 'INBOX',
  from: { name: 'Service Facturation', address: 'compta@exemple-invalid.test' },
  to: [{ name: '', address: 'moi@exemple-invalid.test' }], cc: [],
  subject: 'Facture N°2026-0417 à régler', date: new Date('2026-01-02').toISOString(),
  isRead: false, isStarred: false, hasAttachments: false, preview: '', bodyPlain: '', ...over,
})

/**
 * Ce que le CONTRÔLE NÉGATIF fait d'un motif : confrontation brute, sans drapeau `i` et sans
 * borne. C'est le produit tel qu'il serait si les garde-fous de la décision 2 n'existaient pas.
 */
const evalNaive = (msg, c) => {
  const text = c.field === 'subject' ? (msg.subject ?? '')
    : c.field === 'body' ? (msg.bodyPlain ?? '')
    : `${msg.from?.name ?? ''} ${msg.from?.address ?? ''}`
  let re
  try { re = new RegExp(c.value) } catch { return false }
  return c.operator === 'matches' ? re.test(text) : !re.test(text)
}
/** LA fonction mesurée : celle du produit, ou celle du contrôle négatif. */
const hits = (msg, c, tags = []) =>
  NEGATIVE && (c.operator === 'matches' || c.operator === 'not_matches')
    ? evalNaive(msg, c)
    : evaluateRule(msg, rule([c]), tags)

// ─── A. un motif retrouve le mail, sur l'objet et sur l'expéditeur ────────────
console.log('\nA. le motif, sur l’objet et sur l’expéditeur')
ok('un motif sur l’objet retrouve le mail',
  hits(mail(), cond({ field: 'subject', operator: 'matches', value: '^Facture N°\\d{4}-\\d{4}' })))
ok('un motif sur l’objet qui ne colle pas ne retrouve rien',
  !hits(mail(), cond({ field: 'subject', operator: 'matches', value: '^Devis' })))
ok('un motif sur l’adresse de l’expéditeur retrouve le mail',
  hits(mail(), cond({ field: 'from', operator: 'matches', value: '@exemple-invalid\\.test$' })))
ok('`not_matches` est exactement l’inverse',
  hits(mail(), cond({ field: 'subject', operator: 'not_matches', value: '^Devis' }))
  && !hits(mail(), cond({ field: 'subject', operator: 'not_matches', value: '^Facture' })))
ok('un motif sur le corps retrouve le mail',
  hits(mail({ bodyPlain: 'Merci de régler avant le 30/01.' }),
       cond({ field: 'body', operator: 'matches', value: 'r[ée]gler avant' })))

// ─── B. la casse : par le drapeau, jamais par un toLowerCase du motif ─────────
console.log('\nB. la casse ignorée PAR LE DRAPEAU `i`')
ok('un motif en minuscules retrouve un objet en majuscules',
  hits(mail({ subject: 'FACTURE URGENTE' }), cond({ field: 'subject', operator: 'matches', value: 'facture urgente' })))
ok('un motif en majuscules retrouve un objet en minuscules',
  hits(mail({ subject: 'facture urgente' }), cond({ field: 'subject', operator: 'matches', value: 'FACTURE URGENTE' })))
// Le piège mesuré : mis en minuscule, `\W` deviendrait `\w` et ce motif changerait de sens.
// `A B` porte un espace (un `\W`) et AUCUN caractère de mot entre `A` et `B`.
ok('`\\W` garde son sens (un motif mis en minuscule deviendrait `\\w`)',
  hits(mail({ subject: 'A B' }), cond({ field: 'subject', operator: 'matches', value: 'A\\WB' }))
  && !hits(mail({ subject: 'A B' }), cond({ field: 'subject', operator: 'matches', value: 'A\\wB' })),
  'A\\WB doit coller sur "A B", A\\wB ne doit pas')
// Même piège sur `\S` / `\s`.
ok('`\\S` garde son sens (il deviendrait `\\s`)',
  hits(mail({ subject: 'AxB' }), cond({ field: 'subject', operator: 'matches', value: 'A\\SB' }))
  && !hits(mail({ subject: 'AxB' }), cond({ field: 'subject', operator: 'matches', value: 'A\\sB' })))

// ─── C. une regex invalide est refusée À L'ÉCRITURE, en nommant la condition ──
console.log('\nC. une regex invalide refusée à l’écriture')
const bad = validate([
  cond({ field: 'subject', operator: 'contains', value: 'ok' }),
  cond({ field: 'subject', operator: 'matches', value: '([a-z' }),
])
ok('une regex qui ne compile pas est refusée', typeof bad === 'string' && bad.length > 0, String(bad))
ok('l’erreur NOMME la condition fautive (rang et champ)',
  typeof bad === 'string' && bad.includes('condition 2') && bad.includes('subject'), String(bad))
ok('une regex valide passe',
  validate([cond({ field: 'subject', operator: 'matches', value: '^Facture' })]) === null)
ok('une condition non-regex n’est pas gênée',
  validate([cond({ field: 'subject', operator: 'contains', value: '([a-z' })]) === null)
ok('un motif vide est refusé',
  typeof validate([cond({ field: 'subject', operator: 'matches', value: '' })]) === 'string')

// ─── D. un motif trop long est refusé ────────────────────────────────────────
console.log(`\nD. le motif borné à ${REGEX_PATTERN_MAX} caractères`)
const justFits = 'a'.repeat(REGEX_PATTERN_MAX)
const tooLong  = 'a'.repeat(REGEX_PATTERN_MAX + 1)
ok(`un motif de ${REGEX_PATTERN_MAX} caractères passe`,
  validate([cond({ field: 'subject', operator: 'matches', value: justFits })]) === null)
const longErr = validate([cond({ field: 'subject', operator: 'matches', value: tooLong })])
ok(`un motif de ${REGEX_PATTERN_MAX + 1} caractères est refusé`, typeof longErr === 'string', String(longErr))
ok('l’erreur dit la longueur mesurée',
  typeof longErr === 'string' && longErr.includes(String(REGEX_PATTERN_MAX + 1)), String(longErr))
ok('compileRulePattern refuse le même motif', compileRulePattern(tooLong) === null)
// Ce que ce banc NE mesure PAS, et pourquoi il ne le mesure pas : un motif à retour arrière
// (`(a+)+$`) reste catastrophique DANS les bornes — 200 caractères de motif sur 1 000 de
// texte. Les deux bornes coupent le travail, elles ne le rendent pas linéaire. Une assertion
// de temps ici mesurerait la machine du jour, pas une propriété du code ; le plafond est écrit
// dans le `ponytail:` de `lib/rules.ts`, avec son chemin de sortie (un moteur sans retour
// arrière = une dépendance nouvelle, interdite tant que rien ne l'a mesurée).

// ─── E. le texte confronté au motif est BORNÉ ────────────────────────────────
console.log(`\nE. le texte borné (${REGEX_TEXT_MAX} car., ${REGEX_BODY_MAX} pour le corps)`)
const farSubject = `${'x'.repeat(REGEX_TEXT_MAX + 50)}CIBLE`
ok('une occurrence au-delà de la borne d’objet ne déclenche pas',
  !hits(mail({ subject: farSubject }), cond({ field: 'subject', operator: 'matches', value: 'CIBLE' })))
ok('la même occurrence AVANT la borne déclenche',
  hits(mail({ subject: `${'x'.repeat(REGEX_TEXT_MAX - 50)}CIBLE` }), cond({ field: 'subject', operator: 'matches', value: 'CIBLE' })))
ok('le corps a une borne plus large que l’objet',
  hits(mail({ bodyPlain: `${'x'.repeat(REGEX_TEXT_MAX + 50)}CIBLE` }), cond({ field: 'body', operator: 'matches', value: 'CIBLE' })))
ok('une occurrence au-delà de la borne de corps ne déclenche pas',
  !hits(mail({ bodyPlain: `${'x'.repeat(REGEX_BODY_MAX + 50)}CIBLE` }), cond({ field: 'body', operator: 'matches', value: 'CIBLE' })))

// ─── F. la condition `tag` : la valeur EFFECTIVE ─────────────────────────────
console.log('\nF. la condition sur une étiquette')
const Q = QUESTIONS[0]
const V = valuesOf(Q)
if (V.length < 2) harness(`la question ${Q.id} n'a qu'une valeur : le banc ne peut pas distinguer`)
const tagCond = (value, operator = 'equals') => cond({ field: 'tag', operator, value, tagQuestion: Q.id })
const withTag = valeur => [{ question: Q.id, valeur }]
ok('une étiquette qui porte la valeur déclenche',
  evaluateRule(mail(), rule([tagCond(V[0])]), withTag(V[0])))
ok('une étiquette qui porte une AUTRE valeur ne déclenche pas',
  !evaluateRule(mail(), rule([tagCond(V[0])]), withTag(V[1])))
ok('un mail sans étiquette ne déclenche pas',
  !evaluateRule(mail(), rule([tagCond(V[0])]), []))
ok('`not_equals` déclenche sur l’absence comme sur une autre valeur',
  evaluateRule(mail(), rule([tagCond(V[0], 'not_equals')]), [])
  && evaluateRule(mail(), rule([tagCond(V[0], 'not_equals')]), withTag(V[1]))
  && !evaluateRule(mail(), rule([tagCond(V[0], 'not_equals')]), withTag(V[0])))
// La valeur EFFECTIVE, c'est ce que `readEffectiveFor` a déjà tranché (humain > moteur) : le
// banc lui donne la seule ligne de rang 1, et vérifie que la règle ne voit QUE celle-là.
ok('la correction humaine est ce que la règle voit (la ligne du moteur n’est pas passée)',
  evaluateRule(mail(), rule([tagCond(V[1])]), withTag(V[1]))
  && !evaluateRule(mail(), rule([tagCond(V[0])]), withTag(V[1])))
ok('une question inconnue est refusée à l’écriture',
  typeof validate([cond({ field: 'tag', operator: 'equals', value: V[0], tagQuestion: 'question_qui_nexiste_pas' })]) === 'string')
ok('une valeur hors liste est refusée à l’écriture',
  typeof validate([cond({ field: 'tag', operator: 'equals', value: 'valeur_inventee', tagQuestion: Q.id })]) === 'string')
ok('un opérateur de motif sur le champ `tag` est refusé',
  typeof validate([cond({ field: 'tag', operator: 'matches', value: V[0], tagQuestion: Q.id })]) === 'string')
ok('une condition `tag` valide passe',
  validateConditions([cond({ field: 'tag', operator: 'equals', value: V[0], tagQuestion: Q.id })]) === null)
ok('`needsTags` ne déclenche une lecture que si une règle en a besoin',
  needsTags([rule([tagCond(V[0])])]) === true
  && needsTags([rule([cond({ field: 'subject', operator: 'contains', value: 'a' })])]) === false)
ok('`testRule` rend les mails dont l’étiquette colle, et eux seuls',
  testRule([mail({ uid: '1' }), mail({ uid: '2' })], rule([tagCond(V[0])]),
    new Map([['1', withTag(V[0])], ['2', withTag(V[1])]])).map(m => m.uid).join(',') === '1')

// ─── G. l'export Sieve ne laisse RIEN tomber en silence ──────────────────────
console.log('\nG. l’export Sieve nomme ce qu’il ne sait pas dire')
const mixed = rule(
  [cond({ field: 'subject', operator: 'contains', value: 'Facture' }),
   cond({ field: 'subject', operator: 'matches', value: '^Facture N°\\d+' })],
  { name: 'mixte', actions: [{ id: 'a1', type: 'move', value: 'Compta' }] })
const onlyRegex = rule(
  [cond({ field: 'subject', operator: 'matches', value: '^Facture N°\\d+' })],
  { name: 'que du motif', actions: [{ id: 'a1', type: 'move', value: 'Compta' }] })
const onlyTag = rule([tagCond(V[0])], { name: 'que l’étiquette', actions: [{ id: 'a1', type: 'move', value: 'Compta' }] })
const script = generateSieveScript([mixed, onlyRegex, onlyTag])
ok('une règle MIXTE est exportée, et son motif est écrit en commentaire',
  script.includes('# mixte') && script.includes('^Facture N°\\d+') && script.includes('fileinto "Compta";'),
  script.split('\n').filter(l => l.includes('mixte')).join(' / '))
ok('l’export DIT que le bloc exporté est plus large que la règle',
  /WIDER than the rule/.test(script))
ok('une règle QUE motif n’est pas exportée mais est SIGNALÉE (jamais un silence)',
  script.includes('# que du motif') && /RULE NOT EXPORTED/.test(script), script)
ok('une règle QUE étiquette est signalée elle aussi, avec sa question',
  script.includes('# que l’étiquette') && script.includes(`tag ${Q.id}`), script)
ok('aucune règle du lot n’a disparu du script',
  ['mixte', 'que du motif', 'que l’étiquette'].every(n => script.includes(`# ${n}`)))

// ─── verdict ─────────────────────────────────────────────────────────────────
if (NEGATIVE) {
  console.log(`\ncontrôle négatif : ${failed} assertion(s) rouge(s) attendue(s) sur B, C, D et E`)
  if (failed === 0) { console.error('KO : le contrôle négatif est VERT — les assertions ne mesurent rien'); process.exit(1) }
  console.log('contrôle négatif : OK (le banc sait virer au rouge)')
  process.exit(0)
}
console.log(`\nconditions de règles : ${failed === 0 ? 'toutes les vérifications passent' : `${failed} ÉCHEC(S)`}`)
process.exit(failed === 0 ? 0 : 1)
