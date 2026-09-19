#!/usr/bin/env node
/**
 * Lot S5 — SONDE, pas un gate. It MEASURES whether the real IMAP server can
 * search message BODIES at all, so Nicolas can decide on numbers rather than on
 * the one data point of 19/09 (`BODY` and `TEXT` returning 0, and dragging a
 * whole `OR` down to 0 with them). It BUILDS NOTHING: read only — CAPABILITY,
 * LIST, SELECT, SEARCH and one FETCH of one message it picked itself. It never
 * creates, moves or deletes a message, and never prints a body, an address or a
 * password.
 *
 * Why it cannot be a pass/fail bench: "does this server search bodies" has no
 * right answer to assert against. Every arm therefore carries its own SAME-RUN
 * reference, and the script exits 0 whatever the server answers — the numbers
 * are the output.
 *
 *  A. The needle. It FETCHes the text of recent messages in the inbox until it
 *     finds a word present in a BODY and absent from every searchable header
 *     (from/to/cc/subject) of that same message. Without such a word no body
 *     search can be told apart from the header search the product already does,
 *     so this arm is the precondition of every other one. The word itself is
 *     NEVER printed — only its length and shape.
 *  B. Does the server answer at all. `BODY` and `TEXT`, with and without
 *     `CHARSET UTF-8`. SAME-RUN REFERENCE, and this is the whole point: the same
 *     search issued on the SUBJECT of that same message, which MUST return at
 *     least that message. A reference at 0 means the harness is broken — not
 *     that the server cannot search bodies.
 *  C. Does it poison an OR. The product's own `OR` over SEARCH_FIELDS, then the
 *     same `OR` with the body term added. Reference: the plain `OR`, same run,
 *     same folder. A drop to 0 reproduces the 19/09 observation.
 *  D. Accented word. Same as B on a non-ASCII word if the message holds one,
 *     with and without CHARSET — the failure mode differs from ASCII often
 *     enough to be worth its own number.
 *  E. What it would cost. If and only if the server answers, `BODY` is timed on
 *     the largest folder, against the SAME-RUN reference of the header-only `OR`
 *     on that same folder: body search is worth building only if its cost is of
 *     the same order.
 *
 *   node --experimental-strip-types scripts/probe-search-body.mjs
 */
import { openTestMailbox, harness } from './bench-imap.mjs'

const { client, config, close } = await openTestMailbox()
const { SEARCH_FIELDS } = await import(new URL('../lib/search.ts', import.meta.url).href)

// How many recent messages arm A may FETCH while hunting for a body-only word.
// Bounded so the probe stays quick and gentle on a real server.
const NEEDLE_CANDIDATES = 25
// A needle must be long enough not to appear everywhere by accident. 6 is the
// shortest length that made every candidate word unique to its body on the test
// mailbox; shorter words matched boilerplate.
const NEEDLE_MIN_LENGTH = 6
// Capabilities that would change the answer if present; printed either way.
const BODY_CAPABILITIES = ['SEARCH=FUZZY', 'ESEARCH', 'CONDSTORE']

const say = (label, value) => console.log(`  ${label}: ${value}`)
// The server's OWN words, which is what lot S5 asks to record: imapflow puts the
// tagged status and its text on the error, and 'Command failed' is only its
// generic wrapper.
const serverWords = err => (err.responseText ? `${err.responseStatus} ${err.responseText}` : String(err.message ?? err))
const shape = word => `${word.length} chars, ${/^[\x20-\x7e]+$/.test(word) ? 'ASCII' : 'non-ASCII'}`

/** Runs one SEARCH, timed, and never throws: a refusal IS a measurement. */
async function timedSearch(label, query) {
  const started = Date.now()
  try {
    const found = await client.search(query, { uid: true })
    const ms = Date.now() - started
    const n = Array.isArray(found) ? found.length : 0
    console.log(`  ${label}: ${n} result(s) in ${ms} ms${found === false ? ' (server refused)' : ''}`)
    return { n, ms, refused: found === false }
  } catch (err) {
    const ms = Date.now() - started
    console.log(`  ${label}: REJECTED in ${ms} ms — server said: ${serverWords(err).slice(0, 160)}`)
    return { n: 0, ms, refused: true, error: serverWords(err) }
  }
}

/**
 * The same thing, as the RAW command — `UID SEARCH CHARSET UTF-8 <key> <word>`.
 * imapflow's search() has no charset option, so asking it for one would silently
 * measure the plain form twice; this issues the wire command itself and counts
 * the UIDs of the untagged SEARCH response.
 */
async function timedRawSearch(label, key, word, charset = true) {
  const started = Date.now()
  let uids = 0
  try {
    const response = await client.exec('UID SEARCH', [
      ...(charset ? [{ type: 'ATOM', value: 'CHARSET' }, { type: 'ATOM', value: 'UTF-8' }] : []),
      { type: 'ATOM', value: key.toUpperCase() },
      { type: 'STRING', value: word },
    ], {
      untagged: {
        SEARCH: async untagged => { uids += (untagged?.attributes ?? []).length },
      },
    })
    response.next()
    const ms = Date.now() - started
    console.log(`  ${label}: ${uids} result(s) in ${ms} ms`)
    return { n: uids, ms, refused: false }
  } catch (err) {
    const ms = Date.now() - started
    console.log(`  ${label}: REJECTED in ${ms} ms — server said: ${serverWords(err).slice(0, 160)}`)
    return { n: 0, ms, refused: true, error: serverWords(err) }
  }
}

try {
  console.log(`server: ${config.imapHost}:${config.imapPort}`)
  const announced = [...(client.capabilities?.keys?.() ?? [])].map(String)
  for (const cap of BODY_CAPABILITIES) console.log(`  ${announced.includes(cap) ? 'yes' : 'no '}  ${cap}`)

  console.log('\nA. the needle — a word in a BODY and in no searchable header')
  const lock = await client.getMailboxLock('INBOX')
  let needle = null
  let accented = null
  let needleUid = null
  let fetched = 0
  try {
    const total = client.mailbox?.exists ?? 0
    const from = Math.max(1, total - NEEDLE_CANDIDATES + 1)
    if (total === 0) harness('the inbox is empty — nothing to derive a needle from')
    for await (const msg of client.fetch(`${from}:${total}`, { uid: true, envelope: true, bodyParts: ['1'] })) {
      fetched++
      const text = msg.bodyParts?.get('1')?.toString('utf8') ?? ''
      if (!text) continue
      // Everything the product ALREADY searches, so the needle is provably out of reach
      // of a header search: that is what makes arm B's answer attributable to the body.
      const envelope = msg.envelope ?? {}
      const headerText = [
        envelope.subject ?? '',
        ...['from', 'to', 'cc'].flatMap(k => (envelope[k] ?? []).map(a => `${a.name ?? ''} ${a.address ?? ''}`)),
      ].join(' ').toLowerCase()
      const words = [...new Set(text.toLowerCase().match(/[\p{L}]{6,20}/gu) ?? [])]
      const ascii = words.find(w => w.length >= NEEDLE_MIN_LENGTH && /^[a-z]+$/.test(w) && !headerText.includes(w))
      if (!ascii) continue
      needle = ascii
      needleUid = msg.uid
      accented = words.find(w => /[^\x00-\x7f]/.test(w) && !headerText.includes(w)) ?? null
      break
    }
  } finally {
    lock.release()
  }
  if (!needle) harness(`no body-only word found in the last ${fetched} message(s) — the probe cannot attribute anything`)
  say('messages fetched before a needle was found', fetched)
  say('needle', shape(needle))
  say('accented needle', accented ? shape(accented) : 'none in this message')

  console.log('\nB. does the server answer — BODY and TEXT, with and without CHARSET')
  const lockB = await client.getMailboxLock('INBOX')
  let reference
  try {
    // SAME-RUN REFERENCE first: this search MUST find the message, otherwise the
    // harness is broken and nothing below licenses a conclusion. The reference
    // word is taken ASCII-only on purpose: a first run showed a non-ASCII SUBJECT
    // search returning 0 on this server, which would have broken the reference
    // for a reason having nothing to do with bodies.
    const envelope = (await client.fetchOne(String(needleUid), { envelope: true }, { uid: true }))?.envelope ?? {}
    const subjectWord = (envelope.subject ?? '').match(/[a-zA-Z]{6,20}/)?.[0]
    const fromAddress = envelope.from?.[0]?.address ?? ''
    const referenceQuery = subjectWord ? { subject: subjectWord } : { from: fromAddress }
    say('reference field', subjectWord ? `SUBJECT, ${shape(subjectWord)}` : 'FROM (the subject holds no ASCII word)')
    reference = await timedSearch('REFERENCE  a header of that same message ', referenceQuery)
    for (const field of ['body', 'text']) {
      await timedSearch(`${field.toUpperCase().padEnd(10)} plain            `, { [field]: needle })
      // The RAW form of the same plain search, purely to capture the server's own
      // refusal text: imapflow's search() swallows it into `false`, and lot S5 asks
      // for the raw responses, not for a boolean.
      await timedRawSearch(`${field.toUpperCase().padEnd(10)} plain, raw       `, field, needle, false)
      await timedRawSearch(`${field.toUpperCase().padEnd(10)} CHARSET UTF-8    `, field, needle)
    }

    console.log('\nC. does a body term poison the OR the product uses')
    const term = config.username.split('@')[1] ?? config.username
    // The plain OR is measured TWICE, bracketing the widened one: each of these
    // searches takes ~25 s on this mailbox, and the mailbox is LIVE. Without the
    // bracket, a handful of messages arriving between two searches would be
    // indistinguishable from an effect of the body term — the drift between the
    // two references is exactly how much of any delta is NOT attributable.
    const plainOr = await timedSearch('REFERENCE  OR over the product fields   ', { or: SEARCH_FIELDS.map(f => ({ [f]: term })) })
    const widenedOr = await timedSearch('           the same OR plus a body term ', { or: [...SEARCH_FIELDS.map(f => ({ [f]: term })), { body: needle }] })
    const plainOrAgain = await timedSearch('REFERENCE  the plain OR again, after    ', { or: SEARCH_FIELDS.map(f => ({ [f]: term })) })
    const drift = Math.abs(plainOrAgain.n - plainOr.n)
    const delta = widenedOr.n - plainOr.n
    say('drift of the mailbox itself during the arm', `${drift} message(s) between the two plain runs`)
    say('widening the OR with a body term', plainOr.n > 0 && widenedOr.n < plainOr.n - drift
      ? `LOSES results — ${plainOr.n} without, ${widenedOr.n} with, beyond a drift of ${drift}`
      : `keeps them — ${plainOr.n} without, ${widenedOr.n} with (delta ${delta >= 0 ? '+' : ''}${delta}, drift ${drift}: ${Math.abs(delta) <= drift ? 'NOT attributable to the body term' : 'beyond the drift'})`)

    if (accented) {
      console.log('\nD. accented word')
      await timedSearch('BODY       accented, plain      ', { body: accented })
      await timedRawSearch('BODY       accented, CHARSET    ', 'body', accented)
    } else {
      console.log('\nD. accented word — skipped: the needle message holds none')
    }
  } finally {
    lockB.release()
  }

  console.log('\nE. what a body search would cost, on the biggest folder')
  const bodyWorks = reference.n > 0
  if (!bodyWorks) {
    say('skipped', 'the reference search itself returned nothing — HARNESS, not a server verdict')
  } else {
    const list = await client.list({ statusQuery: { messages: true } })
    const biggest = list
      .filter(f => !f.flags?.has('\\Noselect'))
      .sort((a, b) => (b.status?.messages ?? 0) - (a.status?.messages ?? 0))[0]
    say('biggest folder', `${biggest.status?.messages ?? '?'} messages`)
    const lockE = await client.getMailboxLock(biggest.path)
    try {
      const term = config.username.split('@')[1] ?? config.username
      // SAME-RUN REFERENCE: the header-only OR on the SAME folder. Body search is
      // worth building only if its cost is of the same order as the search the
      // product already ships.
      const headerCost = await timedSearch('REFERENCE  header OR, biggest folder', { or: SEARCH_FIELDS.map(f => ({ [f]: term })) })
      const bodyCost = await timedSearch('           BODY, same folder, same run', { body: needle })
      say('body vs header cost', `${bodyCost.ms} ms vs ${headerCost.ms} ms (ratio ${(bodyCost.ms / Math.max(1, headerCost.ms)).toFixed(1)}×)`)
    } finally {
      lockE.release()
    }
  }

  console.log('\nprobe-search-body: measured (this probe asserts nothing — the numbers are the output)')
} finally {
  await close()
}
