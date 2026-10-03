#!/usr/bin/env node
/**
 * Banc du lot T12 (suite du gate du 03/10) : la priorité ne lit que les origines de CONFIANCE.
 *
 * Mesuré au gate sur la boîte réelle : 221 mails d'un moteur d'ESSAI (« Yumi One (local) »,
 * jamais rattaché) et des lignes de BANC dominaient « À traiter », parce que l'étiquette
 * « effective » est la plus récente toutes origines confondues. Ici, sur une boîte de banc
 * (`.invalid`, jamais la boîte réelle), deux moteurs écrivent sur le même mail :
 *
 *   A. seul le moteur RATTACHÉ (`mailbox_tagging.engine_id`) pèse dans `getFocusItems()` /
 *      `withPriority()` ; les lignes du moteur étranger, plus récentes, sont ignorées ;
 *   B. une correction HUMAINE pèse toujours, et une ligne du trieur (`regle`) aussi ;
 *   C. l'AFFICHAGE (`readEffectiveFor` sans `trusted`) garde la règle de GOAL.md : la plus récente ;
 *   D. l'échéance EXTRAITE (`message_fields.echeance`, lot T11) du moteur rattaché entre dans le
 *      score comme part `echeance`, visible dans l'infobulle — celle du moteur étranger non.
 *
 *   node --experimental-strip-types scripts/check-focus-origin.mjs
 *   node --experimental-strip-types scripts/check-focus-origin.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le moteur ÉTRANGER est rattaché à la boîte à la place du
 * moteur attendu. A et D DOIVENT tomber (c'est alors lui qui pèse) ; B et C tiennent.
 * Nettoyage complet dans le `finally` (utilisateur, boîte, moteurs : CASCADE).
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
if (!process.env.DATABASE_URL) { console.error("HARNESS: DATABASE_URL n'est pas renseigné"); process.exit(2) }
const NEGATIVE = process.argv.includes('--negative')

const { query, initDb } = await import('../lib/db.ts')
const store = await import('../lib/tagging/store.ts')
const focus = await import('../lib/focus.ts')
const { RULE_SOURCE, HUMAN_SOURCE } = await import('../lib/tagging/engine.ts')

const failures = []
let ok = 0
const check = (id, cond, detail) => { if (cond) { ok++; console.log(`  ok   ${id}`) } else { failures.push(id); console.log(`  FAIL ${id}\n       ${detail}`) } }

await initDb()
const tag = crypto.randomBytes(4).toString('hex')
const EMAIL = `t12-${tag}@banc-t12.invalid`
const [user] = await query(`INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, 'banc t12', 'x', 'user', 'active') RETURNING id`, [EMAIL])
const USER = user.id
try {
  const [acct] = await query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1, 'banc t12', $2, 'imap.banc-t12.invalid', 993, true, 'smtp.banc-t12.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`, [USER, EMAIL])
  const ACCOUNT = acct.id
  const engine = async name => (await query(
    `INSERT INTO decision_engines (user_id, name, kind, url, model, usd_per_billion_input) VALUES ($1, $2, 'jev', $3, 'banc-1', 1) RETURNING id, name`,
    [USER, name, `http://banc-t12.invalid/${name}`]))[0]
  const attached = await engine('rattaché')
  const foreign = await engine('essai')
  await query(`INSERT INTO mailbox_tagging (account_id, engine_id) VALUES ($1, $2)`, [ACCOUNT, NEGATIVE ? foreign.id : attached.id])

  const MID = n => `<banc-t12-${tag}-${n}@banc-t12.invalid>`
  const mail = async (n, subject) => query(
    `INSERT INTO messages_cache (account_id, folder, uid, message_id, from_address, from_name, subject, date, is_read, is_starred, has_attachments)
     VALUES ($1, 'INBOX', $2, $3, 'client@exemple.invalid', 'Client', $4, NOW() - make_interval(mins => $5), false, false, false)`,
    [ACCOUNT, String(n), MID(n), subject, n])
  await mail(1, 'Bonjour')          // rattaché : calme ; étranger (plus récent) : tout à oui
  await mail(2, 'Bonjour encore')   // rattaché : urgent ; humain : pas urgent
  await mail(3, 'Point du mois')    // échéance extraite J+2 par le rattaché, J+200 par l'étranger
  await mail(4, 'Divulgation')      // seule une ligne `regle` (trieur)

  const author = e => ({ id: e.id, nom: e.name })
  const write = (mid, e, tags) => store.writeTags({ accountId: ACCOUNT, messageId: mid, source: 'jev', auteur: author(e), modele: 'banc-1', tags })
  const LOUD = [{ question: 'urgence', valeur: 'aujourdhui' }, { question: 'fraude_paiement', valeur: 'oui' }, { question: 'menace_juridique', valeur: 'oui' }]
  await write(MID(1), attached, [{ question: 'urgence', valeur: 'aucune' }, { question: 'automatique', valeur: 'oui' }])
  await new Promise(r => setTimeout(r, 20))
  await write(MID(1), foreign, LOUD)

  await write(MID(2), attached, [{ question: 'urgence', valeur: 'aujourdhui' }])
  await new Promise(r => setTimeout(r, 20))
  await store.writeTags({ accountId: ACCOUNT, messageId: MID(2), source: HUMAN_SOURCE, auteur: { id: USER, nom: 'banc' }, validePar: USER, tags: [{ question: 'urgence', valeur: 'aucune' }] })

  const iso = d => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
  await store.writeFields({ accountId: ACCOUNT, messageId: MID(3), source: 'jev', auteur: author(attached), modele: 'banc-1', fields: [{ champ: 'echeance', valeur: iso(2) }] })
  await new Promise(r => setTimeout(r, 20))
  await store.writeFields({ accountId: ACCOUNT, messageId: MID(3), source: 'jev', auteur: author(foreign), modele: 'banc-1', fields: [{ champ: 'echeance', valeur: iso(200) }] })

  await store.writeTags({ accountId: ACCOUNT, messageId: MID(4), source: RULE_SOURCE, auteur: { id: 'iban', nom: 'iban' }, tags: [{ question: 'iban', valeur: 'oui' }] })

  const items = await focus.getFocusItems(USER, ACCOUNT, 10)
  const byMid = Object.fromEntries(items.map(i => [i.messageId, i]))
  const tagPart = (item, q) => item?.parts.find(p => p.kind === 'tag' && p.question === q)

  // A. le moteur étranger ne pèse pas
  check('A1 mail 1 : les « oui » du moteur étranger ne remontent pas (pas dans « à traiter »)', !byMid[MID(1)], `score=${byMid[MID(1)]?.score} parts=${JSON.stringify(byMid[MID(1)]?.parts)}`)
  const [m1] = await focus.withPriority([{ messageId: MID(1), subject: 'Bonjour', from: { address: 'client@exemple.invalid' }, isStarred: false, hasAttachments: false, date: new Date().toISOString() }], ACCOUNT, USER)
  check('A2 withPriority : mail 1 pèse les étiquettes du rattaché (automatique -3), aucune de l\'étranger', m1.priority.score === -3 && !tagPart(m1.priority, 'fraude_paiement'), JSON.stringify(m1.priority))

  // B. humain et trieur pèsent toujours
  check('B1 mail 2 : la correction humaine (urgence aucune) l\'emporte sur le rattaché', !byMid[MID(2)], JSON.stringify(byMid[MID(2)]))
  const [m4] = await focus.withPriority([{ messageId: MID(4), subject: 'Divulgation', from: { address: 'x@exemple.invalid' }, isStarred: false, hasAttachments: false, date: new Date().toISOString() }], ACCOUNT, USER)
  const trusted = await store.readEffectiveFor(ACCOUNT, [MID(4)], { trusted: true })
  check('B2 une ligne du trieur (regle) est une origine de confiance', trusted.get(MID(4))?.[0]?.source === RULE_SOURCE && m4.priority.score === 0, JSON.stringify(trusted.get(MID(4))))

  // C. l'affichage garde la règle « la plus récente »
  const shown = (await store.readEffectiveFor(ACCOUNT, [MID(1)])).get(MID(1)) ?? []
  check('C1 l\'affichage montre la ligne la plus récente (moteur étranger), règle GOAL.md inchangée', shown.find(t => t.question === 'urgence')?.auteurId === foreign.id, JSON.stringify(shown.map(t => `${t.question}=${t.valeur}@${t.auteurNom}`)))

  // D. l'échéance extraite du rattaché pèse ; celle de l'étranger non
  const ech = byMid[MID(3)]?.parts.find(p => p.kind === 'reason' && p.reason === 'echeance')
  check('D1 mail 3 : part « échéance extraite » +6 (J+2 du rattaché, pas J+200 de l\'étranger)', ech?.points === 6 && byMid[MID(3)]?.reason === 'echeance', JSON.stringify(byMid[MID(3)]))
} finally {
  await query('DELETE FROM users WHERE id = $1', [USER]).catch(() => {})
  const { default: pool } = await import('../lib/db.ts')
  await pool.end().catch(() => {})
}

console.log(`check-focus-origin${NEGATIVE ? ' --negative' : ''}: ${ok} ok, ${failures.length} FAIL`)
if (NEGATIVE) {
  const expected = ['A1', 'A2', 'D1']
  const fell = expected.filter(id => failures.some(f => f.startsWith(id)))
  if (fell.length === expected.length && failures.length === expected.length) { console.log(`contrôle négatif : ${fell.join(', ')} tombés, comme attendu`); process.exit(0) }
  console.error(`CONTRÔLE NÉGATIF : attendu ${expected.join(', ')} rouges et rien d'autre, obtenu ${failures.join(', ') || 'rien'}`); process.exit(1)
}
process.exit(failures.length ? 1 : 0)
