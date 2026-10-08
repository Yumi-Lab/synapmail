#!/usr/bin/env node
/**
 * The preamble every IMAP bench needs, written ONCE: secrets loaded from the env
 * files, the product's own TypeScript modules made importable, and the test
 * account opened read only. Importing this module HAS the side effect of
 * registering the resolver hooks — it must therefore be imported before any
 * product module, which ESM guarantees by evaluating imports in order.
 *
 * It opens a connection and hands it back; it never creates, moves or deletes a
 * message, and never prints a body, an address or a password.
 */
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { Pool } from 'pg'

// The IMAP benches talk to IMAP and PostgreSQL directly, so they need the
// server-side secrets too: `.env.local` carries DATABASE_URL and ENCRYPTION_KEY,
// `.env` the test account. Neither is ever printed.
for (const file of ['.env', '.env.local']) {
  const url = new URL(`../${file}`, import.meta.url)
  if (!existsSync(url)) continue
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

// The product's own modules are IMPORTED by the benches, never retyped: a change
// in lib/imap.ts or lib/search.ts fails a bench instead of silently making it
// measure something else. Extensionless relative specifiers and the `@/` root
// alias are both resolved to their .ts source.
const ROOT = new URL('../', import.meta.url)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) {
      const url = new URL(`${spec.slice(2)}.ts`, ROOT)
      if (existsSync(url)) return next(url.href, ctx)
      return next(new URL(spec.slice(2), ROOT).href, ctx)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) {
      const url = new URL(`${spec}.ts`, ctx.parentURL)
      if (existsSync(url)) return next(url.href, ctx)
    }
    return next(spec, ctx)
  },
})

/** A harness failure: the product was never exercised, so NO conclusion follows. */
export const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

/**
 * Opens the test account's IMAP connection, read only.
 * Returns { client, config, pool, close } — `close` logs out and ends the pool.
 */
export async function openTestMailbox() {
  const { ImapFlow } = await import('imapflow')
  const { decrypt } = await import(new URL('../lib/encrypt.ts', import.meta.url).href)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let account
  try {
    const { rows } = await pool.query(
      `SELECT id, imap_host, imap_port, imap_secure, username, password_encrypted
         FROM email_accounts ORDER BY created_at ASC LIMIT 1`
    )
    account = rows[0]
  } catch (err) {
    harness(`cannot read the test account from the database: ${err}`)
  }
  if (!account) harness('no email account configured in the database')

  const config = {
    id: account.id,
    imapHost: account.imap_host,
    imapPort: account.imap_port,
    imapSecure: account.imap_secure,
    username: account.username,
    passwordEncrypted: account.password_encrypted,
  }

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: config.username, pass: decrypt(config.passwordEncrypted) },
    logger: false,
    tls: { rejectUnauthorized: false },
  })

  try {
    await client.connect()
  } catch (err) {
    // No connection = the product was never exercised: a harness failure, which
    // licenses NO conclusion about the search.
    harness(`IMAP connection failed: ${err}`)
  }

  return {
    client,
    config,
    pool,
    close: async () => {
      await client.logout().catch(() => {})
      await pool.end().catch(() => {})
    },
  }
}
