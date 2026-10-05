#!/usr/bin/env node
/**
 * Banc du lot T10 : la taxonomie v2, et la VERSION de question portée par chaque étiquette.
 *
 * Banc DB. Il écrit sur la base de la lane (`DATABASE_URL` de `.env.local`), qui contient des
 * données réelles : toutes ses lignes portent un identifiant de banc et sont supprimées dans le
 * `finally`, y compris après un échec. Il ne sort JAMAIS sur le réseau, n'ouvre AUCUNE connexion
 * IMAP et n'appelle AUCUN moteur — les étiquettes qu'il écrit sont écrites à la main.
 *
 *   node --experimental-strip-types scripts/check-tagging-taxonomy.mjs
 *   node --experimental-strip-types scripts/check-tagging-taxonomy.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. la taxonomie v2 : `categorie` admet `notification_plateforme` avec ses frontières écrites,
 *      `action_attendue` existe avec ses 8 valeurs, et les deux partent bien AU MOTEUR ;
 *   B. la version d'une question est STABLE : deux appels donnent le même hex, et deux questions
 *      différentes donnent deux versions différentes ;
 *   C. elle CHANGE quand la définition change — la seule propriété qui la rend utile. Mesuré en
 *      hachant le corps réellement envoyé, une fois tel quel puis une fois avec un critère
 *      modifié : sans cette sensibilité, un export mélangerait deux définitions sans le dire ;
 *   D. la base la RETIENT, pour une ligne de moteur COMME pour une ligne humaine, et la rend à
 *      la relecture comme à l'export — une correction humaine sans version serait inutilisable ;
 *   E. les libellés des nouvelles valeurs existent dans les TROIS locales.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : la version est calculée sur le seul IDENTIFIANT de la
 * question au lieu du corps envoyé — ce qu'elle serait si on l'avait écrite à la main plutôt que
 * dérivée de `engineQuestionsFor`. Le banc DOIT alors virer au rouge sur C. Ce qu'il démontre :
 * l'assertion C mesure bien la dérivation depuis le corps réel. Ce qu'il ne démontre PAS : que la
 * colonne en base soit remplie — c'est D qui le mesure, et D ne peut pas être « débranché ».
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const { DEFAULT_SET, engineBodyFor, valuesOf } = await import('../lib/tagging/questions.ts')
// Le banc mesure le JEU PAR DÉFAUT (lot T-Q : le jeu est par utilisateur ; ici, rien n'a été modifié) —
// les mêmes fonctions que le produit, appliquées à ce jeu-là.
const QUESTIONS = DEFAULT_SET.enabled
const questionById = id => DEFAULT_SET.questionById(id)
const isValidTag = (q, v) => DEFAULT_SET.isValidTag(q, v)
const engineQuestionsFor = ids => engineBodyFor(DEFAULT_SET.posed(ids))
const ENGINE_QUESTIONS = engineQuestionsFor()
const questionVersion = id => store.questionVersion(questionById(id))
const TAXONOMY_VERSION = store.taxonomyVersion(DEFAULT_SET)
const { alreadyTagged } = store
/** L'auteur du banc (décision 23) : un id de moteur qui n'existe pas en base, ce qui suffit à signer. */
const MOTEUR = { id: '00000000-0000-4000-8000-0000000000a1', nom: 'JEV banc T10' }

/** Les 12 hex : la longueur du produit, relue sur lui plutôt que recopiée ici. */
const VERSION_LEN = questionVersion('categorie').length

/**
 * La version du CONTRÔLE NÉGATIF : dérivée du seul identifiant, donc insensible à un changement
 * de définition. C'est la version telle qu'elle serait si on ne la tirait pas du corps envoyé.
 */
const versionOfId = id => createHash('sha256').update(id).digest('hex').slice(0, VERSION_LEN)

/**
 * Ce que serait la version si la définition changeait. On ne TOUCHE PAS à `questions.ts` : on
 * rejoue le hachage du produit sur le corps réel, puis sur une copie de ce corps dont un critère
 * a bougé. En négatif, la même fonction ignore le corps — c'est là que C tombe.
 */
const versionOfBody = (id, body) => NEGATIVE
  ? versionOfId(id)
  : createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, VERSION_LEN)

/** Les Message-ID du banc portent un domaine réservé (RFC 2606) : jamais un vrai mail. */
const MID = n => `<banc-t10-${n}@exemple.invalid>`
const MID_LIKE = '<banc-t10-%@exemple.invalid>'

const pool = new pg.Pool({ connectionString: DB_URL })
const clean = async () => {
  await pool.query('DELETE FROM message_tags WHERE message_id LIKE $1', [MID_LIKE])
  await pool.query('DELETE FROM tagged_messages WHERE message_id LIKE $1', [MID_LIKE])
}

console.log(`\nbanc de la taxonomie v2 et des versions de question${NEGATIVE ? ' — CONTRÔLE NÉGATIF (version tirée de l’identifiant, pas du corps envoyé)' : ''}\n`)

await initDb()

const [account] = await query('SELECT id, user_id FROM email_accounts ORDER BY created_at LIMIT 1')
if (!account) harness("la base de la lane n'a aucune boîte : rien à quoi rattacher des étiquettes")
const ACCOUNT = account.id
const USER = account.user_id

const NOUVELLE_CATEGORIE = 'notification_plateforme'
const ACTION = 'action_attendue'
const ACTION_VALUES = ['repondre', 'payer', 'signer', 'expedier', 'rembourser', 'relancer', 'archiver', 'aucune']

/** Les 7 questions ajoutées le 28/09, et le nombre de valeurs que chacune doit porter. */
const NOUVELLES_QUESTIONS = {
  relation: 9, canal_vente: 7, sens_flux: 4, organisme: 7, transporteur: 9, pays: 11, retour_positif: 2,
}
const TOTAL_QUESTIONS = 57

try {
  await clean()

  // ---- A. la taxonomie v2 ----
  console.log('A. la taxonomie v2 est posée, et part au moteur')
  check(`A1 \`categorie\` admet \`${NOUVELLE_CATEGORIE}\` (les 5 mails sur 20 que « autre » absorbait en T8)`,
    isValidTag('categorie', NOUVELLE_CATEGORIE), valuesOf(questionById('categorie')).join(' '))
  const critere = ENGINE_QUESTIONS.categorie?.criteria?.[NOUVELLE_CATEGORIE]
  check('A2 sa frontière contre `marketing` et `newsletter` est ÉCRITE dans le critère envoyé',
    typeof critere === 'object' && /marketing/.test(critere?.not_for ?? '') && /newsletter/.test(critere?.not_for ?? ''),
    JSON.stringify(critere))
  const action = questionById(ACTION)
  check(`A3 \`${ACTION}\` existe, en \`choice\` du groupe général`,
    action?.type === 'choice' && action?.group === 'general', `${action?.type} / ${action?.group}`)
  check('A4 elle porte EXACTEMENT les 8 valeurs décidées',
    action && valuesOf(action).join(',') === ACTION_VALUES.join(','), valuesOf(action ?? {}).join(','))
  check('A5 et elle part bien au moteur, avec ses critères',
    Object.keys(ENGINE_QUESTIONS[ACTION]?.criteria ?? {}).join(',') === ACTION_VALUES.join(','),
    Object.keys(ENGINE_QUESTIONS[ACTION]?.criteria ?? {}).join(','))
  check(`A6 la taxonomie compte ${TOTAL_QUESTIONS} questions`,
    QUESTIONS.length === TOTAL_QUESTIONS, String(QUESTIONS.length))
  for (const [id, nbValeurs] of Object.entries(NOUVELLES_QUESTIONS)) {
    const q = questionById(id)
    check(`A7 \`${id}\` existe, porte ses ${nbValeurs} valeurs, et part au moteur`,
      !!q && valuesOf(q).length === nbValeurs && !!ENGINE_QUESTIONS[id],
      `${q ? valuesOf(q).length : 'absente'} valeur(s)`)
  }
  // La consigne EXPLICITE de `pays` : ne rien déduire de la seule langue. Elle ne vaut que si
  // elle part au moteur, donc on la cherche dans le corps envoyé, pas dans un commentaire.
  const paysCritere = JSON.stringify(ENGINE_QUESTIONS.pays?.criteria ?? {})
  check('A8 `pays` dit au moteur de NE PAS déduire le pays de la seule langue',
    /langue/i.test(paysCritere), paysCritere.slice(0, 160))

  // ---- B. la version est stable et distingue deux questions ----
  console.log('\nB. la version d’une question est stable, et propre à elle')
  const v1 = questionVersion('categorie')
  check('B1 elle est reproductible', v1 === questionVersion('categorie'), `${v1} / ${questionVersion('categorie')}`)
  check(`B2 elle fait ${VERSION_LEN} hex`, /^[0-9a-f]+$/.test(v1) && v1.length === VERSION_LEN, v1)
  check('B3 deux questions différentes ont deux versions différentes',
    v1 !== questionVersion(ACTION), `${v1} / ${questionVersion(ACTION)}`)

  // ---- C. elle change quand la définition change ----
  console.log('\nC. elle CHANGE quand la définition change')
  const corps = engineQuestionsFor(['categorie']).categorie
  const telQuel = versionOfBody('categorie', corps)
  check('C1 le hachage du corps réel redonne la version du produit', telQuel === v1, `${telQuel} / ${v1}`)
  const modifie = JSON.parse(JSON.stringify(corps))
  modifie.criteria[NOUVELLE_CATEGORIE] = { ...modifie.criteria[NOUVELLE_CATEGORIE], what: 'une définition RÉÉCRITE' }
  const apres = versionOfBody('categorie', modifie)
  check('C2 un critère RÉÉCRIT donne une AUTRE version (sinon un export mélangerait deux définitions)',
    apres !== telQuel, `avant ${telQuel} / après ${apres}`)
  const consigne = JSON.parse(JSON.stringify(corps))
  consigne.instructions = `${consigne.instructions} (reformulée)`
  check('C3 une CONSIGNE reformulée aussi', versionOfBody('categorie', consigne) !== telQuel)

  // ---- D. la base la retient, pour toutes les sources ----
  console.log('\nD. la base retient la version, moteur comme humain')
  await store.writeTags({
    accountId: ACCOUNT, messageId: MID(1), source: 'jev', auteur: MOTEUR, modele: 'jev-1.13.0',
    tags: [
      { question: 'categorie', valeur: NOUVELLE_CATEGORIE, confiance: 0.77 },
      { question: ACTION, valeur: 'archiver', confiance: 0.9 },
    ],
    position: { folder: 'INBOX', uid: 1010, fromAddress: 'plateforme@exemple.invalid', subject: 'Banc T10', date: new Date('2026-09-28T09:00:00Z') },
  })
  const lu = await store.readTags(ACCOUNT, MID(1))
  const ligneMoteur = lu.tags.find(t => t.question === 'categorie')
  check('D1 la ligne du moteur porte la version de SA question',
    ligneMoteur?.questionVersion === questionVersion('categorie'),
    `${ligneMoteur?.questionVersion} / ${questionVersion('categorie')}`)
  check('D2 chaque question porte SA version, pas une version de lot',
    lu.tags.find(t => t.question === ACTION)?.questionVersion === questionVersion(ACTION))
  await store.writeTags({
    accountId: ACCOUNT, messageId: MID(1), source: 'humain', auteur: { id: USER, nom: 'Banc T10' }, validePar: USER,
    tags: [{ question: 'categorie', valeur: 'marketing' }],
  })
  const corrige = await store.readTags(ACCOUNT, MID(1))
  const ligneHumaine = corrige.tags.find(t => t.question === 'categorie' && t.source === 'humain')
  check('D3 la correction HUMAINE porte la même version : les deux répondent à la MÊME question',
    ligneHumaine?.questionVersion === questionVersion('categorie'),
    `${ligneHumaine?.questionVersion} / ${questionVersion('categorie')}`)
  const { rows } = await store.exportTags({ accountId: ACCOUNT, limit: 5000 })
  const exportees = rows.filter(r => String(r.messageId).startsWith('<banc-t10-'))
  check('D5 l’export rend la version avec chaque ligne (c’est ce qui sépare deux jeux)',
    exportees.length > 0 && exportees.every(r => /^[0-9a-f]+$/.test(r.questionVersion ?? '')),
    exportees.map(r => `${r.source}:${r.questionVersion}`).join(' ') || 'aucune ligne exportée')

  // ---- F. la version GLOBALE, et le saut qui la respecte ----
  console.log('\nF. la version de la TAXONOMIE, et le saut du trieur qui la respecte')
  check(`F1 elle fait ${VERSION_LEN} hex`,
    /^[0-9a-f]+$/.test(TAXONOMY_VERSION) && TAXONOMY_VERSION.length === VERSION_LEN,
    TAXONOMY_VERSION)
  check('F2 elle porte sur le JEU entier, donc elle diffère de la version d’UNE question',
    TAXONOMY_VERSION !== questionVersion('categorie'),
    `${TAXONOMY_VERSION} / ${questionVersion('categorie')}`)
  // Le hachage du corps de TOUTES les questions doit redonner la constante : sans ça, elle ne
  // décrirait pas le jeu réellement envoyé, et un ajout de question passerait inaperçu.
  // Triées par id : la version décrit le JEU, pas l'ordre d'affichage (F7 le prouve sur un jeu
  // en base dont les positions ne sont plus celles du défaut).
  const sortedBody = () => Object.entries(engineQuestionsFor()).sort(([a], [b]) => a.localeCompare(b))
  check('F3 le hachage du corps de TOUTES les questions, triées par id, redonne la constante',
    versionOfBody('*', sortedBody()) === TAXONOMY_VERSION,
    `${versionOfBody('*', sortedBody())} / ${TAXONOMY_VERSION}`)
  // Ce qui compte vraiment : un mail tagué sous la taxonomie COURANTE est sauté, un mail tagué
  // sous une AUTRE version ne l’est pas. La seconde ligne est écrite en SQL direct, car le
  // produit n’a pas de chemin pour écrire une version périmée — c’est l’état d’une base d’avant.
  //
  // F4 et F5 n’ont pas besoin du mode `--negative` : ce sont deux assertions OPPOSÉES sur le MÊME
  // mail, donc elles se contrôlent l’une l’autre. Un `alreadyTagged` qui ignorerait la colonne
  // ferait tomber F5 ; un `alreadyTagged` qui ne rendrait jamais rien ferait tomber F4. Aucune
  // implémentation ne peut les rendre vertes toutes les deux sans lire vraiment la version.
  check('F4 un mail tagué sous la taxonomie courante est bien SAUTÉ',
    (await alreadyTagged(ACCOUNT, { source: 'jev', auteurId: MOTEUR.id }, [MID(1)])).before.has(MID(1)))
  await pool.query(
    `UPDATE message_tags SET taxonomy_version = 'perime00000' WHERE message_id = $1 AND source = 'jev'`, [MID(1)])
  check('F5 le MÊME mail, tagué sous une AUTRE version, n’est PLUS sauté (la boîte se rejoue)',
    !(await alreadyTagged(ACCOUNT, { source: 'jev', auteurId: MOTEUR.id }, [MID(1)])).before.has(MID(1)))
  const perime = await pool.query(
    `SELECT DISTINCT taxonomy_version FROM message_tags WHERE message_id = $1 AND source = 'jev'`, [MID(1)])
  check('F6 et ce n’est pas la ligne qui a disparu : elle est là, sous son ancienne version',
    perime.rows.length === 1 && perime.rows[0].taxonomy_version === 'perime00000',
    JSON.stringify(perime.rows))
  // L'écran doit pouvoir EXPLIQUER une relance : la version qu'il affiche vient de l'état de la
  // boîte, relu par le même chemin que l'écran, pas d'une constante recopiée dans la page.
  const { ensureMailboxTagging, readTaggingStatus } = await import('../lib/tagging/mailbox.ts')
  await ensureMailboxTagging(ACCOUNT)
  const etat = await readTaggingStatus(ACCOUNT)
  check('F7 l’état que lit l’écran de tri porte la version courante et le nombre de questions',
    etat?.taxonomyVersion === TAXONOMY_VERSION && etat?.questions === TOTAL_QUESTIONS,
    `${etat?.taxonomyVersion} / ${etat?.questions} question(s)`)

  // ---- E. les libellés des trois locales ----
  console.log('\nE. les nouvelles valeurs ont un libellé dans les trois locales')
  for (const loc of ['en', 'fr', 'zh']) {
    const tags = JSON.parse(readFileSync(new URL(`../locales/${loc}.json`, import.meta.url), 'utf8')).tags
    // TOUTES les valeurs de TOUTES les questions, pas seulement les nouvelles : un libellé
    // manquant afficherait la valeur brute (`maritime_fret`) dans une pastille.
    const manquants = QUESTIONS.flatMap(q => valuesOf(q)).filter(v => !tags.v?.[v])
    check(`E1 ${loc} : chaque valeur de la taxonomie a son libellé`, manquants.length === 0, manquants.join(' '))
    const sansTitre = QUESTIONS.map(q => q.id).filter(id => !tags.q?.[id])
    check(`E2 ${loc} : chacune des ${TOTAL_QUESTIONS} questions a le sien`, sansTitre.length === 0, sansTitre.join(' '))
    // Une valeur RETIRÉE doit disparaître des locales, sinon les trois fichiers accumulent des
    // libellés morts que rien ne signale.
    const mortes = ['signer_valider', 'fournir_document', 'rappeler', 'rien'].filter(v => tags.v?.[v])
    check(`E3 ${loc} : les valeurs remplacées de \`${ACTION}\` ne traînent plus`, mortes.length === 0, mortes.join(' '))
  }
} finally {
  await clean().catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : version tirée de l’identifiant, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\ntaxonomie v2 et versions de question : OK')
