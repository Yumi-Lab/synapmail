/**
 * Synapmail — Email Rules Engine v2
 *
 * Full-featured rule evaluation + action execution.
 * Supports: from/to/cc/subject/body/size/date/list-unsubscribe/priority conditions,
 * move/mark/delete/forward actions, AND/OR logic, stop-processing, history logging.
 */

import { query } from './db'
import { markReadBulk, deleteMessagesBulk, moveMessagesBulk, markStarred } from './imap'
import { sendMail } from './smtp'
import type { AccountConfig } from './imap'
import type { Message } from '@/types/email'
import { valuesOf, type QuestionSet } from './tagging/questions'
import { messageIdOf, readEffectiveFor } from './tagging/store'
import { queueRuleDelivery, type WebhookMessage } from './webhooks'
import type { EmailRule, RuleCondition, RuleAction } from '@/types/rule'
import { REGEX_PATTERN_MAX } from '@/types/rule'
import { NO_TAGS, REGEX_OPERATORS, compileRulePattern, evaluateRule, type RuleTag } from './rulesEval'

// ---------------------------------------------------------------------------
// Conditions regex : les bornes, écrites UNE fois
// ---------------------------------------------------------------------------

// Les trois bornes vivent dans `types/rule.ts` : l'éditeur de règles, qui tourne dans le
// NAVIGATEUR, borne sa saisie sur la même valeur que le serveur. Les importer depuis ce
// fichier-ci y tirait `lib/imap.ts`, donc `tls`, et l'écran des règles ne se rendait plus.
export { REGEX_PATTERN_MAX, REGEX_TEXT_MAX, REGEX_BODY_MAX } from '@/types/rule'

/**
 * Ce qu'une condition doit valoir AVANT d'être enregistrée. Rend le motif de l'erreur en
 * NOMMANT la condition fautive — une règle enregistrée ne peut pas porter une regex qui ne
 * compile pas, donc `evalCondition` n'a jamais à s'en expliquer à l'exécution.
 * Une condition `tag` se juge contre le jeu de questions de la BOÎTE de la règle
 * (`questionSetForAccount`) : ses étiquettes répondent au jeu du propriétaire, pas à celui
 * de la main qui écrit la règle.
 */
export function validateConditions(conditions: readonly RuleCondition[], set: QuestionSet): string | null {
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i]
    const where = `condition ${i + 1} (${c?.field ?? '?'} ${c?.operator ?? '?'})`
    if (!c || typeof c !== 'object') return `${where}: malformed condition`
    if (REGEX_OPERATORS.has(c.operator)) {
      if (c.field === 'tag') return `${where}: the tag field takes equals / not_equals, not a pattern`
      if (typeof c.value !== 'string' || !c.value.length) return `${where}: pattern required`
      if (c.value.length > REGEX_PATTERN_MAX) {
        return `${where}: pattern longer than ${REGEX_PATTERN_MAX} characters (${c.value.length})`
      }
      if (!compileRulePattern(c.value)) return `${where}: invalid regular expression`
    }
    if (c.field === 'tag') {
      if (c.operator !== 'equals' && c.operator !== 'not_equals') {
        return `${where}: the tag field takes equals / not_equals`
      }
      const q = set.questionById(c.tagQuestion ?? '')
      if (!q) return `${where}: unknown tag question "${c.tagQuestion ?? ''}"`
      if (!valuesOf(q).includes(c.value)) {
        return `${where}: value "${c.value}" is not one of ${valuesOf(q).join(' / ')}`
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// DB row → domain type
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string
  user_id: string
  account_id: string
  name: string
  enabled: boolean
  priority: number
  condition_logic: string
  conditions: RuleCondition[]
  actions: { id: string; type: string; value?: string }[]
  stop_processing: boolean
  created_at: string
  updated_at: string
  last_run_at: string | null
  total_processed: number
  total_matched: number
}

function rowToRule(r: RuleRow): EmailRule {
  return {
    id: r.id,
    userId: r.user_id,
    accountId: r.account_id,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    conditionLogic: r.condition_logic as 'all' | 'any',
    conditions: r.conditions ?? [],
    actions: (r.actions ?? []) as EmailRule['actions'],
    stopProcessing: r.stop_processing,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at ?? null,
    totalProcessed: r.total_processed ?? 0,
    totalMatched: r.total_matched ?? 0,
  }
}

// ---------------------------------------------------------------------------
// DB CRUD
// ---------------------------------------------------------------------------

export async function getRulesForUser(userId: string): Promise<EmailRule[]> {
  const rows = await query<RuleRow>(
    `SELECT * FROM email_rules WHERE user_id = $1 ORDER BY priority ASC, created_at ASC`,
    [userId]
  )
  return rows.map(rowToRule)
}

export async function getEnabledRulesForAccount(accountId: string): Promise<EmailRule[]> {
  const rows = await query<RuleRow>(
    `SELECT * FROM email_rules WHERE account_id = $1 AND enabled = true ORDER BY priority ASC, created_at ASC`,
    [accountId]
  )
  return rows.map(rowToRule)
}

export async function getRuleById(id: string, userId: string): Promise<EmailRule | null> {
  const rows = await query<RuleRow>(
    `SELECT * FROM email_rules WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId]
  )
  return rows.length ? rowToRule(rows[0]) : null
}

export async function createRule(
  userId: string,
  accountId: string,
  data: Omit<EmailRule, 'id' | 'userId' | 'accountId' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'totalProcessed' | 'totalMatched'>
): Promise<EmailRule> {
  const rows = await query<RuleRow>(
    `INSERT INTO email_rules (user_id, account_id, name, enabled, priority, condition_logic, conditions, actions, stop_processing)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     RETURNING *`,
    [
      userId, accountId, data.name, data.enabled, data.priority, data.conditionLogic,
      JSON.stringify(data.conditions), JSON.stringify(data.actions), data.stopProcessing,
    ]
  )
  return rowToRule(rows[0])
}

export async function updateRule(
  id: string,
  userId: string,
  data: Partial<Omit<EmailRule, 'id' | 'userId' | 'accountId' | 'createdAt' | 'updatedAt'>>
): Promise<EmailRule | null> {
  const current = await getRuleById(id, userId)
  if (!current) return null

  const rows = await query<RuleRow>(
    `UPDATE email_rules
     SET name = $1, enabled = $2, priority = $3, condition_logic = $4,
         conditions = $5::jsonb, actions = $6::jsonb, stop_processing = $7,
         updated_at = NOW()
     WHERE id = $8 AND user_id = $9
     RETURNING *`,
    [
      data.name ?? current.name,
      data.enabled ?? current.enabled,
      data.priority ?? current.priority,
      data.conditionLogic ?? current.conditionLogic,
      JSON.stringify(data.conditions ?? current.conditions),
      JSON.stringify(data.actions ?? current.actions),
      data.stopProcessing ?? current.stopProcessing,
      id, userId,
    ]
  )
  return rows.length ? rowToRule(rows[0]) : null
}

export async function deleteRule(id: string, userId: string): Promise<boolean> {
  const rows = await query(`DELETE FROM email_rules WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId])
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// History logging
// ---------------------------------------------------------------------------

export async function logRuleExecution(
  ruleId: string,
  accountId: string,
  userId: string,
  folder: string,
  processed: number,
  matched: number
): Promise<void> {
  await query(
    `INSERT INTO rule_execution_log (rule_id, account_id, user_id, folder, processed, matched)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ruleId, accountId, userId, folder, processed, matched]
  )
  // Update cumulative stats on the rule
  await query(
    `UPDATE email_rules
     SET last_run_at = NOW(), total_processed = total_processed + $1, total_matched = total_matched + $2
     WHERE id = $3`,
    [processed, matched, ruleId]
  )
}

export async function getRecentLogs(
  ruleId: string,
  limit = 10
): Promise<Array<{ executedAt: string; folder: string; processed: number; matched: number }>> {
  const rows = await query<{
    executed_at: string; folder: string; processed: number; matched: number
  }>(
    `SELECT executed_at, folder, processed, matched FROM rule_execution_log
     WHERE rule_id = $1 ORDER BY executed_at DESC LIMIT $2`,
    [ruleId, limit]
  )
  return rows.map(r => ({ executedAt: r.executed_at, folder: r.folder, processed: r.processed, matched: r.matched }))
}

// L'évaluation des conditions vit dans `lib/rulesEval.ts` (pure) ; ré-exportée ici pour les appelants historiques.
export { evalCondition, evaluateRule, testRule, compileRulePattern, type RuleTag } from './rulesEval'

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

interface FullAccountRow {
  id: string
  email: string
  smtp_host: string; smtp_port: number; smtp_secure: boolean
  username: string; password_encrypted: string
  oauth_provider: string | null; oauth_access_token: string | null
  oauth_refresh_token: string | null; oauth_expires_at: number | null
}

export async function executeActions(
  account: AccountConfig,
  folder: string,
  uid: string,
  rule: EmailRule,
  fullMessage?: Message,  // needed for forward action
  tags: readonly RuleTag[] = NO_TAGS,  // voyagent dans la charge utile d'un webhook
  allowWebhook = false   // cf. `case 'webhook'` : refus par défaut, un appelant doit le DEMANDER
): Promise<{ movedOrDeleted: boolean }> {
  let movedOrDeleted = false

  for (const action of rule.actions) {
    try {
      switch (action.type) {
        case 'mark_read':
          await markReadBulk(account, folder, [uid], true)
          break
        case 'mark_unread':
          await markReadBulk(account, folder, [uid], false)
          break
        case 'mark_starred':
          await markStarred(account, folder, uid, true)
          break
        case 'mark_unstarred':
          await markStarred(account, folder, uid, false)
          break
        case 'move':
          if (action.value) {
            await moveMessagesBulk(account, folder, [uid], action.value)
            movedOrDeleted = true
          }
          break
        case 'delete':
          await deleteMessagesBulk(account, folder, [uid])
          movedOrDeleted = true
          break
        case 'forward':
          if (action.value && fullMessage && account.id) {
            await forwardMessage(account.id, fullMessage, action.value)
          } else if (action.value) {
            console.log(`[Rules] Forward: full message not available for uid ${uid}, skipping`)
          }
          break
        // L'action n'ENVOIE pas : elle inscrit un envoi à faire. Le planificateur le porte,
        // avec ses reprises — une règle ne doit pas attendre un récepteur de 10 s, ni perdre
        // l'envoi si le processus tombe entre l'évaluation et l'appel.
        //
        // REFUS PAR DÉFAUT. Seul un appelant à CURSEUR peut inscrire un envoi (`allowWebhook`),
        // parce que lui seul sait ce qui est NOUVEAU. Les autres appelants de `executeActions`
        // balayent un état, pas un flux : `processRules` repasse les 30 derniers non-lus toutes
        // les 5 min, `POST /api/rules/run` repasse un dossier entier à la demande — un webhook
        // y partirait sur du vieux courrier, soit l'historique rejoué que la décision 8 interdit.
        // C'est ici, au seul endroit qui exécute une action, que ce refus tient : un appelant
        // ajouté demain est protégé sans avoir à le savoir.
        case 'webhook':
          if (allowWebhook && action.value) {
            await queueRuleDelivery({
              webhookId: action.value,
              rule: { id: rule.id, name: rule.name, accountId: rule.accountId },
              message: webhookMessageOf(fullMessage ?? null, folder, uid),
              tags: tags.map(t => ({ question: t.question, valeur: t.valeur })),
            })
          }
          break
      }
    } catch (err) {
      console.error(`[Rules] Action ${action.type} failed for uid ${uid}:`, err)
    }
  }

  return { movedOrDeleted }
}

async function forwardMessage(accountId: string, msg: Message, to: string): Promise<void> {
  const accounts = await query<FullAccountRow>(
    'SELECT * FROM email_accounts WHERE id = $1 LIMIT 1',
    [accountId]
  )
  if (!accounts.length) return
  const acc = accounts[0]

  const fwdSubject = msg.subject.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject}`
  const fwdBody = `
    <p><em>--- Message transféré automatiquement ---</em></p>
    <p><strong>De :</strong> ${msg.from.name ? `${msg.from.name} &lt;${msg.from.address}&gt;` : msg.from.address}</p>
    <p><strong>Date :</strong> ${new Date(msg.date).toLocaleString('fr')}</p>
    <p><strong>Objet :</strong> ${msg.subject}</p>
    <hr>
    ${msg.bodyHtml ?? `<pre>${msg.bodyPlain ?? ''}</pre>`}
  `

  await sendMail(
    {
      id: acc.id,
      smtpHost: acc.smtp_host,
      smtpPort: acc.smtp_port,
      smtpSecure: acc.smtp_secure,
      username: acc.username,
      passwordEncrypted: acc.password_encrypted,
      oauthProvider: acc.oauth_provider,
      oauthAccessToken: acc.oauth_access_token,
      oauthRefreshToken: acc.oauth_refresh_token,
      oauthExpiresAt: acc.oauth_expires_at,
    },
    { from: acc.email, to: [to], subject: fwdSubject, html: fwdBody }
  )
}

/**
 * Ce qu'un webhook apprend du mail. `messageIdOf` (et pas `msg.messageId`) parce que c'est
 * l'identifiant qui porte l'unicité de `webhook_deliveries` : un mail sans `Message-ID` doit
 * quand même être reconnu comme le même mail au passage suivant. L'aperçu est borné par
 * `buildPayload`, jamais ici : une seule borne, écrite une seule fois.
 */
function webhookMessageOf(msg: Message | null, folder: string, uid: string): WebhookMessage {
  return {
    messageId: messageIdOf({
      messageId: msg?.messageId, fromAddress: msg?.from?.address, date: msg?.date, subject: msg?.subject,
    }),
    uid,
    folder,
    from: msg?.from ?? null,
    to: msg?.to ?? [],
    subject: msg?.subject ?? '',
    date: msg?.date ?? null,
    preview: msg?.preview ?? msg?.bodyPlain ?? '',
    hasAttachments: msg?.hasAttachments === true,
  }
}

// ---------------------------------------------------------------------------
// Batch: apply rules to a list of messages
// ---------------------------------------------------------------------------

export interface RuleResult {
  uid: string
  matchedRules: string[]
  movedOrDeleted: boolean
}

/** Une règle porte-t-elle au moins une condition sur une étiquette ? */
export const needsTags = (rules: readonly EmailRule[]): boolean =>
  rules.some(r => r.conditions.some(c => c.field === 'tag'))

/**
 * Les étiquettes EFFECTIVES (humain > moteur) des mails d'un lot, rangées par uid. Une seule
 * requête pour tout le lot, et seulement si une règle en a besoin — sinon rien n'est lu.
 */
export async function tagsForMessages(
  accountId: string,
  messages: readonly Message[],
  rules: readonly EmailRule[]
): Promise<Map<string, RuleTag[]> | undefined> {
  if (!needsTags(rules) || !messages.length) return undefined
  const idOf = new Map(messages.map(m => [m.uid, messageIdOf({
    messageId: m.messageId, fromAddress: m.from?.address, date: m.date, subject: m.subject,
  })]))
  const effective = await readEffectiveFor(accountId, Array.from(new Set(Array.from(idOf.values()))))
  const byUid = new Map<string, RuleTag[]>()
  idOf.forEach((messageId, uid) => {
    byUid.set(uid, (effective.get(messageId) ?? []).map(t => ({ question: t.question, valeur: t.valeur })))
  })
  return byUid
}

export async function applyRulesToMessages(
  account: AccountConfig,
  folder: string,
  messages: Message[],
  rules: EmailRule[],
  fullMessageFetcher?: (uid: string) => Promise<Message | null>,
  tagsByUid?: Map<string, RuleTag[]>,
  allowWebhook = false   // transmis tel quel à `executeActions` — cf. son `case 'webhook'`
): Promise<RuleResult[]> {
  const results: RuleResult[] = []

  for (const msg of messages) {
    const result: RuleResult = { uid: msg.uid, matchedRules: [], movedOrDeleted: false }
    const tags = tagsByUid?.get(msg.uid) ?? NO_TAGS

    for (const rule of rules) {
      if (evaluateRule(msg, rule, tags)) {
        result.matchedRules.push(rule.name)

        // Fetch full message if forward action is present and we have a fetcher
        let fullMsg: Message | undefined
        if (rule.actions.some(a => a.type === 'forward') && fullMessageFetcher) {
          fullMsg = (await fullMessageFetcher(msg.uid)) ?? undefined
        }

        const { movedOrDeleted } = await executeActions(account, folder, msg.uid, rule, fullMsg ?? msg, tags, allowWebhook)
        if (movedOrDeleted) result.movedOrDeleted = true

        if (result.movedOrDeleted || rule.stopProcessing) break
      }
    }

    if (result.matchedRules.length > 0) results.push(result)
  }

  return results
}

// ---------------------------------------------------------------------------
// Sieve script export
// ---------------------------------------------------------------------------

/**
 * Ce que Sieve ne sait PAS dire, nommé. Rendre `''` ici ferait disparaître la condition, puis
 * — si c'était la dernière — la règle entière, sans un mot : un script exporté qui trie moins
 * que la règle qu'il prétend traduire.
 */
function sieveActionUntranslatable(a: RuleAction): string | null {
  return a.type === 'webhook' ? `webhook ${a.value ?? '?'}` : null
}

function sieveUntranslatable(c: RuleCondition): string | null {
  if (c.operator === 'matches' || c.operator === 'not_matches') {
    return `${c.operator === 'not_matches' ? 'NOT ' : ''}regex on ${c.field}: /${c.value}/i`
  }
  if (c.field === 'tag') {
    return `tag ${c.tagQuestion ?? '?'} ${c.operator === 'not_equals' ? '!=' : '=='} ${c.value}`
  }
  return null
}

function sieveCondition(c: RuleCondition): string {
  if (sieveUntranslatable(c)) return ''
  switch (c.field) {
    case 'from':
    case 'to':
    case 'cc':
    case 'subject': {
      const header = { from: 'From', to: 'To', cc: 'Cc', subject: 'Subject' }[c.field]
      const negPrefix = c.operator.startsWith('not_') ? 'not ' : ''
      const match = c.operator === 'equals' || c.operator === 'not_equals' ? ':is' : ':contains'
      return `${negPrefix}header ${match} "${header}" "${c.value.replace(/"/g, '\\"')}"`
    }
    case 'has_attachments':
      return c.operator === 'is_true'
        ? 'header :matches "Content-Type" "multipart/mixed*"'
        : 'not header :matches "Content-Type" "multipart/mixed*"'
    case 'list_unsubscribe':
      return c.operator === 'is_true' ? 'exists "List-Unsubscribe"' : 'not exists "List-Unsubscribe"'
    case 'body':
      return `${c.operator === 'not_contains' ? 'not ' : ''}body :contains "${c.value.replace(/"/g, '\\"')}"`
    case 'size':
      if (c.operator === 'greater_than') return `size :over ${Math.round(parseFloat(c.value) * 1024)}`
      if (c.operator === 'less_than')    return `size :under ${Math.round(parseFloat(c.value) * 1024)}`
      return ''
    case 'date_received':
      return '' // Sieve date extension is complex — skip
    default:
      return ''
  }
}

function sieveAction(a: RuleAction, requires: Set<string>): string {
  switch (a.type) {
    case 'move':
      requires.add('fileinto')
      return `fileinto "${(a.value ?? '').replace(/"/g, '\\"')}";`
    case 'mark_read':
      requires.add('imap4flags')
      return 'addflag "\\\\Seen";'
    case 'mark_unread':
      requires.add('imap4flags')
      return 'removeflag "\\\\Seen";'
    case 'mark_starred':
      requires.add('imap4flags')
      return 'addflag "\\\\Flagged";'
    case 'mark_unstarred':
      requires.add('imap4flags')
      return 'removeflag "\\\\Flagged";'
    case 'delete':
      return 'discard;'
    case 'forward':
      return a.value ? `redirect "${a.value.replace(/"/g, '\\"')}";` : ''
    default:
      return ''
  }
}

export function generateSieveScript(rules: EmailRule[]): string {
  const requires = new Set<string>(['fileinto', 'imap4flags'])
  const blocks: string[] = [
    '# Synapmail — Règles auto-générées',
    `# Exporté le ${new Date().toISOString()}`,
    '',
  ]

  for (const rule of rules) {
    if (!rule.enabled || !rule.conditions.length || !rule.actions.length) continue

    const conds = rule.conditions.map(c => sieveCondition(c)).filter(Boolean)
    const acts  = rule.actions.map(a => sieveAction(a, requires)).filter(Boolean)
    // Ce que ce script NE FERA PAS, écrit dans le script lui-même.
    const dropped = [
      ...rule.conditions.map(c => sieveUntranslatable(c)),
      ...rule.actions.map(a => sieveActionUntranslatable(a)),
    ].filter(Boolean) as string[]
    const warn = dropped.length
      ? dropped.map(d => `#   condition not expressible in Sieve, evaluated by Synapmail only: ${d}`).join('\n') + '\n'
      : ''

    if (!conds.length || !acts.length) {
      if (warn) {
        blocks.push(`# ${rule.name}\n# RULE NOT EXPORTED — Synapmail evaluates it, this script does not:\n${warn}`.trimEnd())
      }
      continue
    }

    const condStr = conds.length === 1
      ? conds[0]
      : `${rule.conditionLogic === 'all' ? 'allof' : 'anyof'} (${conds.join(',\n        ')})`

    // `all` : une condition en moins RELÂCHE le filtre ; `any` : elle le RESSERRE.
    const widthNote = warn
      ? `#   the block below is therefore ${rule.conditionLogic === 'all' ? 'WIDER' : 'NARROWER'} than the rule\n`
      : ''
    let block = `# ${rule.name}\n${warn}${widthNote}if ${condStr} {\n`
    block += acts.map(a => `    ${a}`).join('\n') + '\n'
    if (rule.stopProcessing) block += '    stop;\n'
    block += '}'
    blocks.push(block)
  }

  const requireLine = `require [${Array.from(requires).map(r => `"${r}"`).join(', ')}];`
  return [requireLine, '', ...blocks].join('\n')
}
