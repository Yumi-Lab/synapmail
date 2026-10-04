/**
 * Le stockage des étiquettes : écrire ce qu'une source a décidé, relire ce qui a été décidé.
 *
 * Une règle commande tout ce fichier :
 *
 *  1. **Une étiquette n'entre que si sa valeur est PRÉVUE** par le jeu de questions du
 *     PROPRIÉTAIRE de la boîte (`QuestionSet.isValidTag`, lot T-Q). C'est la même porte
 *     que pour le moteur : ni un agent, ni un clic, ni un INSERT applicatif ne peuvent ranger
 *     une valeur inventée. Une écriture qui en contient une échoue ENTIÈREMENT (transaction),
 *     avec le nom de la question et de la valeur fautives — une route en fait un 422 qui NOMME.
 *
 * L'historique (décisions 5 et 23) tient dans la clé primaire `(account_id, message_id, question,
 * source, auteur_id, modele, question_version)` : chaque ligne porte son AUTEUR (le moteur, la
 * personne, le détecteur) et ce qu'il a annoncé. Rejouer exactement le même auteur + modèle +
 * version remplace la ligne ; tout autre auteur, modèle ou version s'AJOUTE, l'ancienne ligne
 * est gardée. L'étiquette EFFECTIVE est la `humain` la plus récente s'il en existe une, sinon la
 * plus récente d'un moteur — calculée sur TOUTES les lignes.
 */
import { createHash } from 'crypto'
import { query } from '../db'
import { HUMAN_SOURCE, RULE_SOURCE, isEngineKind, TAG_SOURCES, type EngineState, type TagSource } from './engine'
import { engineBodyOf, isRuleQuestionId, type QuestionSet, type TagQuestion } from './questions'
import { FIELDS, fieldTemplate, isFieldName, isValidFieldValue, type Candidate, type FieldValue } from './fields'
import { questionSetForAccount } from './userQuestions'

/**
 * Un mail sans `Message-ID` (ils existent) a tout de même besoin d'un identifiant STABLE, sinon
 * il serait retagué à chaque passage. Dérivé de trois champs qu'il ne peut pas changer sans être
 * un autre mail, calculé ICI et nulle part ailleurs (décision 6).
 */
export const DERIVED_ID_DOMAIN = 'synapmail.local'

export function messageIdOf(m: { messageId?: string | null; fromAddress?: string | null; date?: Date | string | null; subject?: string | null }): string {
  const given = (m.messageId ?? '').trim()
  if (given) return given
  const date = m.date instanceof Date ? m.date.toISOString() : String(m.date ?? '')
  const seed = `${m.fromAddress ?? ''}|${date}|${m.subject ?? ''}`
  return `<${createHash('sha256').update(seed).digest('hex')}@${DERIVED_ID_DOMAIN}>`
}

/**
 * La VERSION d'une question : les 12 premiers hex du SHA-256 du corps EXACT envoyé au moteur
 * (consigne + critères, `engineBodyOf` — la même fonction que la requête, donc rien à tenir en
 * accord à la main). Elle change dès qu'une définition change, et c'est tout son intérêt : un
 * export ne mélange plus jamais deux définitions d'une même question dans un seul jeu
 * d'entraînement. Depuis le lot T-Q elle est indépendante du compteur `version` affiché à
 * l'écran : deux utilisateurs qui écrivent la même consigne obtiennent la même version.
 *
 * Calculée ICI et nulle part ailleurs, et pour TOUTES les sources : une correction humaine
 * porte la version de la question telle qu'elle a été posée, sinon la ligne `humain` et la
 * ligne du moteur qu'elle corrige passeraient pour deux réponses à deux questions différentes.
 *
 * Pas de cache : 49 hachages de quelques centaines d'octets par mail, hors de toute mesure
 * devant l'aller-retour à la base qui suit.
 */
const VERSION_CHARS = 12
const shortSha256 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, VERSION_CHARS)

export const questionVersion = (q: TagQuestion): string => shortSha256(JSON.stringify(engineBodyOf(q)))

/**
 * La version de la TAXONOMIE ENTIÈRE d'un jeu : le même hachage, sur le corps de TOUTES les
 * questions ACTIVES. `questionVersion` dit à quelle définition UNE étiquette répond ; celle-ci
 * dit avec quel JEU de questions un mail a été traité — c'est ce que le trieur compare pour
 * décider de rejouer une boîte (une question AJOUTÉE laisse les autres inchangées, donc aucune
 * `questionVersion` ne bouge, et sans cette version globale le mail serait sauté sans jamais
 * recevoir la nouvelle). Une question DÉSACTIVÉE la change aussi : le jeu posé n'est plus le même.
 * Triée par id : l'ORDRE d'affichage n'est pas le jeu — déplacer une question (ou une migration
 * qui en insère une au milieu, lot T11b) ne doit pas rejouer la boîte.
 */
export const taxonomyVersion = (set: QuestionSet): string =>
  shortSha256(JSON.stringify([...set.enabled].sort((a, b) => a.id.localeCompare(b.id)).map(q => [q.id, engineBodyOf(q)])))

/**
 * L'INSTANTANÉ d'état (décision 14) : le hachage de l'état EXACT envoyé au moteur (`buildState`),
 * même recette que les versions. C'est ce qui permet de revérifier une étiquette : sans le texte
 * jugé, elle ne se relit plus. Une correction humaine porte le MÊME hachage que la ligne du
 * moteur qu'elle corrige (le dernier instantané du mail, `latestState`) : les deux parlent du
 * même texte.
 */
export const stateHash = (state: EngineState): string => shortSha256(JSON.stringify(state, canonicalKeys))

// `jsonb` RÉORDONNE les clés d'un objet : l'état relu de `tag_states` ne se sérialise plus
// octet pour octet comme celui envoyé (mesuré : hachage différent avant/après aller-retour).
// Les clés sont donc triées avant de hacher, à l'écriture comme à la relecture.
const canonicalKeys = (_: string, v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v

/** Le dernier instantané d'état connu d'un mail, ou `null` s'il n'a jamais été jugé. */
export async function latestState(accountId: string, messageId: string): Promise<EngineState | null> {
  const [row] = await query<{ state: EngineState }>(
    `SELECT state FROM tag_states WHERE account_id = $1 AND message_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [accountId, messageId]
  )
  return row?.state ?? null
}

export interface TagToWrite {
  question: string
  valeur: string
  probabilites?: Record<string, number> | null
  confiance?: number | null
}

/**
 * QUI écrit (décision 23) : l'id du moteur (`decision_engines.id`), de l'utilisateur ou du
 * détecteur, et son nom TEL QU'IL EST au moment d'écrire — l'instantané qui reste lisible une
 * fois le moteur renommé ou supprimé.
 */
export interface TagAuthor {
  id: string
  nom: string
}

/** Ce qu'une ligne de `message_tags` rend à la lecture. */
export interface StoredTag {
  question: string
  valeur: string
  probabilites: Record<string, number> | null
  confiance: number | null
  source: TagSource
  modele: string | null
  creeLe: Date
  validePar: string | null
  /** La version de la question à laquelle CETTE ligne répond — voir `questionVersion`. */
  questionVersion: string
  /** L'origine de la ligne : id de l'auteur (vide quand la migration n'a pu nommer personne) et son nom d'alors. */
  auteurId: string
  auteurNom: string
  /** L'instantané du texte jugé (`tag_states`, voir `stateHash`) ; vide quand il est inconnu. */
  stateHash: string
}

/** La position connue d'un mail tagué, pour le retrouver hors de la page chargée. */
export interface TaggedMessagePosition {
  folder?: string | null
  uid?: number | null
  fromName?: string | null
  fromAddress?: string | null
  subject?: string | null
  date?: Date | string | null
}

/** Une valeur refusée à l'entrée : la route qui la reçoit en fait un 422 qui la NOMME. */
export class InvalidTagError extends Error {
  question: string
  valeur: unknown
  constructor(question: string, valeur: unknown) {
    super(`valeur non prévue pour la question ${question}: ${JSON.stringify(valeur)}`)
    this.name = 'InvalidTagError'
    this.question = question
    this.valeur = valeur
  }
}

/** Une source refusée à l'écrivain qui la demande : la route en fait un 403 qui la NOMME. */
export class ForbiddenSourceError extends Error {
  source: unknown
  constructor(source: unknown) {
    super(`source ${JSON.stringify(source)} interdite à cet appelant`)
    this.name = 'ForbiddenSourceError'
    this.source = source
  }
}

/**
 * QUI a le droit d'écrire QUELLE source (décision 7), en UN endroit : la route qui écrit s'en
 * sert, elle ne redécide pas.
 *
 * Une session humaine écrit `humain`, toujours : c'est elle qui valide. Une clé API parle POUR un
 * moteur, donc elle écrit le `kind` d'un moteur — jamais `humain` ni `dossier`, sinon un agent
 * signerait une réponse de moteur comme validée par une main.
 */
export function sourceForWriter(params: { session: boolean; requested?: unknown }): TagSource {
  const requested = params.requested
  if (params.session) {
    if (requested !== undefined && requested !== null && requested !== HUMAN_SOURCE) throw new ForbiddenSourceError(requested)
    return HUMAN_SOURCE
  }
  // `regle` n'est pas un moteur (`ENGINES`) : seul le code du trieur la signe (lot T11b).
  if (!isEngineKind(requested)) throw new ForbiddenSourceError(requested ?? null)
  return requested
}

/**
 * QUI signe une écriture venue d'une route (décision 23), en UN endroit. Une session signe de
 * l'utilisateur. Une clé API signe du MOTEUR qu'elle nomme (`engineId`, qui doit appartenir au
 * même utilisateur — une clé ne peut pas usurper le moteur d'autrui) ou, sans moteur nommé, de
 * la clé elle-même : jamais d'un nom libre pris dans le corps de la requête.
 */
export async function authorForWriter(params: {
  userId: string; apiKeyId: string | null; engineId?: unknown
}): Promise<TagAuthor> {
  const { userId, apiKeyId } = params
  if (apiKeyId === null) {
    const [u] = await query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId])
    return { id: userId, nom: u?.name ?? '' }
  }
  if (typeof params.engineId === 'string' && params.engineId) {
    const [e] = await query<{ id: string; name: string }>(
      `SELECT id, name FROM decision_engines WHERE id = $1 AND user_id = $2`, [params.engineId, userId])
    if (!e) throw new ForbiddenSourceError(params.engineId)
    return { id: e.id, nom: e.name }
  }
  const [k] = await query<{ name: string }>(`SELECT name FROM api_keys WHERE id = $1`, [apiKeyId])
  return { id: apiKeyId, nom: k?.name ?? '' }
}

/**
 * Écrit les étiquettes d'UN auteur sur UN mail. UNE SEULE instruction les insère toutes
 * (`unnest` des colonnes) : elle est atomique par construction, donc soit toutes entrent, soit
 * aucune — sans transaction à ouvrir, et en un aller-retour au lieu d'un par étiquette. Les 41
 * questions d'un mail tiennent dans un seul INSERT.
 *
 * Le conflit se juge sur la clé ENTIÈRE (décision 23) : même auteur + même modèle annoncé + même
 * version de question → la ligne est remplacée (relance idempotente) ; tout autre cas ajoute une
 * ligne. `auteur_nom` est ré-instantané à chaque écriture : un moteur renommé signe de son nom
 * du jour, sans réécrire ses lignes passées.
 *
 * Une valeur non prévue jette `InvalidTagError` AVANT de toucher la base : inutile de l'ouvrir
 * pour refuser.
 *
 * La position du mail est enregistrée quand on la connaît : c'est ce qui permet au filtre par
 * étiquette de montrer un mail sorti de la fenêtre de `messages_cache`.
 */
export async function writeTags(params: {
  accountId: string
  messageId: string
  source: TagSource
  auteur: TagAuthor
  tags: TagToWrite[]
  modele?: string | null
  validePar?: string | null
  position?: TaggedMessagePosition | null
  /** Le jeu de questions de la boîte, quand l'appelant l'a déjà chargé (le trieur) ; sinon relu ici. */
  questions?: QuestionSet
  /** L'état jugé (décision 14) : enregistré dans `tag_states` et référencé par chaque ligne ; absent = inconnu. */
  state?: EngineState | null
}): Promise<number> {
  const { accountId, messageId, source, auteur, tags } = params
  const set = params.questions ?? await questionSetForAccount(accountId)
  for (const t of tags) {
    if (!set.isValidTag(t.question, t.valeur)) throw new InvalidTagError(t.question, t.valeur)
    // Un détecteur (lot T11b) est tranché par le programme ou corrigé par une main — jamais
    // signé d'un moteur, même par une clé qui parle pour lui.
    if (isEngineKind(source) && isRuleQuestionId(t.question)) throw new InvalidTagError(t.question, t.valeur)
  }
  if (!tags.length) return 0
  const versionOf = (question: string) => questionVersion(set.questionById(question)!)

  if (params.position) await upsertPosition(accountId, messageId, params.position)
  const hash = params.state ? stateHash(params.state) : ''
  if (params.state) await writeState(accountId, messageId, hash, params.state)
  await query(
    `INSERT INTO message_tags (account_id, message_id, question, valeur, probabilites, confiance,
                               source, modele, valide_par, question_version,
                               taxonomy_version, auteur_id, auteur_nom, state_hash, cree_le)
     SELECT $1, $2, q.question, q.valeur, q.probabilites, q.confiance, $3, $4, $5, q.question_version,
            $11, $12, $13, $14, NOW()
       FROM unnest($6::text[], $7::text[], $8::jsonb[], $9::real[], $10::text[])
              AS q(question, valeur, probabilites, confiance, question_version)
     ON CONFLICT (account_id, message_id, question, source, auteur_id, modele, question_version) DO UPDATE SET
       valeur = EXCLUDED.valeur, probabilites = EXCLUDED.probabilites, confiance = EXCLUDED.confiance,
       valide_par = EXCLUDED.valide_par, taxonomy_version = EXCLUDED.taxonomy_version,
       auteur_nom = EXCLUDED.auteur_nom, state_hash = EXCLUDED.state_hash, cree_le = NOW()`,
    [accountId, messageId, source, params.modele ?? '', params.validePar ?? null,
      tags.map(t => t.question), tags.map(t => t.valeur),
      tags.map(t => (t.probabilites ? JSON.stringify(t.probabilites) : null)),
      tags.map(t => t.confiance ?? null), tags.map(t => versionOf(t.question)),
      taxonomyVersion(set), auteur.id, auteur.nom, hash]
  )
  return tags.length
}

/** Un instantané n'est écrit qu'une fois par mail : le même texte revenu (relance, correction) ne coûte rien. */
const writeState = (accountId: string, messageId: string, hash: string, state: EngineState): Promise<unknown> =>
  query(
    `INSERT INTO tag_states (account_id, message_id, state_hash, state) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (account_id, message_id, state_hash) DO NOTHING`,
    [accountId, messageId, hash, JSON.stringify(state)]
  )

/** La dernière position connue d'un mail. Écrite par le trieur et par un PUT qui la fournit. */
export async function upsertPosition(accountId: string, messageId: string, p: TaggedMessagePosition): Promise<void> {
  await query(
    `INSERT INTO tagged_messages (account_id, message_id, folder, uid, from_name, from_address, subject, date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, message_id) DO UPDATE SET
       folder = COALESCE(EXCLUDED.folder, tagged_messages.folder),
       uid = COALESCE(EXCLUDED.uid, tagged_messages.uid),
       from_name = COALESCE(EXCLUDED.from_name, tagged_messages.from_name),
       from_address = COALESCE(EXCLUDED.from_address, tagged_messages.from_address),
       subject = COALESCE(EXCLUDED.subject, tagged_messages.subject),
       date = COALESCE(EXCLUDED.date, tagged_messages.date)`,
    [accountId, messageId, p.folder ?? null, p.uid ?? null, p.fromName ?? null,
      p.fromAddress ?? null, p.subject ?? null, p.date ?? null]
  )
}

type TagRow = {
  question: string; valeur: string; probabilites: Record<string, number> | null; confiance: number | null
  source: TagSource; modele: string; cree_le: Date; valide_par: string | null
  question_version: string; auteur_id: string; auteur_nom: string; state_hash: string
}

/** Les colonnes qu'une lecture rend, écrites UNE fois : les quatre lectures ci-dessous les partagent. */
const TAG_COLUMNS = `question, valeur, probabilites, confiance, source, modele, cree_le, valide_par,
            question_version, auteur_id, auteur_nom, state_hash`

const toStored = (r: TagRow): StoredTag => ({
  question: r.question, valeur: r.valeur, probabilites: r.probabilites, confiance: r.confiance,
  source: r.source, modele: r.modele || null, creeLe: r.cree_le, validePar: r.valide_par,
  questionVersion: r.question_version, auteurId: r.auteur_id, auteurNom: r.auteur_nom, stateHash: r.state_hash,
})

/**
 * L'étiquette EFFECTIVE, en SQL, pour que le filtre et la liste lisent la même règle que le
 * volet de lecture (décision 5) : `humain` d'abord, sinon la plus récente d'un moteur. Ce
 * fragment est la SOURCE UNIQUE de cette règle — les trois lectures ci-dessous s'en servent,
 * aucune ne réécrit un `ORDER BY`.
 */
export const EFFECTIVE_ORDER = `(source = '${HUMAN_SOURCE}') DESC, cree_le DESC`
const EFFECTIVE_RANK = `ROW_NUMBER() OVER (
  PARTITION BY account_id, message_id, question
  ORDER BY ${EFFECTIVE_ORDER}
)`

/**
 * Les lignes qui ont le droit de PESER sur la priorité d'une boîte (lot T12, gate du 03/10) :
 * une main, le trieur (`regle`), le moteur RATTACHÉ à la boîte, et les lignes d'origine inconnue
 * (`auteur_id = ''`, antérieures aux auteurs — écrites par le moteur de la boîte d'alors). Jamais un
 * moteur d'essai ni une clé de banc : mesuré sur la boîte réelle, 221 mails d'un moteur de test
 * répondant « oui » presque partout dominaient « à traiter ». L'AFFICHAGE garde la règle de
 * `GOAL.md` (effective sur toutes les lignes) ; seule la priorité se restreint. `$1` = account_id.
 */
const TRUSTED_ORIGIN = `(source IN ('${HUMAN_SOURCE}', '${RULE_SOURCE}') OR auteur_id = ''
  OR auteur_id IN (SELECT engine_id::text FROM mailbox_tagging WHERE account_id = $1 AND engine_id IS NOT NULL))`

/** Toutes les lignes d'un mail, toutes sources, plus l'effective par question. */
export async function readTags(accountId: string, messageId: string): Promise<{ tags: StoredTag[]; effective: StoredTag[] }> {
  const rows = await query<TagRow & { rang: number }>(
    `SELECT ${TAG_COLUMNS}, ${EFFECTIVE_RANK} AS rang
       FROM message_tags WHERE account_id = $1 AND message_id = $2
      ORDER BY question, ${EFFECTIVE_ORDER}`,
    [accountId, messageId]
  )
  return { tags: rows.map(toStored), effective: rows.filter(r => Number(r.rang) === 1).map(toStored) }
}

/**
 * Les étiquettes effectives d'une LISTE de mails : ce que la liste affiche en pastilles, en UNE
 * requête par page — jamais une par ligne.
 */
export async function readEffectiveFor(accountId: string, messageIds: string[], opts: { trusted?: boolean } = {}): Promise<Map<string, StoredTag[]>> {
  const byMessage = new Map<string, StoredTag[]>()
  if (!messageIds.length) return byMessage
  const rows = await query<TagRow & { message_id: string; rang: number }>(
    `SELECT * FROM (
       SELECT message_id, ${TAG_COLUMNS}, ${EFFECTIVE_RANK} AS rang
         FROM message_tags WHERE account_id = $1 AND message_id = ANY($2::text[])
          ${opts.trusted ? `AND ${TRUSTED_ORIGIN}` : ''}
     ) r WHERE rang = 1 ORDER BY message_id, question`,
    [accountId, messageIds]
  )
  for (const r of rows) {
    const list = byMessage.get(r.message_id) ?? []
    list.push(toStored(r))
    byMessage.set(r.message_id, list)
  }
  return byMessage
}

export interface TaggedMessage {
  messageId: string
  folder: string | null
  uid: number | null
  fromName: string | null
  fromAddress: string | null
  subject: string | null
  date: Date | null
}

/**
 * Les mails dont l'étiquette EFFECTIVE pour cette question porte cette valeur, avec leur
 * dernière position connue. Paginé. Une ligne du moteur CORRIGÉE par un humain ne ressort donc
 * plus sous l'ancienne valeur : c'est l'effective qui filtre, pas n'importe quelle ligne.
 *
 * `origine` restreint à UNE origine (décision 23) : une SOURCE (`humain` = ce qu'une main a
 * confirmé, quelle qu'elle soit) ou l'id d'un AUTEUR (un moteur précis). L'effective se calcule
 * alors parmi ces lignes seules — « ce que CE moteur a répondu », pas ce que la boîte retient.
 */
export async function filterByTag(params: {
  accountId: string; question: string; valeur: string; origine?: string | null; page?: number; perPage?: number
}): Promise<{ messages: TaggedMessage[]; total: number }> {
  const perPage = Math.min(Math.max(params.perPage ?? 50, 1), 200)
  const offset = (Math.max(params.page ?? 1, 1) - 1) * perPage
  const origine = params.origine || null
  const bySource = origine !== null && (TAG_SOURCES as readonly string[]).includes(origine)
  const rows = await query<{ message_id: string; folder: string | null; uid: number | null; from_name: string | null
    from_address: string | null; subject: string | null; date: Date | null; total: string }>(
    `WITH ranked AS (
       SELECT message_id, question, valeur, ${EFFECTIVE_RANK} AS rang
         FROM message_tags WHERE account_id = $1 AND question = $2
          AND ($6::text IS NULL OR source = $6) AND ($7::text IS NULL OR auteur_id = $7)
     ), hits AS (
       SELECT message_id FROM ranked WHERE rang = 1 AND valeur = $3
     )
     SELECT h.message_id, t.folder, t.uid, t.from_name, t.from_address, t.subject, t.date,
            COUNT(*) OVER () AS total
       FROM hits h LEFT JOIN tagged_messages t ON t.account_id = $1 AND t.message_id = h.message_id
      ORDER BY t.date DESC NULLS LAST, h.message_id
      LIMIT $4 OFFSET $5`,
    [params.accountId, params.question, params.valeur, perPage, offset,
      bySource ? origine : null, bySource ? null : origine]
  )
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    messages: rows.map(r => ({
      messageId: r.message_id, folder: r.folder, uid: r.uid, fromName: r.from_name,
      fromAddress: r.from_address, subject: r.subject, date: r.date,
    })),
  }
}

/**
 * L'export d'une boîte, paginé par `id` : toutes les lignes, toutes sources, chacune avec la
 * version de sa question ET l'état jugé (décision 14) — un jeu d'entraînement se relit sans la
 * boîte. `state` est `null` quand l'instantané est inconnu (`state_hash` vide).
 */
export async function exportTags(params: {
  accountId: string; after?: number; limit?: number
}): Promise<{ rows: (StoredTag & { id: number; messageId: string; state: EngineState | null })[]; nextAfter: number | null }> {
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 5000)
  const rows = await query<TagRow & { id: string; message_id: string; state: EngineState | null }>(
    `SELECT t.*, s.state
       FROM (SELECT id, account_id, message_id, ${TAG_COLUMNS}
               FROM message_tags
              WHERE account_id = $1 AND id > $2
              ORDER BY id LIMIT $3) t
       LEFT JOIN tag_states s ON s.account_id = t.account_id AND s.message_id = t.message_id AND s.state_hash = t.state_hash
      ORDER BY t.id`,
    [params.accountId, params.after ?? 0, limit]
  )
  return {
    rows: rows.map(r => ({ ...toStored(r), id: Number(r.id), messageId: r.message_id, state: r.state })),
    nextAfter: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
  }
}

/**
 * La RÉPARTITION des valeurs, par question, sur les mails d'une boîte : ce que l'écran de tri
 * montre après un échantillon, pour décider de lancer le reste ou de revoir la taxonomie.
 *
 * Elle porte sur l'étiquette EFFECTIVE (même règle que la liste et le volet de lecture, par
 * `EFFECTIVE_RANK`) : une valeur corrigée à la main compte pour la correction, pas pour ce que le
 * moteur avait dit — sinon la répartition décrirait le moteur au lieu de décrire la boîte.
 *
 * Restreinte, QUESTION PAR QUESTION, aux lignes qui répondent à sa définition COURANTE
 * (`question_version`, le complément exact de `staleCounts`) : mélanger deux définitions d'une
 * même question donnerait des valeurs qui ne s'additionnent pas. Pas à la taxonomie entière :
 * `taxonomyVersion` change dès qu'on (dés)active N'IMPORTE QUELLE question, et un simple
 * interrupteur ferait perdre la mesure de toutes les autres (lot T-Q3b).
 */
export async function tagDistribution(accountId: string): Promise<Array<{ question: string; values: Array<{ valeur: string; count: number }> }>> {
  const set = await questionSetForAccount(accountId)
  const rows = await query<{ question: string; valeur: string; n: string }>(
    `SELECT question, valeur, COUNT(*) AS n FROM (
       SELECT question, valeur, ${EFFECTIVE_RANK} AS rang
         FROM message_tags WHERE account_id = $1
          AND (question, question_version) IN (SELECT * FROM unnest($2::text[], $3::text[]))
     ) r WHERE rang = 1
      GROUP BY question, valeur`,
    [accountId, set.enabled.map(q => q.id), set.enabled.map(questionVersion)]
  )
  const byQuestion = new Map<string, Array<{ valeur: string; count: number }>>()
  for (const r of rows) {
    const list = byQuestion.get(r.question) ?? []
    list.push({ valeur: r.valeur, count: Number(r.n) })
    byQuestion.set(r.question, list)
  }
  // L'ordre des questions est celui du jeu de l'utilisateur, et celui des valeurs le plus fréquent
  // d'abord : c'est ce qu'on lit dans une répartition, pas un ordre alphabétique.
  return set.posed()
    .filter(q => byQuestion.has(q.id))
    .map(q => ({
      question: q.id,
      values: (byQuestion.get(q.id) ?? []).sort((a, b) => b.count - a.count || (a.valeur < b.valeur ? -1 : 1)),
    }))
}

/**
 * Les mails de cette boîte que CET auteur a DÉJÀ tagués SOUS LA TAXONOMIE COURANTE, parmi ceux
 * qu'on s'apprête à demander : c'est ce qui fait sauter un mail au lieu de le repayer (lot T3).
 * Un seul aller à la base pour un petit lot, jamais une requête par mail.
 *
 * Le filtre par `taxonomy_version` est ce qui fait rejouer une boîte après un changement de
 * taxonomie, au lieu de sauter des mails qui n'auraient jamais la question neuve. C'est voulu, et
 * ça coûte : la relance repasse la boîte entière, sous le même plafond et les mêmes pauses.
 *
 * Le résultat est SÉPARÉ EN DEUX par `since` (l'instant où le tri courant a démarré) : `before`
 * = tagué AVANT ce tri, donc sauté pour de bon et à compter comme tel ; `during` = tagué PAR ce
 * tri, donc déjà compté en « tagués » et relu seulement parce qu'un lot coupé au délai ne fait
 * pas avancer son curseur — le compter en « sautés » serait un double compte (lot T10c). Sans
 * `sinceTagId`, tout tombe dans `before` : un appelant qui ne trie pas n'a rien à distinguer.
 * La borne est un IDENTIFIANT (`message_tags.id`, séquence monotone), pas une date : `cree_le`
 * suit l'horloge de Postgres, qui recule sous Docker Desktop (voir `lib/db.ts`).
 */
export async function alreadyTagged(
  accountId: string, by: { source: TagSource; auteurId: string; questions?: QuestionSet }, messageIds: string[], sinceTagId?: string | number | null
): Promise<{ before: Set<string>; during: Set<string> }> {
  if (!messageIds.length) return { before: new Set(), during: new Set() }
  const set = by.questions ?? await questionSetForAccount(accountId)
  // Le MÊME auteur sous la MÊME taxonomie (décision 23) : un autre moteur du même type ne fait
  // sauter aucun mail. ponytail: le modèle ANNONCÉ n'est connu qu'APRÈS avoir payé l'appel
  // (`jev-latest` configuré → `jev-1.13.0` annoncé), donc il n'entre pas dans le saut — le
  // comparer au modèle configuré ne matcherait jamais et repaierait chaque mail à chaque passage.
  // Retaguer sous une nouvelle version se fait en AJOUTANT un moteur (nouvel `auteur_id`). Voie
  // d'amélioration : retenir sur `decision_engines` le dernier modèle annoncé et le comparer ici.
  const rows = await query<{ message_id: string; during: boolean }>(
    `SELECT message_id, bool_or($5::bigint IS NOT NULL AND id > $5::bigint) AS during
       FROM message_tags
      WHERE account_id = $1 AND source = $2 AND auteur_id = $6
        AND taxonomy_version = $3 AND message_id = ANY($4::text[])
      GROUP BY message_id`,
    [accountId, by.source, taxonomyVersion(set), messageIds, sinceTagId ?? null, by.auteurId]
  )
  const before = new Set<string>(), during = new Set<string>()
  for (const r of rows) (r.during ? during : before).add(r.message_id)
  return { before, during }
}

// ---------------------------------------------------------------- valeurs extraites (lot T11)

/** Ce qu'une ligne de `message_fields` rend à la lecture : une étiquette dont la valeur est LUE, pas prévue. */
export interface StoredField extends Omit<StoredTag, 'probabilites' | 'confiance' | 'stateHash'> {
  candidats: Candidate[] | null
}

/** Une valeur de champ refusée à l'entrée : même refus nommé qu'une étiquette (422). */
export class InvalidFieldError extends InvalidTagError {
  constructor(champ: string, valeur: unknown) {
    super(champ, valeur)
    this.name = 'InvalidFieldError'
  }
}

/**
 * Écrit les valeurs extraites d'UN auteur sur UN mail — même forme, même clé, même conflit que
 * `writeTags` : la version est celle du GABARIT du champ (`fieldTemplate`, sans les candidats
 * qui changent à chaque mail), la validation est `isValidFieldValue` pour toute source.
 */
export async function writeFields(params: {
  accountId: string
  messageId: string
  source: TagSource
  auteur: TagAuthor
  fields: FieldValue[]
  modele?: string | null
  validePar?: string | null
}): Promise<number> {
  const { accountId, messageId, source, auteur, fields } = params
  for (const f of fields) if (!isFieldName(f.champ) || !isValidFieldValue(f.champ, f.valeur)) throw new InvalidFieldError(f.champ, f.valeur)
  if (!fields.length) return 0
  await query(
    `INSERT INTO message_fields (account_id, message_id, question, valeur, candidats,
                                 source, modele, valide_par, question_version, auteur_id, auteur_nom, cree_le)
     SELECT $1, $2, q.question, q.valeur, q.candidats, $3, $4, $5, q.question_version, $9, $10, NOW()
       FROM unnest($6::text[], $7::text[], $8::jsonb[], $11::text[]) AS q(question, valeur, candidats, question_version)
     ON CONFLICT (account_id, message_id, question, source, auteur_id, modele, question_version) DO UPDATE SET
       valeur = EXCLUDED.valeur, candidats = EXCLUDED.candidats, valide_par = EXCLUDED.valide_par,
       auteur_nom = EXCLUDED.auteur_nom, cree_le = NOW()`,
    [accountId, messageId, source, params.modele ?? '', params.validePar ?? null,
      fields.map(f => f.champ), fields.map(f => f.valeur),
      fields.map(f => (f.candidats?.length ? JSON.stringify(f.candidats) : null)),
      auteur.id, auteur.nom, fields.map(f => questionVersion(fieldTemplate(f.champ)))]
  )
  return fields.length
}

type FieldRow = Omit<TagRow, 'probabilites' | 'confiance'> & { candidats: Candidate[] | null }

const FIELD_COLUMNS = `question, valeur, candidats, source, modele, cree_le, valide_par, question_version, auteur_id, auteur_nom`

const toField = (r: FieldRow): StoredField => ({
  question: r.question, valeur: r.valeur, candidats: r.candidats, source: r.source, modele: r.modele || null,
  creeLe: r.cree_le, validePar: r.valide_par, questionVersion: r.question_version, auteurId: r.auteur_id, auteurNom: r.auteur_nom,
})

/**
 * Toutes les valeurs d'un mail, toutes sources, plus l'effective par champ — même règle que
 * `readTags`. Dans l'ordre MÉTIER de `FIELDS` (montant, devise, type…), pas l'alphabétique.
 */
export async function readFields(accountId: string, messageId: string): Promise<{ fields: StoredField[]; effective: StoredField[] }> {
  const rows = await query<FieldRow & { rang: number }>(
    `SELECT ${FIELD_COLUMNS}, ${EFFECTIVE_RANK} AS rang
       FROM message_fields WHERE account_id = $1 AND message_id = $2
      ORDER BY array_position($3::text[], question), ${EFFECTIVE_ORDER}`,
    [accountId, messageId, [...FIELDS]]
  )
  return { fields: rows.map(toField), effective: rows.filter(r => Number(r.rang) === 1).map(toField) }
}

/**
 * Les valeurs effectives d'UNE LISTE de mails, en UNE requête — le pendant de `readEffectiveFor` :
 * la liste des documents GED (toutes origines, ordre MÉTIER de `FIELDS`) et la priorité (lot T12 :
 * l'échéance extraite pèse — `trusted`, restreint aux origines de confiance).
 */
export async function readEffectiveFieldsFor(accountId: string, messageIds: string[], opts: { trusted?: boolean } = {}): Promise<Map<string, StoredField[]>> {
  const byMessage = new Map<string, StoredField[]>()
  if (!messageIds.length) return byMessage
  const rows = await query<FieldRow & { message_id: string; rang: number }>(
    `SELECT * FROM (
       SELECT message_id, ${FIELD_COLUMNS}, ${EFFECTIVE_RANK} AS rang
         FROM message_fields WHERE account_id = $1 AND message_id = ANY($2::text[])
          ${opts.trusted ? `AND ${TRUSTED_ORIGIN}` : ''}
     ) r WHERE rang = 1 ORDER BY message_id, array_position($3::text[], question)`,
    [accountId, messageIds, [...FIELDS]]
  )
  for (const r of rows) {
    const list = byMessage.get(r.message_id) ?? []
    list.push(toField(r))
    byMessage.set(r.message_id, list)
  }
  return byMessage
}
