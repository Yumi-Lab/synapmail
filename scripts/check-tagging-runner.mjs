#!/usr/bin/env node
/**
 * Banc du lot T3 : ce que le trieur redemande, et ce qu'il ne redemande PAS.
 *
 * Banc DB + faux moteur. Il tourne sur la base de la lane (`DATABASE_URL` de `.env.local`), qui
 * contient des données RÉELLES : toutes ses lignes portent un identifiant de banc et sont
 * supprimées dans le `finally`, y compris après un échec. Il n'ouvre AUCUNE connexion IMAP (la
 * source de mails est fausse) et n'appelle AUCUN moteur réel (le faux moteur COMPTE ses appels) :
 * aucun crédit n'est dépensé, aucune boîte IONOS n'est touchée.
 *
 *   node --experimental-strip-types scripts/check-tagging-runner.mjs
 *   node --experimental-strip-types scripts/check-tagging-runner.mjs --negative
 *
 * CE QUI EST MESURÉ (le critère de chacun est un NOMBRE D'APPELS au moteur, pas une impression) :
 *   A. coupure au milieu (délai épuisé) puis reprise → chaque mail distinct demandé EXACTEMENT
 *      une fois, tous tagués. C'est l'assertion centrale : payer deux fois le même mail est le
 *      défaut que le curseur existe pour empêcher ;
 *   B. relancer un tri TERMINÉ → 0 appel ;
 *   C. plafond atteint → pause `budget`, et 0 appel de plus au passage suivant ;
 *   D. 402 au mail n → pause `credit`, curseur INTACT, et la reprise finit sans redemander les
 *      mails déjà faits ;
 *   E. au fil de l'eau : n'appelle QUE pour les UID arrivés APRÈS l'activation ;
 *   F. deux passages SIMULTANÉS sur la même boîte → un seul travaille (verrou) ;
 *   G. la sélection du planificateur (`mailboxesToSort`) ne retient QUE les boîtes à travailler :
 *      une boîte en pause, sans moteur ou verrouillée n'y figure pas. Mesurée sur la VRAIE requête
 *      SQL — celle que `processTagging` utilise — sans ouvrir aucune connexion IMAP ;
 *   H. l'ÉCHANTILLON (lot T10b) : le tirage est reproductible à graine égale, différent à graine
 *      différente, indépendant de l'ordre d'énumération des dossiers et réparti sur plusieurs
 *      dossiers ; le tri s'ARRÊTE à N (critère = nombre d'appels au moteur) ; le tirage est
 *      ENREGISTRÉ et non refait ; `total` vaut la taille du tirage ; le plafond et les pauses sont
 *      ceux du tri complet ; la RELECTURE d'un lot tiré ne transmet QUE les mails tirés (H21, le
 *      critère est le nombre de mails transmis, pas le nombre d'appels) ;
 *      un mail supprimé entre le tirage et son tour est compté sauté sans
 *      bloquer le curseur ; la répartition par question totalise les mails tagués ; « lancer le
 *      tri complet » efface le mode échantillon.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : entre deux passages de A (et de H), la MÉMOIRE DE LA REPRISE
 * est effacée dans la base (curseurs de masse ET d'échantillon remis à NULL, et les étiquettes
 * déjà écrites supprimées) — le trieur ne peut donc plus savoir où il en était. Le banc DOIT alors
 * virer au rouge sur A2 (le nombre d'appels au moteur) et sur H5 (l'arrêt à N : un tirage refait à
 * chaque passage ne s'arrête pas où il faut), ET sur H21 (la relecture repasse par la plage
 * ouverte `N:*` : elle transmet alors la fin du dossier au lieu des 20 mails tirés). Rien n'est modifié dans le produit : l'effacement est fait par le banc, en
 * SQL, sur ses propres lignes.
 * Ce qu'il démontre : le critère de A (le nombre d'appels) est bien SENSIBLE à l'état de reprise —
 * il ne se contente pas de constater que le jeu de banc n'a pas de doublons. Ce qu'il ne démontre
 * PAS : lequel des deux mécanismes (curseur enregistré, saut par `alreadyTagged`) porte quelle part
 * du résultat — les deux sont effacés ensemble ; ni le comportement d'une VRAIE source IMAP (lot
 * T8), ni celui des routes HTTP (lot T4).
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
const runner = await import('../lib/tagging/runner.ts')
const { ASSUMED_INPUT_TOKENS_PER_QUESTION, assumedInputTokensPerMail, EngineError } = await import('../lib/tagging/engine.ts')
const { QUESTIONS, valuesOf } = await import('../lib/tagging/questions.ts')
const store = await import('../lib/tagging/store.ts')

/** Domaine de test réservé (RFC 2606) : aucun risque de heurter un vrai mail de la boîte. */
const MID = n => `<banc-t3-${n}@exemple.invalid>`
const MID_LIKE = '<banc-t3-%@exemple.invalid>'

const pool = new pg.Pool({ connectionString: DB_URL })

const clean = async accountId => {
  await pool.query(`DELETE FROM message_tags WHERE ${MINE}`, MINE_ARGS)
  await pool.query(`DELETE FROM tagged_messages WHERE ${MINE}`, MINE_ARGS)
  if (accountId) await pool.query('DELETE FROM mailbox_tagging WHERE account_id = $1', [accountId])
}

/**
 * La FAUSSE source : 3 dossiers, ~60 mails, dont 2 doublons de Message-ID (le même mail classé
 * deux fois, ce qui arrive vraiment) et 1 mail SANS Message-ID (qui doit recevoir un identifiant
 * dérivé stable). Elle rend les mails par UID croissant, comme une vraie.
 */
const FOLDERS = [
  { path: 'INBOX', uidValidity: '1000', count: 25 },
  { path: 'Clients', uidValidity: '1001', count: 20 },
  { path: 'Fournisseurs', uidValidity: '1002', count: 15 },
]

/** L'UID du mail d'INBOX qui n'a PAS de Message-ID. */
const NO_ID_UID = 11

/** Le mail n°i d'un dossier. Les deux doublons et le mail sans identifiant sont dans INBOX. */
const mailOf = (folder, i) => {
  const base = { folder, uid: i, fromName: 'Client Banc', fromAddress: `client${i}@exemple.invalid`,
    subject: `Banc T3 ${folder} ${i}`, bodyPlain: `Corps du mail ${i} du dossier ${folder}.`,
    date: new Date(Date.UTC(2026, 8, 1, 0, i)) }
  if (folder === 'INBOX' && i === 3) return { ...base, messageId: MID('INBOX-2') }   // doublon de l'UID 2
  if (folder === 'INBOX' && i === 7) return { ...base, messageId: MID('INBOX-6') }   // doublon de l'UID 6
  if (folder === 'INBOX' && i === NO_ID_UID) return { ...base, messageId: null }      // sans Message-ID
  return { ...base, messageId: MID(`${folder}-${i}`) }
}

/**
 * Le mail SANS Message-ID reçoit un identifiant DÉRIVÉ (`…@synapmail.local`) : il ne porte donc
 * pas le motif du banc. Le nettoyage et les comptages doivent le viser explicitement, sinon il
 * survit au `finally` — et une ligne de banc laissée dans une base réelle est un défaut, pas un
 * détail. Il est calculé par le PRODUIT, jamais recopié à la main.
 */
const DERIVED = store.messageIdOf(mailOf('INBOX', NO_ID_UID))
const MINE = 'message_id LIKE $1 OR message_id = $2'
const MINE_ARGS = [MID_LIKE, DERIVED]

/**
 * `holes` est une liste VIVE de `dossier|uid` disparus. Une vraie boîte en a : un mail supprimé
 * entre le moment où on l'a listé et celui où on le relit. La source ne le rend plus, et rend le
 * SUIVANT — c'est ce qu'un `FETCH` d'un UID absent fait, et ce que H6 mesure.
 */
const makeSource = (folders = FOLDERS, holes = new Set()) => ({
  async folders() {
    return folders.map(f => ({ path: f.path, uidValidity: f.uidValidity, total: f.count }))
  },
  // Les UID SEULS, sans lire un mail : c'est ce que le tirage utilise. Le compteur `reads` plus
  // bas mesure que le tirage n'appelle bien PLUS `fetch` — la vraie source y téléchargeait le
  // corps de chaque mail de la boîte.
  async uids(folder) {
    const f = folders.find(x => x.path === folder)
    if (!f) return []
    const out = []
    for (let i = 1; i <= f.count; i += 1) if (!holes.has(`${folder}|${i}`)) out.push(i)
    return out
  },
  async fetch(folder, afterUid, limit) {
    const f = folders.find(x => x.path === folder)
    if (!f) return []
    const out = []
    for (let i = afterUid + 1; i <= f.count && out.length < limit; i += 1) {
      if (holes.has(`${folder}|${i}`)) continue
      out.push(mailOf(folder, i))
    }
    return out
  },
  // La lecture d'une LISTE d'UID : ce que l'échantillon utilise pour relire ses mails tirés. Un
  // UID dans un trou est simplement absent du résultat, comme un `UID FETCH` d'un UID supprimé.
  async fetchUids(folder, uids) {
    const f = folders.find(x => x.path === folder)
    if (!f) return []
    return uids
      .filter(u => u >= 1 && u <= f.count && !holes.has(`${folder}|${u}`))
      .sort((a, b) => a - b)
      .map(u => mailOf(folder, u))
  },
})

/** Le nombre de mails DISTINCTS (par Message-ID) que la fausse source contient. */
const distinctMails = (folders = FOLDERS) => {
  const ids = new Set()
  for (const f of folders) for (let i = 1; i <= f.count; i += 1) ids.add(store.messageIdOf(mailOf(f.path, i)))
  return ids.size
}

/**
 * Combien de mails de la fausse source portent un Message-ID DÉJÀ porté par un mail précédent :
 * le même mail classé deux fois. Ce sont les SEULS « sautés » qu'un tri complet doit compter —
 * calculé depuis la source, jamais recopié à la main.
 */
const duplicateMails = (folders = FOLDERS) => {
  const ids = new Set()
  let dups = 0
  for (const f of folders) for (let i = 1; i <= f.count; i += 1) {
    const id = store.messageIdOf(mailOf(f.path, i))
    if (ids.has(id)) dups += 1
    else ids.add(id)
  }
  return dups
}

/** Une réponse plausible du moteur : une valeur PRÉVUE pour chaque question posée. */
const ANSWERS = Object.fromEntries(QUESTIONS.map(q => {
  const value = valuesOf(q)[0]
  if (q.type === 'noul') return [q.id, { noul: 0.9 }]
  if (q.type === 'score') return [q.id, { score: 0, probabilities: { 0: 0.8 } }]
  return [q.id, { choice: value, confidence: 0.8, probabilities: { [value]: 0.8 } }]
}))

/**
 * Le FAUX moteur. Il COMPTE ses appels et retient quels mails il a vus : c'est la mesure elle-même.
 * `failAt` lui fait jeter l'erreur typée du produit au n-ième appel — un 402 ne se simule pas en
 * changeant le trieur, mais en faisant refuser le moteur, comme le vrai.
 */
const ENGINE_LATENCY_MS = 25

const makeEngine = (opts = {}) => {
  const seen = []
  return {
    source: 'jev',
    usdPerBillionInput: opts.usdPerBillionInput ?? 42,
    get calls() { return seen.length },
    get seen() { return seen },
    async ask(state) {
      seen.push(state.objet)
      // Le refus se décide sur le RANG de cet appel, retenu AVANT la latence : avec deux requêtes
      // en vol, `seen.length` a déjà avancé quand la promesse se résout, et un test d'égalité sur
      // sa valeur d'alors ne tomberait jamais.
      const rank = seen.length
      // Un moteur INSTANTANÉ ne laisse jamais expirer le délai d'un passage : le tri entier
      // tiendrait dans un seul, et A ne mesurerait plus aucune coupure. Une latence de l'ordre de
      // celle mesurée sur JEV (~1 s, réduite ici pour que le banc reste court) rend les coupures
      // RÉELLES — c'est ce qui rend A2 sensible à l'état de reprise, cf. le contrôle négatif.
      await new Promise(r => setTimeout(r, opts.delayMs ?? ENGINE_LATENCY_MS))
      if (opts.failAt && rank >= opts.failAt) throw new EngineError('credit', 402, 'insufficient credit balance')
      return { model: 'faux-1.0.0', tags: QUESTIONS.map(q => {
        const a = ANSWERS[q.id]
        const valeur = q.type === 'noul' ? 'oui' : valuesOf(q)[0]
        return { question: q.id, valeur, probabilites: a.probabilities ?? null, confiance: 0.8 }
      }), rejected: [], inputTokens: opts.inputTokens ?? assumedInputTokensPerMail() }
    },
  }
}

/** La ligne `mailbox_tagging` de la boîte du banc, remise à l'état demandé. */
const setMailbox = async (accountId, engineId, patch = {}) => {
  const cols = { budget_usd: 1000, spent_usd: 0, input_tokens: 0, live: false, live_cursor: null,
    bulk_state: 'idle', bulk_cursor: null, tagged: 0, skipped: 0, errors: 0, total: 0,
    paused_reason: null, paused_detail: null, locked_until: null,
    // Les colonnes d'échantillon sont remises comme les autres : sans ça, la section H laisserait
    // `sample_size` posé et les sections suivantes trieraient un échantillon sans le savoir.
    sample_size: null, sample_seed: null, sample_cursor: null, run_started_at: null, ...patch }
  await pool.query(
    `INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd, spent_usd, input_tokens, live,
                                  live_cursor, bulk_state, bulk_cursor, tagged, skipped, errors,
                                  total, paused_reason, paused_detail, locked_until,
                                  sample_size, sample_seed, sample_cursor, run_started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)
     ON CONFLICT (account_id) DO UPDATE SET
       engine_id = EXCLUDED.engine_id, budget_usd = EXCLUDED.budget_usd, spent_usd = EXCLUDED.spent_usd,
       input_tokens = EXCLUDED.input_tokens, live = EXCLUDED.live, live_cursor = EXCLUDED.live_cursor,
       bulk_state = EXCLUDED.bulk_state, bulk_cursor = EXCLUDED.bulk_cursor, tagged = EXCLUDED.tagged,
       skipped = EXCLUDED.skipped, errors = EXCLUDED.errors, total = EXCLUDED.total,
       paused_reason = EXCLUDED.paused_reason, paused_detail = EXCLUDED.paused_detail,
       locked_until = EXCLUDED.locked_until, sample_size = EXCLUDED.sample_size,
       sample_seed = EXCLUDED.sample_seed, sample_cursor = EXCLUDED.sample_cursor,
       run_started_at = EXCLUDED.run_started_at`,
    [accountId, engineId, cols.budget_usd, cols.spent_usd, cols.input_tokens, cols.live,
      cols.live_cursor ? JSON.stringify(cols.live_cursor) : null, cols.bulk_state,
      cols.bulk_cursor ? JSON.stringify(cols.bulk_cursor) : null, cols.tagged, cols.skipped,
      cols.errors, cols.total, cols.paused_reason, cols.paused_detail, cols.locked_until,
      cols.sample_size, cols.sample_seed, cols.sample_cursor ? JSON.stringify(cols.sample_cursor) : null,
      cols.run_started_at])
}

/**
 * CONTRÔLE NÉGATIF : efface ce qui permet de reprendre. Le curseur ne dit plus où on en était, et
 * les étiquettes ne disent plus ce qui est déjà payé — un passage repart donc du premier mail.
 */
const forgetResume = async accountId => {
  await pool.query('UPDATE mailbox_tagging SET bulk_cursor = NULL, sample_cursor = NULL WHERE account_id = $1', [accountId])
  await pool.query(`DELETE FROM message_tags WHERE account_id = $3 AND (${MINE})`, [...MINE_ARGS, accountId])
}

const mailboxOf = async accountId =>
  (await pool.query('SELECT * FROM mailbox_tagging WHERE account_id = $1', [accountId])).rows[0]

const taggedCount = async accountId =>
  Number((await pool.query(
    `SELECT COUNT(DISTINCT message_id) AS n FROM message_tags
      WHERE account_id = $3 AND (${MINE})`, [...MINE_ARGS, accountId])).rows[0].n)

console.log(`\nbanc du trieur${NEGATIVE ? ' — CONTRÔLE NÉGATIF (curseur non enregistré)' : ''}\n`)

await initDb()

const [account] = await query('SELECT id, user_id FROM email_accounts ORDER BY created_at LIMIT 1')
if (!account) harness("la base de la lane n'a aucune boîte : rien à trier")
const ACCOUNT = account.id
const USER = account.user_id

let ENGINE_ID = null
try {
  const ins = await pool.query(
    `INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input)
     VALUES ($1, $2, 'jev', 'http://banc.invalid/v1/systemone', 'banc-latest', 42) RETURNING id`,
    [USER, 'banc T3 (faux moteur)'])
  ENGINE_ID = ins.rows[0].id

  await clean(ACCOUNT)
  const DISTINCT = distinctMails()

  // ---- A. coupure au milieu, puis reprise ----
  console.log('A. une coupure ne fait pas payer deux fois le même mail')
  await setMailbox(ACCOUNT, ENGINE_ID)
  await runner.startBulk(ACCOUNT)
  const engineA = makeEngine()
  const source = makeSource()
  // Des passages COURTS : le délai s'épuise au milieu d'un dossier, exactement comme une coupure.
  const passes = []
  for (let n = 0; n < 40; n += 1) {
    const before = await mailboxOf(ACCOUNT)
    if (before.bulk_state === 'done' || before.paused_reason) break
    passes.push(await runner.runPass({ accountId: ACCOUNT, source, engine: engineA, budgetMs: 250 }))
    if (NEGATIVE) await forgetResume(ACCOUNT)
  }
  const afterA = await mailboxOf(ACCOUNT)
  check('A1 le tri finit par se terminer, et il a bien fallu PLUSIEURS passages coupés',
    afterA.bulk_state === 'done' && passes.length >= 3,
    `état=${afterA.bulk_state} passages=${passes.length} pause=${afterA.paused_reason}`)
  check(`A2 chaque mail DISTINCT est demandé exactement une fois (${DISTINCT} attendus)`,
    engineA.calls === DISTINCT, `${engineA.calls} appel(s) pour ${DISTINCT} mails distincts`)
  check('A3 aucun objet n’a été soumis deux fois au moteur',
    new Set(engineA.seen).size === engineA.seen.length,
    `${engineA.seen.length} appels, ${new Set(engineA.seen).size} objets distincts`)
  check(`A4 tous les mails distincts portent des étiquettes`,
    (await taggedCount(ACCOUNT)) === DISTINCT, `${await taggedCount(ACCOUNT)} / ${DISTINCT}`)
  check('A5 le mail SANS Message-ID a bien été tagué sous un identifiant dérivé',
    Number((await pool.query(
      `SELECT COUNT(*) AS n FROM message_tags WHERE account_id = $1 AND message_id LIKE '%@synapmail.local>'`,
      [ACCOUNT])).rows[0].n) > 0)

  // A6 : LE point du lot T10c. Un lot coupé au délai ne fait pas avancer son curseur, donc le
  // passage suivant RELIT ses mails. Ceux-là sont déjà comptés en « tagués » — les compter aussi
  // en « sautés » gonflait les deux compteurs pour un seul mail (mesuré en vrai : 86 sautés pour
  // 995 tagués sur 1 000 tirés). Seuls les VRAIS sautés comptent : ici, les doublons de
  // Message-ID. Le nombre de passages coupés (A1 en exige ≥ 3) ne doit RIEN y changer.
  const DUPS = duplicateMails()
  check(`A6 « sautés » ne compte que les vrais sautés : ${DUPS} doublon(s), pas les mails relus après une coupure`,
    afterA.skipped === DUPS, `sautés=${afterA.skipped}, attendu=${DUPS}, passages coupés=${passes.length}`)
  check('A7 tagués + sautés = les mails demandés : aucun mail compté deux fois',
    afterA.tagged + afterA.skipped === DISTINCT + DUPS,
    `tagués=${afterA.tagged} + sautés=${afterA.skipped} = ${afterA.tagged + afterA.skipped}, attendu=${DISTINCT + DUPS}`)

  // ---- B. relancer un tri terminé ----
  console.log('\nB. relancer un tri TERMINÉ ne coûte rien')
  const engineB = makeEngine()
  const passB = await runner.runPass({ accountId: ACCOUNT, source, engine: engineB, budgetMs: 5_000 })
  check('B1 aucun appel au moteur', engineB.calls === 0, `${engineB.calls} appel(s)`)
  check('B2 le passage le DIT (état « done »)', passB.reason === 'done', passB.reason)
  await runner.startBulk(ACCOUNT)
  const engineB2 = makeEngine()
  await runner.runPass({ accountId: ACCOUNT, source, engine: engineB2, budgetMs: 5_000 })
  check('B3 un « lancer » sur un tri déjà fait ne redemande rien non plus (saut par étiquette déjà écrite)',
    engineB2.calls === 0, `${engineB2.calls} appel(s)`)

  // ---- C. plafond ----
  console.log('\nC. le plafond arrête AVANT de payer')
  await clean(ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running', budget_usd: 0.0001, spent_usd: 0 })
  const engineC = makeEngine()
  const passC1 = await runner.runPass({ accountId: ACCOUNT, source, engine: engineC, budgetMs: 5_000 })
  const rowC = await mailboxOf(ACCOUNT)
  check('C1 la boîte est en pause « budget »', rowC.paused_reason === 'budget', String(rowC.paused_reason))
  check('C2 la pause NOMME le plafond', /plafond/.test(rowC.paused_detail ?? ''), String(rowC.paused_detail))
  const callsAtPause = engineC.calls
  const passC2 = await runner.runPass({ accountId: ACCOUNT, source, engine: engineC, budgetMs: 5_000 })
  check('C3 le passage suivant n’appelle PLUS le moteur', engineC.calls === callsAtPause,
    `${callsAtPause} → ${engineC.calls}`)
  check('C4 et il le dit (« paused »)', passC2.reason === 'paused', passC2.reason)
  void passC1

  // ---- D. 402 : pause credit, curseur intact, reprise sans doublon ----
  console.log('\nD. un crédit épuisé met en pause sans perdre le curseur')
  await clean(ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running', budget_usd: 1000 })
  const FAIL_AT = 15
  const engineD = makeEngine({ failAt: FAIL_AT })
  await runner.runPass({ accountId: ACCOUNT, source, engine: engineD, budgetMs: 10_000 })
  const rowD = await mailboxOf(ACCOUNT)
  check('D1 la boîte est en pause « credit »', rowD.paused_reason === 'credit', String(rowD.paused_reason))
  check('D2 le curseur est ENREGISTRÉ, pas perdu', !!rowD.bulk_cursor, JSON.stringify(rowD.bulk_cursor))
  const taggedBefore = await taggedCount(ACCOUNT)
  check('D3 les mails déjà faits sont bien rangés', taggedBefore > 0, `${taggedBefore} mail(s)`)
  await runner.resumeMailbox(ACCOUNT)
  const engineD2 = makeEngine()
  for (let n = 0; n < 40; n += 1) {
    const before = await mailboxOf(ACCOUNT)
    if (before.bulk_state === 'done' || before.paused_reason) break
    await runner.runPass({ accountId: ACCOUNT, source, engine: engineD2, budgetMs: 2_000 })
  }
  const rowD2 = await mailboxOf(ACCOUNT)
  check('D4 la reprise termine le tri', rowD2.bulk_state === 'done',
    `état=${rowD2.bulk_state} pause=${rowD2.paused_reason}`)
  check(`D5 la reprise ne redemande PAS les ${taggedBefore} mails déjà faits`,
    engineD2.calls === DISTINCT - taggedBefore,
    `${engineD2.calls} appel(s), ${DISTINCT - taggedBefore} attendu(s)`)
  check('D6 au total, chaque mail distinct a été tagué',
    (await taggedCount(ACCOUNT)) === DISTINCT, `${await taggedCount(ACCOUNT)} / ${DISTINCT}`)

  // ---- E. au fil de l'eau ----
  console.log('\nE. le fil de l’eau ne tague QUE ce qui arrive après')
  await clean(ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'idle', budget_usd: 1000 })
  const growing = FOLDERS.map(f => ({ ...f }))
  const growingSource = makeSource(growing)
  const cursorE = await runner.enableLive(ACCOUNT, growingSource)
  check('E1 l’activation place le curseur au DERNIER UID de chaque dossier',
    growing.every(f => cursorE[f.path]?.lastUid === f.count), JSON.stringify(cursorE))
  const engineE = makeEngine()
  await runner.runPass({ accountId: ACCOUNT, source: growingSource, engine: engineE, budgetMs: 5_000 })
  check('E2 juste après l’activation, AUCUN mail de l’historique n’est demandé',
    engineE.calls === 0, `${engineE.calls} appel(s)`)
  // Trois mails arrivent dans INBOX.
  growing[0].count += 3
  await runner.runPass({ accountId: ACCOUNT, source: growingSource, engine: engineE, budgetMs: 5_000 })
  check('E3 seuls les 3 nouveaux mails sont demandés', engineE.calls === 3, `${engineE.calls} appel(s)`)
  await runner.runPass({ accountId: ACCOUNT, source: growingSource, engine: engineE, budgetMs: 5_000 })
  check('E4 le passage suivant, sans nouveauté, ne demande rien', engineE.calls === 3, `${engineE.calls} appel(s)`)

  // ---- F. verrou ----
  console.log('\nF. deux passages simultanés : un seul travaille')
  await clean(ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running', budget_usd: 1000 })
  const engineF1 = makeEngine()
  const engineF2 = makeEngine()
  const [f1, f2] = await Promise.all([
    runner.runPass({ accountId: ACCOUNT, source, engine: engineF1, budgetMs: 1_500 }),
    runner.runPass({ accountId: ACCOUNT, source, engine: engineF2, budgetMs: 1_500 }),
  ])
  const locked = [f1, f2].filter(p => p.reason === 'locked')
  check('F1 exactement un des deux passages est refusé par le verrou', locked.length === 1,
    `${f1.reason} / ${f2.reason}`)
  check('F2 le passage refusé n’a appelé le moteur AUCUNE fois',
    (f1.reason === 'locked' ? engineF1.calls : engineF2.calls) === 0,
    `${engineF1.calls} / ${engineF2.calls}`)
  check('F3 le passage gagnant a bien travaillé',
    (f1.reason === 'locked' ? engineF2.calls : engineF1.calls) > 0,
    `${engineF1.calls} / ${engineF2.calls}`)

  // ---- G. ce que le planificateur sélectionne ----
  console.log('\nG. le planificateur ne réveille que les boîtes à trier')
  const mine = async () => (await runner.mailboxesToSort()).filter(b => b.account_id === ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running' })
  check('G1 une boîte dont le tri en masse tourne est sélectionnée', (await mine()).length === 1)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'idle', live: true })
  check('G2 une boîte au fil de l’eau est sélectionnée', (await mine()).length === 1)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'idle', live: false })
  check('G3 une boîte sans rien à trier n’est PAS sélectionnée', (await mine()).length === 0)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running', paused_reason: 'user', paused_detail: 'banc' })
  check('G4 une boîte EN PAUSE n’est jamais réveillée', (await mine()).length === 0)
  await setMailbox(ACCOUNT, null, { bulk_state: 'running' })
  check('G5 une boîte SANS moteur n’est pas sélectionnée (rien à quoi demander)', (await mine()).length === 0)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running', locked_until: new Date(Date.now() + 60_000) })
  check('G6 une boîte VERROUILLÉE (passage en cours) n’est pas reprise', (await mine()).length === 0)
  const selected = (await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running' }), (await mine())[0])
  check('G7 la boîte sélectionnée porte le moteur ET ses identifiants IMAP, en une requête',
    selected?.engine_kind === 'jev' && selected?.engine_model === 'banc-latest' && !!selected?.imap_host
      && Number(selected?.engine_price) === 42,
    JSON.stringify({ kind: selected?.engine_kind, model: selected?.engine_model, price: selected?.engine_price, host: !!selected?.imap_host }))
  check('G8 la clé du moteur n’est PAS en clair dans ce que la requête rend',
    selected?.engine_key === null || !/^sk-|^syn_/.test(String(selected?.engine_key)),
    String(selected?.engine_key))

  // ---- H. l'échantillon (lot T10b) ----
  console.log('\nH. un échantillon tire le même hasard, s’arrête à N, et obéit au plafond')
  // PLUS GRAND qu'un lot : sinon un seul passage tire ET finit tout, et ni la coupure ni
  // l'effacement du contrôle négatif ne changeraient quoi que ce soit — H5 serait vert sans rien
  // mesurer, et H11 n'aurait aucun mail « pas encore traité » à faire disparaître.
  const SAMPLE_N = runner.BATCH_SIZE + 10
  const SEED_A = 20260926
  const SEED_B = 777

  // H1/H2 : le TIRAGE lui-même, sans rien taguer — `drawSample` est pur vis-à-vis de la base.
  const drawA1 = await runner.drawSample(source, { seed: SEED_A, size: SAMPLE_N })
  const drawA2 = await runner.drawSample(source, { seed: SEED_A, size: SAMPLE_N })
  const drawB = await runner.drawSample(source, { seed: SEED_B, size: SAMPLE_N })
  const key = picks => picks.map(p => `${p.folder}|${p.uid}`).join(',')
  check(`H1 à graine égale, le tirage est le MÊME (${SAMPLE_N} mails)`,
    drawA1.length === SAMPLE_N && key(drawA1) === key(drawA2), `${key(drawA1)}\n       vs ${key(drawA2)}`)
  check('H2 à graine DIFFÉRENTE, le tirage est autre', key(drawA1) !== key(drawB),
    `${key(drawA1)}\n       vs ${key(drawB)}`)
  // Un tirage qui ne sortirait que d'un seul dossier ne serait pas « au hasard dans TOUS les
  // dossiers » : c'est la propriété que le besoin demande, donc elle se mesure.
  check('H3 le tirage puise dans PLUSIEURS dossiers, pas seulement le premier',
    new Set(drawA1.map(p => p.folder)).size > 1, JSON.stringify([...new Set(drawA1.map(p => p.folder))]))
  // L'ordre d'énumération ne doit RIEN changer : c'est la raison d'être du rang par hachage.
  const reversedSource = makeSource([...FOLDERS].reverse())
  check('H4 l’ordre dans lequel les dossiers sont parcourus ne change pas le tirage',
    key(await runner.drawSample(reversedSource, { seed: SEED_A, size: SAMPLE_N })) === key(drawA1))

  // H17/H18/H19 : le TIRAGE sur une GROSSE boîte. C'est le défaut qui a fait échouer le gate sur
  // la vraie boîte (161 635 mails) : le tirage énumérait tout en LISANT chaque mail, ne finissait
  // aucun passage de 50 s, et ne gardait rien — la boîte ne taguait jamais rien.
  const BIG_FOLDERS = 1000
  const BIG_PER_FOLDER = 100
  const BIG_TOTAL = BIG_FOLDERS * BIG_PER_FOLDER
  let bigReads = 0
  const bigSource = {
    async folders() {
      return Array.from({ length: BIG_FOLDERS }, (_, i) => ({ path: `Gros/${i}`, uidValidity: '1', total: BIG_PER_FOLDER }))
    },
    async uids(folder) {
      // Les UID ne sont PAS contigus dans une vraie boîte : un mail supprimé laisse un trou.
      const base = Number(folder.split('/')[1]) * 10
      return Array.from({ length: BIG_PER_FOLDER }, (_, i) => base + i * 3 + 1)
    },
    async fetch() { bigReads += 1; return [] },
  }
  const BIG_MS = 30_000
  const t0 = Date.now()
  const bigDraw = await runner.drawSample(bigSource, { seed: SEED_A, size: runner.SAMPLE_SIZE_DEFAULT })
  const bigMs = Date.now() - t0
  check(`H17 le tirage finit sur ${BIG_TOTAL} mails / ${BIG_FOLDERS} dossiers en moins de ${BIG_MS} ms`,
    bigDraw.length === runner.SAMPLE_SIZE_DEFAULT && bigMs < BIG_MS,
    `${bigDraw.length} tirés en ${bigMs} ms`)
  check('H18 le tirage ne LIT aucun mail : zéro appel à fetch (c’est le défaut mesuré sur la vraie boîte)',
    bigReads === 0, `${bigReads} appel(s) à fetch`)
  // H19 : le même tirage, mais COUPÉ — on le rejoue dossier par dossier via `drawStep`, exactement
  // ce que fait le passage quand son délai tombe. Le résultat doit être IDENTIQUE, sinon la
  // reprise change l'échantillon annoncé.
  let best = []
  for (const f of await bigSource.folders()) {
    best = runner.drawStep(best, SEED_A, runner.SAMPLE_SIZE_DEFAULT, f.path, await bigSource.uids(f.path))
  }
  check('H19 un tirage COUPÉ puis repris dossier par dossier rend EXACTEMENT le même échantillon',
    key(best.map(m => ({ folder: m.folder, uid: m.uid }))) === key(bigDraw),
    `${best.length} vs ${bigDraw.length}`)
  check(`H20 l’état gardé entre deux passages reste BORNÉ à la taille du tirage (${runner.SAMPLE_SIZE_DEFAULT}), pas la boîte (${BIG_TOTAL})`,
    best.length === runner.SAMPLE_SIZE_DEFAULT, `${best.length} entrées`)

  // H21 : la RELECTURE des mails tirés. Le tirage (H17-H20) ne lit aucun mail ; il reste à
  // mesurer ce que coûte de les relire. C'est le second défaut mesuré sur la vraie boîte : chaque
  // mail tiré était relu par `fetch(folder, uid - 1, 1)`, dont la plage IMAP `N:*` est OUVERTE —
  // le serveur transmet toute la fin du dossier avant que le client ne s'arrête. Le critère n'est
  // donc PAS le nombre d'appels mais le nombre de mails TRANSMIS : lire 20 UID épars dans un
  // dossier de 100 000 doit en transmettre 20.
  const READ_PER_FOLDER = 100_000
  const READ_PICKS = 20
  let sent = 0
  const readSource = {
    async folders() { return [{ path: 'Gros', uidValidity: '1', total: READ_PER_FOLDER }] },
    async uids() { return Array.from({ length: READ_PER_FOLDER }, (_, i) => i + 1) },
    // La forme d'AVANT le correctif, telle que le serveur la sert : la plage `afterUid+1:*` est
    // ouverte, donc TOUT ce qui suit est transmis, même si le client s'arrête après `limit`.
    async fetch(folder, afterUid, limit) {
      sent += Math.max(READ_PER_FOLDER - afterUid, 0)
      const out = []
      for (let i = afterUid + 1; i <= READ_PER_FOLDER && out.length < limit; i += 1) out.push(mailOf(folder, i))
      return out
    },
    async fetchUids(folder, uids) {
      // CONTRÔLE NÉGATIF : on remet le `N:*` d'avant le correctif. Le compte de mails transmis
      // explose, et H21 DOIT virer au rouge — sinon son critère ne mesure rien.
      if (NEGATIVE) {
        const out = []
        for (const u of [...uids].sort((a, b) => a - b)) out.push(...await readSource.fetch(folder, u - 1, 1))
        return out
      }
      sent += uids.length
      return [...uids].sort((a, b) => a - b).map(u => mailOf(folder, u))
    },
  }
  const readPicks = (await runner.drawSample(readSource, { seed: SEED_A, size: READ_PICKS }))
  sent = 0
  const readBack = await readSource.fetchUids('Gros', readPicks.map(p => p.uid))
  check(`H21 relire ${READ_PICKS} mails tirés dans un dossier de ${READ_PER_FOLDER.toLocaleString('fr-FR')} en transmet ${READ_PICKS}, pas la fin du dossier`,
    sent === READ_PICKS && readBack.length === READ_PICKS, `${sent} mail(s) transmis, ${readBack.length} rendu(s)`)

  // H5 : le tri d'un échantillon, de bout en bout, en passages COURTS (donc coupés).
  await clean(ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'idle', budget_usd: 1000 })
  await runner.startSample(ACCOUNT, { size: SAMPLE_N, seed: SEED_A })
  const engineH = makeEngine()
  const passesH = []
  for (let n = 0; n < 40; n += 1) {
    const before = await mailboxOf(ACCOUNT)
    if (before.bulk_state === 'done' || before.paused_reason) break
    passesH.push(await runner.runPass({ accountId: ACCOUNT, source, engine: engineH, budgetMs: 250 }))
    if (NEGATIVE) await forgetResume(ACCOUNT)
  }
  const rowH = await mailboxOf(ACCOUNT)
  // Les doublons de Message-ID du jeu de banc peuvent tomber dans le tirage : le nombre d'APPELS
  // est alors le nombre de mails DISTINCTS tirés, pas N. C'est calculé depuis le tirage, jamais
  // supposé — un critère deviné ne mesure rien.
  const drawnDistinct = new Set(drawA1.map(p => store.messageIdOf(mailOf(p.folder, p.uid)))).size
  check(`H5 l’échantillon s’arrête à N : ${drawnDistinct} appel(s) pour ${SAMPLE_N} mails tirés, et le tri est « done »`,
    engineH.calls === drawnDistinct && rowH.bulk_state === 'done',
    `${engineH.calls} appel(s) (${drawnDistinct} attendu(s)), état=${rowH.bulk_state}, pause=${rowH.paused_reason}`)
  check('H6 le tirage est ENREGISTRÉ (il n’est pas refait à chaque passage), et il est allé au bout',
    rowH.sample_cursor?.picks?.length === SAMPLE_N && rowH.sample_cursor?.done === SAMPLE_N,
    JSON.stringify({ picks: rowH.sample_cursor?.picks?.length, done: rowH.sample_cursor?.done }))
  check(`H7 « total » vaut la taille du TIRAGE (${SAMPLE_N}), pas celle de la boîte (${DISTINCT})`,
    rowH.total === SAMPLE_N, `total=${rowH.total}`)
  check('H8 le tirage enregistré est exactement celui que drawSample rend à la même graine',
    key(rowH.sample_cursor?.picks ?? []) === key(drawA1))

  // H9 : le plafond, sur un échantillon. Même pause, même code que le tri complet — ce qui se
  // mesure ici, c'est qu'il soit bien ATTEINT par ce chemin-là.
  await clean(ACCOUNT)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'idle', budget_usd: 0.0001 })
  await runner.startSample(ACCOUNT, { size: SAMPLE_N, seed: SEED_A })
  const engineH2 = makeEngine()
  await runner.runPass({ accountId: ACCOUNT, source, engine: engineH2, budgetMs: 5_000 })
  const rowH2 = await mailboxOf(ACCOUNT)
  check('H9 un échantillon au plafond passe en pause « budget »', rowH2.paused_reason === 'budget',
    `${rowH2.paused_reason} / ${rowH2.paused_detail}`)
  const callsH2 = engineH2.calls
  const passH2 = await runner.runPass({ accountId: ACCOUNT, source, engine: engineH2, budgetMs: 5_000 })
  check('H10 et le passage suivant n’appelle plus le moteur', engineH2.calls === callsH2 && passH2.reason === 'paused',
    `${callsH2} → ${engineH2.calls}, ${passH2.reason}`)

  // H11 : un mail SUPPRIMÉ entre le tirage et son tour. Il est compté sauté, et le curseur avance
  // quand même — sinon l'échantillon ne finirait jamais. Le trou est posé APRÈS le tirage.
  await clean(ACCOUNT)
  const holes = new Set()
  const holedSource = makeSource(FOLDERS, holes)
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'idle', budget_usd: 1000 })
  await runner.startSample(ACCOUNT, { size: SAMPLE_N, seed: SEED_A })
  const engineH3 = makeEngine()
  // Premier passage, COURT : le tirage est fait et enregistré sur la boîte ENTIÈRE, et il reste
  // des mails tirés non traités derrière.
  await runner.runPass({ accountId: ACCOUNT, source: holedSource, engine: engineH3, budgetMs: 250 })
  const rowH3a = await mailboxOf(ACCOUNT)
  const drawnH3 = rowH3a.sample_cursor?.picks ?? []
  const pending = drawnH3.slice(rowH3a.sample_cursor?.done ?? 0)
  // Trois mails tirés mais PAS encore traités disparaissent de la boîte.
  const vanished = pending.slice(-3)
  for (const p of vanished) holes.add(`${p.folder}|${p.uid}`)
  check(`H11a le montage tient : ${pending.length} mail(s) tiré(s) restent à traiter, ${vanished.length} vont disparaître`,
    vanished.length === 3, `tirés=${drawnH3.length} done=${rowH3a.sample_cursor?.done} restants=${pending.length}`)
  for (let n = 0; n < 40; n += 1) {
    const before = await mailboxOf(ACCOUNT)
    if (before.bulk_state === 'done' || before.paused_reason) break
    await runner.runPass({ accountId: ACCOUNT, source: holedSource, engine: engineH3, budgetMs: 250 })
  }
  const rowH3 = await mailboxOf(ACCOUNT)
  check(`H11 ${vanished.length} mail(s) disparu(s) après le tirage n’empêchent PAS l’échantillon de finir`,
    rowH3.bulk_state === 'done' && rowH3.sample_cursor?.done === SAMPLE_N,
    `état=${rowH3.bulk_state} done=${rowH3.sample_cursor?.done}/${SAMPLE_N} pause=${rowH3.paused_reason}`)
  check(`H12 ils sont COMPTÉS comme sautés, jamais tus (≥ ${vanished.length})`,
    rowH3.skipped >= vanished.length, `sautés=${rowH3.skipped}, disparus=${vanished.length}`)
  check('H13 ils ne sont pas payés : le moteur n’a pas été appelé pour eux',
    engineH3.calls <= SAMPLE_N - vanished.length,
    `${engineH3.calls} appel(s), ${SAMPLE_N - vanished.length} au plus attendu(s)`)

  // H14 : la répartition, ce qu'on LIT après un échantillon pour décider de lancer le reste.
  const dist = await store.tagDistribution(ACCOUNT)
  const distOf = id => dist.find(d => d.question === id)
  const totalOf = id => (distOf(id)?.values ?? []).reduce((n, v) => n + v.count, 0)
  const someQuestion = QUESTIONS.find(q => distOf(q.id))
  check('H14 la répartition rend des valeurs PAR QUESTION', dist.length > 0 && !!someQuestion,
    `${dist.length} question(s)`)
  check('H15 chaque question totalise exactement les mails tagués de l’échantillon',
    !!someQuestion && dist.every(d => totalOf(d.question) === rowH3.tagged),
    JSON.stringify({ tagged: rowH3.tagged, totaux: dist.map(d => [d.question, totalOf(d.question)]).slice(0, 4) }))

  // H16 : démarrer un échantillon ne laisse pas un curseur de tri complet traîner, et inversement
  // `start` efface le mode échantillon — sinon un « lancer le reste » après un échantillon
  // relancerait l'échantillon.
  await runner.startBulk(ACCOUNT)
  const rowH4 = await mailboxOf(ACCOUNT)
  check('H16 « lancer le tri complet » après un échantillon EFFACE le mode échantillon',
    rowH4.sample_size === null && rowH4.sample_cursor === null,
    JSON.stringify({ size: rowH4.sample_size, cursor: rowH4.sample_cursor === null }))

  // ---- I. l'estimation d'une boîte JAMAIS triée suit le nombre de questions ----
  // Elle partait d'un nombre de jetons PAR MAIL figé, mesuré à 41 questions alors que la
  // taxonomie en comptait 49 : l'écran annonçait 0,21 $ et la dépense réelle a été 0,30 $.
  // Elle part maintenant d'un coût PAR QUESTION, donc elle reste juste quand la taxonomie bouge
  // — ce que le lot T-Q rendra courant en laissant modifier les questions.
  console.log('\nI. l’estimation d’une boîte jamais triée suit le nombre de questions')
  const MAILS_I = 1_000, PRICE_I = 42
  const estI = n => runner.estimateUsd({ mails: MAILS_I, usdPerBillionInput: PRICE_I, inputTokens: 0, tagged: 0 })
  const estNow = estI()
  check('I1 elle vaut coût-par-question × nombre de questions × mails, au tarif du moteur',
    Math.abs(estNow - (ASSUMED_INPUT_TOKENS_PER_QUESTION * QUESTIONS.length * MAILS_I * PRICE_I) / 1e9) < 1e-12,
    `estimée=${estNow}`)
  // Le discriminant : à 41 questions (ce que mesurait T8) elle ne doit PAS rendre la même chose
  // qu'à 49. Une constante figée par mail rendrait le même nombre dans les deux cas.
  const estAt = q => (ASSUMED_INPUT_TOKENS_PER_QUESTION * q * MAILS_I * PRICE_I) / 1e9
  check(`I2 elle CHANGE avec le nombre de questions (41 → ${QUESTIONS.length})`,
    Math.abs(estAt(41) - estAt(QUESTIONS.length)) > 1e-9 && Math.abs(estNow - estAt(QUESTIONS.length)) < 1e-12,
    `41 questions=${estAt(41)}, ${QUESTIONS.length} questions=${estAt(QUESTIONS.length)}`)
  // Et elle reste ancrée sur la mesure réelle : 995 mails tagués pour 0,3009 $ à 42 $/milliard
  // (gate T10b, 28/09/2026). Une estimation de 1 000 mails doit tomber à ±20 % de ce coût-là.
  const MESURE_USD_POUR_1000 = (0.3009 / 995) * 1_000
  check('I3 elle tombe à ±20 % de la dépense RÉELLE mesurée sur 1 000 mails (0,3024 $)',
    Math.abs(estNow - MESURE_USD_POUR_1000) / MESURE_USD_POUR_1000 < 0.2,
    `estimée=${estNow.toFixed(4)} $, mesurée=${MESURE_USD_POUR_1000.toFixed(4)} $, écart=${((estNow - MESURE_USD_POUR_1000) / MESURE_USD_POUR_1000 * 100).toFixed(1)} %`)
  // Et une boîte qui a DÉJÀ une moyenne mesurée l'utilise, elle : la constante n'est qu'un défaut.
  const estMesure = runner.estimateUsd({ mails: MAILS_I, usdPerBillionInput: PRICE_I, inputTokens: 1_000_000, tagged: 100 })
  check('I4 une boîte qui a une moyenne MESURÉE s’en sert, et ignore le défaut',
    Math.abs(estMesure - (10_000 * MAILS_I * PRICE_I) / 1e9) < 1e-12, `estimée=${estMesure}`)
} finally {
  await clean(ACCOUNT).catch(() => {})
  if (ENGINE_ID) await pool.query('DELETE FROM decision_engines WHERE id = $1', [ENGINE_ID]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : curseur non enregistré, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\ntrieur : OK')
