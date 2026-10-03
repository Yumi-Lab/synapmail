#!/usr/bin/env node
/**
 * Bench for P2 — defects #1 and #6, both in `lib/db.ts` migrations.
 *
 *   node --no-warnings scripts/check-db-fresh.mjs
 *   node --no-warnings scripts/check-db-fresh.mjs --negative
 *
 * WHAT IS MEASURED, against databases `initDb()` has NEVER touched before:
 *   1a/1b (defect #1). `initDb()` does not throw on an EMPTY database, and
 *      `ai_settings.translate_mode` exists afterwards — the old file order ran the
 *      ALTER on that column before the CREATE TABLE for `ai_settings` itself, which
 *      throws on a database where the table has never existed. A second call is
 *      also checked for idempotence (every boot calls initDb() again).
 *   6b/6c/6d (defect #6). The `api_key_accounts` backfill covers a mailbox reached
 *      only through an ACTIVE, non-expired `account_shares` row — not just owned
 *      mailboxes — while a REVOKED or EXPIRED share is correctly left un-backfilled.
 *   G1-G9 (lane `courrier`, lot G2). The five `ged_*` tables exist after initDb() on
 *      an empty database, with their constraints LIVE: one PDF = one document (unique
 *      attachment key), the French tsvector is generated and searched through the GIN
 *      index, two sibling folders cannot share a name (root included), a filing
 *      outside the `lib/ged/model.ts` vocabulary is refused, the effective filing is
 *      "human first, then most recent" (the `message_tags` rule), a pattern value is
 *      unique per folder, and deleting a mailbox cascades through every ged_* row.
 *
 * Each defect runs in its OWN disposable database, so defect #1's early throw
 * (which would otherwise abort the rest of the schema) never blocks defect #6's
 * fixture.
 *
 * NEGATIVE CONTROL (`--negative`): the exact SAME checks (1a and 6b) run against
 * the OLD buggy SQL shapes instead of the current `lib/db.ts` — an ALTER issued
 * before its table's CREATE, and a backfill query joined only through owned
 * mailboxes. Both must turn red: that is what proves the checks measure the
 * defects themselves, not an artifact of the fixture. For the GED section the
 * constraints under test are DROPPED first (G2, G4, G5, G8) and the effective-filing
 * query is run with the naive "most recent" order (G7): those must turn red too.
 *
 * SAFETY: everything runs against disposable `synapmail_fresh_<pid>_*` databases,
 * created on the SAME server as `DATABASE_URL` (an admin connection swaps only the
 * db name for `postgres`) and DROPped in `finally`. The lane's real database
 * (`synapmail_pr30`) is never opened by this script.
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

const { DATABASE_URL: BASE_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')

/** The bench could not measure anything: it concludes NOTHING about the product. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
if (!BASE_URL) harness("DATABASE_URL is not set")

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

/**
 * `lib/db.ts` builds its own connection pool from `process.env.DATABASE_URL` ONCE,
 * at module evaluation — a second `import('../lib/db.ts')` in the same process
 * returns the SAME cached module, still pointed at the first fresh database. A
 * `?fresh=<tag>` query string makes each database its own module specifier, so
 * `lib/db.ts` (and everything it imports) re-evaluates against the right pool.
 */
/** Runs `fn(query, importDb)` against a fresh, disposable `synapmail_fresh_<pid>_<tag>` database. */
async function withFreshDb(tag, fn) {
  const dbName = `synapmail_fresh_${process.pid}_${tag}`
  const adminUrl = new URL(BASE_URL)
  adminUrl.pathname = '/postgres'
  const freshUrl = new URL(BASE_URL)
  freshUrl.pathname = `/${dbName}`

  // `DROP DATABASE ... WITH (FORCE)` kills every backend on this database, including
  // idle pooled connections mid-teardown — pg's Pool surfaces that as an async
  // 'error' event (not a rejected promise), which crashes the process unhandled.
  // A no-op listener is the documented way to catch it: an idle-client error is
  // never actionable, the pool has already dropped that client.
  const swallowIdleErrors = pool => pool.on('error', () => {})

  const admin = new pg.Pool({ connectionString: adminUrl.toString() })
  const target = new pg.Pool({ connectionString: freshUrl.toString() })
  swallowIdleErrors(admin)
  swallowIdleErrors(target)
  let dbModulePool = null
  const importDb = async () => {
    const mod = await import(`../lib/db.ts?fresh=${dbName}`)
    dbModulePool = mod.default
    swallowIdleErrors(dbModulePool)
    return mod
  }
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    process.env.DATABASE_URL = freshUrl.toString()
    const query = async (sql, values) => (await target.query(sql, values)).rows
    await fn(query, importDb)
  } finally {
    // Must close BEFORE the DROP, or the server killing a pool's connections
    // fires an unhandled 'error' event on it and crashes the process.
    try { await dbModulePool?.end() } catch { /* never opened or already closed */ }
    try { await target.end() } catch { /* already closed */ }
    try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`) } catch (e) { console.error(`WARN: could not drop ${dbName}: ${e.message}`) }
    await admin.end()
  }
}

const insertAccount = (query, ownerId, label) => query(`
    INSERT INTO email_accounts (user_id, name, email, imap_host, smtp_host, username, password_encrypted)
    VALUES ($1, $2, $3, 'imap.bench.invalid', 'smtp.bench.invalid', $3, 'bench-not-a-real-secret')
    RETURNING id
  `, [ownerId, `bench-${label}`, `bench-${label}@bench.invalid`]).then(r => r[0])

// ---------------------------------------------------------------------------
// Defect #1 — initDb() on an empty database
// ---------------------------------------------------------------------------
await withFreshDb('defect1', async (query, importDb) => {
  let threw = false
  if (NEGATIVE) {
    // The OLD file order: this ALTER ran before `ai_settings` had ever been
    // created — on an empty database that throws (relation does not exist).
    try {
      await query(`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS translate_mode VARCHAR(20) NOT NULL DEFAULT 'quick'`)
    } catch { threw = true }
  } else {
    const { initDb } = await importDb()
    await initDb()
  }

  const col = await query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'ai_settings' AND column_name = 'translate_mode'
  `)
  check('1a ai_settings.translate_mode exists after initDb() on an empty database',
    !threw && col.length === 1, threw ? 'the migration threw before creating any table' : `${col.length} column(s) found`)

  if (!NEGATIVE) {
    // Idempotence: every boot calls initDb() again.
    const { initDb } = await importDb()
    let secondThrew = false
    try { await initDb() } catch { secondThrew = true }
    check('1b a second initDb() call does not throw (migrations are idempotent)', !secondThrew)
  }
})

// ---------------------------------------------------------------------------
// Defect #6 — api_key_accounts backfill must cover ACTIVE shared mailboxes
// ---------------------------------------------------------------------------
await withFreshDb('defect6', async (query, importDb) => {
  const { initDb } = await importDb()
  await initDb() // brings up the full schema so the fixture below has tables to use

  // User A owns account X; user B only ever holds shares to it.
  const ownerA = (await query(`INSERT INTO users (email, name, password_hash) VALUES ('a@bench.invalid', 'a', 'h') RETURNING id`))[0]
  const userB = (await query(`INSERT INTO users (email, name, password_hash) VALUES ('b@bench.invalid', 'b', 'h') RETURNING id`))[0]

  const accountX = await insertAccount(query, ownerA.id, 'active-share')
  await query(`
    INSERT INTO account_shares (account_id, invited_by, invitee_user_id, status, accepted_at)
    VALUES ($1, $2, $3, 'active', NOW())
  `, [accountX.id, ownerA.id, userB.id])

  // A REVOKED share on a second mailbox — must NOT be backfilled.
  const accountY = await insertAccount(query, ownerA.id, 'revoked-share')
  await query(`
    INSERT INTO account_shares (account_id, invited_by, invitee_user_id, status, accepted_at, revoked_at)
    VALUES ($1, $2, $3, 'revoked', NOW(), NOW())
  `, [accountY.id, ownerA.id, userB.id])

  // An EXPIRED share on a third mailbox — must NOT be backfilled either.
  const accountZ = await insertAccount(query, ownerA.id, 'expired-share')
  await query(`
    INSERT INTO account_shares (account_id, invited_by, invitee_user_id, status, accepted_at, expires_at)
    VALUES ($1, $2, $3, 'active', NOW(), NOW() - INTERVAL '1 day')
  `, [accountZ.id, ownerA.id, userB.id])

  // B's key is created AFTER initDb() already ran once, so `accounts_migrated_at`
  // is NULL and no `api_key_accounts` row exists yet — the pre-migration state.
  const keyB = (await query(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'b key', 'bench-pos-1', 'h') RETURNING id`, [userB.id]))[0]

  if (NEGATIVE) {
    // The OLD backfill — joined through owned mailboxes only, no account_shares.
    await query(`
      INSERT INTO api_key_accounts (api_key_id, account_id)
      SELECT ak.id, a.id FROM api_keys ak
        JOIN email_accounts a ON a.user_id = ak.user_id
       WHERE ak.id = $1
      ON CONFLICT DO NOTHING
    `, [keyB.id])
  } else {
    // Re-running the real initDb() is what performs the fixed backfill for keyB.
    const { initDb: initDbAgain } = await importDb()
    await initDbAgain()
  }

  const gotX = await query(`SELECT COUNT(*)::int AS n FROM api_key_accounts WHERE api_key_id = $1 AND account_id = $2`, [keyB.id, accountX.id])
  check('6b backfill covers the ACTIVE shared mailbox (key B -> account X)',
    gotX[0].n === 1, `${gotX[0].n} row(s)`)

  const gotY = await query(`SELECT COUNT(*)::int AS n FROM api_key_accounts WHERE api_key_id = $1 AND account_id = $2`, [keyB.id, accountY.id])
  check('6c a REVOKED share is not backfilled',
    gotY[0].n === 0, `${gotY[0].n} row(s)`)

  const gotZ = await query(`SELECT COUNT(*)::int AS n FROM api_key_accounts WHERE api_key_id = $1 AND account_id = $2`, [keyB.id, accountZ.id])
  check('6d an EXPIRED share is not backfilled',
    gotZ[0].n === 0, `${gotZ[0].n} row(s)`)
})

// ---------------------------------------------------------------------------
// Lot G2 — the ged_* tables on an empty database
// ---------------------------------------------------------------------------
await withFreshDb('ged', async (query, importDb) => {
  const { initDb } = await importDb()
  await initDb()
  const { FILING_SOURCES, PATTERN_KINDS, OCR_STATUSES } = await import('../lib/ged/model.ts')
  const { HUMAN_SOURCE } = await import('../lib/tagging/engine.ts')

  const tables = (await query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'ged\\_%' ORDER BY 1`)).map(r => r.table_name)
  check('G1 the five ged_* tables exist after initDb() on an empty database',
    ['ged_documents', 'ged_filings', 'ged_folders', 'ged_mailboxes', 'ged_patterns'].every(t => tables.includes(t)), tables.join(','))

  const owner = (await query(`INSERT INTO users (email, name, password_hash) VALUES ('ged@bench.invalid', 'ged', 'h') RETURNING id`))[0]
  const account = await insertAccount(query, owner.id, 'ged')
  await query(`INSERT INTO ged_mailboxes (account_id) VALUES ($1)`, [account.id])

  /** A violated constraint rejects the statement: `null` when it went through. */
  const rejects = async (sql, values) => { try { await query(sql, values); return null } catch (e) { return e.code } }

  if (NEGATIVE) {
    await query(`ALTER TABLE ged_documents DROP CONSTRAINT ged_documents_account_id_message_id_part_idx_key`)
    await query(`ALTER TABLE ged_folders DROP CONSTRAINT ged_folders_account_id_parent_id_nom_key`)
    await query(`ALTER TABLE ged_filings DROP CONSTRAINT ged_filings_source_check`)
    await query(`ALTER TABLE ged_patterns DROP CONSTRAINT ged_patterns_folder_id_genre_valeur_key`)
  }

  // G2 — one PDF = one document: the attachment key (mail + part) is unique, the IMAP uid is not part of it.
  const insertDoc = (part, uid) => query(`
    INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, ocr_text)
    VALUES ($1, '<bench-1@bench.invalid>', 'INBOX', $3, $2, 'doc.pdf', $4) RETURNING id, ocr_status`,
    [account.id, part, uid, 'FACTURE N 48213 TOTAL 407,70 EUR SIRET 73282932000074 Lycée des factures impayées'])
  const doc = (await insertDoc(0, 7))[0]
  check('G2 the same attachment (mail + part) cannot become two documents, even under another uid',
    (await rejects(`INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx) VALUES ($1, '<bench-1@bench.invalid>', 'INBOX', 8, 0)`, [account.id])) === '23505')
  check('G3 a new document starts in the pending OCR state', OCR_STATUSES.includes(doc.ocr_status) && doc.ocr_status === 'attente', doc.ocr_status)

  // G4 — French tsvector, generated by the base, searched through the GIN index (stemmed: factures → factur).
  const hit = await query(`SELECT id FROM ged_documents WHERE texte_tsv @@ plainto_tsquery('french', $1)`, ['facture lycée'])
  const miss = await query(`SELECT id FROM ged_documents WHERE texte_tsv @@ plainto_tsquery('french', $1)`, ['bordereau'])
  const plan = (await query(`EXPLAIN SELECT id FROM ged_documents WHERE texte_tsv @@ plainto_tsquery('french', 'facture')`)).map(r => r['QUERY PLAN']).join('\n')
  const hasGin = (await query(`SELECT 1 FROM pg_indexes WHERE indexname = 'ged_documents_tsv_idx' AND indexdef ILIKE '%USING gin%'`)).length === 1
  const generated = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'ged_documents' AND column_name = 'texte_tsv' AND is_generated = 'ALWAYS'`)).length === 1
  check('G4 the French full-text search finds the document by stem and accent, through a generated column + GIN index',
    hit.length === 1 && hit[0].id === doc.id && miss.length === 0 && hasGin && generated,
    `hit=${hit.length} miss=${miss.length} gin=${hasGin} generated=${generated}\n       ${plan.split('\n')[0]}`)

  // G5 — folder tree: nested, and two siblings cannot share a name, at the root too.
  const root = (await query(`INSERT INTO ged_folders (account_id, nom) VALUES ($1, 'Fournisseurs') RETURNING id`, [account.id]))[0]
  const child = (await query(`INSERT INTO ged_folders (account_id, parent_id, nom) VALUES ($1, $2, 'FedEx') RETURNING id`, [account.id, root.id]))[0]
  const dupRoot = await rejects(`INSERT INTO ged_folders (account_id, nom) VALUES ($1, 'Fournisseurs')`, [account.id])
  const dupChild = await rejects(`INSERT INTO ged_folders (account_id, parent_id, nom) VALUES ($1, $2, 'FedEx')`, [account.id, root.id])
  const sameNameElsewhere = await rejects(`INSERT INTO ged_folders (account_id, parent_id, nom) VALUES ($1, $2, 'Fournisseurs')`, [account.id, child.id])
  check('G5 two sibling folders cannot share a name (root included); the same name under another parent is fine',
    dupRoot === '23505' && dupChild === '23505' && sameNameElsewhere === null, `root=${dupRoot} child=${dupChild} elsewhere=${sameNameElsewhere}`)

  // G6 — a filing outside the model vocabulary is refused; every listed source goes through.
  const badSource = await rejects(`INSERT INTO ged_filings (document_id, folder_id, source) VALUES ($1, $2, 'robot')`, [doc.id, root.id])
  let allOk = true
  for (const source of FILING_SOURCES) if (await rejects(`INSERT INTO ged_filings (document_id, folder_id, source, auteur_nom) VALUES ($1, $2, $3, $4)`, [doc.id, root.id, source, source])) allOk = false
  check(`G6 a filing source outside lib/ged/model.ts (${FILING_SOURCES.join('|')}) is refused by the base`, badSource === '23514' && allOk, `bad=${badSource} listed=${allOk}`)

  // G7 — effective filing = human first, then most recent (same rule as message_tags).
  await query(`DELETE FROM ged_filings WHERE document_id = $1`, [doc.id])
  await query(`INSERT INTO ged_filings (document_id, folder_id, source, cree_le) VALUES ($1, $2, 'motif', NOW() - INTERVAL '2 hour')`, [doc.id, child.id])
  await query(`INSERT INTO ged_filings (document_id, folder_id, source, cree_le) VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`, [doc.id, root.id, HUMAN_SOURCE])
  await query(`INSERT INTO ged_filings (document_id, folder_id, source, cree_le) VALUES ($1, $2, 'agent', NOW())`, [doc.id, child.id])
  const order = NEGATIVE ? 'cree_le DESC' : `(source = '${HUMAN_SOURCE}') DESC, cree_le DESC`
  const effective = (await query(`SELECT folder_id, source FROM ged_filings WHERE document_id = $1 ORDER BY ${order} LIMIT 1`, [doc.id]))[0]
  const history = await query(`SELECT COUNT(*)::int AS n FROM ged_filings WHERE document_id = $1`, [doc.id])
  check('G7 the effective filing is the human one even when an agent filed later; the history keeps all three rows',
    effective.folder_id === root.id && effective.source === HUMAN_SOURCE && history[0].n === 3, `effective=${effective.source} rows=${history[0].n}`)

  // G8 — patterns: a value is unique per folder, may point to two folders (the "doubt" case), kinds are closed.
  await query(`INSERT INTO ged_patterns (folder_id, genre, valeur, appris_de) VALUES ($1, 'siret', '73282932000074', $2)`, [child.id, doc.id])
  const dupPattern = await rejects(`INSERT INTO ged_patterns (folder_id, genre, valeur) VALUES ($1, 'siret', '73282932000074')`, [child.id])
  const twoFolders = await rejects(`INSERT INTO ged_patterns (folder_id, genre, valeur) VALUES ($1, 'siret', '73282932000074')`, [root.id])
  const badKind = await rejects(`INSERT INTO ged_patterns (folder_id, genre, valeur) VALUES ($1, 'iban', 'FR76')`, [root.id])
  check(`G8 a pattern value is unique per folder, may point to two folders, and its kind is closed (${PATTERN_KINDS.join('|')})`,
    dupPattern === '23505' && twoFolders === null && badKind === '23514', `dup=${dupPattern} two=${twoFolders} kind=${badKind}`)

  // G9 — deleting the mailbox takes every ged_* row with it (no orphan, no FK error).
  await query(`DELETE FROM email_accounts WHERE id = $1`, [account.id])
  const left = (await query(`
    SELECT (SELECT COUNT(*) FROM ged_mailboxes) + (SELECT COUNT(*) FROM ged_documents) + (SELECT COUNT(*) FROM ged_folders)
         + (SELECT COUNT(*) FROM ged_filings) + (SELECT COUNT(*) FROM ged_patterns) AS n`))[0].n
  check('G9 deleting the mailbox cascades through documents, folders, filings and patterns', Number(left) === 0, `${left} row(s) left`)
})

if (NEGATIVE) {
  if (failures.length) { console.log(`\nnegative control: ${failures.length} failure(s), as expected`); process.exit(0) }
  console.error('\nNEGATIVE CONTROL SILENT: stayed green — it measures nothing')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nfresh database (defects #1 / #6, GED tables): OK')
