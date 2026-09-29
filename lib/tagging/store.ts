/**
 * Le stockage des étiquettes : écrire ce qu'une source a décidé, relire ce qui a été décidé.
 *
 * Une règle commande tout ce fichier :
 *
 *  1. **Une étiquette n'entre que si sa valeur est PRÉVUE** (`isValidTag`). C'est la même porte
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
import { HUMAN_SOURCE, isEngineKind, TAG_SOURCES, type TagSource } from './engine'
import { engineQuestionsFor, isValidTag, posedQuestions } from './questions'

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
 * (consigne + critères, `engineQuestionsFor` — la même fonction que la requête, donc rien à
 * tenir en accord à la main). Elle change dès qu'une définition change, et c'est tout son
 * intérêt : un export ne mélange plus jamais deux définitions d'une même question dans un seul
 * jeu d'entraînement.
 *
 * Calculée ICI et nulle part ailleurs, et pour TOUTES les sources : une correction humaine
 * porte la version de la question telle qu'elle a été posée, sinon la ligne `humain` et la
 * ligne du moteur qu'elle corrige passeraient pour deux réponses à deux questions différentes.
 *
 * Pas de cache : 41 hachages de quelques centaines d'octets par mail, hors de toute mesure
 * devant l'aller-retour à la base qui suit.
 */
const VERSION_CHARS = 12

export const questionVersion = (question: string): string =>
  createHash('sha256').update(JSON.stringify(engineQuestionsFor([question]))).digest('hex').slice(0, VERSION_CHARS)

/**
 * La version de la TAXONOMIE ENTIÈRE : le même hachage, sur le corps de TOUTES les questions
 * posées. `questionVersion` dit à quelle définition UNE étiquette répond ; celle-ci dit avec quel
 * JEU de questions un mail a été traité — c'est ce que le trieur compare pour décider de rejouer
 * une boîte (une question AJOUTÉE laisse les autres inchangées, donc aucune `questionVersion` ne
 * bouge, et sans cette version globale le mail serait sauté sans jamais recevoir la nouvelle).
 *
 * Constante et non fonction : la taxonomie ne change pas en cours de processus.
 */
export const TAXONOMY_VERSION: string =
  createHash('sha256').update(JSON.stringify(engineQuestionsFor())).digest('hex').slice(0, VERSION_CHARS)

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
}): Promise<number> {
  const { accountId, messageId, source, auteur, tags } = params
  for (const t of tags) if (!isValidTag(t.question, t.valeur)) throw new InvalidTagError(t.question, t.valeur)
  if (!tags.length) return 0

  if (params.position) await upsertPosition(accountId, messageId, params.position)
  await query(
    `INSERT INTO message_tags (account_id, message_id, question, valeur, probabilites, confiance,
                               source, modele, valide_par, question_version,
                               taxonomy_version, auteur_id, auteur_nom, cree_le)
     SELECT $1, $2, q.question, q.valeur, q.probabilites, q.confiance, $3, $4, $5, q.question_version,
            $11, $12, $13, NOW()
       FROM unnest($6::text[], $7::text[], $8::jsonb[], $9::real[], $10::text[])
              AS q(question, valeur, probabilites, confiance, question_version)
     ON CONFLICT (account_id, message_id, question, source, auteur_id, modele, question_version) DO UPDATE SET
       valeur = EXCLUDED.valeur, probabilites = EXCLUDED.probabilites, confiance = EXCLUDED.confiance,
       valide_par = EXCLUDED.valide_par, taxonomy_version = EXCLUDED.taxonomy_version,
       auteur_nom = EXCLUDED.auteur_nom, cree_le = NOW()`,
    [accountId, messageId, source, params.modele ?? '', params.validePar ?? null,
      tags.map(t => t.question), tags.map(t => t.valeur),
      tags.map(t => (t.probabilites ? JSON.stringify(t.probabilites) : null)),
      tags.map(t => t.confiance ?? null), tags.map(t => questionVersion(t.question)),
      TAXONOMY_VERSION, auteur.id, auteur.nom]
  )
  return tags.length
}

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
  question_version: string; auteur_id: string; auteur_nom: string
}

/** Les colonnes qu'une lecture rend, écrites UNE fois : les quatre lectures ci-dessous les partagent. */
const TAG_COLUMNS = `question, valeur, probabilites, confiance, source, modele, cree_le, valide_par,
            question_version, auteur_id, auteur_nom`

const toStored = (r: TagRow): StoredTag => ({
  question: r.question, valeur: r.valeur, probabilites: r.probabilites, confiance: r.confiance,
  source: r.source, modele: r.modele || null, creeLe: r.cree_le, validePar: r.valide_par,
  questionVersion: r.question_version, auteurId: r.auteur_id, auteurNom: r.auteur_nom,
})

/**
 * L'étiquette EFFECTIVE, en SQL, pour que le filtre et la liste lisent la même règle que le
 * volet de lecture (décision 5) : `humain` d'abord, sinon la plus récente d'un moteur. Ce
 * fragment est la SOURCE UNIQUE de cette règle — les trois lectures ci-dessous s'en servent,
 * aucune ne réécrit un `ORDER BY`.
 */
const EFFECTIVE_ORDER = `(source = '${HUMAN_SOURCE}') DESC, cree_le DESC`
const EFFECTIVE_RANK = `ROW_NUMBER() OVER (
  PARTITION BY account_id, message_id, question
  ORDER BY ${EFFECTIVE_ORDER}
)`

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
export async function readEffectiveFor(accountId: string, messageIds: string[]): Promise<Map<string, StoredTag[]>> {
  const byMessage = new Map<string, StoredTag[]>()
  if (!messageIds.length) return byMessage
  const rows = await query<TagRow & { message_id: string; rang: number }>(
    `SELECT * FROM (
       SELECT message_id, ${TAG_COLUMNS}, ${EFFECTIVE_RANK} AS rang
         FROM message_tags WHERE account_id = $1 AND message_id = ANY($2::text[])
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

/** L'export d'une boîte, paginé par `id` : toutes les lignes, toutes sources. */
export async function exportTags(params: {
  accountId: string; after?: number; limit?: number
}): Promise<{ rows: (StoredTag & { id: number; messageId: string })[]; nextAfter: number | null }> {
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 5000)
  const rows = await query<TagRow & { id: string; message_id: string }>(
    `SELECT id, message_id, ${TAG_COLUMNS}
       FROM message_tags
      WHERE account_id = $1 AND id > $2
      ORDER BY id LIMIT $3`,
    [params.accountId, params.after ?? 0, limit]
  )
  return {
    rows: rows.map(r => ({ ...toStored(r), id: Number(r.id), messageId: r.message_id })),
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
 * Restreinte à la taxonomie COURANTE : mélanger deux jeux de questions dans un même tableau
 * donnerait des totaux par question qui ne s'additionnent pas.
 */
export async function tagDistribution(accountId: string): Promise<Array<{ question: string; values: Array<{ valeur: string; count: number }> }>> {
  const rows = await query<{ question: string; valeur: string; n: string }>(
    `SELECT question, valeur, COUNT(*) AS n FROM (
       SELECT question, valeur, ${EFFECTIVE_RANK} AS rang
         FROM message_tags WHERE account_id = $1 AND taxonomy_version = $2
     ) r WHERE rang = 1
      GROUP BY question, valeur`,
    [accountId, TAXONOMY_VERSION]
  )
  const byQuestion = new Map<string, Array<{ valeur: string; count: number }>>()
  for (const r of rows) {
    const list = byQuestion.get(r.question) ?? []
    list.push({ valeur: r.valeur, count: Number(r.n) })
    byQuestion.set(r.question, list)
  }
  // L'ordre des questions est celui de `questions.ts`, et celui des valeurs le plus fréquent
  // d'abord : c'est ce qu'on lit dans une répartition, pas un ordre alphabétique.
  return posedQuestions()
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
 * `since`, tout tombe dans `before` : un appelant qui ne trie pas n'a rien à distinguer.
 */
export async function alreadyTagged(
  accountId: string, by: { source: TagSource; auteurId: string }, messageIds: string[], since?: Date | null
): Promise<{ before: Set<string>; during: Set<string> }> {
  if (!messageIds.length) return { before: new Set(), during: new Set() }
  // Le MÊME auteur sous la MÊME taxonomie (décision 23) : un autre moteur du même type ne fait
  // sauter aucun mail. ponytail: le modèle ANNONCÉ n'est connu qu'APRÈS avoir payé l'appel
  // (`jev-latest` configuré → `jev-1.13.0` annoncé), donc il n'entre pas dans le saut — le
  // comparer au modèle configuré ne matcherait jamais et repaierait chaque mail à chaque passage.
  // Retaguer sous une nouvelle version se fait en AJOUTANT un moteur (nouvel `auteur_id`). Voie
  // d'amélioration : retenir sur `decision_engines` le dernier modèle annoncé et le comparer ici.
  const rows = await query<{ message_id: string; during: boolean }>(
    `SELECT message_id, bool_or($5::timestamptz IS NOT NULL AND cree_le >= $5::timestamptz) AS during
       FROM message_tags
      WHERE account_id = $1 AND source = $2 AND auteur_id = $6
        AND taxonomy_version = $3 AND message_id = ANY($4::text[])
      GROUP BY message_id`,
    [accountId, by.source, TAXONOMY_VERSION, messageIds, since ?? null, by.auteurId]
  )
  const before = new Set<string>(), during = new Set<string>()
  for (const r of rows) (r.during ? during : before).add(r.message_id)
  return { before, during }
}
