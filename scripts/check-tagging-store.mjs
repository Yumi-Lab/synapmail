#!/usr/bin/env node
/**
 * Banc du lot T2 : ce que le stockage des étiquettes RETIENT, et ce que la base REFUSE.
 *
 * Banc DB. Il tourne sur la base de la lane (`DATABASE_URL` de `.env.local`), qui contient des
 * données réelles : toutes ses lignes portent un identifiant de banc et sont supprimées dans le
 * `finally`, y compris après un échec. Il ne sort JAMAIS sur le réseau, n'ouvre AUCUNE connexion
 * IMAP et n'appelle AUCUN moteur — les étiquettes qu'il écrit sont écrites à la main.
 *
 *   node --experimental-strip-types scripts/check-tagging-store.mjs
 *   node --experimental-strip-types scripts/check-tagging-store.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. aller-retour : ce qu'on écrit est ce qu'on relit (valeur, probabilités, confiance, modèle) ;
 *   B. une ligne `humain` s'AJOUTE sans toucher la ligne du moteur, et devient l'EFFECTIVE ;
 *      une seconde correction humaine REMPLACE la première, celle du moteur restant intacte ;
 *   C. la base REFUSE un INSERT SQL direct d'une ligne de moteur marquée entraînable — le second
 *      niveau de la règle contractuelle, celui qu'un bug applicatif ne peut pas contourner ;
 *   D. l'export `entrainement` ne rend QUE `humain`/`dossier`, et pagine par `id` ;
 *   E. le filtre par étiquette rend les mails dont l'EFFECTIVE porte cette valeur — donc PAS
 *      celui qu'un humain a corrigé ailleurs — avec leur position connue hors de `messages_cache` ;
 *   F. une valeur non prévue est refusée AVANT la base, en NOMMANT la question et la valeur, et
 *      n'écrit RIEN du lot (l'INSERT est unique, donc atomique) ;
 *   G. un mail sans Message-ID reçoit un identifiant dérivé STABLE, et deux mails différents en
 *      reçoivent deux différents.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : l'export est relu SANS son filtre serveur, comme si le
 * paramètre `entrainement` était appliqué côté client. Le banc DOIT alors virer au rouge sur D.
 * Ce qu'il démontre : l'assertion D mesure bien le filtre, pas la simple absence de lignes de
 * moteur dans le jeu de banc. Ce qu'il ne démontre PAS : le comportement des routes HTTP (lot T4),
 * ni celui de la contrainte CHECK, qui est mesurée en C et ne peut pas être « débranchée ».
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const { DATABASE_URL: DB_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
if (!DB_URL) harness("DATABASE_URL n'est pas renseigné")

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const { initDb, query } = await import('../lib/db.ts')
const store = await import('../lib/tagging/store.ts')
const { TRAINING_SOURCES } = await import('../lib/tagging/engine.ts')
const { questionById, valuesOf } = await import('../lib/tagging/questions.ts')

/**
 * Les Message-ID du banc portent un domaine de test réservé (RFC 2606, `.invalid` n'est jamais
 * délégué) : impossible de heurter un vrai mail de la boîte, et le nettoyage peut cibler par
 * motif sans risque d'emporter autre chose.
 */
const MID = n => `<banc-t2-${n}@exemple.invalid>`
const MID_LIKE = '<banc-t2-%@exemple.invalid>'

const pool = new pg.Pool({ connectionString: DB_URL })

const clean = async () => {
  await pool.query('DELETE FROM message_tags WHERE message_id LIKE $1', [MID_LIKE])
  await pool.query('DELETE FROM tagged_messages WHERE message_id LIKE $1', [MID_LIKE])
}

/** L'export du produit, ou celui du CONTRÔLE NÉGATIF : le même, sans son filtre serveur. */
const exportTags = NEGATIVE
  ? async ({ accountId, after = 0, limit = 500 }) => {
    const rows = await query(
      `SELECT id, message_id, question, valeur, source, entrainement_autorise
         FROM message_tags WHERE account_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [accountId, after, limit])
    return { rows: rows.map(r => ({ ...r, id: Number(r.id), messageId: r.message_id, entrainementAutorise: r.entrainement_autorise })), nextAfter: null }
  }
  : store.exportTags

console.log(`\nbanc du stockage des étiquettes${NEGATIVE ? ' — CONTRÔLE NÉGATIF (export sans son filtre serveur)' : ''}\n`)

// Les tables du lot doivent EXISTER : c'est `initDb()` qui les crée, et c'est lui qu'on mesure.
await initDb()

const [account] = await query('SELECT id, user_id FROM email_accounts ORDER BY created_at LIMIT 1')
if (!account) harness("la base de la lane n'a aucune boîte : rien à quoi rattacher des étiquettes")
const ACCOUNT = account.id
const USER = account.user_id

try {
  await clean()

  // ---- A. aller-retour ----
  console.log('A. ce qu’on écrit est ce qu’on relit')
  const CATEGORIE = valuesOf(questionById('categorie'))[0]
  const URGENCE = valuesOf(questionById('urgence'))[1]
  await store.writeTags({
    accountId: ACCOUNT, messageId: MID(1), source: 'jev', modele: 'jev-1.13.0',
    tags: [
      { question: 'categorie', valeur: CATEGORIE, probabilites: { [CATEGORIE]: 0.82 }, confiance: 0.82 },
      { question: 'urgence', valeur: URGENCE, probabilites: { [URGENCE]: 0.6 }, confiance: 0.6 },
    ],
    position: { folder: 'INBOX', uid: 4242, fromAddress: 'client@exemple.invalid', subject: 'Banc T2', date: new Date('2026-09-20T10:00:00Z') },
  })
  const back = await store.readTags(ACCOUNT, MID(1))
  const cat = back.tags.find(t => t.question === 'categorie')
  check('A1 les deux étiquettes écrites sont relues', back.tags.length === 2, `${back.tags.length} ligne(s)`)
  check('A2 la valeur, la confiance et les probabilités font l’aller-retour',
    cat?.valeur === CATEGORIE && Math.abs((cat?.confiance ?? 0) - 0.82) < 1e-6 && cat?.probabilites?.[CATEGORIE] === 0.82,
    JSON.stringify(cat))
  check('A3 le modèle RÉPONDANT est retenu avec l’étiquette', cat?.modele === 'jev-1.13.0', String(cat?.modele))
  check('A4 une étiquette de moteur n’est JAMAIS entraînable, sans qu’on l’ait demandé',
    back.tags.every(t => t.entrainementAutorise === false))

  // ---- B. l'humain s'ajoute, ne remplace pas le moteur ----
  console.log('\nB. la correction humaine s’AJOUTE, et devient l’effective')
  const AUTRE = valuesOf(questionById('categorie')).find(v => v !== CATEGORIE)
  await store.writeTags({
    accountId: ACCOUNT, messageId: MID(1), source: 'humain', validePar: USER,
    tags: [{ question: 'categorie', valeur: AUTRE }],
  })
  const corrected = await store.readTags(ACCOUNT, MID(1))
  const onCategorie = corrected.tags.filter(t => t.question === 'categorie')
  check('B1 les deux avis coexistent : celui du moteur ET celui de l’humain',
    onCategorie.length === 2 && onCategorie.some(t => t.source === 'jev' && t.valeur === CATEGORIE),
    onCategorie.map(t => `${t.source}=${t.valeur}`).join(' '))
  const effCat = corrected.effective.find(t => t.question === 'categorie')
  check('B2 l’EFFECTIVE est celle de l’humain', effCat?.source === 'humain' && effCat?.valeur === AUTRE,
    `${effCat?.source}=${effCat?.valeur}`)
  check('B3 la correction humaine est entraînable, et porte QUI l’a validée',
    effCat?.entrainementAutorise === true && effCat?.validePar === USER)
  const TROISIEME = valuesOf(questionById('categorie')).find(v => v !== CATEGORIE && v !== AUTRE)
  await store.writeTags({ accountId: ACCOUNT, messageId: MID(1), source: 'humain', validePar: USER,
    tags: [{ question: 'categorie', valeur: TROISIEME }] })
  const recorrected = await store.readTags(ACCOUNT, MID(1))
  const human = recorrected.tags.filter(t => t.question === 'categorie' && t.source === 'humain')
  check('B4 une SECONDE correction humaine remplace la première (une seule ligne humaine)',
    human.length === 1 && human[0].valeur === TROISIEME, human.map(t => t.valeur).join(' '))
  check('B5 et la ligne du moteur n’a toujours pas bougé',
    recorrected.tags.find(t => t.question === 'categorie' && t.source === 'jev')?.valeur === CATEGORIE)

  // ---- C. la base refuse ce que le contrat interdit ----
  console.log('\nC. la base refuse une étiquette de moteur entraînable')
  let refused = null
  try {
    await pool.query(
      `INSERT INTO message_tags (account_id, message_id, question, valeur, source, entrainement_autorise)
       VALUES ($1, $2, 'categorie', $3, 'jev', true)`,
      [ACCOUNT, MID(9), CATEGORIE])
  } catch (e) { refused = e }
  check('C1 un INSERT SQL DIRECT d’une ligne `jev` entraînable est REFUSÉ par la base',
    refused !== null, 'la base a ACCEPTÉ la ligne')
  check('C2 et c’est bien la contrainte contractuelle qui refuse',
    String(refused?.constraint ?? refused?.message).includes('message_tags_training_sources'),
    `${refused?.constraint ?? ''} ${refused?.message ?? ''}`)
  let refusedAutre = null
  try {
    await pool.query(
      `INSERT INTO message_tags (account_id, message_id, question, valeur, source, entrainement_autorise)
       VALUES ($1, $2, 'categorie', $3, 'autre', true)`,
      [ACCOUNT, MID(9), CATEGORIE])
  } catch (e) { refusedAutre = e }
  check('C3 un moteur `autre` (décision 13) est refusé de la même façon, sans règle en plus',
    refusedAutre !== null, 'la base a ACCEPTÉ la ligne')
  const { rows: [dbCheck] } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'message_tags_training_sources'`)
  check('C4 la contrainte en base nomme EXACTEMENT la liste blanche du code',
    TRAINING_SOURCES.every(s => String(dbCheck?.def).includes(`'${s}'`))
      && !String(dbCheck?.def).includes("'jev'") && !String(dbCheck?.def).includes("'autre'"),
    String(dbCheck?.def))

  // ---- D. l'export entraînement ----
  console.log('\nD. l’export d’entraînement ne rend que ce qui est entraînable')
  await store.writeTags({ accountId: ACCOUNT, messageId: MID(2), source: 'jev', modele: 'jev-1.13.0',
    tags: [{ question: 'categorie', valeur: CATEGORIE, confiance: 0.9 }] })
  const trainable = await exportTags({ accountId: ACCOUNT, entrainementOnly: true, limit: 5000 })
  const benchRows = trainable.rows.filter(r => String(r.messageId).startsWith('<banc-t2-'))
  check('D1 l’export d’entraînement ne contient AUCUNE ligne de moteur',
    benchRows.length > 0 && benchRows.every(r => TRAINING_SOURCES.includes(r.source)),
    benchRows.map(r => r.source).join(' ') || 'aucune ligne de banc exportée')
  check('D2 toutes ses lignes sont marquées entraînables',
    benchRows.every(r => r.entrainementAutorise === true))
  const all = await store.exportTags({ accountId: ACCOUNT, entrainementOnly: false, limit: 5000 })
  const allBench = all.rows.filter(r => r.messageId.startsWith('<banc-t2-'))
  check('D3 sans le filtre, les lignes de moteur SONT là (donc D1 mesure le filtre, pas un jeu vide)',
    allBench.some(r => r.source === 'jev'), allBench.map(r => r.source).join(' '))
  const firstPage = await store.exportTags({ accountId: ACCOUNT, entrainementOnly: false, limit: 1 })
  check('D4 l’export pagine par `id` et dit où reprendre',
    firstPage.rows.length === 1 && firstPage.nextAfter === firstPage.rows[0].id,
    `${firstPage.rows.length} ligne(s), nextAfter=${firstPage.nextAfter}`)

  // ---- E. le filtre par étiquette ----
  console.log('\nE. le filtre par étiquette suit l’effective, et retrouve le mail')
  const hits = await store.filterByTag({ accountId: ACCOUNT, question: 'categorie', valeur: CATEGORIE })
  const ids = hits.messages.map(m => m.messageId)
  check('E1 le mail dont le moteur a dit CETTE valeur est rendu', ids.includes(MID(2)), ids.join(' '))
  check('E2 le mail qu’un humain a CORRIGÉ ailleurs n’est PLUS rendu sous l’ancienne valeur',
    !ids.includes(MID(1)), ids.join(' '))
  const onCorrected = await store.filterByTag({ accountId: ACCOUNT, question: 'categorie', valeur: TROISIEME })
  check('E3 il est rendu sous la valeur CORRIGÉE',
    onCorrected.messages.some(m => m.messageId === MID(1)),
    onCorrected.messages.map(m => m.messageId).join(' '))
  const positioned = onCorrected.messages.find(m => m.messageId === MID(1))
  check('E4 avec sa position connue, lisible sans `messages_cache`',
    positioned?.folder === 'INBOX' && positioned?.uid === 4242 && positioned?.subject === 'Banc T2',
    JSON.stringify(positioned))
  check('E5 le filtre annonce un total', hits.total >= 1, String(hits.total))

  // ---- F. une valeur non prévue n'entre pas ----
  console.log('\nF. une valeur non prévue est refusée, et NOMMÉE')
  let invalid = null
  try {
    await store.writeTags({ accountId: ACCOUNT, messageId: MID(3), source: 'jev',
      tags: [{ question: 'categorie', valeur: CATEGORIE }, { question: 'urgence', valeur: 'valeur_forgee' }] })
  } catch (e) { invalid = e }
  check('F1 l’écriture est refusée', invalid?.name === 'InvalidTagError', String(invalid))
  check('F2 le refus NOMME la question et la valeur (une route en fait un 422 qui les nomme)',
    invalid?.question === 'urgence' && invalid?.valeur === 'valeur_forgee'
      && String(invalid?.message).includes('urgence') && String(invalid?.message).includes('valeur_forgee'),
    String(invalid?.message))
  const nothing = await store.readTags(ACCOUNT, MID(3))
  check('F3 et RIEN du lot n’est entré, pas même l’étiquette valide qui le précédait',
    nothing.tags.length === 0, `${nothing.tags.length} ligne(s)`)
  let invalidQuestion = null
  try {
    await store.writeTags({ accountId: ACCOUNT, messageId: MID(3), source: 'jev',
      tags: [{ question: 'question_inventee', valeur: 'oui' }] })
  } catch (e) { invalidQuestion = e }
  check('F4 une QUESTION inventée est refusée elle aussi', invalidQuestion?.name === 'InvalidTagError', String(invalidQuestion))

  // ---- G. l'identifiant d'un mail sans Message-ID ----
  console.log('\nG. un mail sans Message-ID reçoit un identifiant stable')
  const mail = { fromAddress: 'sans-id@exemple.invalid', date: new Date('2026-09-01T08:30:00Z'), subject: 'Aucun Message-ID' }
  const derived = store.messageIdOf(mail)
  check('G1 l’identifiant dérivé est reproductible', derived === store.messageIdOf(mail), `${derived} / ${store.messageIdOf(mail)}`)
  check('G2 il porte le domaine réservé, donc ne peut pas heurter un vrai Message-ID',
    derived.endsWith(`@${store.DERIVED_ID_DOMAIN}>`), derived)
  check('G3 un autre mail reçoit un AUTRE identifiant',
    store.messageIdOf({ ...mail, subject: 'Un autre objet' }) !== derived)
  check('G4 un Message-ID fourni est gardé TEL QUEL, jamais remplacé',
    store.messageIdOf({ messageId: MID(7), ...mail }) === MID(7))

  // ---- alreadyTagged : ce qui fait sauter un mail au lot T3 ----
  console.log('\nH. ce que le trieur sautera')
  const seen = await store.alreadyTagged(ACCOUNT, 'jev', [MID(1), MID(2), MID(8)])
  check('H1 les mails déjà tagués PAR CETTE SOURCE sont reconnus',
    seen.has(MID(1)) && seen.has(MID(2)) && !seen.has(MID(8)), [...seen].join(' '))
  const seenHuman = await store.alreadyTagged(ACCOUNT, 'one', [MID(1), MID(2)])
  check('H2 une AUTRE source n’a rien tagué : changer de moteur retague', seenHuman.size === 0, [...seenHuman].join(' '))
} finally {
  await clean().catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : export sans filtre, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nstockage des étiquettes : OK')
