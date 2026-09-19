#!/usr/bin/env node
/**
 * Lot S5, second half — SONDE, pas un gate. `probe-search-body.mjs` established
 * that this server answers `NO full text search not supported` to BODY and TEXT,
 * so searching bodies can only mean a LOCAL index. This script SIZES that index
 * so Nicolas decides on numbers. It BUILDS NOTHING that survives it: read only on
 * IMAP, and on PostgreSQL it creates one TEMPORARY table that dies with the
 * connection — no production table, no route, no migration. It never prints a
 * body, an address or a password.
 *
 *  A. HOW MANY. Messages across the test mailboxes, from the product's own cache
 *     plus the real folder counts, so the index size is grounded in real volume.
 *  B. HOW BIG. A sample of messages is FETCHed and reduced to the text an index
 *     would actually store (plain text, HTML stripped, capped). The measurement
 *     is the DISTRIBUTION, not just the mean: a mean hides the long tail that
 *     decides the cap.
 *  C. HOW LONG. The observed FETCH throughput, which is what an initial indexing
 *     run is bounded by — not the database write.
 *  D. HOW FAST TO SEARCH. A TEMPORARY table filled with synthetic rows of the
 *     SAME measured shape and volume, with the native `tsvector` + GIN index, and
 *     a query timed on it. SAME-RUN REFERENCE: the same query on the same table
 *     WITHOUT the index, so the number attributes the speed to the index rather
 *     than to the machine being fast.
 *
 *   node --experimental-strip-types scripts/probe-body-index.mjs
 */
import { openTestMailbox, harness } from './bench-imap.mjs'

const { client, config, pool, close } = await openTestMailbox()

// Messages FETCHed in arm B. Lot S5 asks for 200; it is also the point past
// which the mean stopped moving on the test mailbox.
const SAMPLE_SIZE = 200
// The cap an index would apply to one message. Measured in arm B against the
// distribution: what fraction of messages it truncates is an OUTPUT here, not an
// assumption. ponytail: one constant, moved to lib/ only if a lot ever builds this.
const TEXT_CAP_BYTES = 16 * 1024
// Synthetic rows in arm D: enough that a sequential scan is visibly slower than
// an index lookup, few enough to build in seconds.
const SYNTHETIC_ROWS = 200000

const say = (label, value) => console.log(`  ${label}: ${value}`)
const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

/** The text an index would store: plain part, else HTML stripped, capped. */
function indexableText(plain, html) {
  const text = plain || String(html ?? '').replace(/<[^>]*>/g, ' ')
  return Buffer.from(text.replace(/\s+/g, ' ').trim(), 'utf8').subarray(0, TEXT_CAP_BYTES)
}

try {
  console.log(`server: ${config.imapHost}:${config.imapPort}`)

  console.log('\nA. how many messages an index would have to hold')
  const { rows: cached } = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT account_id)::int AS accounts FROM messages_cache`
  )
  say('already in the product cache', `${cached[0].n} message(s) over ${cached[0].accounts} mailbox(es)`)
  const list = await client.list({ statusQuery: { messages: true } })
  const selectable = list.filter(f => !f.flags?.has('\\Noselect'))
  const live = selectable.reduce((sum, f) => sum + (f.status?.messages ?? 0), 0)
  say('actually on the server, this mailbox', `${live} message(s) over ${selectable.length} folder(s)`)

  console.log(`\nB. how big the stored text is — sample of ${SAMPLE_SIZE}`)
  const lock = await client.getMailboxLock('INBOX')
  const sizes = []
  let truncated = 0
  let fetchMs = 0
  try {
    const total = client.mailbox?.exists ?? 0
    if (total === 0) harness('the inbox is empty — nothing to sample')
    const from = Math.max(1, total - SAMPLE_SIZE + 1)
    const started = Date.now()
    for await (const msg of client.fetch(`${from}:${total}`, { uid: true, bodyParts: ['1'] })) {
      const raw = msg.bodyParts?.get('1')?.toString('utf8') ?? ''
      const stored = indexableText(raw, '')
      if (Buffer.byteLength(raw, 'utf8') > TEXT_CAP_BYTES) truncated++
      sizes.push(stored.length)
    }
    fetchMs = Date.now() - started
  } finally {
    lock.release()
  }
  if (sizes.length === 0) harness('the sample came back empty — nothing measured')
  sizes.sort((a, b) => a - b)
  const at = q => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))]
  const mean = Math.round(sizes.reduce((s, n) => s + n, 0) / sizes.length)
  say('sampled', `${sizes.length} message(s)`)
  say('stored text per message', `mean ${mean} B · median ${at(0.5)} B · p90 ${at(0.9)} B · p99 ${at(0.99)} B · max ${sizes[sizes.length - 1]} B`)
  say(`capped at ${TEXT_CAP_BYTES} B`, `${truncated} of ${sizes.length} sampled message(s) truncated`)
  say('extrapolated raw text for this mailbox', `${live} × ${mean} B = ${mib(live * mean)}`)

  console.log('\nC. how long an initial indexing run would take')
  // The bound is the FETCH, not the database write: the server is remote and the
  // throughput below is what it actually gave this run.
  const perMessageMs = fetchMs / sizes.length
  say('measured FETCH throughput', `${sizes.length} message(s) in ${fetchMs} ms = ${perMessageMs.toFixed(1)} ms/message`)
  say('extrapolated for this mailbox', `${live} × ${perMessageMs.toFixed(1)} ms = ${(live * perMessageMs / 1000 / 60).toFixed(0)} min, single stream`)

  console.log(`\nD. how fast a search would be — ${SYNTHETIC_ROWS} synthetic rows of the measured shape`)
  const client2 = await pool.connect()
  try {
    // TEMPORARY: dropped when this connection closes. Nothing survives this probe.
    await client2.query(`CREATE TEMPORARY TABLE probe_body_index (uid int, body text) ON COMMIT PRESERVE ROWS`)
    const fillStart = Date.now()
    await client2.query(
      `INSERT INTO probe_body_index (uid, body)
       SELECT g, repeat(md5(g::text) || ' ', $2) FROM generate_series(1, $1) g`,
      [SYNTHETIC_ROWS, Math.max(1, Math.round(mean / 33))]
    )
    const fillMs = Date.now() - fillStart
    const { rows: sized } = await client2.query(`SELECT pg_total_relation_size('probe_body_index') AS bytes`)
    say('table built', `${SYNTHETIC_ROWS} rows in ${fillMs} ms, ${mib(Number(sized[0].bytes))}`)

    // SAME-RUN REFERENCE: the identical query on the identical table, before the
    // index exists. Without it, a fast number would only prove the machine is fast.
    const needle = 'zzsynthetic'
    await client2.query(`UPDATE probe_body_index SET body = body || ' ' || $1 WHERE uid % 1000 = 0`, [needle])
    const q = `SELECT count(*) FROM probe_body_index WHERE to_tsvector('simple', body) @@ plainto_tsquery('simple', $1)`
    const seqStart = Date.now()
    const { rows: seqRows } = await client2.query(q, [needle])
    const seqMs = Date.now() - seqStart
    say('REFERENCE without an index', `${seqRows[0].count} match(es) in ${seqMs} ms (sequential scan)`)

    const idxStart = Date.now()
    await client2.query(`CREATE INDEX probe_body_gin ON probe_body_index USING GIN (to_tsvector('simple', body))`)
    const buildMs = Date.now() - idxStart
    const { rows: idxSized } = await client2.query(`SELECT pg_relation_size('probe_body_gin') AS bytes`)
    say('GIN index', `built in ${buildMs} ms, ${mib(Number(idxSized[0].bytes))} for ${SYNTHETIC_ROWS} rows`)

    const hitStart = Date.now()
    const { rows: hitRows } = await client2.query(q, [needle])
    const hitMs = Date.now() - hitStart
    say('the same query WITH the index', `${hitRows[0].count} match(es) in ${hitMs} ms`)
    say('index vs no index, same run, same table', `${hitMs} ms vs ${seqMs} ms (${(seqMs / Math.max(1, hitMs)).toFixed(1)}× faster)`)
    const perRow = Number(idxSized[0].bytes) / SYNTHETIC_ROWS
    say('extrapolated index for this mailbox', `${live} × ${Math.round(perRow)} B/row = ${mib(live * perRow)}, plus ${mib(live * mean)} of stored text`)
    // What this arm does NOT measure, stated where the number is produced rather
    // than only in the note: the synthetic body is a repeated md5 hash, so each
    // row holds very FEW distinct lexemes. A GIN index over real prose carries far
    // more of them, so the size above is a FLOOR, not an estimate — only a run over
    // real indexed text would give the true figure, and that means storing the text.
    say('caveat on that figure', 'synthetic rows repeat one token: a FLOOR for the index size, not an estimate')
  } finally {
    client2.release()
  }

  console.log('\nprobe-body-index: measured (this probe asserts nothing — the numbers are the output)')
} finally {
  await close()
}
