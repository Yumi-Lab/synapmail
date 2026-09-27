/**
 * Le stockage des étiquettes : écrire ce qu'une source a décidé, relire ce qui a été décidé.
 *
 * Deux règles commandent tout ce fichier :
 *
 *  1. **Une étiquette n'entre que si sa valeur est PRÉVUE** (`isValidTag`). C'est la même porte
 *     que pour le moteur : ni un agent, ni un clic, ni un INSERT applicatif ne peuvent ranger
 *     une valeur inventée. Une écriture qui en contient une échoue ENTIÈREMENT (transaction),
 *     avec le nom de la question et de la valeur fautives — une route en fait un 422 qui NOMME.
 *  2. **Une étiquette de moteur n'est jamais entraînable** (décision 3). Le code ne l'écrit pas,
 *     et la base le refuse : la contrainte `message_tags_training_sources` (`lib/db.ts`) double
 *     la liste blanche `TRAINING_SOURCES`, donc même un INSERT SQL direct est rejeté.
 *
 * L'historique des corrections (décision 5) tient dans la clé primaire `(account_id, message_id,
 * question, source)` : la ligne `humain` s'AJOUTE à côté de celle du moteur au lieu de l'écraser,
 * et une seconde correction humaine remplace la première. L'étiquette EFFECTIVE est `humain`
 * s'il en existe une, sinon la plus récente d'un moteur.
 */
import { createHash } from 'crypto'
import { query } from '../db'
import { HUMAN_SOURCE, isEngineKind, trainingAllowed, type TagSource } from './engine'
import { engineQuestionsFor, isValidTag } from './questions'

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
  entrainementAutorise: boolean
  /** La version de la question à laquelle CETTE ligne répond — voir `questionVersion`. */
  questionVersion: string
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
 * Une session humaine écrit `humain`, toujours : c'est elle qui valide, et c'est la seule source
 * entraînable qu'on produise. Une clé API parle POUR un moteur, donc elle écrit le `kind` d'un
 * moteur — jamais `humain` ni `dossier`, sinon un agent blanchirait une réponse de moteur en
 * étiquette entraînable. C'est la même liste blanche que la contrainte de la base, prise par
 * l'autre bout : ici on refuse l'appelant, là-bas on refuse la ligne.
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
 * Écrit les étiquettes d'UNE source sur UN mail. UNE SEULE instruction les insère toutes
 * (`unnest` des colonnes) : elle est atomique par construction, donc soit toutes entrent, soit
 * aucune — sans transaction à ouvrir, et en un aller-retour au lieu d'un par étiquette. Les 41
 * questions d'un mail tiennent dans un seul INSERT.
 *
 * Une valeur non prévue jette `InvalidTagError` AVANT de toucher la base : inutile de l'ouvrir
 * pour refuser. `entrainement_autorise` n'est jamais un paramètre — il se DÉDUIT de la source
 * (liste blanche), ce qui rend impossible de blanchir une réponse de moteur en la demandant.
 *
 * La position du mail est enregistrée quand on la connaît : c'est ce qui permet au filtre par
 * étiquette de montrer un mail sorti de la fenêtre de `messages_cache`.
 */
export async function writeTags(params: {
  accountId: string
  messageId: string
  source: TagSource
  tags: TagToWrite[]
  modele?: string | null
  validePar?: string | null
  position?: TaggedMessagePosition | null
}): Promise<number> {
  const { accountId, messageId, source, tags } = params
  for (const t of tags) if (!isValidTag(t.question, t.valeur)) throw new InvalidTagError(t.question, t.valeur)
  if (!tags.length) return 0

  if (params.position) await upsertPosition(accountId, messageId, params.position)
  await query(
    `INSERT INTO message_tags (account_id, message_id, question, valeur, probabilites, confiance,
                               source, modele, valide_par, entrainement_autorise, question_version, cree_le)
     SELECT $1, $2, q.question, q.valeur, q.probabilites, q.confiance, $3, $4, $5, $6, q.question_version, NOW()
       FROM unnest($7::text[], $8::text[], $9::jsonb[], $10::real[], $11::text[])
              AS q(question, valeur, probabilites, confiance, question_version)
     ON CONFLICT (account_id, message_id, question, source) DO UPDATE SET
       valeur = EXCLUDED.valeur, probabilites = EXCLUDED.probabilites, confiance = EXCLUDED.confiance,
       modele = EXCLUDED.modele, valide_par = EXCLUDED.valide_par,
       entrainement_autorise = EXCLUDED.entrainement_autorise,
       question_version = EXCLUDED.question_version, cree_le = NOW()`,
    [accountId, messageId, source, params.modele ?? null, params.validePar ?? null,
      trainingAllowed(source),
      tags.map(t => t.question), tags.map(t => t.valeur),
      tags.map(t => (t.probabilites ? JSON.stringify(t.probabilites) : null)),
      tags.map(t => t.confiance ?? null), tags.map(t => questionVersion(t.question))]
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
  source: TagSource; modele: string | null; cree_le: Date; valide_par: string | null; entrainement_autorise: boolean
  question_version: string
}

const toStored = (r: TagRow): StoredTag => ({
  question: r.question, valeur: r.valeur, probabilites: r.probabilites, confiance: r.confiance,
  source: r.source, modele: r.modele, creeLe: r.cree_le, validePar: r.valide_par,
  entrainementAutorise: r.entrainement_autorise, questionVersion: r.question_version,
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
    `SELECT question, valeur, probabilites, confiance, source, modele, cree_le, valide_par,
            entrainement_autorise, question_version, ${EFFECTIVE_RANK} AS rang
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
       SELECT message_id, question, valeur, probabilites, confiance, source, modele, cree_le,
              valide_par, entrainement_autorise, question_version, ${EFFECTIVE_RANK} AS rang
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
 */
export async function filterByTag(params: {
  accountId: string; question: string; valeur: string; page?: number; perPage?: number
}): Promise<{ messages: TaggedMessage[]; total: number }> {
  const perPage = Math.min(Math.max(params.perPage ?? 50, 1), 200)
  const offset = (Math.max(params.page ?? 1, 1) - 1) * perPage
  const rows = await query<{ message_id: string; folder: string | null; uid: number | null; from_name: string | null
    from_address: string | null; subject: string | null; date: Date | null; total: string }>(
    `WITH ranked AS (
       SELECT message_id, question, valeur, ${EFFECTIVE_RANK} AS rang
         FROM message_tags WHERE account_id = $1 AND question = $2
     ), hits AS (
       SELECT message_id FROM ranked WHERE rang = 1 AND valeur = $3
     )
     SELECT h.message_id, t.folder, t.uid, t.from_name, t.from_address, t.subject, t.date,
            COUNT(*) OVER () AS total
       FROM hits h LEFT JOIN tagged_messages t ON t.account_id = $1 AND t.message_id = h.message_id
      ORDER BY t.date DESC NULLS LAST, h.message_id
      LIMIT $4 OFFSET $5`,
    [params.accountId, params.question, params.valeur, perPage, offset]
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
 * L'export, paginé par `id`. `entrainementOnly` filtre côté SERVEUR (décision 3) : le client ne
 * choisit pas ce qu'il a le droit de lire. Le filtre porte sur `entrainement_autorise`, que la
 * base ne laisse être vrai que pour `humain`/`dossier` — deux verrous pour la même règle.
 */
export async function exportTags(params: {
  accountId: string; entrainementOnly: boolean; after?: number; limit?: number
}): Promise<{ rows: (StoredTag & { id: number; messageId: string })[]; nextAfter: number | null }> {
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 5000)
  const rows = await query<TagRow & { id: string; message_id: string }>(
    `SELECT id, message_id, question, valeur, probabilites, confiance, source, modele, cree_le,
            valide_par, entrainement_autorise, question_version
       FROM message_tags
      WHERE account_id = $1 AND id > $2
        AND ($3::boolean IS NOT TRUE OR entrainement_autorise)
      ORDER BY id LIMIT $4`,
    [params.accountId, params.after ?? 0, params.entrainementOnly, limit]
  )
  return {
    rows: rows.map(r => ({ ...toStored(r), id: Number(r.id), messageId: r.message_id })),
    nextAfter: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
  }
}

/**
 * Les mails de cette boîte que cette source a DÉJÀ tagués, parmi ceux qu'on s'apprête à
 * demander : c'est ce qui fait sauter un mail au lieu de le repayer (lot T3). Un seul aller à la
 * base pour un petit lot, jamais une requête par mail.
 */
export async function alreadyTagged(accountId: string, source: TagSource, messageIds: string[]): Promise<Set<string>> {
  if (!messageIds.length) return new Set()
  const rows = await query<{ message_id: string }>(
    `SELECT DISTINCT message_id FROM message_tags
      WHERE account_id = $1 AND source = $2 AND message_id = ANY($3::text[])`,
    [accountId, source, messageIds]
  )
  return new Set(rows.map(r => r.message_id))
}
