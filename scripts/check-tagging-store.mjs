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
 * CONTRÔLE NÉGATIF (`--negative`) : la clé primaire est REMISE à l'ancienne, sans l'auteur
 * (account_id, message_id, question, source) sur une COPIE temporaire de la table — jamais sur
 * `message_tags` elle-même —, et le banc écrit dans cette copie via un `search_path` qui la
 * masque. Sous cette clé, un second moteur du même type ÉCRASE le premier : la section I DOIT
 * virer au rouge (I1, I2, I4). Ce qu'il démontre : I mesure bien la clé, pas la présence des
 * colonnes. Ce qu'il ne démontre pas : le comportement de la migration sur une base ancienne.
 *
 * CE QUI EST MESURÉ :
 *   A. aller-retour : ce qu'on écrit est ce qu'on relit (valeur, probabilités, confiance, modèle) ;
 *   B. une ligne `humain` s'AJOUTE sans toucher la ligne du moteur, et devient l'EFFECTIVE ;
 *      une seconde correction humaine REMPLACE la première, celle du moteur restant intacte ;
 *   D. l'export pagine par `id` et dit où reprendre ;
 *   E. le filtre par étiquette rend les mails dont l'EFFECTIVE porte cette valeur — donc PAS
 *      celui qu'un humain a corrigé ailleurs — avec leur position connue hors de `messages_cache` ;
 *   F. une valeur non prévue est refusée AVANT la base, en NOMMANT la question et la valeur, et
 *      n'écrit RIEN du lot (l'INSERT est unique, donc atomique) ;
 *   G. un mail sans Message-ID reçoit un identifiant dérivé STABLE, et deux mails différents en
 *      reçoivent deux différents ;
 *   I. l'ORIGINE est conservée (décision 23) : deux moteurs du même type → 2 lignes ; le même
 *      moteur sous une nouvelle version annoncée → 2 lignes ; la relance identique → 1 ligne ;
 *      deux humains → 2 lignes, l'effective = le plus récent ; un moteur supprimé garde son
 *      `auteur_nom` lisible ; le trieur ne saute que ce que CE moteur a déjà fait.
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

console.log('\nbanc du stockage des étiquettes\n')

// Les tables du lot doivent EXISTER : c'est `initDb()` qui les crée, et c'est lui qu'on mesure.
await initDb()

const [account] = await query('SELECT id, user_id FROM email_accounts ORDER BY created_at LIMIT 1')
if (!account) harness("la base de la lane n'a aucune boîte : rien à quoi rattacher des étiquettes")
const ACCOUNT = account.id
const USER = account.user_id

/** Les AUTEURS du banc (décision 23) : deux moteurs du même type, et une main par utilisateur. */
const MOTEUR_A = { id: '00000000-0000-4000-8000-00000000b2a1', nom: 'JEV banc A' }
const MOTEUR_B = { id: '00000000-0000-4000-8000-00000000b2b2', nom: 'JEV banc B' }
const HUMAIN = (userId, nom = 'Banc T2') => ({ id: userId, nom })

/**
 * Le contrôle négatif remplace `message_tags` par une copie SOUS L'ANCIENNE CLÉ, dans un schéma
 * de banc placé devant `public` : le code du produit, inchangé, écrit dedans sans le savoir. La
 * vraie table n'est pas touchée ; le schéma est supprimé dans le `finally`. Le `search_path` est
 * posé sur CHAQUE connexion du pool du produit (`SET` par session, pas `ALTER DATABASE`, qui ne
 * vaudrait que pour les connexions ouvertes après lui) : le pool du produit n'ouvre qu'une
 * connexion à la fois pour un banc séquentiel, et l'on vérifie qu'elle voit bien la copie.
 * ponytail: plafond connu — un pool à plusieurs connexions actives contournerait le SET ; la voie
 * d'amélioration est `?options=-c search_path=…` dans DATABASE_URL, posé sur chaque connexion.
 */
const NEG_SCHEMA = 'banc_t2_negatif'
const armNegative = async () => {
  await query(`DROP SCHEMA IF EXISTS ${NEG_SCHEMA} CASCADE`)
  await query(`CREATE SCHEMA ${NEG_SCHEMA}`)
  await query(`CREATE TABLE ${NEG_SCHEMA}.message_tags (LIKE public.message_tags INCLUDING DEFAULTS)`)
  await query(`ALTER TABLE ${NEG_SCHEMA}.message_tags ADD PRIMARY KEY (account_id, message_id, question, source)`)
  await query(`SET search_path = ${NEG_SCHEMA}, public`)
  const [seen] = await query(`SELECT to_regclass('message_tags')::oid = to_regclass('${NEG_SCHEMA}.message_tags')::oid AS ok`)
  if (!seen?.ok) harness('le produit ne voit pas la copie sous l’ancienne clé : le contrôle négatif ne mesurerait rien')
}
const disarmNegative = async () => {
  await query(`RESET search_path`)
  await query(`DROP SCHEMA IF EXISTS ${NEG_SCHEMA} CASCADE`)
}

try {
  await clean()

  // ---- A. aller-retour ----
  console.log('A. ce qu’on écrit est ce qu’on relit')
  const CATEGORIE = valuesOf(questionById('categorie'))[0]
  const URGENCE = valuesOf(questionById('urgence'))[1]
  await store.writeTags({
    accountId: ACCOUNT, messageId: MID(1), source: 'jev', auteur: MOTEUR_A, modele: 'jev-1.13.0',
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

  // ---- B. l'humain s'ajoute, ne remplace pas le moteur ----
  console.log('\nB. la correction humaine s’AJOUTE, et devient l’effective')
  const AUTRE = valuesOf(questionById('categorie')).find(v => v !== CATEGORIE)
  await store.writeTags({
    accountId: ACCOUNT, messageId: MID(1), source: 'humain', auteur: HUMAIN(USER), validePar: USER,
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
  check('B3 la correction humaine porte QUI l’a validée', effCat?.validePar === USER, String(effCat?.validePar))
  const TROISIEME = valuesOf(questionById('categorie')).find(v => v !== CATEGORIE && v !== AUTRE)
  await store.writeTags({ accountId: ACCOUNT, messageId: MID(1), source: 'humain', auteur: HUMAIN(USER), validePar: USER,
    tags: [{ question: 'categorie', valeur: TROISIEME }] })
  const recorrected = await store.readTags(ACCOUNT, MID(1))
  const human = recorrected.tags.filter(t => t.question === 'categorie' && t.source === 'humain')
  check('B4 une SECONDE correction humaine remplace la première (une seule ligne humaine)',
    human.length === 1 && human[0].valeur === TROISIEME, human.map(t => t.valeur).join(' '))
  check('B5 et la ligne du moteur n’a toujours pas bougé',
    recorrected.tags.find(t => t.question === 'categorie' && t.source === 'jev')?.valeur === CATEGORIE)

  // ---- D. l'export ----
  console.log('\nD. l’export rend les lignes de la boîte, et pagine')
  await store.writeTags({ accountId: ACCOUNT, messageId: MID(2), source: 'jev', auteur: MOTEUR_A, modele: 'jev-1.13.0',
    tags: [{ question: 'categorie', valeur: CATEGORIE, confiance: 0.9 }] })
  const all = await store.exportTags({ accountId: ACCOUNT, limit: 5000 })
  const allBench = all.rows.filter(r => r.messageId.startsWith('<banc-t2-'))
  check('D1 l’export rend les lignes des DEUX sortes de source, sans en filtrer aucune',
    allBench.some(r => r.source === 'jev') && allBench.some(r => r.source === 'humain'),
    allBench.map(r => r.source).join(' '))
  const firstPage = await store.exportTags({ accountId: ACCOUNT, limit: 1 })
  check('D2 l’export pagine par `id` et dit où reprendre',
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
    await store.writeTags({ accountId: ACCOUNT, messageId: MID(3), source: 'jev', auteur: MOTEUR_A,
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
    await store.writeTags({ accountId: ACCOUNT, messageId: MID(3), source: 'jev', auteur: MOTEUR_A,
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
  const seen = await store.alreadyTagged(ACCOUNT, { source: 'jev', auteurId: MOTEUR_A.id }, [MID(1), MID(2), MID(8)])
  check('H1 les mails déjà tagués PAR CETTE SOURCE sont reconnus',
    seen.before.has(MID(1)) && seen.before.has(MID(2)) && !seen.before.has(MID(8)), [...seen.before].join(' '))
  const seenHuman = await store.alreadyTagged(ACCOUNT, { source: 'one', auteurId: MOTEUR_A.id }, [MID(1), MID(2)])
  check('H2 une AUTRE source n’a rien tagué : changer de moteur retague',
    seenHuman.before.size === 0 && seenHuman.during.size === 0, [...seenHuman.before].join(' '))

  // ---- I. l'origine est conservée (décision 23) ----
  console.log(`\nI. l’origine de chaque étiquette est conservée${NEGATIVE ? ' — CONTRÔLE NÉGATIF (ancienne clé)' : ''}`)
  if (NEGATIVE) { await armNegative(); await clean() }
  const tagsOn = async (mid, question) => (await store.readTags(ACCOUNT, mid)).tags.filter(t => t.question === question)
  const onA = { accountId: ACCOUNT, messageId: MID(9), source: 'jev', tags: [{ question: 'categorie', valeur: CATEGORIE, confiance: 0.7 }] }
  // Sous l'ancienne clé, l'écriture du produit est REFUSÉE par la base elle-même (son
  // `ON CONFLICT` nomme la clé à sept colonnes, qu'aucun index de la copie ne porte) : un refus
  // est un rouge, pas une panne du banc — il est donc compté comme tel, et nommé.
  const attempt = async (label, fn) => { try { await fn() } catch (e) { check(label, false, `écriture refusée : ${String(e).split('\n')[0]}`); return false } return true }
  const wroteA = await attempt('I1 deux moteurs du MÊME type sur le même mail → 2 lignes, chacune signée', async () => {
    await store.writeTags({ ...onA, auteur: MOTEUR_A, modele: 'jev-1.13.0' })
    await store.writeTags({ ...onA, auteur: MOTEUR_B, modele: 'jev-1.13.0', tags: [{ question: 'categorie', valeur: AUTRE, confiance: 0.6 }] })
  })
  const deuxMoteurs = await tagsOn(MID(9), 'categorie')
  if (wroteA) check('I1 deux moteurs du MÊME type sur le même mail → 2 lignes, chacune signée',
    deuxMoteurs.length === 2 && deuxMoteurs.some(t => t.auteurId === MOTEUR_A.id && t.auteurNom === MOTEUR_A.nom)
      && deuxMoteurs.some(t => t.auteurId === MOTEUR_B.id && t.valeur === AUTRE),
    deuxMoteurs.map(t => `${t.auteurNom}=${t.valeur}`).join(' '))

  const wroteV = await attempt('I2 le même moteur sous une NOUVELLE version annoncée → 2 lignes (l’ancienne est gardée)',
    () => store.writeTags({ ...onA, auteur: MOTEUR_A, modele: 'jev-1.14.0' }))
  const nouvelleVersion = (await tagsOn(MID(9), 'categorie')).filter(t => t.auteurId === MOTEUR_A.id)
  if (wroteV) check('I2 le même moteur sous une NOUVELLE version annoncée → 2 lignes (l’ancienne est gardée)',
    nouvelleVersion.length === 2 && new Set(nouvelleVersion.map(t => t.modele)).size === 2,
    nouvelleVersion.map(t => t.modele).join(' '))
  if (NEGATIVE && !wroteA && !wroteV) throw new Error('négatif : rien d’écrit, le reste de I n’a pas d’objet')

  await store.writeTags({ ...onA, auteur: MOTEUR_A, modele: 'jev-1.14.0', tags: [{ question: 'categorie', valeur: CATEGORIE, confiance: 0.75 }] })
  const relance = (await tagsOn(MID(9), 'categorie')).filter(t => t.auteurId === MOTEUR_A.id && t.modele === 'jev-1.14.0')
  check('I3 la relance IDENTIQUE (même auteur, même modèle, même version) → 1 ligne, mise à jour',
    relance.length === 1 && Math.abs(relance[0].confiance - 0.75) < 1e-6, `${relance.length} ligne(s), confiance ${relance[0]?.confiance}`)

  const [autreUser] = await query(`SELECT id FROM users WHERE id <> $1 ORDER BY created_at LIMIT 1`, [USER])
  const SECOND_USER = autreUser?.id ?? USER
  await store.writeTags({ ...onA, source: 'humain', auteur: HUMAIN(USER, 'Première main'), validePar: USER, tags: [{ question: 'categorie', valeur: AUTRE }] })
  await new Promise(r => setTimeout(r, 20))
  await store.writeTags({ ...onA, source: 'humain', auteur: HUMAIN(SECOND_USER, 'Seconde main'), validePar: SECOND_USER === USER ? USER : SECOND_USER, tags: [{ question: 'categorie', valeur: TROISIEME }] })
  const humains = (await tagsOn(MID(9), 'categorie')).filter(t => t.source === 'humain')
  const eff = (await store.readTags(ACCOUNT, MID(9))).effective.find(t => t.question === 'categorie')
  if (SECOND_USER === USER) {
    // Une seule personne dans cette base : deux humains distincts ne peuvent pas être joués, et
    // le banc le DIT au lieu de faire semblant (la même main relancée = 1 ligne, par I3).
    console.log('  --   I4 sauté : un seul utilisateur dans cette base, deux humains distincts ne peuvent pas être joués')
  } else {
    check('I4 deux humains → 2 lignes, l’effective est la plus récente',
      humains.length === 2 && eff?.auteurNom === 'Seconde main' && eff?.valeur === TROISIEME,
      `${humains.length} ligne(s) humaines, effective ${eff?.auteurNom}=${eff?.valeur}`)
  }

  // Un moteur SUPPRIMÉ : rien à supprimer ici puisque `auteur_id` n'est pas une clé étrangère —
  // c'est précisément ce qu'on mesure : le nom reste, sans ligne `decision_engines` derrière.
  const [orphan] = await query(`SELECT COUNT(*)::int AS n FROM decision_engines WHERE id::text = $1`, [MOTEUR_B.id])
  const ligneB = deuxMoteurs.find(t => t.auteurId === MOTEUR_B.id)
  check('I5 un moteur qui n’existe pas (supprimé) garde un `auteur_nom` lisible',
    orphan.n === 0 && ligneB?.auteurNom === MOTEUR_B.nom, `${orphan.n} moteur(s) en base, nom lu « ${ligneB?.auteurNom} »`)

  const sautA = await store.alreadyTagged(ACCOUNT, { source: 'jev', auteurId: MOTEUR_A.id }, [MID(9)])
  const sautC = await store.alreadyTagged(ACCOUNT, { source: 'jev', auteurId: '00000000-0000-4000-8000-00000000b2c3' }, [MID(9)])
  check('I6 le trieur saute ce que CE moteur a fait, pas ce qu’un AUTRE moteur du même type a fait',
    sautA.before.has(MID(9)) && !sautC.before.has(MID(9)), `A: ${[...sautA.before].length}, C: ${[...sautC.before].length}`)

  const parOrigine = await store.filterByTag({ accountId: ACCOUNT, question: 'categorie', valeur: CATEGORIE, origine: MOTEUR_A.id })
  const parHumain = await store.filterByTag({ accountId: ACCOUNT, question: 'categorie', valeur: CATEGORIE, origine: 'humain' })
  check('I7 le filtre par ORIGINE rend ce que CE moteur a dit, et rien de ce qu’une main a dit',
    parOrigine.messages.some(m => m.messageId === MID(9)) && !parHumain.messages.some(m => m.messageId === MID(9)),
    `moteur A: ${parOrigine.total}, humain: ${parHumain.total}`)
} catch (e) {
  if (!NEGATIVE) throw e
  console.log(`  --   ${e.message}`)
} finally {
  await clean().catch(() => {})
  if (NEGATIVE) await disarmNegative().catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['I1', 'I2']
  const fell = expected.filter(id => failures.some(f => f.startsWith(id)))
  if (fell.length === expected.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés (${fell.join(', ')}), comme attendu`); process.exit(0) }
  console.error(`\nCONTRÔLE NÉGATIF MUET : ancienne clé posée, et ${expected.filter(id => !fell.includes(id)).join(', ')} reste vert — le banc ne mesure pas la clé`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nstockage des étiquettes : OK')
