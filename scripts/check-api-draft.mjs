#!/usr/bin/env node
/**
 * Banc du lot D2 : une clé API écrit un brouillon dans le VRAI dossier « Brouillons ».
 *
 * Avant ce lot, l'API ne savait pas créer de brouillon : `/api/drafts` est la sauvegarde
 * automatique de la fenêtre de composition (une ligne en base par compte, session seule),
 * jamais un message de la boîte. Un agent ne pouvait donc pas préparer une réponse qu'on
 * relirait depuis un téléphone. Ce banc mesure, sur une instance qui tourne et une VRAIE
 * boîte IONOS, que la clé y arrive — et pas plus loin que son droit.
 *
 *   A. `POST` écrit le brouillon : 200, le dossier rendu porte bien le rôle « brouillons »,
 *      et le message RELU PAR IMAP porte le drapeau `\Draft`, l'en-tête `In-Reply-To`,
 *      `References`, et sa pièce jointe intacte (SHA-256 comparé à ce qui a été envoyé) ;
 *   B. deux brouillons COEXISTENT — le second n'écrase pas le premier ;
 *   C. `PUT` remplace sans perte : le nouveau est écrit AVANT que l'ancien uid disparaisse,
 *      et un `?account=` contredit par le corps est refusé plutôt qu'arbitré en silence ;
 *   D. `DELETE` supprime, et un uid déjà parti rend 404 plutôt que « supprimé » ; un uid non
 *      numérique dans l'URL (PUT ou DELETE) rend 400 nommé AVANT toute connexion IMAP ;
 *   E. la barrière : sans `messages:draft`, 403 qui NOMME la portée ; sans la boîte, 403
 *      qui NOMME la boîte ; une clé `messages:send` seule ne peut pas écrire de brouillon ;
 *   F. RIEN N'EST ENVOYÉ : aucun chemin SMTP n'existe dans ce lot — mesuré sur les sources
 *      (la route n'importe pas `sendMail`, et `composeMail` ne reçoit pas les identifiants
 *      SMTP de la boîte) ET sur le produit (aucune ligne `sent_tracking` n'est née).
 *
 * DANGER, respecté ici : le banc ÉCRIT dans une vraie boîte. Il n'écrit que dans son dossier
 * Brouillons, avec un objet `[banc synapmail] …`, et SUPPRIME tout ce qu'il a écrit dans son
 * `finally` — y compris après un échec, y compris les brouillons dont une assertion a perdu
 * la trace (il balaie le dossier par objet). Aucun envoi, aucune rafale : chaque appel HTTP
 * ouvre au plus une connexion IMAP.
 *
 *   node --experimental-strip-types scripts/check-api-draft.mjs
 *   node --experimental-strip-types scripts/check-api-draft.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : deux verres déformants posés ENSEMBLE, chacun rendant au
 * banc l'état du produit SANS la barrière ou SANS la garantie —
 *   (1) chaque clé reçoit TOUTES les portées et TOUTES les boîtes → les bras E doivent tomber ;
 *   (2) le banc relit le brouillon par une lecture qui IGNORE les drapeaux et les en-têtes
 *       (ce que mesurerait un APPEND sans `\Draft` ni `In-Reply-To`) → A doit tomber.
 * Un banc qui ne peut pas échouer ne prouve rien.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import pg from 'pg'
import { ALL_SCOPES } from '../lib/apiScopes.ts'
import { detectSpecials } from '../lib/specialFolders.ts'
import { decrypt } from '../lib/encrypt.ts'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, DATABASE_URL: DB_URL,
} = process.env

const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, DATABASE_URL: DB_URL,
})) if (!v) harness(`${k} n'est pas renseigné`)

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const REQUIRED_SCOPE = 'messages:draft'
/** Tout ce que ce banc écrit porte ce préfixe : c'est ainsi que le `finally` le retrouve. */
const SUBJECT_TAG = '[banc synapmail] brouillon'
const REPLY_TO = `<bench-${crypto.randomUUID()}@yumi-lab.invalid>`
const ATTACHMENT = Buffer.from(`piece jointe du banc ${crypto.randomUUID()}\n`.repeat(8))
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

const call = async (method, path, { key, body } = {}) => {
  const headers = { authorization: `Bearer ${key}` }
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method, headers, redirect: 'manual',
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* rapporté via `text` */ }
  return { status: res.status, body: parsed, text }
}

const draftBody = (accountId, extra = {}) => ({
  accountId,
  to: 'destinataire@yumi-lab.invalid',
  subject: `${SUBJECT_TAG} ${crypto.randomUUID()}`,
  text: 'Corps du brouillon écrit par le banc. Rien ne doit partir.',
  inReplyTo: REPLY_TO,
  references: REPLY_TO,
  attachments: [{
    filename: 'banc.txt',
    contentType: 'text/plain',
    content: ATTACHMENT.toString('base64'),
  }],
  ...extra,
})

/**
 * Les OCTETS de la pièce jointe, décodés depuis le message relu — pas une sous-chaîne
 * du base64. Une comparaison de texte passerait sur un fichier tronqué dont le début
 * est intact ; l'empreinte des octets décodés, non. Le découpage suit la frontière MIME
 * que le message DÉCLARE, jamais une frontière devinée.
 */
function attachmentBytes(source) {
  const boundary = source.match(/boundary="?([^"\r\n;]+)"?/)?.[1]
  if (!boundary) return null
  const part = source
    .split(`--${boundary}`)
    .find(block => /Content-Disposition:\s*attachment/i.test(block))
  if (!part) return null
  const body = part.split(/\r?\n\r?\n/).slice(1).join('\n\n')
  return Buffer.from(body.replace(/\s+/g, ''), 'base64')
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }
let imapConfig = null
let draftsFolder = null

/** Tout ce que le banc a posé dans la boîte, retrouvé par son objet — pas par un uid mémorisé. */
async function sweepBenchDrafts() {
  if (!imapConfig || !draftsFolder) return 0
  const client = new ImapFlow({ ...imapConfig, logger: false, tls: { rejectUnauthorized: false } })
  await client.connect()
  try {
    const lock = await client.getMailboxLock(draftsFolder)
    try {
      const uids = await client.search({ header: { subject: SUBJECT_TAG } }, { uid: true })
      if (uids?.length) await client.messageDelete(uids.join(','), { uid: true })
      return uids?.length ?? 0
    } finally { lock.release() }
  } finally { await client.logout() }
}

/** Ce que la BOÎTE contient vraiment : drapeaux, en-têtes, pièce jointe. Pas ce que l'API a dit. */
async function readDraft(uid) {
  const client = new ImapFlow({ ...imapConfig, logger: false, tls: { rejectUnauthorized: false } })
  await client.connect()
  try {
    const lock = await client.getMailboxLock(draftsFolder)
    try {
      const msg = await client.fetchOne(uid, { source: true, flags: true }, { uid: true })
      if (!msg) return null
      const source = msg.source.toString('binary')
      const headers = source.split(/\r?\n\r?\n/)[0]
      return {
        // Verre déformant (2) : le banc lit un message dont les drapeaux et les
        // en-têtes de fil ont disparu — ce que rendrait un APPEND qui les omet.
        flags: NEGATIVE ? new Set() : new Set(msg.flags ?? []),
        headers: NEGATIVE ? '' : headers,
        source,
      }
    } finally { lock.release() }
  } finally { await client.logout() }
}

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  const mine = await pool.query(
    `SELECT id, imap_host, imap_port, imap_secure, username, password_encrypted, oauth_provider
       FROM email_accounts WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  )
  if (mine.rows.length < 2) harness(`${EMAIL} a moins de deux boîtes : le bras E ne peut pas en fermer une`)
  const everyAccount = mine.rows.map(r => r.id)
  const open = mine.rows.find(r => !r.oauth_provider)
  if (!open) harness('aucune boîte à mot de passe : le banc ne sait pas relire par IMAP')
  const openId = open.id
  const closedId = everyAccount.find(id => id !== openId)

  imapConfig = {
    host: open.imap_host, port: open.imap_port, secure: open.imap_secure,
    auth: { user: open.username, pass: decrypt(open.password_encrypted) },
  }

  // Le dossier des brouillons de CETTE boîte, résolu comme le produit le résout
  // (`lib/specialFolders.ts`) — pas un nom écrit en dur dans le banc.
  {
    const client = new ImapFlow({ ...imapConfig, logger: false, tls: { rejectUnauthorized: false } })
    await client.connect()
    try {
      const folders = (await client.list())
        .filter(f => !f.flags?.has('\\Noselect'))
        .map(f => ({ name: f.name, path: f.path, delimiter: f.delimiter ?? '/', specialUse: f.specialUse }))
      const specials = detectSpecials(folders)
      draftsFolder = folders.find(f => specials.get(f.path) === 'drafts')?.path ?? null
    } finally { await client.logout() }
  }
  if (!draftsFolder) harness(`la boîte ${openId} n'expose aucun dossier de brouillons`)

  // Ce qui traîne d'un run précédent interrompu part AVANT toute mesure.
  await sweepBenchDrafts()

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

  const goodKey = await makeKey('brouillon', [REQUIRED_SCOPE], [openId])
  const noScopeKey = await makeKey('sans-portee', ['messages:read'], [openId])
  const noAccountKey = await makeKey('sans-boite', [REQUIRED_SCOPE], [closedId])
  const sendOnlyKey = await makeKey('envoi-seul', ['messages:send'], [openId])

  const trackingBefore = await pool.query(
    'SELECT count(*)::int AS n FROM sent_tracking WHERE account_id = $1', [openId]
  )

  // ---- A. le brouillon est ÉCRIT, et la boîte le confirme ----
  const first = await call('POST', '/api/messages/draft', { key: goodKey.raw, body: draftBody(openId) })
  check('A1 la clé portant la portée ET la boîte écrit un brouillon (200)',
    first.status === 200 && !!first.body?.data, `HTTP ${first.status} — ${first.text.slice(0, 200)}`)
  check('A2 le dossier rendu est celui que le serveur désigne comme « brouillons »',
    first.body?.data?.folder === draftsFolder,
    `rendu ${first.body?.data?.folder} vs dossier résolu ${draftsFolder}`)
  check("A3 l'uid rendu vient d'APPENDUID (UIDPLUS annoncé par ce serveur)",
    typeof first.body?.data?.uid === 'string' && /^\d+$/.test(first.body.data.uid),
    `uid rendu ${JSON.stringify(first.body?.data?.uid)}`)

  const firstUid = first.body?.data?.uid
  const stored = firstUid ? await readDraft(firstUid) : null
  check('A4 relu par IMAP, le message porte le drapeau \\Draft',
    !!stored?.flags.has('\\Draft'), `drapeaux ${JSON.stringify([...(stored?.flags ?? [])])}`)
  check('A5 il porte In-Reply-To ET References, donc il s\'accroche au fil',
    !!stored && stored.headers.includes(`In-Reply-To: ${REPLY_TO}`) && stored.headers.includes(`References: ${REPLY_TO}`),
    `en-têtes ${JSON.stringify((stored?.headers ?? '').slice(0, 300))}`)
  const storedAttachment = stored ? attachmentBytes(stored.source) : null
  check('A6 la pièce jointe est intacte (SHA-256 des octets DÉCODÉS du message relu)',
    !!storedAttachment && sha256(storedAttachment) === sha256(ATTACHMENT),
    `relu ${storedAttachment?.length ?? 0} o / ${storedAttachment ? sha256(storedAttachment).slice(0, 16) : '—'}… vs envoyé ${ATTACHMENT.length} o / ${sha256(ATTACHMENT).slice(0, 16)}…`)

  // ---- B. deux brouillons COEXISTENT ----
  const second = await call('POST', '/api/messages/draft', { key: goodKey.raw, body: draftBody(openId) })
  const secondUid = second.body?.data?.uid
  check('B1 un second brouillon est écrit sous un autre uid',
    second.status === 200 && !!secondUid && secondUid !== firstUid,
    `premier ${firstUid} / second ${secondUid} (HTTP ${second.status})`)
  check('B2 le PREMIER est toujours là : le second ne l\'a pas écrasé',
    !!(firstUid && await readDraft(firstUid)), `uid ${firstUid} introuvable après le second APPEND`)

  // ---- C. PUT remplace SANS PERTE ----
  const place = `?account=${openId}&folder=${encodeURIComponent(draftsFolder)}`
  const replaced = await call('PUT', `/api/messages/draft/${secondUid}${place}`, {
    key: goodKey.raw, body: draftBody(openId, { text: 'Corps corrigé par le banc.' }),
  })
  const replacedUid = replaced.body?.data?.uid
  check('C1 PUT rend 200, un nouvel uid, et nomme celui qu\'il a remplacé',
    replaced.status === 200 && !!replacedUid && replacedUid !== secondUid && replaced.body?.data?.replaced === secondUid,
    `HTTP ${replaced.status} — ${replaced.text.slice(0, 200)}`)
  check('C2 le NOUVEAU est bien dans la boîte (écrit avant toute suppression)',
    !!(replacedUid && await readDraft(replacedUid)), `uid ${replacedUid} introuvable`)
  check('C3 l\'ANCIEN a disparu, et lui seul',
    !(await readDraft(secondUid)) && !!(firstUid && await readDraft(firstUid)),
    `ancien ${secondUid} / premier ${firstUid}`)

  const mismatch = await call('PUT', `/api/messages/draft/${replacedUid}${place}`, {
    key: goodKey.raw, body: draftBody(closedId),
  })
  check('C4 un accountId du corps qui contredit ?account= est REFUSÉ, pas arbitré',
    mismatch.status === 400 && mismatch.body?.error === 'account_mismatch',
    `HTTP ${mismatch.status} — ${mismatch.text.slice(0, 200)}`)

  // ---- D. DELETE supprime, et ne ment pas sur ce qui n'existe plus ----
  const removed = await call('DELETE', `/api/messages/draft/${replacedUid}${place}`, { key: goodKey.raw })
  check('D1 DELETE rend 200 et le brouillon a quitté la boîte',
    removed.status === 200 && removed.body?.data?.deleted === true && !(await readDraft(replacedUid)),
    `HTTP ${removed.status} — ${removed.text.slice(0, 200)}`)
  const twice = await call('DELETE', `/api/messages/draft/${replacedUid}${place}`, { key: goodKey.raw })
  check('D2 un uid déjà parti rend 404 « draft_not_found », jamais « supprimé »',
    twice.status === 404 && twice.body?.error === 'draft_not_found',
    `HTTP ${twice.status} — ${twice.text.slice(0, 200)}`)

  // Un uid non numérique n'atteint JAMAIS IMAP : 400 nommé, pas un 500 qui fuit
  // « Invalid sequence set value » (constaté par l'orchestrateur avant ce lot).
  const badPut = await call('PUT', `/api/messages/draft/undefined${place}`, {
    key: goodKey.raw, body: draftBody(openId),
  })
  check('D3 PUT avec un uid non numérique rend 400 « draft_invalid_uid », jamais 500',
    badPut.status === 400 && badPut.body?.error === 'draft_invalid_uid',
    `HTTP ${badPut.status} — ${badPut.text.slice(0, 200)}`)
  const badDelete = await call('DELETE', `/api/messages/draft/abc123${place}`, { key: goodKey.raw })
  check('D4 DELETE avec un uid non numérique rend 400 « draft_invalid_uid », jamais 500',
    badDelete.status === 400 && badDelete.body?.error === 'draft_invalid_uid',
    `HTTP ${badDelete.status} — ${badDelete.text.slice(0, 200)}`)

  // ---- E. la barrière ----
  const noScope = await call('POST', '/api/messages/draft', { key: noScopeKey.raw, body: draftBody(openId) })
  check(`E1 sans ${REQUIRED_SCOPE}, la clé reçoit 403 qui NOMME la portée`,
    noScope.status === 403 && noScope.body?.missingScope === REQUIRED_SCOPE &&
      String(noScope.body?.error ?? '').includes(REQUIRED_SCOPE),
    `HTTP ${noScope.status} — ${noScope.text.slice(0, 200)}`)
  const noAccount = await call('POST', '/api/messages/draft', { key: noAccountKey.raw, body: draftBody(openId) })
  check('E2 sans la boîte cochée, la clé reçoit 403 qui NOMME la boîte',
    noAccount.status === 403 && noAccount.body?.missingAccount === openId,
    `HTTP ${noAccount.status} — ${noAccount.text.slice(0, 200)}`)
  const sendOnly = await call('POST', '/api/messages/draft', { key: sendOnlyKey.raw, body: draftBody(openId) })
  check('E3 `messages:send` NE donne PAS le brouillon : ce sont deux portées',
    sendOnly.status === 403 && sendOnly.body?.missingScope === REQUIRED_SCOPE,
    `HTTP ${sendOnly.status} — ${sendOnly.text.slice(0, 200)}`)

  // ---- F. rien n'est ENVOYÉ ----
  const routeSource = readFileSync(new URL('../app/api/messages/draft/route.ts', import.meta.url), 'utf8')
  const putSource = readFileSync(new URL('../app/api/messages/draft/[uid]/route.ts', import.meta.url), 'utf8')
  check('F1 aucune route brouillon n\'importe sendMail : l\'envoi est STRUCTURELLEMENT hors d\'atteinte',
    !/\bsendMail\b/.test(routeSource) && !/\bsendMail\b/.test(putSource),
    'une route brouillon nomme sendMail')
  const smtpSource = readFileSync(new URL('../lib/smtp.ts', import.meta.url), 'utf8')
  const composeSignature = smtpSource.match(/export const composeMail[^\n]*/)?.[0] ?? ''
  check('F2 composeMail ne reçoit PAS les identifiants SMTP : il ne peut joindre aucun serveur',
    !!composeSignature && !/SmtpConfig/.test(composeSignature),
    `signature lue : ${composeSignature || '(composeMail introuvable)'}`)
  const trackingAfter = await pool.query(
    'SELECT count(*)::int AS n FROM sent_tracking WHERE account_id = $1', [openId]
  )
  check('F3 aucune trace d\'envoi n\'est née pendant le banc',
    trackingAfter.rows[0].n === trackingBefore.rows[0].n,
    `sent_tracking ${trackingBefore.rows[0].n} → ${trackingAfter.rows[0].n}`)
} finally {
  // La boîte est rendue comme elle a été trouvée, même après un échec : le balayage
  // cherche par OBJET, donc il attrape aussi les brouillons dont une assertion a
  // perdu la trace. Puis les clés du banc.
  try {
    const swept = await sweepBenchDrafts()
    console.log(`\nnettoyage : ${swept} brouillon(s) du banc retiré(s) de ${draftsFolder ?? '(dossier inconnu)'}`)
  } catch (err) {
    console.error(`\nNETTOYAGE INCOMPLET : ${err} — brouillons « ${SUBJECT_TAG} » à retirer à la main`)
  }
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`contrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('CONTRÔLE NÉGATIF MUET : droits élargis, drapeaux et en-têtes effacés — et le banc reste vert')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('brouillons par la clé API : OK')
