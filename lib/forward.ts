/**
 * Transfert de messages ENTIERS en pièces jointes (lot M5) — la frontière de
 * confiance.
 *
 * Le client annonce un compte, un dossier et des uid : rien de tout cela n'est
 * digne de foi. Ce module tient, à UN seul endroit, ce que la route accepte,
 * ce qu'elle refuse, et sous quel code — le même code habille l'erreur côté
 * serveur et choisit la phrase traduite côté fenêtre de rédaction.
 */

/**
 * Nombre maximal de messages joints en une fois. Calibré sur l'usage visé
 * (« je coche quelques mails et je les fais suivre »), pas sur une capacité
 * machine : au-delà, c'est une exportation de boîte, pas un transfert.
 */
export const FORWARD_MAX_MESSAGES = 25

/**
 * Plafond de la somme des sources relues, mesuré AVANT de charger le moindre
 * octet en mémoire. 25 Mio est la limite de pièce jointe la plus répandue chez
 * les serveurs SMTP (IONOS, Gmail, Outlook) : au-delà, l'envoi serait de
 * toute façon refusé après avoir fait gonfler le processus.
 */
export const FORWARD_MAX_TOTAL_BYTES = 25 * 1024 * 1024

/** Un uid IMAP est un entier décimal. `1:*` est un JEU de séquences valide : il est donc refusé ici. */
const UID_PATTERN = /^\d+$/

/** Codes d'erreur — le serveur les renvoie, la fenêtre de rédaction les traduit. */
export const FORWARD_ERROR = {
  invalid: 'forward_invalid',
  tooMany: 'forward_too_many',
  tooLarge: 'forward_too_large',
  missing: 'forward_missing',
  originDenied: 'forward_origin_denied',
} as const

export type ForwardErrorCode = (typeof FORWARD_ERROR)[keyof typeof FORWARD_ERROR]

/** Ce que le client DOIT fournir : le compte d'ORIGINE de la sélection, son dossier, ses uid. */
export interface ForwardedMessages {
  accountId: string
  folder: string
  uids: string[]
}

export type ForwardCheck<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: ForwardErrorCode; detail?: number }

/**
 * Valide la demande de transfert telle qu'elle arrive du réseau. Les uid sont
 * dédoublonnés en conservant l'ordre de la sélection : c'est cet ordre-là que
 * l'oeil a coché, et donc celui des pièces jointes.
 */
export function parseForwardedMessages(raw: unknown): ForwardCheck<ForwardedMessages> {
  const deny = (code: ForwardErrorCode, status = 400, detail?: number): ForwardCheck<ForwardedMessages> =>
    ({ ok: false, status, code, detail })

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return deny(FORWARD_ERROR.invalid)
  const { accountId, folder, uids } = raw as Record<string, unknown>

  if (typeof accountId !== 'string' || !accountId.trim()) return deny(FORWARD_ERROR.invalid)
  if (typeof folder !== 'string' || !folder.trim()) return deny(FORWARD_ERROR.invalid)
  if (!Array.isArray(uids) || !uids.length) return deny(FORWARD_ERROR.invalid)
  if (!uids.every(uid => typeof uid === 'string' && UID_PATTERN.test(uid))) return deny(FORWARD_ERROR.invalid)

  const unique = Array.from(new Set(uids as string[]))
  if (unique.length > FORWARD_MAX_MESSAGES) {
    return deny(FORWARD_ERROR.tooMany, 400, FORWARD_MAX_MESSAGES)
  }

  return { ok: true, value: { accountId, folder: folder.trim(), uids: unique } }
}

/**
 * Le compte où les sources sont RELUES. L'expéditeur choisi dans « De » et le
 * compte d'origine de la sélection sont deux choses différentes : lire dans le
 * premier reviendrait à joindre les messages qui portent les mêmes uid dans une
 * AUTRE boîte — les uid d'une boîte de réception sont de petits entiers, ils
 * existent des deux côtés. L'accès à l'origine se contrôle donc séparément.
 *
 * `loadAccount` est injecté pour que la décision se vérifie sans base de
 * données (voir `scripts/check-forward-decision.mjs`).
 */
export async function resolveForwardOrigin<A extends { id: string }>(
  senderAccount: A,
  originAccountId: string,
  loadAccount: (accountId: string) => Promise<A | null>
): Promise<ForwardCheck<A>> {
  if (originAccountId === senderAccount.id) return { ok: true, value: senderAccount }
  const origin = await loadAccount(originAccountId)
  if (!origin) return { ok: false, status: 404, code: FORWARD_ERROR.originDenied }
  return { ok: true, value: origin }
}
