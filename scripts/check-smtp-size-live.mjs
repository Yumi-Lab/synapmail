#!/usr/bin/env node
/**
 * MESURE le lot M10 contre de VRAIES boîtes et un VRAI serveur : le plafond
 * d'envoi vient-il de la taille que le serveur ANNONCE, ou d'un chiffre écrit
 * en dur ?
 *
 * La question ne se tranche pas avec un seul envoi : un refus à 17 Mio ne dit
 * pas d'où sort le 17. Ce banc mesure donc TROIS BRAS dans LA MÊME PASSE, avec
 * la MÊME charge utile, et ne fait varier QUE l'annonce enregistrée sur la
 * boîte. Si les trois verdicts diffèrent, la différence ne peut venir que de
 * l'annonce — c'est la preuve, pas l'intention.
 *
 *   BRAS 0  la valeur enregistrée sur la boîte = ce que le serveur annonce
 *           MAINTENANT, relu en direct par une poignée de main TLS SANS
 *           authentification (bras de référence : sans lui, le chiffre en base
 *           pourrait être n'importe quoi de périmé).
 *   BRAS A  annonce RÉELLE (135 Mo) → la charge PASSE, avec l'avertissement
 *           destinataire ; relue en IMAP, puis supprimée.
 *   BRAS B  annonce PETITE, posée pour la mesure puis retirée → la MÊME charge
 *           est refusée, et le refus CITE ce chiffre-là.
 *   BRAS C  AUCUNE annonce → la MÊME charge est refusée au plafond prudent de
 *           M9, et le refus le DIT (`limitSource: fallback`).
 *   BRAS D  une valeur fausse posée sur la boîte est CORRIGÉE par un simple
 *           essai de connexion : l'annonce se relit, elle ne se fige pas.
 *
 * ÉCRITURES : un seul message réel, d'une boîte du compte de test VERS
 * ELLE-MÊME, supprimé à la fin (réception ET envoyés). Les valeurs posées sur
 * les boîtes pour les bras B et D sont restaurées dans un `finally`.
 *
 * Besoin d'un serveur lancé et des SYNAPMAIL_TEST_* (voir .env).
 *   node scripts/check-smtp-size-live.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import tls from 'node:tls'
import { Agent, setGlobalDispatcher } from 'undici'
import { Client } from 'pg'
import { ImapFlow } from 'imapflow'
import { decrypt } from '../lib/encrypt.ts'

// Un envoi de 21 Mio prend DES MINUTES sur le fil : `fetch` abandonne par défaut
// après 300 s d'attente d'en-têtes, et l'abandon du CLIENT ressemble alors à un
// échec du PRODUIT alors que la route a rendu 200 (mesuré : 200 in 300655ms côté
// serveur, `UND_ERR_HEADERS_TIMEOUT` côté banc, MÊME passe). Le banc doit
// attendre plus longtemps que le serveur ne met à répondre, sinon il ne mesure
// que sa propre impatience.
const SEND_TIMEOUT_MS = 20 * 60 * 1000
setGlobalDispatcher(new Agent({ headersTimeout: SEND_TIMEOUT_MS, bodyTimeout: SEND_TIMEOUT_MS }))

for (const file of ['.env', '.env.local']) {
  const url = new URL(`../${file}`, import.meta.url)
  if (!existsSync(url)) continue
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL } = process.env
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL }))
  if (!v) harness(`${k} is not set`)

// Les seuils et codes viennent des modules livrés : un renommage là-bas casse
// ce banc au lieu de lui faire mesurer un contrat que le produit n'honore plus.
const readConst = (file, name) => {
  const src = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8')
  const m = src.match(new RegExp(`export const ${name} = ([^\\n]+)`))
  if (!m) harness(`cannot read ${name} from lib/${file}`)
  const expr = m[1].replace(/\/\/.*$/, '').trim()
  // eslint-disable-next-line no-new-func
  return Function(`"use strict";return (${expr})`)()
}
const M9_FALLBACK_BYTES = readConst('attachments.ts', 'MESSAGE_MAX_TOTAL_BYTES')
const WARNING_BYTES = readConst('smtpSize.ts', 'SEND_WARNING_BYTES')
const RESERVE_BYTES = readConst('smtpSize.ts', 'MESSAGE_ENVELOPE_RESERVE_BYTES')
const { resolveSendCeiling, wireBytes } = await import(new URL('../lib/smtpSize.ts', import.meta.url).href)

// La charge utile tient dans la fenêtre que le lot ouvre : AU-DESSUS du plafond
// prudent de M9 (donc refusée avant M10), AU-DESSUS du seuil d'avertissement
// (donc elle doit avertir), et très au-dessous des 135 Mo annoncés.
const PAYLOAD_BYTES = 21 * 1024 * 1024
if (PAYLOAD_BYTES <= M9_FALLBACK_BYTES) harness('payload must exceed the M9 fallback to prove anything')
if (PAYLOAD_BYTES <= WARNING_BYTES) harness('payload must exceed the recipient warning threshold')

// Annonce posée pour le BRAS B. Basse, mais au-dessus du plancher du module
// (une annonce sous la réserve d'enveloppe ne veut rien dire) et sous la charge.
const SMALL_ANNOUNCED = 8 * 1024 * 1024

/** Un seul sujet : il sert à envoyer, à retrouver, et à nettoyer. */
const SUBJECT = `M10 bench ${PAYLOAD_BYTES}`
if (SMALL_ANNOUNCED <= RESERVE_BYTES) harness('the small announcement must stay above the envelope reserve')

const failures = []
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ── Session, exactement comme le navigateur l'obtient ──
const jar = new Map()
const keep = res => {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}
const api = async (path, init) => {
  const cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...init?.headers, cookie } })
  keep(res)
  return res
}
const csrfRes = await api('/api/auth/csrf')
if (!csrfRes.ok) harness(`GET /api/auth/csrf -> ${csrfRes.status}`)
const { csrfToken } = await csrfRes.json()
keep(await api('/api/auth/callback/credentials', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  redirect: 'manual',
}))
if (!Array.from(jar.keys()).some(n => n.endsWith('session-token')))
  harness(`credentials login yielded no session cookie (cookies: ${Array.from(jar.keys()).join(', ') || 'none'})`)

const accountsRes = await api('/api/accounts')
if (!accountsRes.ok) harness(`GET /api/accounts -> ${accountsRes.status}`)
const accounts = (accountsRes.status, (await accountsRes.json()).data ?? [])
if (!accounts.length) harness('the test user owns no mailbox')

// ── Lecture directe de la base : la colonne EST le souvenir de l'annonce ──
const db = new Client({ connectionString: DATABASE_URL })
await db.connect()
const announcedOf = async id =>
  (await db.query('SELECT smtp_max_size FROM email_accounts WHERE id = $1', [id])).rows[0]?.smtp_max_size ?? null
const setAnnounced = (id, value) =>
  db.query('UPDATE email_accounts SET smtp_max_size = $1 WHERE id = $2', [value, id])

const rows = (await db.query(
  `SELECT a.id, a.email, a.username, a.smtp_host, a.smtp_port, a.smtp_secure,
          a.imap_host, a.imap_port, a.imap_secure, a.smtp_max_size
     FROM email_accounts a JOIN users u ON u.id = a.user_id
    WHERE u.email = $1 ORDER BY a.created_at`, [EMAIL])).rows
const subject = rows.find(r => r.smtp_max_size !== null)
if (!subject) harness('no mailbox of the test user carries a recorded announcement — run a connection test first')
const spare = rows.find(r => r.id !== subject.id)
if (!spare) harness('the test user needs a second mailbox to hold the reference arms')

// La valeur d'origine de CHAQUE boîte touchée, pour la remettre quoi qu'il arrive.
const original = new Map([[subject.id, subject.smtp_max_size], [spare.id, spare.smtp_max_size]])

try {
  // ── BRAS 0 — la valeur enregistrée = ce que le serveur dit MAINTENANT ──
  const live = await new Promise(resolve => {
    const sock = tls.connect({ host: subject.smtp_host, port: subject.smtp_port, servername: subject.smtp_host, rejectUnauthorized: false })
    let buf = '', greeted = false
    const done = v => { try { sock.destroy() } catch {} ; resolve(v) }
    const timer = setTimeout(() => done(null), 15000)
    sock.on('error', () => { clearTimeout(timer); done(null) })
    sock.on('data', d => {
      buf += d.toString()
      if (!greeted && /^220[ -]/m.test(buf)) { greeted = true; sock.write('EHLO probe.local\r\n'); return }
      const m = buf.match(/250[- ]SIZE\s+(\d+)/i)
      if (m) { clearTimeout(timer); done(Number(m[1])) }
    })
  })
  if (live === null) harness(`${subject.smtp_host}:${subject.smtp_port} announced nothing readable — bench cannot attribute anything`)
  const recorded = Number(await announcedOf(subject.id))
  check('la taille enregistrée sur la boîte EST celle que le serveur annonce',
    recorded === live, `base=${recorded} annonce vivante=${live} (${(live / 1e6).toFixed(1)} Mo) sur ${subject.smtp_host}:${subject.smtp_port}`)

  const serverCeiling = resolveSendCeiling(recorded, M9_FALLBACK_BYTES)
  check('le plafond déduit de cette annonce dépasse l’ancien plafond de M9',
    serverCeiling.limit > M9_FALLBACK_BYTES && serverCeiling.source === 'server',
    `plafond=${serverCeiling.limit} > M9=${M9_FALLBACK_BYTES}, source=${serverCeiling.source}`)

  // Charge utile : un seul tampon, réutilisé par les trois bras, pour que la
  // SEULE variable entre eux soit l'annonce enregistrée.
  const payload = Buffer.alloc(PAYLOAD_BYTES, 0x4d).toString('base64')
  const send = (accountId, to, extra = {}) => api('/api/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId, to, subject: SUBJECT,
      text: 'banc M10 — message de mesure, supprimé après', html: '<p>banc M10</p>',
      attachments: [{ filename: 'm10.bin', content: payload, contentType: 'application/octet-stream' }],
      ...extra,
    }),
  })

  // ── BRAS C — aucune annonce : le repli prudent, et il le DIT ──
  await setAnnounced(spare.id, null)
  const armC = await send(spare.id, spare.email)
  const bodyC = await armC.json()
  check('sans annonce du serveur, la MÊME charge est refusée au plafond prudent de M9',
    armC.status === 413 && bodyC.limit === M9_FALLBACK_BYTES && bodyC.limitSource === 'fallback' && bodyC.announcedSize === null,
    `status=${armC.status} body=${JSON.stringify(bodyC)}`)

  // ── BRAS B — une PETITE annonce : le refus cite CE chiffre ──
  await setAnnounced(spare.id, SMALL_ANNOUNCED)
  const expected = resolveSendCeiling(SMALL_ANNOUNCED, M9_FALLBACK_BYTES)
  const armB = await send(spare.id, spare.email)
  const bodyB = await armB.json()
  check('avec une annonce de ' + SMALL_ANNOUNCED + ' octets, le refus CITE cette annonce',
    armB.status === 413 && bodyB.limitSource === 'server' && Number(bodyB.announcedSize) === SMALL_ANNOUNCED && bodyB.limit === expected.limit,
    `status=${armB.status} body=${JSON.stringify(bodyB)} plafond attendu=${expected.limit}`)
  check('le plafond opposé SUIT l’annonce : deux annonces, deux plafonds différents',
    expected.limit !== serverCeiling.limit && expected.limit !== M9_FALLBACK_BYTES,
    `petit=${expected.limit} réel=${serverCeiling.limit} repli=${M9_FALLBACK_BYTES}`)
  await setAnnounced(spare.id, original.get(spare.id))

  // ── BRAS A — l'annonce RÉELLE : la charge PASSE, et elle avertit ──
  const t0 = Date.now()
  const armA = await send(subject.id, subject.email)
  const bodyA = await armA.json()
  const elapsed = Date.now() - t0
  check('au-dessus de l’ancien plafond mais sous l’annonce du serveur, l’envoi PASSE',
    armA.status === 200 && bodyA.success === true,
    `status=${armA.status} body=${JSON.stringify(bodyA)} elapsed=${elapsed}ms (refusé avant M10 : ${PAYLOAD_BYTES} > ${M9_FALLBACK_BYTES})`)
  check('il PART mais il AVERTIT : le destinataire, lui, peut refuser',
    bodyA.warning === 'recipient_may_refuse_size' && bodyA.bytes === PAYLOAD_BYTES,
    `warning=${bodyA.warning} bytes=${bodyA.bytes} seuil=${WARNING_BYTES}`)

  // ── Relecture IMAP, puis nettoyage ──
  // La relecture passe par IMAP et non par la liste paginée de l'API : un
  // message de 30 Mo n'apparaît pas forcément en page 1 dans la minute, et
  // « absent de la page 1 » dirait « perdu » alors qu'il est bien arrivé
  // (mesuré : trois messages introuvables par la liste, retrouvés par
  // `search({subject})` dans la MÊME boîte).
  if (armA.status === 200) {
    const creds = (await db.query('SELECT username, password_encrypted, imap_host, imap_port, imap_secure FROM email_accounts WHERE id = $1', [subject.id])).rows[0]
    const imap = new ImapFlow({
      host: creds.imap_host, port: creds.imap_port, secure: creds.imap_secure,
      auth: { user: creds.username, pass: decrypt(creds.password_encrypted) },
      logger: false, tls: { rejectUnauthorized: false },
    })
    await imap.connect()
    try {
      let seen = null
      for (let attempt = 0; attempt < 40 && !seen; attempt++) {
        await new Promise(r => setTimeout(r, 5000))
        const lock = await imap.getMailboxLock('INBOX')
        try {
          const uids = await imap.search({ subject: SUBJECT }, { uid: true })
          if (uids?.length) {
            const uid = uids[uids.length - 1]
            const msg = await imap.fetchOne(String(uid), { envelope: true, bodyStructure: true, size: true }, { uid: true })
            const parts = []
            ;(function walk(node) {
              if (!node) return
              const name = node.dispositionParameters?.filename ?? node.parameters?.name
              if (name) parts.push({ name, size: node.size })
              ;(node.childNodes ?? []).forEach(walk)
            })(msg.bodyStructure)
            seen = { uid, subject: msg.envelope.subject, parts }
          }
        } finally { lock.release() }
      }
      check('le message est bien ARRIVÉ dans la boîte, relu par IMAP', Boolean(seen),
        seen ? `uid=${seen.uid} sujet="${seen.subject}"` : 'introuvable après 200 s')
      if (seen) {
        const att = seen.parts.find(a => a.name === 'm10.bin')
        // La taille lue est celle du base64 SUR LE FIL : elle doit valoir ce que
        // `wireBytes` prédit pour la charge envoyée, à la tolérance des en-têtes
        // de partie près. C'est la vérification que rien n'a été tronqué.
        const expectedWire = wireBytes(PAYLOAD_BYTES)
        check('la pièce est arrivée ENTIÈRE, au bon nom, à la taille attendue sur le fil',
          Boolean(att) && Math.abs(att.size - expectedWire) <= expectedWire * 0.01,
          att ? `nom="${att.name}" taille sur le fil=${att.size} attendue=${expectedWire} (décodé=${PAYLOAD_BYTES})`
              : `pièces=${JSON.stringify(seen.parts.map(a => a.name))}`)
      }
    } finally { await imap.logout() }
  }

  // ── BRAS D — une valeur fausse se CORRIGE au prochain essai de connexion ──
  await setAnnounced(subject.id, SMALL_ANNOUNCED)
  // La route de test exige la fiche de connexion, pas seulement l'identifiant :
  // `accountId` seul rend 400 « Missing fields » (mesuré). Le mot de passe n'est
  // PAS envoyé — c'est justement la décision `STORED` qu'on veut emprunter, celle
  // qui déchiffre le mot de passe enregistré vers les hôtes ENREGISTRÉS.
  const testRes = await api('/api/accounts/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: subject.id,
      imapHost: subject.imap_host, imapPort: subject.imap_port, imapSecure: subject.imap_secure,
      smtpHost: subject.smtp_host, smtpPort: subject.smtp_port, smtpSecure: subject.smtp_secure,
      username: subject.username,
    }),
  })
  const afterTest = Number(await announcedOf(subject.id))
  check('un essai de connexion RELIT l’annonce et corrige la valeur enregistrée',
    testRes.ok && afterTest === live,
    `test=${testRes.status} valeur posée=${SMALL_ANNOUNCED} → relue=${afterTest} (annonce vivante=${live})`)
} finally {
  for (const [id, value] of original) await setAnnounced(id, value)
  // Nettoyage par SUJET, pas par uid : si le banc est mort avant d'avoir relu
  // son message, l'uid est inconnu mais le message, lui, est bien là — un
  // nettoyage indexé sur l'uid laisserait des messages de mesure de 30 Mo dans
  // une VRAIE boîte (mesuré : trois, laissés par trois passages interrompus).
  const creds = (await db.query('SELECT username, password_encrypted, imap_host, imap_port, imap_secure FROM email_accounts WHERE id = $1', [subject.id])).rows[0]
  const imap = new ImapFlow({
    host: creds.imap_host, port: creds.imap_port, secure: creds.imap_secure,
    auth: { user: creds.username, pass: decrypt(creds.password_encrypted) },
    logger: false, tls: { rejectUnauthorized: false },
  })
  try {
    await imap.connect()
    for (const box of await imap.list()) {
      const lock = await imap.getMailboxLock(box.path)
      try {
        const uids = await imap.search({ subject: SUBJECT }, { uid: true })
        if (uids?.length) {
          await imap.messageDelete(uids.map(String).join(','), { uid: true })
          console.log(`  cleanup: ${uids.length} message(s) de mesure supprimé(s) dans ${box.path}`)
        }
      } catch {} finally { lock.release() }
    }
    await imap.logout()
  } catch (e) {
    console.log(`  cleanup: échec du nettoyage IMAP — ${e.message} (À SUPPRIMER À LA MAIN : sujet "${SUBJECT}")`)
  }
  await db.query('DELETE FROM messages_cache WHERE subject = $1', [SUBJECT])
  await db.end()
}

console.log(failures.length ? `check-smtp-size-live: ${failures.length} FAILED` : 'check-smtp-size-live: OK')
process.exit(failures.length ? 1 : 0)
