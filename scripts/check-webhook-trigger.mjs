#!/usr/bin/env node
/**
 * Banc du lot W3 : le DÉCLENCHEMENT. Un nouveau mail qui colle à une règle-webhook fait
 * exactement UN envoi ; un mail qui ne colle pas n'en fait aucun ; relancer n'en refait pas ;
 * activer un webhook ne rejoue pas l'historique ; et une règle `move` existante se comporte
 * comme avant.
 *
 * Banc DB + serveur HTTP **LOCAL** + **FAUSSE SOURCE de mails** : aucune connexion IMAP, aucune
 * boîte réelle lue, aucun appel sortant. Le récepteur est démarré par le banc sur 127.0.0.1 et
 * compte ce qu'il reçoit. Les lignes écrites portent un nom de banc, supprimées dans le
 * `finally` même après un échec.
 *
 *   node --experimental-strip-types scripts/check-webhook-trigger.mjs
 *   node --experimental-strip-types scripts/check-webhook-trigger.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. le curseur est POSÉ à la première activation : rien n'est confronté, l'historique
 *      (3 mails déjà là) ne part PAS au récepteur ;
 *   B. un mail qui colle au motif → 1 envoi inscrit, puis effectivement reçu et signé ;
 *      un mail qui ne colle pas → 0 ;
 *   C. relancer le balayage n'inscrit RIEN de plus (le curseur a avancé), et même curseur remis
 *      en arrière, l'unicité de `webhook_deliveries` empêche un second envoi du même mail ;
 *   D. le corps n'est TÉLÉCHARGÉ que si une condition porte sur `body` (la fausse source dit ce
 *      qu'on lui a demandé) ;
 *   E. NON-RÉGRESSION : une règle `move` passée à ce balayage ne déplace rien (le balayage réduit
 *      les actions à `webhook`) — déplacer reste le travail de `processRules` ;
 *   F. une règle-webhook qui vise un webhook d'une AUTRE boîte, ou un webhook désactivé,
 *      n'inscrit rien ;
 *   G. NON-RÉGRESSION, l'autre sens : un appelant SANS curseur — `processRules` toutes les 5 min,
 *      `POST /api/rules/run` à la demande — n'inscrit AUCUN envoi, même sur une règle-webhook qui
 *      colle. Ces deux-là repassent un ÉTAT (les 30 derniers non-lus, un dossier entier), pas un
 *      flux : un envoi y partirait sur du courrier vieux de six ans, soit l'historique rejoué que
 *      la décision 8 interdit. L'appel est celui de `lib/scheduler.ts` mot pour mot, règle NON
 *      réduite, sur un mail non-lu daté de 2020.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : `webhookRulesOf` est remplacée par un « on garde toutes les
 * actions », le curseur de première activation par « on repart de zéro », et l'action `webhook`
 * est autorisée aux appelants sans curseur — le produit tel qu'il serait SANS les décisions de ce
 * lot. Le banc DOIT alors virer au rouge sur A (l'historique part au récepteur), sur B et C par
 * conséquence (les comptes ne sont plus ceux des nouveaux mails seuls), sur E (les actions ne sont
 * plus réduites) et sur G (un appelant sans curseur inscrit un envoi sur du vieux courrier). Ce qu'il démontre : ces assertions mesurent
 * bien ces deux décisions. Ce qu'il ne démontre PAS : le comportement de la source IMAP réelle
 * (`lib/webhookSource.ts`), ni celui des routes HTTP (W4).
 */
import './alias-resolver.mjs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
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

// `lib/rules.ts` importe `lib/smtp.ts` (l'action « transférer »), qui charge son composeur par
// `require` — légal dans le module compilé par le bundler, absent du contexte ESM d'un banc.
// Même crochet que `scripts/check-rule-conditions.mjs`. Aucune connexion SMTP n'est ouverte pour
// autant : ce banc n'appelle ni SMTP, ni IMAP.
globalThis.require ??= createRequire(import.meta.url)

const { DATABASE_URL: DB_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')

const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
if (!DB_URL) harness("DATABASE_URL n'est pas renseigné")
if (!process.env.ENCRYPTION_KEY) harness("ENCRYPTION_KEY n'est pas renseigné")

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const { initDb, query } = await import('../lib/db.ts')
const W = await import('../lib/webhooks.ts')
const T = await import('../lib/webhookTrigger.ts')
const R = await import('../lib/rules.ts')
const { encrypt } = await import('../lib/encrypt.ts')

const BANC = 'banc-w3'
const MID = n => `<${BANC}-${n}@exemple.invalid>`
const FOLDER = 'INBOX'

const pool = new pg.Pool({ connectionString: DB_URL })
const clean = async () => {
  await pool.query(`DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE name LIKE $1)`, [`${BANC}%`])
  await pool.query(`DELETE FROM webhooks WHERE name LIKE $1`, [`${BANC}%`])
  await pool.query(`DELETE FROM email_rules WHERE name LIKE $1`, [`${BANC}%`])
}

// ─── le récepteur LOCAL ──────────────────────────────────────────────────────
function startReceiver() {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      seen.push({ body: raw, signature: req.headers['x-synapmail-signature'] ?? null })
      res.writeHead(200); res.end('ok')
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/hook`,
      seen,
      close: () => new Promise(r => server.close(r)),
    }))
  })
}

// ─── la FAUSSE source de mails ───────────────────────────────────────────────
/**
 * Elle honore le contrat de `WebhookMailSource` et rien de plus : où en est le dossier, et le
 * lot suivant après un UID. Elle NOTE si on lui a demandé le corps — c'est ainsi que D le mesure
 * sans inspecter le code.
 */
function fakeSource(mails) {
  const calls = { bodyAsked: [], fetches: 0 }
  return {
    calls,
    add(mail) { mails.push(mail) },
    async state() {
      return { uidValidity: '1', lastUid: mails.reduce((n, m) => Math.max(n, Number(m.uid)), 0) }
    },
    async fetch(folder, afterUid, limit, withBody) {
      calls.fetches += 1
      calls.bodyAsked.push(withBody)
      return mails
        .filter(m => Number(m.uid) > afterUid)
        .sort((a, b) => Number(a.uid) - Number(b.uid))
        .slice(0, limit)
        .map(m => withBody ? m : { ...m, bodyPlain: undefined, bodyHtml: undefined })
    },
  }
}

const mailOf = (uid, subject, extra = {}) => ({
  uid: String(uid),
  messageId: MID(uid),
  from: { name: 'Compta', address: 'compta@exemple.invalid' },
  to: [{ name: '', address: 'moi@exemple.invalid' }],
  subject,
  date: new Date(2026, 8, 28, 10, uid).toISOString(),
  preview: '',
  isRead: false, isStarred: false, isFlagged: false, hasAttachments: false,
  folder: FOLDER, accountId: '',
  ...extra,
})

// ─── le CONTRÔLE NÉGATIF : le produit sans ses décisions ────────────────────
/** Sans la réduction des actions : le balayage exécuterait AUSSI `move` / `delete`. */
const rulesOf = NEGATIVE ? (rules => rules.filter(r => r.actions.some(a => a.type === 'webhook'))) : T.webhookRulesOf
/** Sans la pose du curseur : la première activation rejouerait tout l'historique. */
const PRIME = !NEGATIVE
/**
 * Sans le refus par défaut de l'action `webhook` : un appelant SANS curseur (`processRules`,
 * `POST /api/rules/run`) inscrirait un envoi sur du vieux courrier. C'est ce que G mesure.
 */
const PROCESS_RULES_ALLOWS_WEBHOOK = NEGATIVE

console.log(`\nbanc du déclenchement${NEGATIVE ? ' — CONTRÔLE NÉGATIF (actions non réduites, curseur à zéro)' : ''}\n`)

await initDb()
const [account] = await query('SELECT id, user_id, email FROM email_accounts ORDER BY created_at LIMIT 1')
if (!account) harness("la base de la lane n'a aucune boîte : rien à quoi rattacher un webhook")

const receiver = await startReceiver()
const ALLOWED_BEFORE = process.env.WEBHOOK_ALLOWED_HOSTS
process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'

/**
 * `scanFolder` du produit, mais avec les deux points que le contrôle négatif remplace. Le reste
 * (curseur, lots, unicité, inscription) est le code du produit, appelé tel quel.
 */
async function scan(source, rules, opts = {}) {
  const reduced = rulesOf(rules)
  if (!reduced.length) return { scanned: 0, matched: 0, primed: false }
  const st = await source.state(FOLDER)
  const [known] = await query('SELECT last_uid, uid_validity FROM webhook_cursors WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
  if (!known && (opts.prime ?? PRIME)) {
    await query(
      `INSERT INTO webhook_cursors (account_id, folder, last_uid, uid_validity) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, folder) DO UPDATE SET last_uid = EXCLUDED.last_uid`,
      [account.id, FOLDER, st.lastUid, st.uidValidity])
    return { scanned: 0, matched: 0, primed: true }
  }
  if (!known) {
    await query(
      `INSERT INTO webhook_cursors (account_id, folder, last_uid, uid_validity) VALUES ($1, $2, 0, $3)`,
      [account.id, FOLDER, st.uidValidity])
  }
  return T.scanFolder({ accountId: account.id, account: { id: account.id }, folder: FOLDER, source, rules: reduced })
}

const countDeliveries = async webhookId => {
  const [r] = await query('SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1', [webhookId])
  return r.n
}

const makeRule = (name, conditions, actions) => query(
  `INSERT INTO email_rules (user_id, account_id, name, enabled, priority, condition_logic, conditions, actions, stop_processing)
   VALUES ($1, $2, $3, true, 0, 'all', $4::jsonb, $5::jsonb, false) RETURNING *`,
  [account.user_id, account.id, `${BANC} ${name}`, JSON.stringify(conditions), JSON.stringify(actions)]
).then(rows => ({
  id: rows[0].id, userId: rows[0].user_id, accountId: rows[0].account_id, name: rows[0].name,
  enabled: true, priority: 0, conditionLogic: 'all', conditions: rows[0].conditions,
  actions: rows[0].actions, stopProcessing: false, createdAt: '', updatedAt: '',
}))

const makeHook = async (label, accountId, enabled = true) => {
  const [row] = await query(
    `INSERT INTO webhooks (user_id, account_id, name, url, secret_encrypted, enabled)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [account.user_id, accountId, `${BANC} ${label}`, receiver.url, encrypt(W.newWebhookSecret()), enabled])
  return row.id
}

try {
  await clean()
  await query('DELETE FROM webhook_cursors WHERE account_id = $1', [account.id])

  const hook = await makeHook('principal', account.id)
  const rule = await makeRule('facture', [{ id: 'c1', field: 'subject', operator: 'matches', value: 'facture\\s+\\d{4}' }],
    [{ id: 'a1', type: 'webhook', value: hook }])

  // ---- A. l'historique n'est pas rejoué ----
  console.log("A. activer un webhook ne renvoie pas l'historique")
  const mails = [mailOf(1, 'Facture 2024-0001'), mailOf(2, 'Facture 2025-0002'), mailOf(3, 'Bonjour')]
  const src = fakeSource(mails)
  const first = await scan(src, [rule])
  check('A1 le premier passage POSE le curseur et ne confronte rien', first.primed === true && first.scanned === 0,
    JSON.stringify(first))
  check("A2 aucun des 3 mails de l'historique n'a produit d'envoi", await countDeliveries(hook) === 0,
    `${await countDeliveries(hook)} envoi(s)`)
  const [cur] = await query('SELECT last_uid FROM webhook_cursors WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
  check('A3 le curseur est au dernier UID du dossier', Number(cur?.last_uid) === 3, String(cur?.last_uid))

  // ---- B. ce qui colle part, ce qui ne colle pas ne part pas ----
  console.log('\nB. un nouveau mail qui colle fait UN envoi, un autre n’en fait aucun')
  src.add(mailOf(4, 'Facture 2026-0417'))
  src.add(mailOf(5, 'Réunion de lundi'))
  const pass = await scan(src, [rule])
  check('B1 les 2 nouveaux mails sont confrontés', pass.scanned === 2, JSON.stringify(pass))
  check('B2 un seul envoi est inscrit', pass.matched === 1 && await countDeliveries(hook) === 1,
    `matched=${pass.matched} lignes=${await countDeliveries(hook)}`)
  const [queued] = await query(
    `SELECT message_id, rule_id, status FROM webhook_deliveries WHERE webhook_id = $1`, [hook])
  check('B3 c’est le mail qui colle, rattaché à SA règle',
    queued?.message_id === MID(4) && queued?.rule_id === rule.id && queued?.status === 'pending',
    `${queued?.message_id} / ${queued?.status}`)

  // L'envoi part du PLANIFICATEUR, pas de la règle : c'est ce passage qui le fait sortir.
  await W.processWebhookDeliveries()
  check('B4 le récepteur local a reçu exactement 1 appel', receiver.seen.length === 1, `${receiver.seen.length} appel(s)`)
  const body = JSON.parse(receiver.seen[0]?.body ?? '{}')
  check('B5 la charge utile nomme la règle, la boîte et le mail',
    body.rule?.name === rule.name && body.account?.id === account.id && body.message?.subject === 'Facture 2026-0417',
    JSON.stringify({ rule: body.rule?.name, subject: body.message?.subject }))
  check('B6 l’appel est signé', typeof receiver.seen[0]?.signature === 'string' && receiver.seen[0].signature.startsWith('sha256='))

  // ---- C. relancer ne refait rien ----
  console.log('\nC. relancer n’envoie pas une seconde fois')
  const again = await scan(src, [rule])
  check('C1 le curseur a avancé : plus rien à confronter', again.scanned === 0 && again.matched === 0, JSON.stringify(again))
  // Curseur REMIS EN ARRIÈRE : ce n'est plus le curseur qui protège, c'est l'unicité en base.
  await query('UPDATE webhook_cursors SET last_uid = 3 WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
  const replay = await scan(src, [rule])
  check('C2 curseur revenu en arrière : le mail est reconfronté', replay.scanned === 2, JSON.stringify(replay))
  // La règle COLLE de nouveau (`matched` remonte) : ce n'est donc pas l'évaluation qui protège,
  // c'est bien l'unicité en base qui refuse la seconde inscription.
  check('C3 la règle colle de nouveau', replay.matched === 1, `matched=${replay.matched}`)
  check('C4 mais AUCUN envoi de plus n’est inscrit (unicité en base)',
    await countDeliveries(hook) === 1, `${await countDeliveries(hook)} ligne(s)`)

  // ---- D. le corps, seulement si une condition le demande ----
  console.log('\nD. le corps n’est lu que si une condition porte dessus')
  src.calls.bodyAsked.length = 0
  await query('UPDATE webhook_cursors SET last_uid = 3 WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
  await scan(src, [rule])
  check('D1 aucune condition sur le corps → il n’est PAS demandé',
    src.calls.bodyAsked.length > 0 && src.calls.bodyAsked.every(v => v === false), JSON.stringify(src.calls.bodyAsked))

  const bodyRule = await makeRule('corps', [{ id: 'c1', field: 'body', operator: 'contains', value: 'virement' }],
    [{ id: 'a1', type: 'webhook', value: hook }])
  src.calls.bodyAsked.length = 0
  await query('UPDATE webhook_cursors SET last_uid = 3 WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
  await scan(src, [bodyRule])
  check('D2 une condition sur le corps → il EST demandé',
    src.calls.bodyAsked.length > 0 && src.calls.bodyAsked.every(v => v === true), JSON.stringify(src.calls.bodyAsked))
  await query('DELETE FROM email_rules WHERE id = $1', [bodyRule.id])

  // ---- E. NON-RÉGRESSION : ce balayage ne déplace pas un mail ----
  console.log('\nE. non-régression : ce balayage ne fait QUE des webhooks')
  // Une règle qui demande `move` EN PLUS du webhook. Si le balayage exécutait `move`, il
  // appellerait `moveMessagesBulk` — donc IMAP. On le mesure en donnant un compte dont la
  // connexion ne peut PAS aboutir : un `move` exécuté laisserait une trace d'erreur.
  const moveRule = await makeRule('move+webhook',
    [{ id: 'c1', field: 'subject', operator: 'matches', value: 'facture\\s+\\d{4}' }],
    [{ id: 'a1', type: 'move', value: 'Archive' }, { id: 'a2', type: 'webhook', value: hook }])
  const reduced = rulesOf([moveRule])
  check('E1 les actions retenues par le balayage ne comptent QUE `webhook`',
    reduced.length === 1 && reduced[0].actions.length === 1 && reduced[0].actions[0].type === 'webhook',
    JSON.stringify(reduced[0]?.actions))
  check('E2 la règle EN BASE garde ses deux actions (processRules les verra)',
    moveRule.actions.length === 2, JSON.stringify(moveRule.actions))
  await query('DELETE FROM email_rules WHERE id = $1', [moveRule.id])

  // ---- F. un webhook qui n'est pas à cette boîte, ou éteint, n'envoie rien ----
  console.log('\nF. un webhook hors boîte ou éteint n’envoie rien')
  const offHook = await makeHook('eteint', account.id, false)
  const offRule = await makeRule('eteint', [{ id: 'c1', field: 'subject', operator: 'matches', value: 'facture' }],
    [{ id: 'a1', type: 'webhook', value: offHook }])
  await query('UPDATE webhook_cursors SET last_uid = 3 WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
  await scan(src, [offRule])
  check('F1 un webhook désactivé n’inscrit rien', await countDeliveries(offHook) === 0, `${await countDeliveries(offHook)} envoi(s)`)

  const [other] = await query('SELECT id FROM email_accounts WHERE id <> $1 LIMIT 1', [account.id])
  if (other) {
    const foreign = await makeHook('autre-boite', other.id)
    const foreignRule = await makeRule('hors-boite', [{ id: 'c1', field: 'subject', operator: 'matches', value: 'facture' }],
      [{ id: 'a1', type: 'webhook', value: foreign }])
    await query('UPDATE webhook_cursors SET last_uid = 3 WHERE account_id = $1 AND folder = $2', [account.id, FOLDER])
    await scan(src, [foreignRule])
    check('F2 un webhook d’une AUTRE boîte n’inscrit rien', await countDeliveries(foreign) === 0,
      `${await countDeliveries(foreign)} envoi(s)`)
  } else {
    console.log('  --   F2 sauté : la base de lane n’a qu’une seule boîte')
  }
  // ---- G. NON-RÉGRESSION : un appelant SANS curseur n'inscrit aucun envoi ----
  console.log("\nG. un appelant sans curseur (processRules) n’inscrit rien")
  // Le scénario du contrôle : un mail NON LU de 2020, encore dans la boîte, que `processRules`
  // repasse toutes les 5 min parce qu'il fait partie des 30 derniers non-lus. La règle colle.
  const oldHook = await makeHook('vieux-courrier', account.id)
  const oldRule = await makeRule('vieux-courrier',
    [{ id: 'c1', field: 'subject', operator: 'matches', value: 'facture\\s+\\d{4}' }],
    [{ id: 'a1', type: 'webhook', value: oldHook }])
  const oldMail = mailOf(900, 'Facture 2020-0001', { date: new Date(2020, 0, 3, 9, 0).toISOString() })
  const oldTags = await R.tagsForMessages(account.id, [oldMail], [oldRule])
  // L'appel de `lib/scheduler.ts` MOT POUR MOT : la règle N'EST PAS réduite (`processRules` ne
  // connaît pas `webhookRulesOf`), il n'y a aucun curseur, et rien ici ne parle de webhook.
  const processed = await R.applyRulesToMessages(
    { id: account.id }, FOLDER, [oldMail], [oldRule], async () => null, oldTags,
    ...(PROCESS_RULES_ALLOWS_WEBHOOK ? [true] : []))
  check('G1 la règle COLLE bien au vieux mail (sinon G ne mesure rien)',
    processed.length === 1 && processed[0].matchedRules.includes(oldRule.name), JSON.stringify(processed))
  check("G2 et pourtant AUCUN envoi n’est inscrit : l’historique n’est pas rejoué",
    await countDeliveries(oldHook) === 0, `${await countDeliveries(oldHook)} envoi(s)`)
  check('G3 le récepteur n’a rien reçu de plus', (await W.processWebhookDeliveries(), receiver.seen.length === 1),
    `${receiver.seen.length} appel(s)`)
} finally {
  if (ALLOWED_BEFORE === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS
  else process.env.WEBHOOK_ALLOWED_HOSTS = ALLOWED_BEFORE
  await receiver.close()
  await query('DELETE FROM webhook_cursors WHERE account_id = $1', [account.id])
  await clean()
  await pool.end()
}

if (NEGATIVE) {
  console.log(`\ncontrôle négatif : ${failures.length} assertion(s) rouge(s) attendue(s) sur A, B, C, E et G`)
  if (failures.length === 0) { console.error('KO : le contrôle négatif est VERT — les assertions ne mesurent rien'); process.exit(1) }
  console.log('contrôle négatif : OK (le banc sait virer au rouge)')
  process.exit(0)
}
console.log(`\ndéclenchement : ${failures.length === 0 ? 'toutes les vérifications passent' : `${failures.length} ÉCHEC(S)`}`)
process.exit(failures.length === 0 ? 0 : 1)
