/**
 * Newsletter subscriptions — list them per sender, unsubscribe in one call.
 *
 * Reads HEADERS ONLY (`From`, `List-Id`, `List-Unsubscribe`,
 * `List-Unsubscribe-Post`, date, subject): the body of a message is never read
 * here and never logged.
 *
 * Everything that parses or decides lives in pure functions so it can be
 * measured without a network and without a mailbox; the two IMPURE doors
 * (DNS resolution and the outgoing HTTPS request) are injected.
 *
 * `lib/imap.ts` belongs to another lane and is NOT modified: only `createClient`
 * is imported. Its own `List-Unsubscribe` reading (single line, `^list-unsubscribe:`)
 * loses a folded header's continuation lines — that defect is reported in the
 * Journal, not fixed from here.
 */
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import type { AccountConfig } from './imap'

/**
 * How many of the most recent messages of the folder are scanned for
 * subscription headers. One constant, used by the route and by the bench.
 * Chosen to cover a few weeks of a busy mailbox while staying a single
 * header-only IMAP fetch; the measured duration on the staging mailbox is
 * recorded in PROGRESS.md.
 */
export const RECENT_MESSAGES_SCANNED = 400

/** Hard ceiling of ids accepted by one unsubscribe call. */
export const MAX_UNSUBSCRIBE_BATCH = 50

/** Deadline of the outgoing one-click request, milliseconds. */
export const UNSUBSCRIBE_TIMEOUT_MS = 8000

/** The exact body RFC 8058 requires for a one-click unsubscribe. */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click'
export const ONE_CLICK_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/** How a group can be left. `link` is never automated — see `unsubscribeOneClick`. */
export type UnsubscribeMethod = 'one-click' | 'mailto' | 'link'

/** Outcome of one requested id. Names are part of the API contract. */
export type UnsubscribeOutcome = 'done' | 'manual' | 'failed' | 'not_found'

/** Why the network boundary refused an address or a URL. Part of the contract. */
export const REFUSAL_REASONS = [
  'not-https',
  'no-address',
  'private-address',
  'unresolvable',
  'redirect-not-followed',
  'http-status',
  'transport',
  'timeout',
] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export interface EmailAddress {
  name: string
  address: string
}

/** One message's subscription-relevant headers, already parsed. */
export interface SubscriptionHeaders {
  from: EmailAddress
  listId?: string
  uris: UnsubscribeUris
  oneClick: boolean
  date: string
  subject: string
  uid: string
}

export interface Subscription {
  id: string
  sender: EmailAddress
  listId?: string
  count: number
  lastDate: string
  lastSubject: string
  lastUid: string
  method: UnsubscribeMethod
  unsubscribedAt: string | null
}

// ---------------------------------------------------------------------------
// Header parsing (RFC 5322 unfolding, RFC 2369 / 8058 values)
// ---------------------------------------------------------------------------

/**
 * Unfolds a raw header block and indexes it by lower-case field name. A field
 * may legitimately appear several times, so every occurrence is kept in order.
 *
 * Folding (RFC 5322 §2.2.3): a continuation line starts with a space or a tab
 * and belongs to the field above it. Reading only the first line — as
 * `lib/imap.ts` does — drops a URI that the sender wrapped onto the next line.
 */
export function unfoldHeaders(raw: string): Map<string, string[]> {
  const fields = new Map<string, string[]>()
  let name: string | null = null
  let value = ''
  const flush = () => {
    if (!name) return
    const list = fields.get(name) ?? []
    list.push(value.trim())
    fields.set(name, list)
    name = null
    value = ''
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      // Continuation: the fold itself is whitespace, so one space is enough.
      if (name) value += ` ${line.trim()}`
      continue
    }
    flush()
    const sep = line.indexOf(':')
    if (sep > 0) {
      name = line.slice(0, sep).trim().toLowerCase()
      value = line.slice(sep + 1)
    }
  }
  flush()
  return fields
}

/** First occurrence of a field, unfolded. */
export function headerValue(fields: Map<string, string[]>, name: string): string | undefined {
  return fields.get(name.toLowerCase())?.[0]
}

export interface UnsubscribeUris {
  https: string[]
  mailto: string[]
}

/**
 * Every URI of a `List-Unsubscribe` value. The field carries one or more URIs
 * between angle brackets, comma-separated (RFC 2369): `<https://…>, <mailto:…>`.
 * Anything that is neither https nor mailto is dropped here — including plain
 * http, which the network boundary would refuse anyway.
 */
export function parseUnsubscribeUris(value: string | undefined): UnsubscribeUris {
  const uris: UnsubscribeUris = { https: [], mailto: [] }
  if (!value) return uris
  for (const m of Array.from(value.matchAll(/<([^<>]+)>/g))) {
    const uri = m[1].trim()
    if (/^https:\/\//i.test(uri)) uris.https.push(uri)
    else if (/^mailto:/i.test(uri)) uris.mailto.push(uri)
  }
  return uris
}

/** RFC 8058: one-click is offered only when the POST field says exactly so. */
export function isOneClick(postHeader: string | undefined, uris: UnsubscribeUris): boolean {
  if (!uris.https.length) return false
  return /list-unsubscribe\s*=\s*one-click/i.test(postHeader ?? '')
}

/** `Name <addr@host>` or a bare address. */
export function parseAddress(value: string | undefined): EmailAddress {
  const raw = (value ?? '').trim()
  const angled = raw.match(/^(.*)<([^<>]+)>\s*$/)
  if (angled) {
    return {
      name: angled[1].trim().replace(/^"(.*)"$/, '$1').trim(),
      address: angled[2].trim().toLowerCase(),
    }
  }
  return { name: '', address: raw.toLowerCase() }
}

/** The address that identifies a mailto unsubscribe, without its parameters. */
export function mailtoAddress(uri: string): string | null {
  const target = uri.replace(/^mailto:/i, '').split('?')[0].trim()
  const decoded = (() => {
    try {
      return decodeURIComponent(target)
    } catch {
      return target
    }
  })()
  return /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/.test(decoded) ? decoded.toLowerCase() : null
}

/** The `subject=` parameter of a mailto URI, when the list asks for one. */
export function mailtoSubject(uri: string): string | undefined {
  const qs = uri.split('?')[1]
  if (!qs) return undefined
  const value = new URLSearchParams(qs).get('subject')?.trim()
  return value || undefined
}

/**
 * The grouping key of a message: its list identity when the sender declares one
 * (`List-Id`, stable across a sender's address rotations), else its From address.
 */
export function groupingKey(h: Pick<SubscriptionHeaders, 'listId' | 'from'>): string {
  const listId = h.listId?.trim().toLowerCase()
  if (listId) {
    // `List-Id: Some name <list.example.com>` — the bracketed identifier is the stable part.
    const bracketed = listId.match(/<([^<>]+)>/)?.[1]
    return `list:${(bracketed ?? listId).trim()}`
  }
  // Lower-cased here too, not only in `parseAddress`: the key must not depend on
  // who built the address (a caller may hand one straight from a database row).
  return `from:${h.from.address.trim().toLowerCase()}`
}

/**
 * Stable, opaque id of a group: the same mailbox and the same key always give
 * the same id, and the id reveals neither the address nor the account.
 */
export function subscriptionId(accountId: string, key: string): string {
  return crypto.createHash('sha256').update(`${accountId}\u0000${key}`).digest('hex').slice(0, 24)
}

/** Parses one message's raw header block. Returns null when no unsubscribe route exists. */
export function parseSubscriptionHeaders(uid: string, raw: string): SubscriptionHeaders | null {
  const fields = unfoldHeaders(raw)
  const uris = parseUnsubscribeUris(headerValue(fields, 'list-unsubscribe'))
  if (!uris.https.length && !uris.mailto.length) return null
  return {
    uid,
    from: parseAddress(headerValue(fields, 'from')),
    listId: headerValue(fields, 'list-id'),
    uris,
    oneClick: isOneClick(headerValue(fields, 'list-unsubscribe-post'), uris),
    date: headerValue(fields, 'date') ?? '',
    subject: headerValue(fields, 'subject') ?? '',
  }
}

/** The method a group offers, most automatic first. */
export function methodOf(h: Pick<SubscriptionHeaders, 'oneClick' | 'uris'>): UnsubscribeMethod {
  if (h.oneClick) return 'one-click'
  if (h.uris.mailto.length) return 'mailto'
  return 'link'
}

/**
 * Groups messages per list, newest message first inside a group, groups sorted
 * by decreasing count. The newest message of a group is the one whose headers a
 * later unsubscribe re-reads — the client never sends a URL or an address.
 */
export function groupSubscriptions(
  accountId: string,
  headers: SubscriptionHeaders[],
  unsubscribedAt: Map<string, string> = new Map()
): Subscription[] {
  const groups = new Map<string, { key: string; newest: SubscriptionHeaders; count: number }>()
  for (const h of headers) {
    const key = groupingKey(h)
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { key, newest: h, count: 1 })
      continue
    }
    existing.count += 1
    if (dateRank(h.date) > dateRank(existing.newest.date)) existing.newest = h
  }
  return Array.from(groups.values())
    .map(({ key, newest, count }) => ({
      id: subscriptionId(accountId, key),
      sender: newest.from,
      ...(newest.listId ? { listId: newest.listId } : {}),
      count,
      lastDate: newest.date,
      lastSubject: newest.subject,
      lastUid: newest.uid,
      method: methodOf(newest),
      unsubscribedAt: unsubscribedAt.get(key) ?? null,
    }))
    .sort((a, b) => b.count - a.count || a.sender.address.localeCompare(b.sender.address))
}

function dateRank(date: string): number {
  const t = Date.parse(date)
  return Number.isNaN(t) ? 0 : t
}

// ---------------------------------------------------------------------------
// Network boundary — the server is about to call a URL written by a stranger
// ---------------------------------------------------------------------------

/** One resolved address. `family` is 4 or 6, as `dns.lookup` reports it. */
export interface ResolvedAddress {
  address: string
  family: number
}

/** Injectable resolver, so the refusal battery runs without a network. */
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>

const defaultResolver: AddressResolver = async hostname => {
  const all = await dns.lookup(hostname, { all: true, verbatim: true })
  return all.map(a => ({ address: a.address, family: a.family }))
}

/**
 * True for an address nobody outside this network should be able to make the
 * server talk to: loopback, private ranges, link-local, carrier-grade NAT,
 * `0/8`, multicast and above, plus their IPv6 counterparts and an IPv4 address
 * smuggled inside IPv6.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = ip.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateAddress(mapped[1])
  const v6mapped = ip.match(/^(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (v6mapped) {
    const [hi, lo] = v6mapped.slice(1).map(h => parseInt(h, 16))
    return isPrivateAddress([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'))
  }
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(ip)) return true // ff00::/8 multicast
    return false
  }
  const parts = ip.split('.')
  if (parts.length !== 4) return true // not an address we can vouch for
  const [a, b] = parts.map(n => Number(n))
  if (parts.some(p => !/^\d{1,3}$/.test(p)) || parts.some(p => Number(p) > 255)) return true
  if (a === 0 || a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

export type UrlDecision =
  | { ok: true; url: URL; address: ResolvedAddress }
  | { ok: false; reason: RefusalReason }

/**
 * Decides whether the server may call this URL, and WHICH address it will
 * connect to. https only; every resolved address must be public — one private
 * address among several refuses the whole name, so a DNS answer that mixes a
 * public and a private address cannot smuggle the request inside.
 */
export async function decideUrl(raw: string, resolve: AddressResolver = defaultResolver): Promise<UrlDecision> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not-https' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' }
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolve(url.hostname)
  } catch {
    return { ok: false, reason: 'unresolvable' }
  }
  if (!addresses.length) return { ok: false, reason: 'no-address' }
  if (addresses.some(a => isPrivateAddress(a.address))) return { ok: false, reason: 'private-address' }
  return { ok: true, url, address: addresses[0] }
}

export interface OneClickResult {
  ok: boolean
  reason?: RefusalReason
  status?: number
}

/** What the boundary needs from an HTTPS client, so a bench can stand in for it. */
export interface HttpsRequester {
  (options: {
    url: URL
    address: ResolvedAddress
    body: string
    contentType: string
    timeoutMs: number
  }): Promise<{ status: number }>
}

const defaultRequester: HttpsRequester = ({ url, address, body, contentType, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
        // Connect to the address that was VERIFIED, without a second
        // resolution: between the check and the connection, DNS could
        // otherwise answer a private address (rebinding).
        lookup: (_hostname, _opts, cb) =>
          (cb as (e: Error | null, a: string, f: number) => void)(null, address.address, address.family),
      },
      res => {
        // The response body is never read, never returned, never logged: it is
        // a stranger's document and nothing here needs it.
        res.resume()
        resolve({ status: res.statusCode ?? 0 })
      }
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end(body)
  })

/**
 * The RFC 8058 one-click POST, through the boundary above. No redirect is ever
 * followed: a 3xx is an answer the sender has to make unambiguous, not an
 * invitation to call a second, unchecked URL.
 */
export async function unsubscribeOneClick(
  rawUrl: string,
  opts: { resolve?: AddressResolver; request?: HttpsRequester } = {}
): Promise<OneClickResult> {
  const decision = await decideUrl(rawUrl, opts.resolve ?? defaultResolver)
  if (!decision.ok) return { ok: false, reason: decision.reason }
  const request = opts.request ?? defaultRequester
  let status: number
  try {
    status = (
      await request({
        url: decision.url,
        address: decision.address,
        body: ONE_CLICK_BODY,
        contentType: ONE_CLICK_CONTENT_TYPE,
        timeoutMs: UNSUBSCRIBE_TIMEOUT_MS,
      })
    ).status
  } catch (err) {
    const code = (err as { code?: string })?.code
    return { ok: false, reason: code === 'ETIMEDOUT' ? 'timeout' : 'transport' }
  }
  if (status >= 300 && status < 400) return { ok: false, reason: 'redirect-not-followed', status }
  if (status < 200 || status >= 300) return { ok: false, reason: 'http-status', status }
  return { ok: true, status }
}

// ---------------------------------------------------------------------------
// Mailbox reading — headers only
// ---------------------------------------------------------------------------

const SUBSCRIPTION_HEADER_FIELDS = ['from', 'list-id', 'list-unsubscribe', 'list-unsubscribe-post', 'date', 'subject']

/**
 * Reads the subscription headers of the most recent `RECENT_MESSAGES_SCANNED`
 * messages of a folder. Header fetch only: no body is ever requested.
 */
export async function readSubscriptionHeaders(
  account: AccountConfig,
  folder: string,
  limit = RECENT_MESSAGES_SCANNED
): Promise<SubscriptionHeaders[]> {
  // Imported inside the function so the pure half of this module (headers,
  // grouping, network boundary) can be measured on its own, without pulling in
  // the IMAP client — the same reason lib/pgp/crypto.ts imports lazily.
  const { createClient } = await import('./imap')
  const client = await createClient(account)
  const found: SubscriptionHeaders[] = []
  try {
    const lock = await client.getMailboxLock(folder)
    try {
      const uids = (await client.search({ all: true }, { uid: true })) as number[] | false
      const recent = (uids || []).slice(-limit)
      if (!recent.length) return found
      for await (const msg of client.fetch(
        recent as unknown as string,
        { uid: true, headers: SUBSCRIPTION_HEADER_FIELDS } as Parameters<typeof client.fetch>[1],
        { uid: true }
      )) {
        const raw = (msg as unknown as { headers?: Buffer }).headers
        if (!Buffer.isBuffer(raw)) continue
        const parsed = parseSubscriptionHeaders(String(msg.uid), raw.toString('utf8'))
        if (parsed) found.push(parsed)
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
  return found
}
