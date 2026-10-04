/**
 * Les webhooks : un objet qui porte une URL et un secret, un envoi SIGNÉ, et un journal de
 * ce qui est parti.
 *
 * Deux règles commandent ce fichier :
 *
 *  1. **L'adresse appelée est contrôlée, à l'enregistrement ET à chaque envoi** (décision 6).
 *     Un bot choisit l'URL et c'est le SERVEUR qui l'appelle : sans ce contrôle, l'API des
 *     webhooks est un scanner de réseau interne offert. `https` obligatoire, résolution DNS
 *     avant l'appel, refus des adresses privées / de bouclage / lien-local / métadonnées —
 *     sauf les hôtes que l'ADMIN SERVEUR a listés dans `WEBHOOK_ALLOWED_HOSTS`.
 *  2. **Le même mail n'est jamais renvoyé deux fois à la même règle** (décision 7). Ce n'est
 *     pas une précaution applicative : c'est la contrainte `UNIQUE (webhook_id, rule_id,
 *     message_id)` de `webhook_deliveries` (`lib/db.ts`), donc un redémarrage, une repasse ou
 *     deux planificateurs ne peuvent pas la contourner.
 *
 * Le secret est CHIFFRÉ, pas haché (contrairement à une clé API) : il doit être RELU à chaque
 * envoi pour calculer le HMAC. Il est montré une seule fois, à la création et à la régénération.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { lookup } from 'dns/promises'
import { query } from './db'
import { decrypt, encrypt } from './encrypt'
import { guardApiPayload } from './promptGuard'
import type { Webhook, WebhookDelivery, WebhookWithSecret } from '@/types/webhook'

// ---------------------------------------------------------------------------
// Les valeurs du protocole, écrites UNE fois (elles sont relues par les routes,
// par l'écran, par la documentation et par le banc)
// ---------------------------------------------------------------------------

/** Le préfixe d'un secret, comme `syn_` l'est d'une clé API : reconnaissable dans un journal. */
export const SECRET_PREFIX = 'whsec_'
export const SIGNATURE_HEADER = 'X-Synapmail-Signature'
export const EVENT_HEADER = 'X-Synapmail-Event'
export const DELIVERY_HEADER = 'X-Synapmail-Delivery'
/** L'algorithme nommé DANS la signature, pour qu'un récepteur sache quoi calculer. */
export const SIGNATURE_ALGO = 'sha256'

export const EVENT_RULE_MATCHED = 'rule.matched'
export const EVENT_TEST = 'webhook.test'

/** Au-delà, l'envoi est abandonné : un récepteur qui ne répond pas ne bloque pas le planificateur. */
export const DELIVERY_TIMEOUT_MS = 10_000
/** Les trois NOUVELLES tentatives de la décision 5, dans l'ordre. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const
/** Premier envoi + les trois reprises. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1
/** Le journal est une trace, pas un stockage : au-delà, il est purgé. */
export const DELIVERY_RETENTION_DAYS = 30
/** Le bail d'une tentative réclamée : plus long que le délai d'attente, donc jamais réclamée deux fois. */
const CLAIM_LEASE_MS = 10 * 60_000
/** Combien de tentatives un passage du planificateur prend en charge. */
const CLAIM_BATCH = 20

/** Ce qu'un aperçu de mail laisse passer dans la charge utile — jamais le corps entier. */
export const PREVIEW_MAX = 500
/** Une erreur retenue au journal reste lisible, elle ne devient pas une pièce jointe. */
export const ERROR_MAX = 500
/** Le nom d'un webhook, tel que la colonne le range ET tel que les routes le refusent. */
export const WEBHOOK_NAME_MAX = 120
/** Combien d'envois un journal rend par défaut, et au plus. */
export const DELIVERY_PAGE_DEFAULT = 50
export const DELIVERY_PAGE_MAX = 200

export const DELIVERY_STATUSES = ['pending', 'ok', 'failed'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

// ---------------------------------------------------------------------------
// Le secret
// ---------------------------------------------------------------------------

/** Un secret neuf. Rendu EN CLAIR une seule fois ; c'est l'appelant qui le montre. */
export function newWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('hex')
}

/** La signature d'un corps, telle qu'elle voyage dans l'en-tête. */
export function signPayload(secret: string, body: string): string {
  return `${SIGNATURE_ALGO}=${createHmac(SIGNATURE_ALGO, secret).update(body, 'utf8').digest('hex')}`
}

/**
 * Ce qu'un récepteur doit faire de l'en-tête reçu. Exporté parce que la documentation et le
 * banc vérifient la signature par CE code : un exemple qui n'est pas exécuté ment tôt ou tard.
 * Comparaison à temps constant — la signature est un secret dérivé.
 */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header) return false
  const expected = Buffer.from(signPayload(secret, body), 'utf8')
  const given = Buffer.from(header, 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// ---------------------------------------------------------------------------
// L'adresse : ce que le serveur s'autorise à appeler (décision 6)
// ---------------------------------------------------------------------------

/**
 * Les hôtes que l'ADMIN SERVEUR autorise malgré tout — c'est ainsi qu'un n8n du réseau privé
 * de la maison devient joignable. Jamais par un bot : la liste ne vient que de l'environnement.
 */
export function allowedHosts(): Set<string> {
  return new Set(
    (process.env.WEBHOOK_ALLOWED_HOSTS ?? '')
      .split(',')
      .map(h => h.trim().toLowerCase())
      .filter(Boolean)
  )
}

/** Les plages que le serveur refuse d'appeler, en IPv4. */
const BLOCKED_V4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],        // « cet hôte »
  ['10.0.0.0', 8],       // privé
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // bouclage
  ['169.254.0.0', 16],   // lien-local — c'est là que vivent les métadonnées cloud
  ['172.16.0.0', 12],    // privé
  ['192.168.0.0', 16],   // privé
]

const v4ToInt = (ip: string): number | null => {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const b = Number(p)
    if (b > 255) return null
    n = (n << 8) | b
  }
  return n >>> 0
}

/** Vrai si cette adresse IP fait partie de ce que le serveur refuse d'appeler. */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '')

  // IPv4 mappée en IPv6 (`::ffff:10.0.0.1`) : c'est la même adresse, elle suit les mêmes règles.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  const v4 = v4ToInt(mapped ? mapped[1] : addr)
  if (v4 !== null) {
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return (v4 & mask) === ((v4ToInt(base) as number) & mask)
    })
  }

  if (addr === '::' || addr === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true   // fc00::/7 — unique local
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true   // fe80::/10 — lien-local
  return false
}

export interface UrlVerdict { ok: true; host: string; addresses: string[] }
export interface UrlRefusal { ok: false; reason: string }

/**
 * L'URL est-elle appelable ? Contrôlée à l'ENREGISTREMENT (un 422 lisible) et de nouveau à
 * CHAQUE envoi, parce qu'une résolution DNS change.
 *
 * ponytail: entre ce contrôle et l'appel, `fetch` résout le nom une seconde fois — une entrée
 * DNS qui change dans cet intervalle passe (rebinding). Le plafond est donc « une fenêtre de
 * quelques millisecondes », pas zéro. Chemin de sortie si une mesure le réclame : un
 * `dispatcher` undici qui se connecte à l'adresse DÉJÀ vérifiée — du code de transport à
 * écrire, inutile tant que rien ne l'a mesuré.
 */
export async function checkWebhookUrl(raw: string): Promise<UrlVerdict | UrlRefusal> {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, reason: `URL illisible : ${raw}` } }

  const host = url.hostname.toLowerCase()
  const allowed = allowedHosts().has(host)

  if (url.protocol !== 'https:' && !allowed) {
    return { ok: false, reason: `https est exigé (${url.protocol}//${host} n'est pas dans WEBHOOK_ALLOWED_HOSTS)` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `protocole non pris en charge : ${url.protocol}` }
  }
  if (allowed) return { ok: true, host, addresses: [] }

  let addresses: string[]
  try {
    addresses = (await lookup(host, { all: true })).map(a => a.address)
  } catch (err) {
    return { ok: false, reason: `nom introuvable : ${host} (${String(err instanceof Error ? err.message : err)})` }
  }
  if (!addresses.length) return { ok: false, reason: `nom sans adresse : ${host}` }

  const blocked = addresses.filter(isBlockedAddress)
  if (blocked.length) {
    return {
      ok: false,
      reason: `adresse interne refusée : ${host} résout en ${blocked.join(', ')} `
        + `(ajouter l'hôte à WEBHOOK_ALLOWED_HOSTS pour l'autoriser)`,
    }
  }
  return { ok: true, host, addresses }
}

// ---------------------------------------------------------------------------
// La charge utile (décision 5)
// ---------------------------------------------------------------------------

export interface WebhookMessage {
  messageId: string
  uid?: string | null
  folder?: string | null
  from?: { name?: string | null; address?: string | null } | null
  to?: Array<{ name?: string | null; address?: string | null }> | null
  subject?: string | null
  date?: string | null
  preview?: string | null
  hasAttachments?: boolean
}

export interface PayloadInput {
  event: string
  deliveryId: string
  rule?: { id: string; name: string } | null
  account: { id: string; email: string }
  message?: WebhookMessage | null
  tags?: Array<{ question: string; valeur: string }>
}

/**
 * Le corps envoyé. `aiSafety` EN TÊTE : ce qui arrive là est du contenu de mail, donc une
 * DONNÉE pour le bot qui le reçoit, jamais une instruction. Le même préfixe que les routes
 * de l'API — `lib/promptGuard.ts`, pas une copie.
 */
export function buildPayload(input: PayloadInput): Record<string, unknown> {
  const m = input.message
  return guardApiPayload({
    event: input.event,
    deliveryId: input.deliveryId,
    rule: input.rule ?? null,
    account: input.account,
    message: m
      ? {
        messageId: m.messageId,
        uid: m.uid ?? null,
        folder: m.folder ?? null,
        from: m.from ?? null,
        to: m.to ?? [],
        subject: m.subject ?? '',
        date: m.date ?? null,
        preview: (m.preview ?? '').slice(0, PREVIEW_MAX),
        hasAttachments: m.hasAttachments === true,
      }
      : null,
    tags: input.tags ?? [],
  }, { enabled: true })
}

// ---------------------------------------------------------------------------
// L'envoi
// ---------------------------------------------------------------------------

export interface SendOutcome {
  ok: boolean
  status: number | null
  durationMs: number
  error: string | null
}

/**
 * Un envoi, une fois. AUCUNE redirection suivie (`redirect: 'manual'`) : sinon le contrôle
 * d'adresse ci-dessus ne vaudrait rien — un récepteur public renverrait un 302 vers
 * `169.254.169.254` et le serveur irait le chercher. Un 3xx est donc un ÉCHEC, pas un détour.
 */
export async function sendWebhook(
  url: string,
  secret: string,
  event: string,
  deliveryId: string,
  payload: unknown,
): Promise<SendOutcome> {
  const verdict = await checkWebhookUrl(url)
  if (!verdict.ok) return { ok: false, status: null, durationMs: 0, error: verdict.reason.slice(0, ERROR_MAX) }

  const body = JSON.stringify(payload)
  const started = Date.now()
  const abort = AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: abort,
      headers: {
        'Content-Type': 'application/json',
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: deliveryId,
        [SIGNATURE_HEADER]: signPayload(secret, body),
      },
      body,
    })
    const durationMs = Date.now() - started
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, durationMs, error: null }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, durationMs, error: `redirection non suivie (${res.status})` }
    }
    return { ok: false, status: res.status, durationMs, error: `réponse ${res.status}` }
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? `pas de réponse en ${DELIVERY_TIMEOUT_MS} ms` : err.message) : String(err)
    return { ok: false, status: null, durationMs: Date.now() - started, error: msg.slice(0, ERROR_MAX) }
  }
}

// ---------------------------------------------------------------------------
// Le journal des envois
// ---------------------------------------------------------------------------

export interface WebhookRow {
  id: string
  user_id: string
  account_id: string
  name: string
  url: string
  secret_encrypted: string
  enabled: boolean
}

export interface DeliveryRow {
  id: string
  webhook_id: string
  rule_id: string | null
  account_id: string
  message_id: string | null
  status: DeliveryStatus
  attempts: number
  response_status: number | null
  duration_ms: number | null
  error: string | null
  next_attempt_at: Date | null
  payload: Record<string, unknown>
  created_at: Date
}

/**
 * Inscrit un envoi À FAIRE. Rend `null` quand ce mail est DÉJÀ parti par cette règle vers ce
 * webhook : c'est la contrainte d'unicité qui le dit, pas une lecture préalable — donc deux
 * planificateurs en parallèle n'en produisent quand même qu'un.
 */
export async function enqueueDelivery(args: {
  webhookId: string
  ruleId: string | null
  accountId: string
  messageId: string | null
  payload: Record<string, unknown>
}): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `INSERT INTO webhook_deliveries (webhook_id, rule_id, account_id, message_id, payload, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (webhook_id, rule_id, message_id) DO NOTHING
     RETURNING id`,
    [args.webhookId, args.ruleId, args.accountId, args.messageId, JSON.stringify(args.payload)]
  )
  return rows[0]?.id ?? null
}

/**
 * Le `deliveryId` de la charge utile doit être celui de la LIGNE : il est donc généré ici, puis
 * la charge utile est construite autour, puis la ligne est inscrite avec cet identifiant. Un
 * seul endroit sait faire ça correctement — W3 et la route d'essai passent par lui.
 */
export async function queueWebhookDelivery(args: {
  webhook: { id: string; accountId: string }
  rule: { id: string; name: string } | null
  account: { id: string; email: string }
  event: string
  message?: WebhookMessage | null
  tags?: Array<{ question: string; valeur: string }>
}): Promise<string | null> {
  const deliveryId = crypto.randomUUID()
  const payload = buildPayload({
    event: args.event,
    deliveryId,
    rule: args.rule,
    account: args.account,
    message: args.message ?? null,
    tags: args.tags,
  })
  const id = await enqueueDelivery({
    webhookId: args.webhook.id,
    ruleId: args.rule?.id ?? null,
    accountId: args.webhook.accountId,
    messageId: args.message?.messageId ?? null,
    payload: { ...payload, deliveryId },
  })
  if (!id) return null
  // L'identifiant de la LIGNE fait foi : la charge utile est recalée dessus.
  await query(`UPDATE webhook_deliveries SET payload = jsonb_set(payload, '{deliveryId}', to_jsonb($2::text)) WHERE id = $1`, [id, id])
  return id
}

/** Remet une ligne en file pour une tentative de plus (le « renvoyer » de la décision 7). */
export async function retryDelivery(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = NOW(), error = NULL
     WHERE id = $1 RETURNING id`,
    [id]
  )
  return rows.length > 0
}

/**
 * Un passage du planificateur : réclame les tentatives dues et les envoie.
 *
 * La réclamation POUSSE `next_attempt_at` d'un bail avant de travailler — deux passages (ou
 * deux instances) ne peuvent donc pas envoyer la même ligne. `FOR UPDATE SKIP LOCKED` comme
 * `processScheduledEmails`.
 *
 * ponytail: le bail est un délai fixe (10 min), pas un verrou tenu par le processus — un
 * processus tué pendant un envoi laisse sa ligne muette pendant ce bail au lieu d'être reprise
 * tout de suite. Plafond connu, coût nul ; chemin de sortie si une mesure le réclame : une
 * colonne `locked_by` relâchée au démarrage.
 */
export async function processWebhookDeliveries(): Promise<{ sent: number; failed: number }> {
  const due = await query<DeliveryRow>(
    `UPDATE webhook_deliveries SET next_attempt_at = NOW() + ($1 || ' milliseconds')::interval
     WHERE id IN (
       SELECT id FROM webhook_deliveries
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at LIMIT ${CLAIM_BATCH} FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [String(CLAIM_LEASE_MS)]
  )

  let sent = 0, failed = 0
  for (const row of due) {
    const [hook] = await query<WebhookRow>(
      `SELECT id, user_id, account_id, name, url, secret_encrypted, enabled FROM webhooks WHERE id = $1`,
      [row.webhook_id]
    )
    if (!hook || !hook.enabled) {
      await query(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, next_attempt_at = NULL, error = $2 WHERE id = $1`,
        [row.id, hook ? 'webhook désactivé' : 'webhook supprimé']
      )
      failed++
      continue
    }

    const event = String((row.payload as { event?: unknown })?.event ?? EVENT_RULE_MATCHED)
    const outcome = await sendWebhook(hook.url, decrypt(hook.secret_encrypted), event, row.id, row.payload)
    const attempts = row.attempts + 1

    if (outcome.ok) {
      await query(
        `UPDATE webhook_deliveries SET status = 'ok', attempts = $2, response_status = $3, duration_ms = $4,
                error = NULL, next_attempt_at = NULL WHERE id = $1`,
        [row.id, attempts, outcome.status, outcome.durationMs]
      )
      sent++
      continue
    }

    const retryIn = RETRY_DELAYS_MS[attempts - 1]
    const exhausted = attempts >= MAX_ATTEMPTS || retryIn === undefined
    await query(
      `UPDATE webhook_deliveries SET status = $5, attempts = $2, response_status = $3, duration_ms = $6,
              error = $4, next_attempt_at = $7 WHERE id = $1`,
      [
        row.id, attempts, outcome.status, (outcome.error ?? '').slice(0, ERROR_MAX),
        exhausted ? 'failed' : 'pending', outcome.durationMs,
        exhausted ? null : new Date(Date.now() + retryIn),
      ]
    )
    if (exhausted) failed++
  }
  return { sent, failed }
}

/** Le journal est une trace : au-delà de 30 jours, il part. Même schéma que `processApiKeyLogCleanup`. */
export async function purgeOldDeliveries(): Promise<number> {
  const gone = await query<{ id: string }>(
    `DELETE FROM webhook_deliveries WHERE created_at < NOW() - INTERVAL '${DELIVERY_RETENTION_DAYS} days' RETURNING id`
  )
  return gone.length
}

/** Le chiffré d'un secret, tel que la table le range. Une seule porte vers `lib/encrypt.ts`. */
export const sealSecret = (secret: string): string => encrypt(secret)

/**
 * L'envoi qu'une règle demande, inscrit À FAIRE. Une seule requête décide de tout ce qui doit
 * l'être : le webhook existe, il est ACTIF, il appartient à la boîte de la règle (donc une règle
 * ne peut pas faire appeler le webhook d'une autre boîte, même si un écrit avait laissé passer
 * l'incohérence) — et elle rend au passage l'adresse de la boîte que la charge utile nomme.
 *
 * Rend `null` sans rien inscrire quand le webhook ne tient pas cette condition, ou quand ce mail
 * est DÉJÀ parti par cette règle vers ce webhook (c'est l'unicité de `webhook_deliveries` qui le
 * dit — décision 7).
 */
export async function queueRuleDelivery(args: {
  webhookId: string
  rule: { id: string; name: string; accountId: string }
  message: WebhookMessage
  tags?: Array<{ question: string; valeur: string }>
}): Promise<string | null> {
  const [hook] = await query<{ id: string; account_id: string; email: string }>(
    `SELECT w.id, w.account_id, a.email
       FROM webhooks w JOIN email_accounts a ON a.id = w.account_id
      WHERE w.id = $1 AND w.account_id = $2 AND w.enabled = true`,
    [args.webhookId, args.rule.accountId]
  )
  if (!hook) return null
  return queueWebhookDelivery({
    webhook: { id: hook.id, accountId: hook.account_id },
    rule: { id: args.rule.id, name: args.rule.name },
    account: { id: hook.account_id, email: hook.email },
    event: EVENT_RULE_MATCHED,
    message: args.message,
    tags: args.tags,
  })
}

// ---------------------------------------------------------------------------
// Les webhooks comme OBJETS : ce que les routes et l'écran lisent et écrivent
// ---------------------------------------------------------------------------

/**
 * La forme rendue au dehors, construite en UNE requête : le webhook, son dernier envoi et
 * combien de règles le visent. Les deux dernières colonnes sont des sous-requêtes plutôt que
 * deux allers-retours par ligne — une liste de N webhooks reste une requête.
 *
 * `actions @> '[{"type":"webhook","value":"<id>"}]'` lit le JSONB des règles : c'est la même
 * forme que `applyAction` exécute, donc « ses déclencheurs » ne peut pas dériver de « ce qui
 * le déclenche vraiment ».
 */
const WEBHOOK_SELECT = `
  SELECT w.id, w.account_id, w.name, w.url, w.enabled, w.created_at,
         d.created_at AS last_at, d.status AS last_status, d.response_status AS last_response,
         (SELECT COUNT(*)::int FROM email_rules r
           WHERE r.account_id = w.account_id
             AND r.actions @> jsonb_build_array(jsonb_build_object('type', 'webhook', 'value', w.id::text))
         ) AS rule_count
    FROM webhooks w
    LEFT JOIN LATERAL (
      SELECT created_at, status, response_status FROM webhook_deliveries
       WHERE webhook_id = w.id ORDER BY created_at DESC LIMIT 1
    ) d ON true`

interface WebhookListRow {
  id: string
  account_id: string
  name: string
  url: string
  enabled: boolean
  created_at: Date
  last_at: Date | null
  last_status: string | null
  last_response: number | null
  rule_count: number
}

const rowToWebhook = (r: WebhookListRow): Webhook => ({
  id: r.id,
  accountId: r.account_id,
  name: r.name,
  url: r.url,
  enabled: r.enabled,
  createdAt: r.created_at.toISOString(),
  lastDelivery: r.last_at
    ? { at: r.last_at.toISOString(), status: r.last_status ?? 'pending', responseStatus: r.last_response }
    : null,
  ruleCount: r.rule_count ?? 0,
})

/** Les webhooks de cet utilisateur, éventuellement d'une seule boîte. */
export async function listWebhooks(userId: string, accountId?: string | null): Promise<Webhook[]> {
  const rows = await query<WebhookListRow>(
    `${WEBHOOK_SELECT} WHERE w.user_id = $1 AND ($2::uuid IS NULL OR w.account_id = $2)
      ORDER BY w.created_at DESC`,
    [userId, accountId ?? null]
  )
  return rows.map(rowToWebhook)
}

/** Un webhook, à condition qu'il soit à cet utilisateur. `null` sinon — jamais un 403 qui révèle. */
export async function getWebhook(id: string, userId: string): Promise<Webhook | null> {
  const rows = await query<WebhookListRow>(`${WEBHOOK_SELECT} WHERE w.id = $1 AND w.user_id = $2`, [id, userId])
  return rows.length ? rowToWebhook(rows[0]) : null
}

/**
 * Crée un webhook et rend son secret EN CLAIR — la seule fois, avec la régénération, où il
 * sort. L'adresse a déjà été contrôlée par l'appelant (`checkWebhookUrl`), qui sait rendre un
 * 422 nommant le motif du refus ; la refaire ici doublerait la résolution DNS.
 */
export async function createWebhook(args: {
  userId: string
  accountId: string
  name: string
  url: string
  enabled?: boolean
  createdByApiKey?: string | null
}): Promise<WebhookWithSecret> {
  const secret = newWebhookSecret()
  const rows = await query<{ id: string }>(
    `INSERT INTO webhooks (user_id, account_id, name, url, secret_encrypted, enabled, created_by_api_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [args.userId, args.accountId, args.name, args.url, sealSecret(secret), args.enabled ?? true, args.createdByApiKey ?? null]
  )
  const created = await getWebhook(rows[0].id, args.userId)
  if (!created) throw new Error('webhook créé puis introuvable')
  return { ...created, secret }
}

/** Modifie ce qui est donné, laisse le reste. `null` si le webhook n'est pas à cet utilisateur. */
export async function updateWebhook(
  id: string,
  userId: string,
  patch: { name?: string; url?: string; enabled?: boolean }
): Promise<Webhook | null> {
  const rows = await query<{ id: string }>(
    `UPDATE webhooks SET name = COALESCE($3, name), url = COALESCE($4, url), enabled = COALESCE($5, enabled)
      WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId, patch.name ?? null, patch.url ?? null, patch.enabled ?? null]
  )
  return rows.length ? getWebhook(id, userId) : null
}

export async function deleteWebhook(id: string, userId: string): Promise<boolean> {
  const rows = await query(`DELETE FROM webhooks WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId])
  return rows.length > 0
}

/**
 * Un secret neuf en remplacement de l'ancien, rendu en clair une fois. L'ancien cesse
 * immédiatement de valider : c'est le but — un secret qu'on régénère est un secret qu'on
 * suppose lu par quelqu'un d'autre.
 */
export async function rotateWebhookSecret(id: string, userId: string): Promise<string | null> {
  const secret = newWebhookSecret()
  const rows = await query<{ id: string }>(
    `UPDATE webhooks SET secret_encrypted = $3 WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId, sealSecret(secret)]
  )
  return rows.length ? secret : null
}

/** Le journal d'un webhook, le plus récent d'abord. Le nom de la règle et l'objet du mail viennent avec. */
export async function listDeliveries(webhookId: string, limit: number): Promise<WebhookDelivery[]> {
  const rows = await query<{
    id: string; webhook_id: string; rule_id: string | null; rule_name: string | null
    message_id: string | null; payload: Record<string, unknown>; status: string; attempts: number
    response_status: number | null; duration_ms: number | null; error: string | null
    next_attempt_at: Date | null; created_at: Date
  }>(
    `SELECT d.id, d.webhook_id, d.rule_id, r.name AS rule_name, d.message_id, d.payload, d.status,
            d.attempts, d.response_status, d.duration_ms, d.error, d.next_attempt_at, d.created_at
       FROM webhook_deliveries d LEFT JOIN email_rules r ON r.id = d.rule_id
      WHERE d.webhook_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
    [webhookId, limit]
  )
  return rows.map(r => {
    const message = (r.payload as { message?: { subject?: unknown } } | null)?.message
    return {
      id: r.id,
      webhookId: r.webhook_id,
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      messageId: r.message_id,
      subject: typeof message?.subject === 'string' ? message.subject : null,
      event: String((r.payload as { event?: unknown } | null)?.event ?? EVENT_RULE_MATCHED),
      status: r.status,
      attempts: r.attempts,
      responseStatus: r.response_status,
      durationMs: r.duration_ms,
      error: r.error,
      nextAttemptAt: r.next_attempt_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    }
  })
}

/** Une ligne de journal, à condition que son webhook soit à cet utilisateur. */
export async function getDeliveryOwned(id: string, userId: string): Promise<{ id: string; webhookId: string } | null> {
  const rows = await query<{ id: string; webhook_id: string }>(
    `SELECT d.id, d.webhook_id FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id = $1 AND w.user_id = $2`,
    [id, userId]
  )
  return rows.length ? { id: rows[0].id, webhookId: rows[0].webhook_id } : null
}

/**
 * Ce qu'une règle a le droit de viser (décision 9) : un webhook de LA MÊME boîte et du même
 * propriétaire. Rend le motif du refus en nommant l'action fautive, `null` si tout va bien.
 *
 * Écrit ici plutôt que dans `lib/rules.ts` parce que c'est la table `webhooks` qui répond —
 * et lu par les DEUX routes de règles, jamais recopié dans chacune. `queueRuleDelivery` refait
 * la même vérification à l'envoi : celle-ci rend une erreur LISIBLE à l'écriture, celle-là
 * ferme la porte si une incohérence était quand même entrée.
 */
export async function validateWebhookActions(
  actions: readonly { type?: string; value?: string }[],
  accountId: string,
  userId: string
): Promise<string | null> {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    if (a?.type !== 'webhook') continue
    const where = `action ${i + 1} (webhook)`
    if (!a.value) return `${where}: a webhook id is required`
    const rows = await query<{ id: string }>(
      `SELECT id FROM webhooks WHERE id = $1 AND account_id = $2 AND user_id = $3`,
      [a.value, accountId, userId]
    )
    if (!rows.length) return `${where}: webhook ${a.value} is not one of this mailbox's webhooks`
  }
  return null
}
