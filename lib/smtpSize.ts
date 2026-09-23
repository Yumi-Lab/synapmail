/**
 * La taille maximale d'un message vient du SERVEUR, plus d'un chiffre écrit en
 * dur (lot M10).
 *
 * MESURE À L'ORIGINE (Nicolas, 23/09/2026, poignée de main TLS en lecture
 * seule, sans authentification) : `smtp.ionos.fr:465` annonce
 * `250 SIZE 141557760`, soit 135 Mo. Le lot M9 plafonnait à 17 Mio par
 * message, déduits d'une limite de 25 Mo qui n'est PAS celle que ce serveur
 * applique : nous refusions des envois qu'il aurait acceptés.
 *
 * Ce module ne connaît ni base de données, ni réseau : il traduit le nombre
 * annoncé en un plafond utilisable et se vérifie seul
 * (`scripts/check-smtp-size.mjs`).
 */
/**
 * Le nombre annoncé compte les octets SUR LE FIL. Une pièce jointe y voyage en
 * base64 : trois octets deviennent quatre caractères (RFC 4648)…
 */
const BASE64_INPUT_GROUP = 3
const BASE64_OUTPUT_GROUP = 4

/** …découpés en lignes de 76 caractères terminées par CRLF (RFC 2045). */
const BASE64_LINE_LENGTH = 76
const BASE64_LINE_TERMINATOR = 2

/**
 * Part du message qui n'est pas une pièce jointe : en-têtes, corps, frontières
 * MIME. Un mégaoctet est large pour un message d'agent ; le plafond qui en
 * découle est donc PRUDENT, jamais optimiste — dépasser la limite annoncée se
 * paie d'un message entièrement transmis PUIS refusé.
 */
export const MESSAGE_ENVELOPE_RESERVE_BYTES = 1024 * 1024

/**
 * Bornes de bon sens sur le nombre annoncé. `250 SIZE 0` signifie « pas de
 * limite déclarée » (RFC 1870) et ne se distingue pas d'une absence ; au-delà
 * du téraoctet, personne n'annonce sérieusement une taille de message.
 */
export const ANNOUNCED_SIZE_MIN_BYTES = MESSAGE_ENVELOPE_RESERVE_BYTES
export const ANNOUNCED_SIZE_MAX_BYTES = 1024 ** 4

/**
 * Seuil d'AVERTISSEMENT, en octets décodés. Il ne bloque RIEN : la limite du
 * serveur d'ENVOI n'est pas celle du DESTINATAIRE. IONOS accepte 135 Mo, Gmail
 * refuse au-delà de 25 Mo et Outlook autour de 20 ; un envoi de 100 Mo
 * partirait puis reviendrait en rebond. Le seuil vit ICI, une seule fois, pour
 * se changer en une ligne.
 */
export const SEND_WARNING_BYTES = 20 * 1024 * 1024

/** D'où vient le plafond appliqué — la réponse d'erreur le DIT. */
export const CEILING_SOURCE = {
  /** Le serveur a annoncé `SIZE` : le plafond est le sien. */
  server: 'server',
  /** Le serveur n'a rien annoncé : on garde le plafond prudent de M9. */
  fallback: 'fallback',
} as const

export type CeilingSource = (typeof CEILING_SOURCE)[keyof typeof CEILING_SOURCE]

export interface SendCeiling {
  /** Plafond des pièces jointes, en octets DÉCODÉS. */
  limit: number
  source: CeilingSource
  /** Le nombre brut annoncé par le serveur, pour le citer tel quel. */
  announced: number | null
}

/**
 * Le nombre annoncé par le serveur, tel qu'il sort d'une réponse EHLO ou d'une
 * colonne de base. Tout ce qui n'est pas un entier crédible vaut « rien
 * annoncé » : on ne déduit pas un plafond d'une valeur qu'on ne comprend pas.
 */
export function parseAnnouncedSize(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const size = Math.floor(n)
  if (size < ANNOUNCED_SIZE_MIN_BYTES || size > ANNOUNCED_SIZE_MAX_BYTES) return null
  return size
}

/** Ce que pèsent, sur le fil, des octets une fois encodés en base64 et pliés. */
export function wireBytes(decoded: number): number {
  const encoded = Math.ceil(decoded / BASE64_INPUT_GROUP) * BASE64_OUTPUT_GROUP
  const lines = Math.ceil(encoded / BASE64_LINE_LENGTH)
  return encoded + lines * BASE64_LINE_TERMINATOR
}

/**
 * Le plafond appliqué à l'envoi. Un seul nombre : une pièce ne peut pas peser
 * plus que le message qui la porte, donc le plafond par pièce et celui du
 * message sont le même — ce sont leurs refus qui diffèrent, l'un nomme le
 * fichier, l'autre le total.
 *
 * `fallback` est le plafond prudent à garder quand le serveur n'annonce rien —
 * celui de M9, que l'appelant passe depuis `lib/attachments.ts`. Il arrive en
 * paramètre plutôt qu'en import : ce module ne connaît que ce que le serveur
 * a dit, et reste ainsi exécutable seul.
 */
export function resolveSendCeiling(announced: unknown, fallback: number): SendCeiling {
  const size = parseAnnouncedSize(announced)
  if (size === null) {
    return { limit: fallback, source: CEILING_SOURCE.fallback, announced: null }
  }
  const usable = size - MESSAGE_ENVELOPE_RESERVE_BYTES
  // Inverse de `wireBytes` : on retire d'abord les fins de ligne, puis on
  // repasse des quatre caractères aux trois octets.
  const encoded = Math.floor(
    (usable * BASE64_LINE_LENGTH) / (BASE64_LINE_LENGTH + BASE64_LINE_TERMINATOR)
  )
  const limit = Math.floor(encoded / BASE64_OUTPUT_GROUP) * BASE64_INPUT_GROUP
  return { limit: Math.max(limit, 0), source: CEILING_SOURCE.server, announced: size }
}

/**
 * Avertissements rendus avec un envoi RÉUSSI — l'appelant les lit, rien n'est
 * bloqué. Ils vivent ici et non dans la route : Next.js refuse tout export
 * autre qu'un gestionnaire dans un fichier de route.
 */
export const SEND_WARNING = {
  /** Au-delà de `SEND_WARNING_BYTES` : le destinataire, lui, peut refuser. */
  recipientMayRefuse: 'recipient_may_refuse_size',
} as const

/**
 * Faut-il AVERTIR sur ce total ? Jamais refuser : c'est le destinataire qui
 * pourrait refuser, et lui n'a rien annoncé.
 */
export const exceedsRecipientWarning = (totalDecodedBytes: number): boolean =>
  totalDecodedBytes > SEND_WARNING_BYTES

/**
 * Codes de réponse SMTP qui disent « trop gros ». `552` est le refus de taille
 * historique (RFC 5321 § 4.2.3, « exceeded storage allocation ») et `523` celui
 * de l'extension SIZE (RFC 1870). Nodemailer, lui, refuse AVANT d'écrire quoi
 * que ce soit sur le fil quand l'enveloppe dépasse ce qu'il a entendu
 * (`_maxAllowedSize`) : ce refus-là ne porte aucun code, seulement le message
 * `Message size larger than allowed <n>`.
 */
const SIZE_REFUSAL_CODES = [523, 552]
const SIZE_REFUSAL_MESSAGE = /size (?:larger than allowed|exceeds)|message too (?:big|large)|exceeded storage allocation/i

/**
 * Ce refus est-il un refus de TAILLE ? La distinction compte : elle seule
 * justifie de relire l'annonce du serveur (lot M10, complément de Nicolas du
 * 23/09/2026 — « en cas d'échec, faire une actualisation pour mettre à jour si
 * ça change »). Un mot de passe faux ou un serveur injoignable ne doit RIEN
 * réécrire sur la boîte.
 */
export function isSizeRefusal(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const { responseCode, message } = err as { responseCode?: unknown; message?: unknown }
  if (typeof responseCode === 'number' && SIZE_REFUSAL_CODES.includes(responseCode)) return true
  return typeof message === 'string' && SIZE_REFUSAL_MESSAGE.test(message)
}

/** Le refus que la route rend quand le serveur, lui, a dit non sur la taille. */
export const SEND_REFUSED_BY_SERVER = 'server_refused_size'

/**
 * Ce que le serveur a RÉPONDU, pour le remonter tel quel plutôt qu'un échec
 * générique (lot M10, point 5 de la DoD). Nodemailer range la ligne du serveur
 * dans `response` quand elle vient du fil, et dans `message` quand c'est lui
 * qui a refusé avant d'écrire (`Message size larger than allowed <n>`). Rien
 * n'est reformulé : c'est la phrase du serveur qui renseigne, pas la nôtre.
 */
export function sizeRefusalReason(err: unknown): string {
  if (err === null || typeof err !== 'object') return ''
  const { response, message } = err as { response?: unknown; message?: unknown }
  if (typeof response === 'string' && response.trim()) return response.trim()
  return typeof message === 'string' ? message.trim() : ''
}
