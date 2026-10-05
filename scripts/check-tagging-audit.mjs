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
 *   K5. l'accord JEV / Yumi One se lit sur les mails que les DEUX ont étiquetés ;
 *   K6. la file « À valider » au clavier (lot T15, décision 17) : une ligne par (mail, question)
 *       par l'une des trois portes (audit, désaccord, confiance sous le seuil de la question),
 *       jamais une étiquette déjà jugée par une main ni une version périmée ; l'audit d'abord ;
 *       un seuil réglé par question déplace la porte « confiance » ; une validation la vide ;
 *   K7. « défaire » (gate T15, bloquant 2) : `removeHumanTag` SUPPRIME la ligne `humain` de cette
 *       main sur cette question, l'item revient dans la file, les lignes des moteurs et celles
 *       d'une autre main restent ; une main qui n'a rien écrit ne retire rien.
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
const { CONFIDENCE_THRESHOLD_DEFAULT, DEFAULT_SET, questionSet, valuesOf } = await import('../lib/tagging/questions.ts')

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
  const queueBefore = await audit.auditPending(ACCOUNT)
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
  check('K3a′ une file vide dit si c’est faute de tirage (drawn 0) ou parce que tout est jugé (drawn 50)',
    queueBefore.total === 0 && queueBefore.drawn === 0 && pending.drawn === 50, JSON.stringify({ before: queueBefore.drawn, after: pending.drawn }))
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
    after.total === 40 && after.drawn === 50 && status.validated === 10 && status.drawn === 50, JSON.stringify({ pending: after.total, drawn: after.drawn, status }))

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

  // ---- K2d. une ANCIENNE version de la question ne se mesure pas : ni tirée, ni comptée ----
  // 300 mails étiquetés par JEV sous une version périmée de `categorie` (ce que laisse une
  // consigne modifiée après un tri) : l'état les annonce « à retaguer », la cible les ignore,
  // et un tirage n'en prend aucun — sinon on ferait valider des mails que `reliability` ne
  // comparera jamais (gate T14, point 2).
  await query(
    `INSERT INTO message_tags (account_id, message_id, question, valeur, source, modele, auteur_id, auteur_nom, question_version, taxonomy_version)
     SELECT $1, '<banc-t14-stale-' || g || '@exemple.invalid>', $2, $3, 'jev', 'jev-banc', $4, $5, 'perimee00000', t.taxonomy_version
       FROM generate_series(1, 300) g, (SELECT taxonomy_version FROM message_tags WHERE account_id = $1 AND source = 'jev' LIMIT 1) t`,
    [ACCOUNT, Q, V0, JEV.id, JEV.nom])
  const withStale = await audit.drawAudit(ACCOUNT)
  const [{ n: staleDrawn }] = await query(`SELECT COUNT(*)::int AS n FROM tag_audits WHERE account_id = $1 AND message_id LIKE '<banc-t14-stale-%'`, [ACCOUNT])
  check('K2d 300 mails sous une ancienne version : comptés « à retaguer », hors cible, jamais tirés',
    withStale.tagged === 2600 && withStale.stale === 300 && withStale.target === 52 && withStale.added === 0 && staleDrawn === 0,
    JSON.stringify({ withStale, staleDrawn }))

  // ---- K6. la file « À valider » (lot T15) ----
  // L'oracle : la même règle écrite à plat en SQL sur l'état courant de la boîte — tirés d'abord.
  // Attendu : audit = 52 tirés − 10 jugés = 42 (fixe) ; désaccord = les mails 30-39 que le tirage
  // n'a pas pris ; confiance = les mails 40-89 (i/120 < 0,75) ni tirés ni jugés — ces deux-là
  // dépendent du tirage (aléatoire), donc l'oracle les recompte à chaque passage.
  const oracle = async threshold => (await query(
    `WITH last AS (
       SELECT DISTINCT ON (message_id, auteur_id) message_id, valeur, confiance, cree_le FROM message_tags
        WHERE account_id = $1 AND question = $2 AND source IN ('jev','one') AND question_version <> 'perimee00000'
        ORDER BY message_id, auteur_id, cree_le DESC),
     agg AS (SELECT message_id, COUNT(DISTINCT valeur) AS nv, (array_agg(confiance ORDER BY cree_le DESC))[1] AS conf FROM last GROUP BY message_id),
     due AS (SELECT a.*, EXISTS (SELECT 1 FROM tag_audits x WHERE x.account_id = $1 AND x.message_id = a.message_id) AS audited FROM agg a
              WHERE NOT EXISTS (SELECT 1 FROM message_tags h WHERE h.account_id = $1 AND h.message_id = a.message_id AND h.question = $2 AND h.source = 'humain'))
     SELECT COUNT(*) FILTER (WHERE audited)::int AS audit,
            COUNT(*) FILTER (WHERE NOT audited AND nv > 1)::int AS disagreement,
            COUNT(*) FILTER (WHERE NOT audited AND nv = 1 AND conf < $3)::int AS confidence
       FROM due`, [ACCOUNT, Q, threshold]))[0]
  const want = await oracle(CONFIDENCE_THRESHOLD_DEFAULT)
  const q1 = await audit.validationQueue(ACCOUNT, 1, 200)
  const all = []
  for (let page = 1; ; page++) { const p = await audit.validationQueue(ACCOUNT, page, 200); all.push(...p.items); if (!p.items.length || all.length >= p.total) break }
  check('K6a la file compte exactement l’oracle : audit 42, désaccord ≤ 10 (> 0), confiance ≤ 50 (> 0)',
    want.audit === 42 && want.disagreement > 0 && want.disagreement <= 10 && want.confidence > 0 && want.confidence <= 50
      && q1.counts.audit === want.audit && q1.counts.disagreement === want.disagreement && q1.counts.confidence === want.confidence
      && q1.total === want.audit + want.disagreement + want.confidence && all.length === q1.total,
    JSON.stringify({ want, got: q1.counts, total: q1.total, fetched: all.length }))
  const firstNonAudit = all.findIndex(i => i.reason !== 'audit')
  check('K6b l’audit vient en tête, puis le reste ; aucune ligne jugée, périmée ou « humain seul »',
    all.slice(0, want.audit).every(i => i.reason === 'audit') && (firstNonAudit === -1 || firstNonAudit === want.audit)
      && !all.some(i => /stale-|humain-seul/.test(i.messageId)) && !all.some(i => drawnIds.has(i.messageId) && judged.some(j => j.messageId === i.messageId)),
    JSON.stringify({ firstNonAudit, want: want.audit, sample: all.slice(0, 3).map(i => [i.messageId, i.reason, i.valeur, i.confiance]) }))
  const disagree = all.filter(i => i.reason === 'disagreement')
  check('K6c un désaccord porte les deux valeurs, la proposition est la ligne la plus récente (One, sans confiance)',
    disagree.length === want.disagreement && disagree.every(i => i.valeurs.length === 2 && i.valeurs.includes(V0) && i.valeurs.includes(V1) && i.valeur === V1 && i.confiance === null),
    JSON.stringify(disagree.slice(0, 2)))
  // Un seuil réglé sur la question (0,5) : la porte « confiance » se referme sur i/120 < 0,5.
  const custom = questionSet(DEFAULT_SET.all.map(q => q.id === Q ? { ...q, confidenceThreshold: 0.5 } : q))
  const wantLow = await oracle(0.5)
  const low = await audit.validationQueue(ACCOUNT, 1, 1, custom)
  check('K6d le seuil par question déplace la porte « confiance » (0,5 → moins de lignes), audit et désaccord inchangés',
    wantLow.confidence < want.confidence && low.counts.confidence === wantLow.confidence && low.counts.audit === want.audit && low.counts.disagreement === want.disagreement,
    JSON.stringify({ wantLow, got: low.counts }))
  // Une validation (ce que fait `Entrée`) retire la ligne : même route d'écriture que le panneau.
  const target = all.find(i => i.reason === 'confidence')
  await store.writeTags({ accountId: ACCOUNT, messageId: target.messageId, source: 'humain', auteur: { id: USER, nom: 'Banc' }, validePar: USER, tags: [{ question: Q, valeur: target.valeur }] })
  const afterOne = await audit.validationQueue(ACCOUNT, 1, 1)
  check('K6e une ligne `humain` écrite retire l’item de la file (total − 1, confiance − 1)',
    afterOne.total === q1.total - 1 && afterOne.counts.confidence === want.confidence - 1, JSON.stringify({ before: q1.total, after: afterOne.total, counts: afterOne.counts }))

  // ---- K7. « défaire » ----
  // Une AUTRE main a aussi jugé un second item : la défaite de la première ne doit pas l'emporter.
  const OTHER = '00000000-0000-4000-8000-0000000015c3'
  const second = all.find(i => i.reason === 'confidence' && i.messageId !== target.messageId)
  await store.writeTags({ accountId: ACCOUNT, messageId: second.messageId, source: 'humain', auteur: { id: USER, nom: 'Banc' }, validePar: USER, tags: [{ question: Q, valeur: second.valeur }] })
  await store.writeTags({ accountId: ACCOUNT, messageId: second.messageId, source: 'humain', auteur: { id: OTHER, nom: 'Autre main' }, validePar: null, tags: [{ question: Q, valeur: second.valeur }] })
  const rowsOf = mid => query(`SELECT source, auteur_id FROM message_tags WHERE account_id = $1 AND message_id = $2 AND question = $3 ORDER BY source, auteur_id`, [ACCOUNT, mid, Q])
  const engineRowsBefore = (await rowsOf(target.messageId)).filter(r => r.source !== 'humain').length
  const removed = await store.removeHumanTag(ACCOUNT, target.messageId, Q, USER)
  const afterUndo = await audit.validationQueue(ACCOUNT, 1, 200)
  const targetRows = await rowsOf(target.messageId)
  check('K7a défaire retire exactement la ligne `humain` de cette main ; les lignes des moteurs restent ; l’item revient dans la file',
    removed === 1 && !targetRows.some(r => r.source === 'humain') && targetRows.length === engineRowsBefore && engineRowsBefore > 0
      && afterUndo.items.some(i => i.messageId === target.messageId) && afterUndo.total === afterOne.total,
    JSON.stringify({ removed, targetRows, engineRowsBefore, back: afterUndo.items.some(i => i.messageId === target.messageId), total: [afterOne.total, afterUndo.total] }))
  const removedSecond = await store.removeHumanTag(ACCOUNT, second.messageId, Q, USER)
  const secondRows = await rowsOf(second.messageId)
  const afterSecond = await audit.validationQueue(ACCOUNT, 1, 200)
  check('K7b défaire ne touche pas la ligne d’une AUTRE main : elle reste, et l’item reste hors de la file',
    removedSecond === 1 && secondRows.filter(r => r.source === 'humain').length === 1 && secondRows.some(r => r.source === 'humain' && r.auteur_id === OTHER)
      && !afterSecond.items.some(i => i.messageId === second.messageId),
    JSON.stringify({ removedSecond, secondRows }))
  const removedNothing = await store.removeHumanTag(ACCOUNT, target.messageId, Q, USER)
  check('K7c une main qui n’a rien écrit ne retire rien (0), et rien ne bouge', removedNothing === 0 && (await rowsOf(target.messageId)).length === engineRowsBefore, String(removedNothing))
} finally {
  if (ACCOUNT) await pool.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]).catch(() => {})
  await pool.query("DELETE FROM email_accounts WHERE email LIKE 'auditbench-%@bench.invalid'").catch(() => {})
  await pool.end()
}

if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\naudit aléatoire : OK')
