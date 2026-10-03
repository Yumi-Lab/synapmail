#!/usr/bin/env node
/**
 * Banc du lot T14 : l'audit aléatoire tire ce qu'il doit, et la fiabilité ne se mesure QUE sur lui.
 *
 * Banc DB. Il crée SA boîte (hôte `.invalid`, jamais joignable) sur la base de la lane, y écrit
 * des étiquettes à la main, et supprime la boîte dans son `finally` (tout part en cascade :
 * étiquettes, tirage, positions). Aucun réseau, aucune connexion IMAP, aucun appel moteur.
 *
 *   node --experimental-strip-types scripts/check-tagging-audit.mjs
 *
 * CE QUI EST MESURÉ :
 *   K1. la cible : 2 % des mails étiquetés, au moins 50, jamais plus que la boîte ;
 *   K2. le tirage atteint la cible, ne tire que des mails étiquetés par un MOTEUR, et un second
 *       tirage n'ajoute rien (idempotent) ; quand la boîte grossit, il COMPLÈTE sans retirer ;
 *   K3. la file « à valider » rend les tirés non jugés, et chaque validation l'en retire ;
 *   K4. l'exactitude, les confusions et la courbe par confiance ne comptent que l'AUDIT : une
 *       validation faite hors tirage compte en « validations », jamais en exactitude ;
 *   K5. l'accord JEV / Yumi One se lit sur les mails que les DEUX ont étiquetés.
 */
import './alias-resolver.mjs'
import crypto from 'node:crypto'
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
const audit = await import('../lib/tagging/audit.ts')
const { DEFAULT_SET, valuesOf } = await import('../lib/tagging/questions.ts')

const pool = new pg.Pool({ connectionString: DB_URL })
const MID = n => `<banc-t14-${n}@exemple.invalid>`
const JEV = { id: '00000000-0000-4000-8000-0000000014a1', nom: 'JEV banc T14' }
const ONE = { id: '00000000-0000-4000-8000-0000000014b2', nom: 'One banc T14' }
let ACCOUNT = null

console.log('\nbanc de l’audit aléatoire et de la fiabilité\n')
await initDb()

try {
  const [owner] = await query('SELECT user_id FROM email_accounts ORDER BY created_at LIMIT 1')
  if (!owner) harness("la base de la lane n'a aucune boîte : rien à quoi rattacher des étiquettes")
  const USER = owner.user_id
  const tag = crypto.randomBytes(4).toString('hex')
  const [row] = await query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1,$2,$3,'imap.bench.invalid',993,true,'smtp.bench.invalid',587,false,$3,'bench-not-a-real-secret') RETURNING id`,
    [USER, `audit-bench-${tag}`, `auditbench-${tag}@bench.invalid`]
  )
  ACCOUNT = row.id
  const Q = 'categorie'
  const [V0, V1, V2] = valuesOf(DEFAULT_SET.questionById(Q))
  const N = 120

  // ---- K1. la cible ----
  check('K1 cible = 2 % des étiquetés, plancher 50, plafond la boîte',
    audit.auditTarget(N) === 50 && audit.auditTarget(10_000) === 200 && audit.auditTarget(30) === 30 && audit.auditTarget(0) === 0,
    `${audit.auditTarget(N)} ${audit.auditTarget(10_000)} ${audit.auditTarget(30)} ${audit.auditTarget(0)}`)

  // ---- K2. le tirage ----
  // 120 mails jugés par JEV (valeur V0, confiance croissante), les 40 premiers aussi par One
  // (One dit V0 sur les 30 premiers, V1 sur les 10 suivants). Un 121ᵉ mail n'a qu'une main.
  for (let i = 0; i < N; i++) {
    await store.writeTags({ accountId: ACCOUNT, messageId: MID(i), source: 'jev', auteur: JEV, modele: 'jev-banc',
      tags: [{ question: Q, valeur: V0, confiance: i / N }], position: { folder: 'INBOX', uid: 1000 + i, subject: `banc ${i}` } })
    if (i < 40) await store.writeTags({ accountId: ACCOUNT, messageId: MID(i), source: 'one', auteur: ONE, modele: 'one-banc',
      tags: [{ question: Q, valeur: i < 30 ? V0 : V1 }] })
  }
  await store.writeTags({ accountId: ACCOUNT, messageId: MID('humain-seul'), source: 'humain', auteur: { id: USER, nom: 'Banc' }, validePar: USER, tags: [{ question: Q, valeur: V0 }] })

  const before = await audit.auditStatus(ACCOUNT)
  const first = await audit.drawAudit(ACCOUNT)
  const again = await audit.drawAudit(ACCOUNT)
  const [{ n: offTarget }] = await query(
    `SELECT COUNT(*)::int AS n FROM tag_audits a WHERE a.account_id = $1
       AND NOT EXISTS (SELECT 1 FROM message_tags t WHERE t.account_id = $1 AND t.message_id = a.message_id AND t.source IN ('jev','one','autre'))`, [ACCOUNT])
  check('K2a le tirage atteint la cible depuis zéro, et un second tirage n’ajoute rien',
    before.tagged === N && before.drawn === 0 && first.added === 50 && first.drawn === 50 && again.added === 0 && again.drawn === 50,
    JSON.stringify({ before, first, again }))
  check('K2b seuls des mails étiquetés par un moteur sont tirés (le mail « humain seul » jamais)', offTarget === 0, `${offTarget} hors cible`)

  // ---- K3. la file à valider, et la validation qui la vide ----
  const pending = await audit.auditPending(ACCOUNT)
  check('K3a la file rend les 50 tirés, avec leur position', pending.total === 50 && pending.messages.length === 50 && pending.messages.every(m => m.folder === 'INBOX' && m.uid >= 1000),
    `${pending.total} / ${pending.messages.length} ${JSON.stringify(pending.messages[0])}`)
  // 10 validations sur l'audit, prises parmi les mails que SEUL JEV a jugés (i ≥ 40) : la
  // réponse « moteur » est sa ligne la plus récente, et sur les 40 premiers c'est celle de One
  // (sans confiance, parfois en désaccord) — les prendre rendrait la mesure aléatoire.
  // 7 d'accord (V0), 2 disent V1, 1 dit V2.
  const indexOf = m => Number(m.messageId.match(/banc-t14-(\d+)@/)?.[1] ?? -1)
  const judged = pending.messages.filter(m => indexOf(m) >= 40).slice(0, 10)
  if (judged.length < 10) harness(`tirage trop pauvre en mails « JEV seul » : ${judged.length}`)
  for (const [k, m] of judged.entries()) {
    const valeur = k < 7 ? V0 : k < 9 ? V1 : V2
    await store.writeTags({ accountId: ACCOUNT, messageId: m.messageId, source: 'humain', auteur: { id: USER, nom: 'Banc' }, validePar: USER, tags: [{ question: Q, valeur }] })
  }
  // Et 5 validations HORS audit (des mails non tirés), toutes en désaccord : elles ne doivent pas peser.
  const drawnIds = new Set(pending.messages.map(m => m.messageId))
  const notDrawn = Array.from({ length: N }, (_, i) => MID(i)).filter(id => !drawnIds.has(id)).slice(0, 5)
  for (const id of notDrawn) {
    await store.writeTags({ accountId: ACCOUNT, messageId: id, source: 'humain', auteur: { id: USER, nom: 'Banc' }, validePar: USER, tags: [{ question: Q, valeur: V2 }] })
  }
  const after = await audit.auditPending(ACCOUNT)
  const status = await audit.auditStatus(ACCOUNT)
  check('K3b chaque validation retire le mail de la file ; l’état compte les validés du tirage seulement',
    after.total === 40 && status.validated === 10 && status.drawn === 50, JSON.stringify({ pending: after.total, status }))

  // ---- K4. l'exactitude sur l'audit SEULEMENT ----
  const table = await audit.reliability(ACCOUNT)
  const r = table.find(x => x.question === Q)
  check('K4a validations = toutes les mains (16), exactitude = l’audit seul (7/10)',
    r && r.humanCount === 16 && r.audit.judged === 10 && r.audit.correct === 7, JSON.stringify(r && { humanCount: r.humanCount, audit: r.audit }))
  check('K4b les confusions les plus fréquentes, moteur → humain, dans l’ordre',
    r && r.confusions.length === 2 && r.confusions[0].moteur === V0 && r.confusions[0].humain === V1 && r.confusions[0].count === 2
      && r.confusions[1].humain === V2 && r.confusions[1].count === 1, JSON.stringify(r?.confusions))
  const bucketSum = r ? r.byConfidence.reduce((n, b) => n + b.judged, 0) : -1
  const bucketCorrect = r ? r.byConfidence.reduce((n, b) => n + b.correct, 0) : -1
  check('K4c la courbe par tranche de confiance totalise exactement les jugés de l’audit, tranches de 0,1 décroissantes',
    bucketSum === 10 && bucketCorrect === 7 && r.byConfidence.every((b, i, a) => Number.isInteger(b.bucket * 10) && b.bucket >= 0 && b.bucket <= 0.9 && (i === 0 || a[i - 1].bucket > b.bucket)),
    JSON.stringify(r?.byConfidence))

  // ---- K5. l'accord entre moteurs ----
  check('K5 accord JEV / One sur les 40 mails que les deux ont jugés : 30 d’accord',
    r && r.engineAgreement && r.engineAgreement.both === 40 && r.engineAgreement.agree === 30, JSON.stringify(r?.engineAgreement))

  // ---- K2c. la boîte grossit : le tirage complète, sans retirer ----
  await query(
    `INSERT INTO message_tags (account_id, message_id, question, valeur, source, modele, auteur_id, auteur_nom, question_version, taxonomy_version)
     SELECT $1, '<banc-t14-plus-' || g || '@exemple.invalid>', $2, $3, 'jev', 'jev-banc', $4, $5, t.question_version, t.taxonomy_version
       FROM generate_series(1, 2480) g, (SELECT question_version, taxonomy_version FROM message_tags WHERE account_id = $1 AND source = 'jev' LIMIT 1) t`,
    [ACCOUNT, Q, V0, JEV.id, JEV.nom])
  const grown = await audit.drawAudit(ACCOUNT)
  const [{ n: kept }] = await query(`SELECT COUNT(*)::int AS n FROM tag_audits WHERE account_id = $1 AND message_id = ANY($2::text[])`, [ACCOUNT, Array.from(drawnIds)])
  check('K2c à 2 600 étiquetés la cible passe à 52 : 2 tirés de plus, les 50 premiers gardés',
    grown.tagged === 2600 && grown.target === 52 && grown.added === 2 && grown.drawn === 52 && kept === 50, JSON.stringify({ grown, kept }))
} finally {
  if (ACCOUNT) await pool.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]).catch(() => {})
  await pool.query("DELETE FROM email_accounts WHERE email LIKE 'auditbench-%@bench.invalid'").catch(() => {})
  await pool.end()
}

if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\naudit aléatoire : OK')
