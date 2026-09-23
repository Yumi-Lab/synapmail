/**
 * Pièces jointes envoyées PAR LA REQUÊTE (lot M9) — la frontière de confiance.
 *
 * Un agent qui tient une clé d'API poste un nom de fichier et du base64 : ni
 * l'un ni l'autre ne sont dignes de foi. Ce module tient, à UN seul endroit,
 * ce que la route accepte, ce qu'elle refuse, et sous quel code. Il ne connaît
 * ni base de données, ni réseau : il se vérifie seul
 * (`scripts/check-send-attachments.mjs`).
 *
 * Il n'écrit PAS un second chemin d'envoi : il produit exactement la forme que
 * `sendMail` reçoit déjà des messages transférés (`lib/forward.ts`).
 */

/**
 * Nombre maximal de pièces en un envoi. Calibré sur l'usage visé (« joins-moi
 * ces quelques fichiers »), pas sur une capacité machine, comme
 * `FORWARD_MAX_MESSAGES` l'est pour les messages transférés.
 */
export const ATTACHMENT_MAX_COUNT = 20

/**
 * Plafond PRUDENT, en octets décodés, appliqué au message entier quand le
 * serveur SMTP n'annonce AUCUNE taille (lot M10 — sinon c'est la sienne qui
 * vaut, cf. `lib/smtpSize.ts`). Il se calibre à l'envers depuis la limite la
 * plus courante, 25 Mo : un message porte ses pièces en base64, soit un TIERS
 * de plus que leur taille décodée, donc 17 Mio décodés pèsent 23,8 Mo sur le
 * fil, en-têtes et corps compris. Écrire 18 Mio ici ferait 25,2 Mo, soit un
 * message refusé APRÈS avoir été tout entier chargé et transmis —
 * `scripts/check-send-attachments.mjs` refait le calcul et casse si le rapport
 * n'est plus tenu.
 */
export const MESSAGE_MAX_TOTAL_BYTES = 17 * 1024 * 1024

/** Type MIME d'une pièce dont le client ne dit rien, ou dit n'importe quoi. */
export const ATTACHMENT_DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Longueur maximale du nom de fichier proposé au destinataire. */
export const ATTACHMENT_MAX_NAME_LENGTH = 100

/** Nom de secours quand il ne reste rien du nom proposé après nettoyage. */
export const ATTACHMENT_FALLBACK_NAME = 'attachment'

/** Codes d'erreur — le serveur les renvoie, l'appelant les lit. */
export const ATTACHMENT_ERROR = {
  invalid: 'attachment_invalid',
  badBase64: 'attachment_bad_base64',
  tooMany: 'attachment_too_many',
  tooLarge: 'attachment_too_large',
  messageTooLarge: 'attachment_message_too_large',
} as const

export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR)[keyof typeof ATTACHMENT_ERROR]

/** La forme que `sendMail` reçoit déjà — celle des messages transférés. */
export interface OutgoingAttachment {
  filename: string
  content: Buffer
  contentType: string
}

export type AttachmentCheck<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: AttachmentErrorCode; limit?: number; detail?: string }

/**
 * Un type MIME valable au sens de la RFC 2045 : un type, une barre, un
 * sous-type, tous deux en jetons. Les paramètres (`; charset=…`) sont admis.
 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(;[\x20-\x7e]*)?$/

/** Le base64 canonique : quatre caractères par groupe, au plus deux `=` finaux. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Nom de fichier sûr, dérivé d'un nom que le client a choisi.
 * Il ne doit désigner AUCUN chemin : les séparateurs et les caractères
 * interdits par Windows sont remplacés, `..` est neutralisé, et la longueur est
 * bornée — beaucoup de clients tronquent un nom trop long.
 */
export function safeAttachmentName(raw: unknown): string {
  const cleaned =
    typeof raw === 'string'
      ? raw
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          // Un nom ne remonte pas d'un dossier, même une fois les séparateurs partis.
          .replace(/\.{2,}/g, '.')
          .replace(/^\.+/, '')
          .trim()
          .slice(0, ATTACHMENT_MAX_NAME_LENGTH)
          .trim()
      : ''
  return cleaned || ATTACHMENT_FALLBACK_NAME
}

/** Taille décodée annoncée par une chaîne base64, sans la décoder. */
export function base64DecodedSize(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

/**
 * Valide les pièces telles qu'elles arrivent du réseau, dans l'ordre reçu.
 * La taille est contrôlée sur le base64 AVANT tout décodage : une pièce
 * au-dessus du plafond est refusée sans jamais avoir été allouée.
 *
 * `ceiling` est le plafond du MESSAGE, en octets décodés — celui qu'a annoncé
 * le serveur, ou `MESSAGE_MAX_TOTAL_BYTES` à défaut. Une pièce ne peut pas
 * peser plus que le message qui la porte : il n'y a donc qu'un nombre, et deux
 * refus distincts, l'un nommant le fichier, l'autre le total.
 */
export function parseAttachments(
  raw: unknown,
  ceiling: number
): AttachmentCheck<OutgoingAttachment[]> {
  const deny = (
    code: AttachmentErrorCode,
    status = 400,
    extra: { limit?: number; detail?: string } = {}
  ): AttachmentCheck<OutgoingAttachment[]> => ({ ok: false, status, code, ...extra })

  if (!Array.isArray(raw) || !raw.length) return deny(ATTACHMENT_ERROR.invalid)
  if (raw.length > ATTACHMENT_MAX_COUNT) {
    return deny(ATTACHMENT_ERROR.tooMany, 400, { limit: ATTACHMENT_MAX_COUNT })
  }

  const parsed: OutgoingAttachment[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return deny(ATTACHMENT_ERROR.invalid)
    }
    const { filename, contentType, content } = item as Record<string, unknown>
    if (typeof filename !== 'string' || !filename.trim()) return deny(ATTACHMENT_ERROR.invalid)
    if (typeof content !== 'string' || !content.length) return deny(ATTACHMENT_ERROR.invalid)

    // Les retours à la ligne d'un base64 en colonnes (RFC 2045) sont admis ;
    // tout le reste doit être du base64 canonique, sinon la pièce arriverait
    // silencieusement tronquée — `Buffer.from` ne se plaint jamais.
    const compact = content.replace(/\s+/g, '')
    if (!compact.length || compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
      return deny(ATTACHMENT_ERROR.badBase64, 400, { detail: safeAttachmentName(filename) })
    }

    const size = base64DecodedSize(compact)
    if (size > ceiling) {
      return deny(ATTACHMENT_ERROR.tooLarge, 413, {
        limit: ceiling,
        detail: safeAttachmentName(filename),
      })
    }

    parsed.push({
      filename: safeAttachmentName(filename),
      content: Buffer.from(compact, 'base64'),
      contentType:
        typeof contentType === 'string' && CONTENT_TYPE_PATTERN.test(contentType.trim())
          ? contentType.trim()
          : ATTACHMENT_DEFAULT_CONTENT_TYPE,
    })
  }

  return { ok: true, value: parsed }
}

/**
 * Plafond de la somme, appliqué une fois toutes les pièces du message réunies
 * — celles de la requête ET les messages transférés, qui partent dans le même
 * envoi et pèsent sur la même limite du serveur SMTP.
 */
export function checkTotalSize(
  attachments: OutgoingAttachment[],
  ceiling: number
): AttachmentCheck<number> {
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0)
  if (total > ceiling) {
    return { ok: false, status: 413, code: ATTACHMENT_ERROR.messageTooLarge, limit: ceiling }
  }
  return { ok: true, value: total }
}
