/**
 * Le déclenchement (décision 8) : les règles qui portent une action `webhook` sont évaluées sur
 * les NOUVEAUX mails d'un dossier, toutes les 60 s, à partir d'un curseur d'UID.
 *
 * Trois choix commandent ce fichier :
 *
 *  1. **C'est un balayage SÉPARÉ de `processRules`.** Celui-ci relit les 30 derniers NON LUS
 *     toutes les 5 min : il ne verrait ni un mail déjà lu, ni le 31ᵉ, et il reverrait sans cesse
 *     les mêmes. Le modifier aurait changé le comportement des règles `move` / `delete` existantes,
 *     ce que le lot interdit. Il n'est pas touché.
 *  2. **Les actions des règles sont RÉDUITES à `webhook` avant l'évaluation** (`webhookRulesOf`).
 *     C'est ce qui garantit la non-régression : ce balayage ne peut ni déplacer, ni supprimer, ni
 *     transférer un mail, même si la règle le demande — ces actions restent le travail de
 *     `processRules`, une seule fois, à son rythme. Et comme il n'y a plus qu'une action possible,
 *     `applyRulesToMessages` est réutilisée telle quelle : aucune boucle d'évaluation en double.
 *     La réciproque est tenue AILLEURS, et pas ici : l'action `webhook` est refusée par défaut
 *     dans `executeActions` (`lib/rules.ts`), et ce balayage est le seul à l'autoriser. Réduire
 *     les actions ne protégeait que ce sens-ci ; `processRules`, qui ne passe pas par cette
 *     fonction, restait libre d'inscrire un envoi sur du vieux courrier.
 *  3. **Le corps n'est lu que si une condition le demande** (`needsBody`) : un dossier qui reçoit
 *     20 mails par minute ne télécharge rien de plus que leurs en-têtes quand aucune règle ne
 *     regarde le corps.
 *
 * La source de mails est INJECTÉE (`WebhookMailSource`) : le banc lui donne une fausse source,
 * donc il mesure ce fichier sans ouvrir une seule connexion vers une vraie boîte.
 */
import { query } from './db'
import { applyRulesToMessages, tagsForMessages } from './rules'
import type { ImapAccountRow } from './accounts'
import type { AccountConfig } from './imap'
import type { Message } from '@/types/email'
import type { EmailRule } from '@/types/rule'

/** Les dossiers balayés. Le même choix que `RULE_FOLDERS` de `lib/scheduler.ts`, pour la même raison. */
export const TRIGGER_FOLDERS = ['INBOX'] as const

/** Les mails pris par passage et par dossier. */
export const SCAN_BATCH = 20

/**
 * Ce qu'un passage traite au plus, par dossier.
 *
 * ponytail: un plafond fixe, pas une file d'attente. Le curseur partant du DERNIER UID connu, il
 * n'y a jamais d'historique à rattraper — seul un afflux de plus de 100 mails en 60 s le touche,
 * et le reste part au passage suivant (rien n'est perdu, le curseur n'a pas avancé). Chemin de
 * sortie si une mesure le réclame : un budget en temps comme `PASS_BUDGET_MS` du trieur.
 */
export const SCAN_CAP = 100

/**
 * D'où viennent les mails. Deux méthodes : où en est le dossier, et le lot suivant. `withBody`
 * est un PARAMÈTRE et non deux méthodes, parce que c'est exactement la décision que l'appelant
 * prend (une condition porte-t-elle sur le corps ?) et qu'une source doit l'honorer, pas la deviner.
 */
export interface WebhookMailSource {
  /** L'`uidValidity` du dossier et son dernier UID — ce dont un curseur neuf part. */
  state(folder: string): Promise<{ uidValidity: string; lastUid: number }>
  /** Les mails d'UID strictement supérieur à `afterUid`, par UID croissant. */
  fetch(folder: string, afterUid: number, limit: number, withBody: boolean): Promise<Message[]>
}

/** Une règle porte-t-elle une action `webhook` ? */
const hasWebhookAction = (r: EmailRule): boolean => r.actions.some(a => a.type === 'webhook')

/**
 * Les règles de ce balayage : celles qui appellent un webhook, RÉDUITES à cette seule action.
 * C'est ici, et nulle part ailleurs, que la non-régression de `processRules` est tenue.
 */
export function webhookRulesOf(rules: readonly EmailRule[]): EmailRule[] {
  return rules
    .filter(hasWebhookAction)
    .map(r => ({ ...r, actions: r.actions.filter(a => a.type === 'webhook') }))
}

/** Une de ces règles regarde-t-elle le corps du mail ? */
export const needsBody = (rules: readonly EmailRule[]): boolean =>
  rules.some(r => r.conditions.some(c => c.field === 'body'))

const readCursor = (accountId: string, folder: string) =>
  query<{ last_uid: string; uid_validity: string }>(
    `SELECT last_uid, uid_validity FROM webhook_cursors WHERE account_id = $1 AND folder = $2`,
    [accountId, folder]
  )

const saveCursor = (accountId: string, folder: string, lastUid: number, uidValidity: string) =>
  query(
    `INSERT INTO webhook_cursors (account_id, folder, last_uid, uid_validity, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (account_id, folder) DO UPDATE SET
       last_uid = EXCLUDED.last_uid, uid_validity = EXCLUDED.uid_validity, updated_at = NOW()`,
    [accountId, folder, lastUid, uidValidity]
  )

export interface ScanOutcome {
  /** Mails confrontés aux règles. */
  scanned: number
  /**
   * Mails sur lesquels au moins une règle a collé. Ce N'EST PAS le nombre d'envois inscrits : un
   * mail déjà parti par cette règle vers ce webhook colle toujours, et `queueRuleDelivery` rend
   * alors `null` sans rien inscrire. Le nombre d'envois, seule la table le sait — et c'est très
   * bien ainsi : l'unicité vit en base, pas dans un compteur qui pourrait en diverger.
   */
  matched: number
  /** Le passage n'a rien confronté : il vient de POSER le curseur, l'historique n'est pas rejoué. */
  primed: boolean
}

/**
 * UN passage sur UN dossier d'UNE boîte. Le curseur est enregistré après chaque lot : une coupure
 * ne coûte que le lot en cours, et ce qui est déjà parti ne repart pas de toute façon (l'unicité
 * de `webhook_deliveries`).
 */
export async function scanFolder(params: {
  accountId: string
  account: AccountConfig
  folder: string
  source: WebhookMailSource
  rules: readonly EmailRule[]
}): Promise<ScanOutcome> {
  const { accountId, account, folder, source } = params
  const rules = webhookRulesOf(params.rules)
  const out: ScanOutcome = { scanned: 0, matched: 0, primed: false }
  if (!rules.length) return out

  const st = await source.state(folder)
  const [known] = await readCursor(accountId, folder)

  // Première activation : le curseur est posé au dernier UID et RIEN n'est confronté — sinon
  // activer un webhook renverrait tout l'historique de la boîte au récepteur (décision 8).
  if (!known) {
    await saveCursor(accountId, folder, st.lastUid, st.uidValidity)
    out.primed = true
    return out
  }

  // Des UID qui ne désignent plus les mêmes mails rendent le curseur muet : on repart du dernier,
  // jamais de zéro — même raisonnement que le curseur du trieur (`lib/tagging/runner.ts`).
  let after = known.uid_validity === st.uidValidity ? Number(known.last_uid) : st.lastUid
  if (!Number.isFinite(after)) after = st.lastUid
  const withBody = needsBody(rules)

  while (out.scanned < SCAN_CAP) {
    const batch = await source.fetch(folder, after, Math.min(SCAN_BATCH, SCAN_CAP - out.scanned), withBody)
    if (!batch.length) break

    const tagsByUid = await tagsForMessages(accountId, batch, rules)
    // `true` : le SEUL appelant autorisé à inscrire un envoi — cf. `case 'webhook'` de
    // `lib/rules.ts`. C'est légitime ici parce que le curseur garantit que ce lot est NOUVEAU.
    const results = await applyRulesToMessages(account, folder, batch, rules, undefined, tagsByUid, true)
    out.scanned += batch.length
    out.matched += results.length

    after = batch[batch.length - 1].uid === undefined ? after : Number(batch[batch.length - 1].uid)
    await saveCursor(accountId, folder, after, st.uidValidity)
    if (batch.length < SCAN_BATCH) break
  }

  return out
}

/**
 * Les boîtes qui ont au moins une règle ACTIVE appelant un webhook — les SEULES à balayer. Une
 * instance sans webhook ne fait donc aucune connexion IMAP toutes les 60 s : c'est la requête
 * elle-même qui le garantit, pas un test dans la boucle.
 */
export const accountsToScan = (): Promise<Array<ImapAccountRow & { user_id: string }>> =>
  query(
    `SELECT DISTINCT a.id, a.user_id, a.imap_host, a.imap_port, a.imap_secure, a.username,
            a.password_encrypted, a.oauth_provider, a.oauth_access_token, a.oauth_refresh_token,
            a.oauth_expires_at
       FROM email_accounts a JOIN email_rules r ON r.account_id = a.id
      WHERE r.enabled = true AND r.actions @> '[{"type": "webhook"}]'::jsonb`
  )
