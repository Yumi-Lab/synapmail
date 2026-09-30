#!/usr/bin/env node
/**
 * Banc du lot D1 : une clé API lit les pièces jointes d'un message.
 *
 * Avant ce lot, `GET /api/messages/[id]/attachment/[partId]` appelait `auth()` :
 * un agent devait ouvrir une session admin dans un navigateur pour récupérer un PDF
 * qu'il venait de trouver par l'API. Ce banc mesure, sur une instance qui tourne et
 * avec de vraies lignes en base, que la clé y accède — et pas plus loin que son droit.
 *
 *   A. une clé portant `messages:read` ET la boîte reçoit 200 et les MÊMES octets
 *      que la session humaine (empreinte SHA-256 comparée, pas la taille) ;
 *   B. un appel Bearer reçoit `X-Synapmail-Untrusted: attachment`, un appel de
 *      session ne le reçoit PAS — le rappel s'adresse à une machine ;
 *   C. sans la portée, 403 qui NOMME `messages:read` ;
 *   D. sans la boîte, 403 qui NOMME la boîte fermée ;
 *   E. la ligne de journal de la clé est complétée (statut, durée, boîte).
 *
 * DANGER, respecté ici : le banc est en LECTURE SEULE. Il n'écrit RIEN dans une
 * boîte, n'envoie RIEN, et ne crée aucune boîte — il lit une pièce jointe d'un
 * message qui existe déjà, choisi dans `messages_cache`. Trois lectures IMAP en
 * tout (le message pour connaître l'index de la pièce jointe, puis la pièce jointe
 * par la session et par la clé) : pas de rafale. Les bras C et D sont refusés AVANT
 * tout réseau, donc ne coûtent aucune connexion. Les clés créées sont supprimées
 * dans le `finally`.
 *
 *   node --experimental-strip-types scripts/check-api-attachment.mjs
 *   node --experimental-strip-types scripts/check-api-attachment.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : trois verres déformants posés ENSEMBLE, chacun
 * rendant au banc l'état du produit AVANT ce lot ou sans la barrière —
 *   (1) chaque clé reçoit TOUTES les portées et TOUTES les boîtes (la barrière ne
 *       restreint plus rien) → les bras C et D doivent tomber ;
 *   (2) l'en-tête `X-Synapmail-Untrusted` est effacé de ce que le banc lit → B1 doit
 *       tomber ;
 *   (3) un octet des données Bearer est retourné avant l'empreinte → A2 doit tomber.
 * MESURÉ : cinq assertions tombent — A2, B1, C1, D1, et E3 PAR CONSÉQUENCE de C1
 * (la clé « sans portée » réussissant désormais, il n'y a plus de refus à
 * journaliser). C'est cohérent : E3 mesure bien la ligne d'un refus, pas l'existence
 * d'une ligne. Ce que le verre démontre : ces assertions sont sensibles à ce qu'elles
 * prétendent mesurer — le droit, l'en-tête, les octets. Ce qu'il NE démontre PAS : le
 * comportement d'un binaire dont on aurait retiré `authorize()` ou `withApiLog` (A1,
 * A3, B2, E1 et E2 restent verts sous le verre, qui n'ôte aucun droit et ne touche à
 * aucune ligne de journal).
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { ALL_SCOPES } from '../lib/apiScopes.ts'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
} = process.env

const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
})) if (!v) harness(`${k} n'est pas renseigné`)

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const UNTRUSTED_HEADER = 'x-synapmail-untrusted'
const REQUIRED_SCOPE = 'messages:read'

/** Une réponse BINAIRE : les octets, l'en-tête du rappel, le statut. */
const fetchBytes = async (path, { key, cookie } = {}) => {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' })
  const bytes = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    bytes,
    untrusted: res.headers.get(UNTRUSTED_HEADER),
    contentType: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
  }
}

/** Une réponse JSON : ce que rend un REFUS, qui reste du JSON même ici. */
const fetchJson = async (path, { key, cookie } = {}) => {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* rapporté via `text` */ }
  return { status: res.status, body, text }
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * Le verre déformant (2) et (3) du contrôle négatif : ce que le banc CROIT avoir
 * reçu du Bearer. Hors `--negative`, l'identité.
 */
const throughNegativeLens = read => {
  if (!NEGATIVE) return read
  const bytes = Buffer.from(read.bytes)
  if (bytes.length) bytes[0] ^= 0xff
  return { ...read, bytes, untrusted: null }
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  const mine = await pool.query('SELECT id FROM email_accounts WHERE user_id = $1', [userId])
  if (mine.rows.length < 2) harness(`${EMAIL} a moins de deux boîtes : le bras D ne peut pas en fermer une`)
  const everyAccount = mine.rows.map(r => r.id)

  // Un message qui PORTE une pièce jointe, choisi dans le cache plutôt qu'écrit :
  // le banc ne dépose rien dans une vraie boîte.
  const candidates = await pool.query(
    `SELECT account_id, folder, uid, subject FROM messages_cache
      WHERE has_attachments = true AND account_id = ANY($1)
      ORDER BY date DESC LIMIT 1`,
    [everyAccount]
  )
  if (!candidates.rows.length) harness(`aucun message avec pièce jointe en cache pour ${EMAIL}`)
  const { account_id: openId, folder, uid } = candidates.rows[0]
  const closedId = everyAccount.find(id => id !== openId)

  /** Pose une clé avec EXACTEMENT ces portées et ces boîtes cochées. */
  const makeKey = async (name, scopes, accountIds) => {
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW(), NOW()) RETURNING id`,
      // Verre déformant (1) : sous `--negative`, toute clé est toute-puissante.
      [userId, `bench ${name}`, raw.slice(0, 12), hash, NEGATIVE ? ALL_SCOPES : scopes]
    )
    const keyId = row.rows[0].id
    created.keys.push(keyId)
    for (const accountId of NEGATIVE ? everyAccount : accountIds) {
      await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [keyId, accountId])
    }
    return { raw, id: keyId }
  }

  const goodKey = await makeKey('piece-jointe', [REQUIRED_SCOPE], [openId])
  const noScopeKey = await makeKey('sans-portee', ['folders:read'], [openId])
  const noAccountKey = await makeKey('sans-boite', [REQUIRED_SCOPE], [closedId])

  // Session humaine : cookie NextAuth obtenu comme le ferait un navigateur.
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const { csrfToken } = await csrfRes.json()
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  })
  const cookie = [csrfCookie, ...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0])].join('; ')
  if (!/session-token/.test(cookie)) harness(`connexion par identifiants refusée (${loginRes.status})`)

  // L'INDEX de la pièce jointe vient du message lui-même : un `partId` écrit en dur
  // mesurerait le hasard du message choisi, pas la route.
  const detail = await fetchJson(`/api/messages/${uid}?account=${openId}&folder=${encodeURIComponent(folder)}`, { cookie })
  const attachments = detail.body?.attachments ?? []
  if (!attachments.length) harness(`le message uid ${uid} n'expose aucune pièce jointe (HTTP ${detail.status})`)
  const partId = attachments[0].id
  const path = `/api/messages/${uid}/attachment/${partId}?account=${openId}&folder=${encodeURIComponent(folder)}`

  // ---- A. la clé lit, et lit LA MÊME CHOSE que la session ----
  const bySession = await fetchBytes(path, { cookie })
  const byKey = throughNegativeLens(await fetchBytes(path, { key: goodKey.raw }))

  check('A1 la clé portant la portée ET la boîte reçoit 200',
    byKey.status === 200, `reçu ${byKey.status} (session : ${bySession.status})`)
  check('A2 elle reçoit les MÊMES octets que la session (SHA-256 comparé)',
    bySession.status === 200 && byKey.bytes.length > 0 && sha256(byKey.bytes) === sha256(bySession.bytes),
    `clé ${byKey.bytes.length} o / ${sha256(byKey.bytes).slice(0, 16)}… vs session ${bySession.bytes.length} o / ${sha256(bySession.bytes).slice(0, 16)}…`)
  check('A3 le type et le nom du fichier voyagent avec les octets',
    !!byKey.contentType && /filename="/.test(byKey.disposition ?? ''),
    `content-type ${byKey.contentType} / disposition ${byKey.disposition}`)

  // ---- B. le rappel « donnée d'un tiers », pour une machine seulement ----
  check(`B1 l'appel Bearer porte ${UNTRUSTED_HEADER}: attachment`,
    byKey.untrusted === 'attachment', `reçu ${JSON.stringify(byKey.untrusted)}`)
  check("B2 l'appel de session ne le porte PAS",
    bySession.untrusted === null, `reçu ${JSON.stringify(bySession.untrusted)}`)

  // ---- C. sans la portée, un refus QUI LA NOMME ----
  const noScope = await fetchJson(path, { key: noScopeKey.raw })
  check(`C1 sans ${REQUIRED_SCOPE}, la clé reçoit 403 qui NOMME la portée`,
    noScope.status === 403 && noScope.body?.missingScope === REQUIRED_SCOPE &&
      String(noScope.body?.error ?? '').includes(REQUIRED_SCOPE),
    `HTTP ${noScope.status} — ${noScope.text.slice(0, 200)}`)

  // ---- D. sans la boîte, un refus QUI LA NOMME ----
  const noAccount = await fetchJson(path, { key: noAccountKey.raw })
  check('D1 sans la boîte cochée, la clé reçoit 403 qui NOMME la boîte',
    noAccount.status === 403 && noAccount.body?.missingAccount === openId &&
      String(noAccount.body?.error ?? '').includes(openId),
    `HTTP ${noAccount.status} — ${noAccount.text.slice(0, 200)}`)

  // ---- E. le journal de la clé est complété ----
  // La ligne se COMPLÈTE après que la réponse est partie : la lire aussitôt attrape
  // une ligne encore ouverte. On attend qu'elle porte son statut, avec un plafond —
  // au-delà c'est le produit qui ne complète pas, et la ligne inachevée est rendue
  // telle quelle pour que l'assertion la montre.
  const logPath = `/api/messages/${uid}/attachment/${partId}`
  const lastLog = async keyId => {
    const read = async () => {
      const { rows } = await pool.query(
        `SELECT method, path, status, duration_ms, account_id, denial_reason, denial_detail
           FROM api_key_requests WHERE api_key_id = $1 AND path = $2
          ORDER BY created_at DESC LIMIT 1`,
        [keyId, logPath]
      )
      return rows[0] ?? null
    }
    let row = await read()
    for (let waited = 0; waited < 3000 && row?.status == null; waited += 50) {
      await new Promise(r => setTimeout(r, 50))
      row = await read()
    }
    return row
  }

  const logOk = await lastLog(goodKey.id)
  check('E1 la lecture accordée a laissé une ligne complétée (méthode, statut, durée)',
    logOk?.method === 'GET' && logOk?.status === 200 && Number.isInteger(logOk?.duration_ms) && logOk.duration_ms >= 0,
    `ligne ${JSON.stringify(logOk)}`)
  check('E2 la ligne nomme la BOÎTE sur laquelle la clé a lu',
    logOk?.account_id === openId, `visée ${openId} vs ligne ${logOk?.account_id ?? 'null'}`)

  const logScope = await lastLog(noScopeKey.id)
  check('E3 le refus de portée est journalisé 403 + motif `scope` + la portée qui manque',
    logScope?.status === 403 && logScope?.denial_reason === 'scope' && logScope?.denial_detail === REQUIRED_SCOPE,
    `ligne ${JSON.stringify(logScope)}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec. Aucune boîte
  // n'a été créée ni touchée : il n'y a que les clés du banc à retirer.
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : droits élargis, en-tête effacé, octets altérés — et le banc reste vert')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\npièces jointes par la clé API : OK')
