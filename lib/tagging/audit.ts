/**
 * La FIABILITÉ se prouve (décision 16, lot T14) : un échantillon tiré AU HASARD parmi les mails
 * qu'un moteur a étiquetés, proposé à la validation humaine SANS regarder la confiance — la
 * seule mesure non biaisée de l'exactitude. Les validations faites ailleurs (un clic sur un mail
 * ouvert parce qu'il intriguait) comptent comme validations, jamais comme mesure : elles
 * sur-représentent ce qui a l'air faux.
 *
 * Le tirage est ENREGISTRÉ (`tag_audits`), jamais recalculé : un mail tiré le reste, et un
 * second tirage COMPLÈTE jusqu'à la cible au lieu de remplacer. Aucun appel moteur : tout ici
 * est de la lecture de `message_tags`.
 */
import { query } from '../db'
import { ENGINES, HUMAN_SOURCE } from './engine'
import { questionVersion, type TaggedMessage } from './store'
import { questionSetForAccount } from './userQuestions'

/** La part des mails étiquetés qu'on tire, et le plancher en dessous duquel un taux ne dit rien. */
export const AUDIT_RATE = 0.02
export const AUDIT_MIN = 50

/** La cible du tirage pour N mails étiquetés : 2 %, au moins 50, jamais plus que N. */
export const auditTarget = (tagged: number): number => Math.min(tagged, Math.max(AUDIT_MIN, Math.ceil(tagged * AUDIT_RATE)))

/** Les mails qu'un MOTEUR a étiquetés : seuls eux ont une exactitude à mesurer. `$1` = account_id. */
const ENGINE_TAGGED = `SELECT DISTINCT message_id FROM message_tags
  WHERE account_id = $1 AND source IN (${ENGINES.map(e => `'${e}'`).join(', ')})`

export interface AuditStatus {
  /** Les mails qu'un moteur a étiquetés dans cette boîte. */
  tagged: number
  /** La cible du tirage pour ce nombre (`auditTarget`). */
  target: number
  /** Les mails tirés jusqu'ici. */
  drawn: number
  /** Les mails tirés qu'une main a jugés (au moins une ligne `humain`). */
  validated: number
}

export async function auditStatus(accountId: string): Promise<AuditStatus> {
  const [r] = await query<{ tagged: string; drawn: string; validated: string }>(
    `SELECT (SELECT COUNT(*) FROM (${ENGINE_TAGGED}) t) AS tagged,
            (SELECT COUNT(*) FROM tag_audits WHERE account_id = $1) AS drawn,
            (SELECT COUNT(*) FROM tag_audits a WHERE a.account_id = $1
               AND EXISTS (SELECT 1 FROM message_tags h WHERE h.account_id = $1 AND h.message_id = a.message_id AND h.source = '${HUMAN_SOURCE}')) AS validated`,
    [accountId]
  )
  const tagged = Number(r.tagged)
  return { tagged, target: auditTarget(tagged), drawn: Number(r.drawn), validated: Number(r.validated) }
}

/**
 * Tire au hasard ce qui manque pour atteindre la cible, parmi les mails étiquetés PAS ENCORE
 * tirés. `ORDER BY random()` de Postgres : uniforme, et une boîte de 100 000 étiquetés reste
 * une seule requête. Rend l'état après tirage.
 */
export async function drawAudit(accountId: string): Promise<AuditStatus & { added: number }> {
  const before = await auditStatus(accountId)
  const missing = before.target - before.drawn
  if (missing <= 0) return { ...before, added: 0 }
  const added = await query<{ message_id: string }>(
    `INSERT INTO tag_audits (account_id, message_id)
     SELECT $1, message_id FROM (${ENGINE_TAGGED}) t
      WHERE NOT EXISTS (SELECT 1 FROM tag_audits a WHERE a.account_id = $1 AND a.message_id = t.message_id)
      ORDER BY random() LIMIT $2
     RETURNING message_id`,
    [accountId, missing]
  )
  return { ...before, drawn: before.drawn + added.length, added: added.length }
}

/** Les mails tirés qu'aucune main n'a encore jugés, avec leur position connue — ce que la liste propose à valider. */
export async function auditPending(accountId: string, page = 1, perPage = 50): Promise<{ messages: TaggedMessage[]; total: number }> {
  const limit = Math.min(Math.max(perPage, 1), 200)
  const offset = (Math.max(page, 1) - 1) * limit
  const rows = await query<{ message_id: string; folder: string | null; uid: number | null; from_name: string | null
    from_address: string | null; subject: string | null; date: Date | null; total: string }>(
    `SELECT a.message_id, t.folder, t.uid, t.from_name, t.from_address, t.subject, t.date, COUNT(*) OVER () AS total
       FROM tag_audits a
       LEFT JOIN tagged_messages t ON t.account_id = a.account_id AND t.message_id = a.message_id
      WHERE a.account_id = $1
        AND NOT EXISTS (SELECT 1 FROM message_tags h WHERE h.account_id = $1 AND h.message_id = a.message_id AND h.source = '${HUMAN_SOURCE}')
      ORDER BY t.date DESC NULLS LAST, a.message_id
      LIMIT $2 OFFSET $3`,
    [accountId, limit, offset]
  )
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    messages: rows.map(r => ({
      messageId: r.message_id, folder: r.folder, uid: r.uid, fromName: r.from_name,
      fromAddress: r.from_address, subject: r.subject, date: r.date,
    })),
  }
}

/** Une ligne du tableau « Fiabilité » : UNE question. */
export interface QuestionReliability {
  question: string
  /** Mails de la boîte qu'une main a jugés sur cette question, audit ou non. */
  humanCount: number
  /** Sur l'audit aléatoire SEULEMENT : mails jugés par le moteur ET par une main, et accord entre les deux. */
  audit: { judged: number; correct: number }
  /** Les désaccords les plus fréquents sur l'audit : ce que le moteur a dit → ce que la main a dit. */
  confusions: { moteur: string; humain: string; count: number }[]
  /** Exactitude sur l'audit par tranche de confiance du moteur (0.1) : `bucket` = borne basse (0.9 = [0.9, 1]). */
  byConfidence: { bucket: number; judged: number; correct: number }[]
  /** Accord JEV / Yumi One sur les mails de la boîte que les DEUX ont étiquetés ; `null` quand aucun. */
  engineAgreement: { both: number; agree: number } | null
}

const CONFUSIONS_SHOWN = 3

/**
 * Le tableau, une ligne par question ACTIVE qui a quelque chose à dire (au moins une validation
 * humaine ou deux moteurs sur un même mail). Le moteur est comparé à la main sous la définition
 * COURANTE de la question (`question_version`, comme `tagDistribution`) : une consigne modifiée
 * ne mélange jamais deux définitions dans une même exactitude. La réponse du moteur est sa ligne
 * la plus récente (tout moteur confondu) ; celle de la main, sa ligne la plus récente.
 */
export async function reliability(accountId: string): Promise<QuestionReliability[]> {
  const set = await questionSetForAccount(accountId)
  const ids = set.enabled.map(q => q.id)
  const versions = set.enabled.map(questionVersion)
  const ENGINE_LIST = ENGINES.map(e => `'${e}'`).join(', ')
  const pairs = await query<{ question: string; humain: string; moteur: string | null; confiance: number | null; audited: boolean }>(
    `WITH cur AS (SELECT * FROM unnest($2::text[], $3::text[]) AS c(question, version)),
     rows AS (
       SELECT t.message_id, t.question, t.valeur, t.source, t.confiance, t.cree_le
         FROM message_tags t JOIN cur c ON c.question = t.question AND c.version = t.question_version
        WHERE t.account_id = $1
     ),
     human AS (
       SELECT DISTINCT ON (message_id, question) message_id, question, valeur
         FROM rows WHERE source = '${HUMAN_SOURCE}' ORDER BY message_id, question, cree_le DESC
     ),
     engine AS (
       SELECT DISTINCT ON (message_id, question) message_id, question, valeur, confiance
         FROM rows WHERE source IN (${ENGINE_LIST}) ORDER BY message_id, question, cree_le DESC
     )
     SELECT h.question, h.valeur AS humain, e.valeur AS moteur, e.confiance,
            EXISTS (SELECT 1 FROM tag_audits a WHERE a.account_id = $1 AND a.message_id = h.message_id) AS audited
       FROM human h LEFT JOIN engine e ON e.message_id = h.message_id AND e.question = h.question`,
    [accountId, ids, versions]
  )
  const agreements = await query<{ question: string; both: string; agree: string }>(
    `WITH rows AS (
       SELECT message_id, question, valeur, source, cree_le FROM message_tags
        WHERE account_id = $1 AND source IN ('jev', 'one')
          AND (question, question_version) IN (SELECT * FROM unnest($2::text[], $3::text[]))
     ),
     jev AS (SELECT DISTINCT ON (message_id, question) message_id, question, valeur FROM rows WHERE source = 'jev' ORDER BY message_id, question, cree_le DESC),
     one AS (SELECT DISTINCT ON (message_id, question) message_id, question, valeur FROM rows WHERE source = 'one' ORDER BY message_id, question, cree_le DESC)
     SELECT j.question, COUNT(*) AS both, COUNT(*) FILTER (WHERE j.valeur = o.valeur) AS agree
       FROM jev j JOIN one o ON o.message_id = j.message_id AND o.question = j.question
      GROUP BY j.question`,
    [accountId, ids, versions]
  )
  const agreementOf = new Map(agreements.map(a => [a.question, { both: Number(a.both), agree: Number(a.agree) }]))

  const byQuestion = new Map<string, QuestionReliability>()
  const confusionCounts = new Map<string, Map<string, number>>()
  const bucketCounts = new Map<string, Map<number, { judged: number; correct: number }>>()
  for (const p of pairs) {
    const row = byQuestion.get(p.question) ?? {
      question: p.question, humanCount: 0, audit: { judged: 0, correct: 0 }, confusions: [], byConfidence: [],
      engineAgreement: agreementOf.get(p.question) ?? null,
    }
    byQuestion.set(p.question, row)
    row.humanCount += 1
    if (!p.audited || p.moteur === null) continue
    const correct = p.moteur === p.humain
    row.audit.judged += 1
    if (correct) row.audit.correct += 1
    else {
      const key = `${p.moteur}\u0000${p.humain}`
      const m = confusionCounts.get(p.question) ?? new Map<string, number>()
      m.set(key, (m.get(key) ?? 0) + 1)
      confusionCounts.set(p.question, m)
    }
    if (p.confiance !== null) {
      // Une confiance de 1 tombe dans la tranche [0.9, 1] : dix tranches, pas onze.
      const bucket = Math.min(Math.floor(Number(p.confiance) * 10), 9) / 10
      const b = bucketCounts.get(p.question) ?? new Map()
      const c = b.get(bucket) ?? { judged: 0, correct: 0 }
      c.judged += 1
      if (correct) c.correct += 1
      b.set(bucket, c)
      bucketCounts.set(p.question, b)
    }
  }
  confusionCounts.forEach((m, question) => {
    byQuestion.get(question)!.confusions = Array.from(m.entries())
      .map(([key, count]) => { const [moteur, humain] = key.split('\u0000'); return { moteur, humain, count } })
      .sort((a, b) => b.count - a.count || (a.moteur < b.moteur ? -1 : 1))
      .slice(0, CONFUSIONS_SHOWN)
  })
  bucketCounts.forEach((b, question) => {
    byQuestion.get(question)!.byConfidence = Array.from(b.entries()).map(([bucket, c]) => ({ bucket, ...c })).sort((a, b) => b.bucket - a.bucket)
  })
  agreementOf.forEach((engineAgreement, question) => {
    if (!byQuestion.has(question)) {
      byQuestion.set(question, { question, humanCount: 0, audit: { judged: 0, correct: 0 }, confusions: [], byConfidence: [], engineAgreement })
    }
  })
  // L'ordre des questions est celui du jeu de l'utilisateur, jamais celui du SQL.
  return set.posed().filter(q => byQuestion.has(q.id)).map(q => byQuestion.get(q.id)!)
}
