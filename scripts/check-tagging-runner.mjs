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
 *   F. deux passages SIMULTANÉS sur la même boîte → un seul travaille (verrou).
 *
 * CONTRÔLE NÉGATIF (`--negative`) : entre deux passages de A, la MÉMOIRE DE LA REPRISE est effacée
 * dans la base (curseur remis à NULL, et les étiquettes déjà écrites supprimées) — le trieur ne
 * peut donc plus savoir où il en était. Le banc DOIT alors virer au rouge sur A2, le nombre
 * d'appels au moteur. Rien n'est modifié dans le produit : l'effacement est fait par le banc, en
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
const { EngineError } = await import('../lib/tagging/engine.ts')
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

const makeSource = (folders = FOLDERS) => ({
  async folders() {
    return folders.map(f => ({ path: f.path, uidValidity: f.uidValidity, total: f.count }))
  },
  async fetch(folder, afterUid, limit) {
    const f = folders.find(x => x.path === folder)
    if (!f) return []
    const out = []
    for (let i = afterUid + 1; i <= f.count && out.length < limit; i += 1) out.push(mailOf(folder, i))
    return out
  },
})

/** Le nombre de mails DISTINCTS (par Message-ID) que la fausse source contient. */
const distinctMails = (folders = FOLDERS) => {
  const ids = new Set()
  for (const f of folders) for (let i = 1; i <= f.count; i += 1) ids.add(store.messageIdOf(mailOf(f.path, i)))
  return ids.size
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
const makeEngine = (opts = {}) => {
  const seen = []
  return {
    source: 'jev',
    usdPerBillionInput: opts.usdPerBillionInput ?? 42,
    get calls() { return seen.length },
    get seen() { return seen },
    async ask(state) {
      seen.push(state.objet)
      if (opts.failAt && seen.length === opts.failAt) throw new EngineError('credit', 402, 'insufficient credit balance')
      return { model: 'faux-1.0.0', tags: QUESTIONS.map(q => {
        const a = ANSWERS[q.id]
        const valeur = q.type === 'noul' ? 'oui' : valuesOf(q)[0]
        return { question: q.id, valeur, probabilites: a.probabilities ?? null, confiance: 0.8 }
      }), rejected: [], inputTokens: opts.inputTokens ?? 1600 }
    },
  }
}

/** La ligne `mailbox_tagging` de la boîte du banc, remise à l'état demandé. */
const setMailbox = async (accountId, engineId, patch = {}) => {
  const cols = { budget_usd: 1000, spent_usd: 0, input_tokens: 0, live: false, live_cursor: null,
    bulk_state: 'idle', bulk_cursor: null, tagged: 0, skipped: 0, errors: 0, total: 0,
    paused_reason: null, paused_detail: null, locked_until: null, ...patch }
  await pool.query(
    `INSERT INTO mailbox_tagging (account_id, engine_id, budget_usd, spent_usd, input_tokens, live,
                                  live_cursor, bulk_state, bulk_cursor, tagged, skipped, errors,
                                  total, paused_reason, paused_detail, locked_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (account_id) DO UPDATE SET
       engine_id = EXCLUDED.engine_id, budget_usd = EXCLUDED.budget_usd, spent_usd = EXCLUDED.spent_usd,
       input_tokens = EXCLUDED.input_tokens, live = EXCLUDED.live, live_cursor = EXCLUDED.live_cursor,
       bulk_state = EXCLUDED.bulk_state, bulk_cursor = EXCLUDED.bulk_cursor, tagged = EXCLUDED.tagged,
       skipped = EXCLUDED.skipped, errors = EXCLUDED.errors, total = EXCLUDED.total,
       paused_reason = EXCLUDED.paused_reason, paused_detail = EXCLUDED.paused_detail,
       locked_until = EXCLUDED.locked_until`,
    [accountId, engineId, cols.budget_usd, cols.spent_usd, cols.input_tokens, cols.live,
      cols.live_cursor ? JSON.stringify(cols.live_cursor) : null, cols.bulk_state,
      cols.bulk_cursor ? JSON.stringify(cols.bulk_cursor) : null, cols.tagged, cols.skipped,
      cols.errors, cols.total, cols.paused_reason, cols.paused_detail, cols.locked_until])
}

/**
 * CONTRÔLE NÉGATIF : efface ce qui permet de reprendre. Le curseur ne dit plus où on en était, et
 * les étiquettes ne disent plus ce qui est déjà payé — un passage repart donc du premier mail.
 */
const forgetResume = async accountId => {
  await pool.query('UPDATE mailbox_tagging SET bulk_cursor = NULL WHERE account_id = $1', [accountId])
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
  await setMailbox(ACCOUNT, ENGINE_ID, { bulk_state: 'running' })
  const engineA = makeEngine()
  const source = makeSource()
  // Des passages COURTS : le délai s'épuise au milieu d'un dossier, exactement comme une coupure.
  const passes = []
  for (let n = 0; n < 40; n += 1) {
    const before = await mailboxOf(ACCOUNT)
    if (before.bulk_state === 'done' || before.paused_reason) break
    passes.push(await runner.runPass({ accountId: ACCOUNT, source, engine: engineA, budgetMs: 900 }))
    if (NEGATIVE) await forgetResume(ACCOUNT)
  }
  const afterA = await mailboxOf(ACCOUNT)
  check('A1 le tri finit par se terminer, en plusieurs passages coupés',
    afterA.bulk_state === 'done', `état=${afterA.bulk_state} passages=${passes.length} pause=${afterA.paused_reason}`)
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
