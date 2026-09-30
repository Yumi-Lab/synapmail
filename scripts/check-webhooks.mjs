#!/usr/bin/env node
/**
 * Banc du lot W2 : ce que vaut un envoi de webhook — sa signature, l'adresse que le serveur
 * s'autorise à appeler, ses reprises, et la garantie « une seule fois par mail ».
 *
 * Banc DB + serveur HTTP **LOCAL** : le récepteur est démarré PAR LE BANC sur 127.0.0.1, il
 * compte ce qu'il reçoit et VÉRIFIE lui-même la signature avec le secret. Aucune URL publique,
 * aucun appel sortant réel, aucune connexion IMAP, aucun mail lu. Les lignes écrites portent
 * un nom de banc et sont supprimées dans le `finally`, même après un échec.
 *
 *   node --experimental-strip-types scripts/check-webhooks.mjs
 *   node --experimental-strip-types scripts/check-webhooks.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. la signature reçue est vérifiable PAR LE RÉCEPTEUR avec le secret, et un corps modifié
 *      d'un octet ne la valide plus ; les trois en-têtes du protocole sont présents ;
 *   B. `aiSafety` est la PREMIÈRE clé de la charge utile, l'aperçu est borné, le corps entier
 *      n'y est pas ;
 *   C. sans `WEBHOOK_ALLOWED_HOSTS` : 10.0.0.1, 127.0.0.1, 169.254.169.254, ::1 et un NOM qui
 *      résout en adresse privée sont refusés ; `http://` est refusé ; une adresse publique passe
 *      le contrôle. Avec `WEBHOOK_ALLOWED_HOSTS=127.0.0.1`, 127.0.0.1 est accepté — et 10.0.0.1
 *      reste refusé (l'autorisation est nominative, pas générale) ;
 *   D. une redirection 302 n'est PAS suivie : la cible ne reçoit rien et l'envoi est un échec ;
 *   E. un récepteur qui rend 500 est retenté 3 fois (4 tentatives en tout) puis la ligne passe
 *      `failed` ; un récepteur qui rend 200 passe `ok` du premier coup ;
 *   F. la même (webhook, règle, mail) ne s'inscrit qu'UNE fois, quoi qu'on demande ;
 *   G. la purge emporte une ligne de plus de 30 jours et garde celle d'hier.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le contrôle d'adresse est remplacé par un « tout passe »,
 * la signature par un HMAC sur un secret fixe, et la redirection par `redirect: 'follow'` — le
 * produit tel qu'il serait SANS les décisions 4, 5 et 6. Le banc DOIT alors virer au rouge sur
 * A, C et D. Ce qu'il démontre : ces assertions mesurent bien ces décisions. Ce qu'il ne
 * démontre PAS : le comportement des routes HTTP (lot W4) ni celui du déclenchement (lot W3).
 */
import './alias-resolver.mjs'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
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
if (!process.env.ENCRYPTION_KEY) harness("ENCRYPTION_KEY n'est pas renseigné")

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const { initDb, query } = await import('../lib/db.ts')
const W = await import('../lib/webhooks.ts')
const { encrypt } = await import('../lib/encrypt.ts')

/** Le nom de banc : tout ce qu'il écrit le porte, donc le nettoyage ne peut rien emporter d'autre. */
const BANC = 'banc-w2'
const MID = n => `<${BANC}-${n}@exemple.invalid>`

const pool = new pg.Pool({ connectionString: DB_URL })
const clean = async () => {
  await pool.query(`DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE name LIKE $1)`, [`${BANC}%`])
  await pool.query(`DELETE FROM webhooks WHERE name LIKE $1`, [`${BANC}%`])
}

// ─── le récepteur LOCAL ──────────────────────────────────────────────────────
/**
 * Un vrai serveur HTTP sur 127.0.0.1. Il n'imite rien : il lit le corps, recalcule le HMAC
 * avec le secret qu'on lui a donné et dit si la signature tient. C'est le RÉCEPTEUR qui juge
 * la signature — pas le code qui l'a produite, sinon on mesurerait une tautologie.
 */
function startReceiver(secret) {
  const seen = []
  let plan = () => ({ status: 200, headers: {}, body: 'ok' })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const header = req.headers['x-synapmail-signature'] ?? null
      const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`
      seen.push({
        path: req.url,
        body: raw,
        signature: header,
        signatureValid: header === expected,
        tamperedValid: header === `sha256=${createHmac('sha256', secret).update(raw + ' ', 'utf8').digest('hex')}`,
        event: req.headers['x-synapmail-event'] ?? null,
        delivery: req.headers['x-synapmail-delivery'] ?? null,
      })
      const r = plan(seen.length, req)
      res.writeHead(r.status, r.headers)
      res.end(r.body ?? '')
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        url: p => `http://127.0.0.1:${port}${p ?? '/hook'}`,
        seen,
        respond: fn => { plan = fn },
        close: () => new Promise(r => server.close(r)),
      })
    })
  })
}

// ─── le CONTRÔLE NÉGATIF : le produit sans ses décisions ────────────────────
const FAKE_SECRET = 'whsec_le-controle-negatif-signe-avec-autre-chose'
const checkUrl = NEGATIVE ? async () => ({ ok: true, host: 'tout-passe', addresses: [] }) : W.checkWebhookUrl
const sendOnce = NEGATIVE
  ? async (url, secret, event, deliveryId, payload) => {
    const body = JSON.stringify(payload)
    const started = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST', redirect: 'follow',
        signal: AbortSignal.timeout(W.DELIVERY_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          [W.EVENT_HEADER]: event, [W.DELIVERY_HEADER]: deliveryId,
          [W.SIGNATURE_HEADER]: W.signPayload(FAKE_SECRET, body),
        },
        body,
      })
      return { ok: res.status >= 200 && res.status < 300, status: res.status, durationMs: Date.now() - started, error: null }
    } catch (err) {
      return { ok: false, status: null, durationMs: Date.now() - started, error: String(err) }
    }
  }
  : W.sendWebhook

console.log(`\nbanc des webhooks${NEGATIVE ? ' — CONTRÔLE NÉGATIF (adresse non contrôlée, signature fausse, redirection suivie)' : ''}\n`)

await initDb()
const [account] = await query('SELECT id, user_id, email FROM email_accounts ORDER BY created_at LIMIT 1')
if (!account) harness("la base de la lane n'a aucune boîte : rien à quoi rattacher un webhook")

const SECRET = W.newWebhookSecret()
const receiver = await startReceiver(SECRET)
const ALLOWED_BEFORE = process.env.WEBHOOK_ALLOWED_HOSTS

try {
  await clean()

  // ---- A. la signature, jugée par le récepteur ----
  console.log('A. le récepteur vérifie la signature avec le secret')
  process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'
  const payloadA = W.buildPayload({
    event: W.EVENT_RULE_MATCHED, deliveryId: 'd-a', rule: { id: 'r', name: 'banc' },
    account: { id: account.id, email: account.email },
    message: { messageId: MID(1), uid: '7', folder: 'INBOX', subject: 'Facture 2026-0417',
      from: { name: 'Compta', address: 'compta@exemple.invalid' }, preview: 'x'.repeat(2000), hasAttachments: false },
    tags: [{ question: 'categorie', valeur: 'facture' }],
  })
  receiver.respond(() => ({ status: 200, body: 'ok' }))
  const outA = await sendOnce(receiver.url(), SECRET, W.EVENT_RULE_MATCHED, 'd-a', payloadA)
  const got = receiver.seen.at(-1)
  check('A1 l’envoi aboutit sur le récepteur local', outA.ok && outA.status === 200 && !!got, JSON.stringify(outA))
  check('A2 le RÉCEPTEUR valide la signature avec le secret', got?.signatureValid === true, got?.signature ?? '(aucune)')
  check('A3 un corps modifié d’un octet ne valide PLUS la signature', got?.tamperedValid === false)
  check('A4 les trois en-têtes du protocole sont là',
    got?.event === W.EVENT_RULE_MATCHED && got?.delivery === 'd-a' && !!got?.signature,
    `${got?.event} / ${got?.delivery}`)
  check('A5 `verifySignature` et le récepteur disent la MÊME chose',
    W.verifySignature(SECRET, got?.body ?? '', got?.signature ?? null) === (got?.signatureValid === true))

  // ---- B. la charge utile ----
  console.log('\nB. la charge utile prévient le bot, et ne lui donne pas le mail entier')
  const parsed = JSON.parse(got?.body ?? '{}')
  check('B1 `aiSafety` est la PREMIÈRE clé', Object.keys(parsed)[0] === 'aiSafety', Object.keys(parsed).slice(0, 3).join(','))
  check('B2 l’aperçu est borné à 500 caractères', parsed.message?.preview?.length === W.PREVIEW_MAX, String(parsed.message?.preview?.length))
  check('B3 ni le corps ni une pièce jointe ne voyagent',
    parsed.message?.bodyPlain === undefined && parsed.message?.bodyHtml === undefined && parsed.attachments === undefined)
  check('B4 les étiquettes effectives accompagnent le mail', parsed.tags?.[0]?.valeur === 'facture')

  // ---- C. l'adresse ----
  console.log('\nC. ce que le serveur s’autorise à appeler')
  delete process.env.WEBHOOK_ALLOWED_HOSTS
  const refused = async (url, label) => {
    const v = await checkUrl(url)
    check(label, v.ok === false, v.ok ? `ACCEPTÉ (${v.addresses?.join(',')})` : v.reason)
  }
  await refused('https://10.0.0.1/hook', 'C1 10.0.0.1 est refusé (privé)')
  await refused('https://127.0.0.1/hook', 'C2 127.0.0.1 est refusé (bouclage)')
  await refused('https://169.254.169.254/latest/meta-data/', 'C3 169.254.169.254 est refusé (métadonnées cloud)')
  await refused('https://[::1]/hook', 'C4 ::1 est refusé (bouclage v6)')
  await refused('https://localhost/hook', 'C5 un NOM qui résout en privé est refusé (localhost)')
  await refused(receiver.url(), 'C6 http:// sans autorisation est refusé')
  {
    // Une adresse publique : littérale, donc AUCUNE requête DNS ne sort du banc.
    const v = await checkUrl('https://93.184.216.34/hook')
    check('C7 une adresse publique passe le contrôle', v.ok === true, v.ok ? '' : v.reason)
  }
  process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'
  {
    const v = await checkUrl(receiver.url())
    check('C8 avec WEBHOOK_ALLOWED_HOSTS=127.0.0.1, le récepteur local est accepté', v.ok === true, v.ok ? '' : v.reason)
    const other = await W.checkWebhookUrl('https://10.0.0.1/hook')
    check('C9 l’autorisation est NOMINATIVE : 10.0.0.1 reste refusé', other.ok === false, other.ok ? 'ACCEPTÉ' : other.reason)
  }

  // ---- D. la redirection ----
  console.log('\nD. une redirection n’est pas un détour autorisé')
  receiver.respond((n, req) => req.url === '/redir'
    ? { status: 302, headers: { Location: `http://127.0.0.1:${receiver.port}/cible` }, body: '' }
    : { status: 200, body: 'ok' })
  const before = receiver.seen.length
  const outD = await sendOnce(receiver.url('/redir'), SECRET, W.EVENT_TEST, 'd-d', { event: W.EVENT_TEST })
  const hitAfter = receiver.seen.slice(before)
  check('D1 la CIBLE de la redirection n’a rien reçu',
    hitAfter.every(h => h.path !== '/cible'), hitAfter.map(h => h.path).join(','))
  check('D2 un 302 est un ÉCHEC, pas un succès', outD.ok === false && outD.status === 302, JSON.stringify(outD))

  // ---- E. les reprises ----
  console.log('\nE. trois nouvelles tentatives, puis abandon')
  const hookRow = async (url, name) => {
    const [row] = await query(
      `INSERT INTO webhooks (user_id, account_id, name, url, secret_encrypted)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [account.user_id, account.id, name, url, encrypt(SECRET)])
    return row.id
  }
  receiver.respond((n, req) => req.url === '/ko' ? { status: 500, body: 'boum' } : { status: 200, body: 'ok' })
  const koHook = await hookRow(receiver.url('/ko'), `${BANC}-ko`)
  const okHook = await hookRow(receiver.url('/ok'), `${BANC}-ok`)
  const koId = await W.queueWebhookDelivery({
    webhook: { id: koHook, accountId: account.id }, rule: null,
    account: { id: account.id, email: account.email }, event: W.EVENT_RULE_MATCHED,
    message: { messageId: MID('ko'), subject: 'ko' },
  })
  const okId = await W.queueWebhookDelivery({
    webhook: { id: okHook, accountId: account.id }, rule: null,
    account: { id: account.id, email: account.email }, event: W.EVENT_RULE_MATCHED,
    message: { messageId: MID('ok'), subject: 'ok' },
  })
  const stateOf = async id => (await query('SELECT status, attempts, response_status FROM webhook_deliveries WHERE id = $1', [id]))[0]
  const due = async id => query(`UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE id = $1 AND status = 'pending'`, [id])

  await W.processWebhookDeliveries()
  check('E1 le récepteur qui répond 200 passe `ok` du premier coup',
    (await stateOf(okId))?.status === 'ok' && (await stateOf(okId))?.attempts === 1, JSON.stringify(await stateOf(okId)))
  let s = await stateOf(koId)
  check('E2 après le 1er échec la ligne reste `pending` et retient le 500',
    s?.status === 'pending' && s?.attempts === 1 && s?.response_status === 500, JSON.stringify(s))
  for (let i = 0; i < W.RETRY_DELAYS_MS.length; i++) { await due(koId); await W.processWebhookDeliveries() }
  s = await stateOf(koId)
  check(`E3 après ${W.MAX_ATTEMPTS} tentatives la ligne est \`failed\``,
    s?.status === 'failed' && s?.attempts === W.MAX_ATTEMPTS, JSON.stringify(s))
  await due(koId)
  const beforeExhausted = receiver.seen.length
  await W.processWebhookDeliveries()
  check('E4 une ligne abandonnée n’est plus réessayée toute seule', receiver.seen.length === beforeExhausted)
  check('E5 « renvoyer » remet la ligne en file', (await W.retryDelivery(koId)) === true && (await stateOf(koId))?.status === 'pending')

  // ---- F. une seule fois par mail ----
  console.log('\nF. le même mail ne part jamais deux fois par la même règle')
  const [rule] = await query(
    `INSERT INTO email_rules (user_id, account_id, name, conditions, actions)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id`,
    [account.user_id, account.id, `${BANC}-regle`, '[]', '[]'])
  const once = { webhook: { id: okHook, accountId: account.id }, rule: { id: rule.id, name: `${BANC}-regle` },
    account: { id: account.id, email: account.email }, event: W.EVENT_RULE_MATCHED,
    message: { messageId: MID('unique'), subject: 'unique' } }
  const first = await W.queueWebhookDelivery(once)
  const second = await W.queueWebhookDelivery(once)
  const third = await W.queueWebhookDelivery(once)
  check('F1 la première inscription rend un identifiant', !!first)
  check('F2 les suivantes rendent `null` (la base l’a refusée, pas une relecture)', second === null && third === null,
    `${second} / ${third}`)
  const rows = await query(
    `SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1 AND message_id = $2`,
    [okHook, MID('unique')])
  check('F3 il n’y a qu’UNE ligne en base pour ce mail', rows[0].n === 1, `${rows[0].n} ligne(s)`)
  await query(`DELETE FROM email_rules WHERE id = $1`, [rule.id])

  // ---- G. la purge ----
  console.log('\nG. le journal ne grossit pas sans fin')
  const [old] = await query(
    `INSERT INTO webhook_deliveries (webhook_id, account_id, message_id, status, created_at)
     VALUES ($1, $2, $3, 'ok', NOW() - INTERVAL '${W.DELIVERY_RETENTION_DAYS + 1} days') RETURNING id`,
    [okHook, account.id, MID('vieux')])
  const [recent] = await query(
    `INSERT INTO webhook_deliveries (webhook_id, account_id, message_id, status, created_at)
     VALUES ($1, $2, $3, 'ok', NOW() - INTERVAL '1 day') RETURNING id`,
    [okHook, account.id, MID('hier')])
  await W.purgeOldDeliveries()
  const left = await query('SELECT id FROM webhook_deliveries WHERE id = ANY($1::uuid[])', [[old.id, recent.id]])
  check(`G1 une ligne de plus de ${W.DELIVERY_RETENTION_DAYS} jours est purgée`, !left.some(r => r.id === old.id))
  check('G2 celle d’hier reste', left.some(r => r.id === recent.id))
} finally {
  if (ALLOWED_BEFORE === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS
  else process.env.WEBHOOK_ALLOWED_HOSTS = ALLOWED_BEFORE
  await receiver.close()
  await clean()
  await pool.end()
}

if (NEGATIVE) {
  console.log(`\ncontrôle négatif : ${failures.length} assertion(s) rouge(s) attendue(s) sur A, C et D`)
  if (failures.length === 0) { console.error('KO : le contrôle négatif est VERT — les assertions ne mesurent rien'); process.exit(1) }
  console.log('contrôle négatif : OK (le banc sait virer au rouge)')
  process.exit(0)
}
console.log(`\nwebhooks : ${failures.length === 0 ? 'toutes les vérifications passent' : `${failures.length} ÉCHEC(S)`}`)
process.exit(failures.length === 0 ? 0 : 1)
