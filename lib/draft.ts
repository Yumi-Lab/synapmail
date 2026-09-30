/**
 * Ce qui se partage entre les trois verbes du brouillon — et rien de plus.
 *
 * Next.js refuse tout export qui n'est pas un handler dans un fichier de route :
 * un code d'erreur ou un lecteur d'en-tête doit donc vivre à côté, ici, pour que
 * `POST`, `PUT` et le contrat d'API disent la MÊME chose.
 */

import { UID_PATTERN } from './forward'

/** Codes d'erreur — le serveur les renvoie, l'appelant les lit. */
export const DRAFT_ERROR = {
  /** La boîte n'expose aucun dossier de brouillons : rien n'a été écrit. */
  noDraftsFolder: 'draft_no_drafts_folder',
  /** L'UID visé n'existe plus dans ce dossier : rien n'a été remplacé ni supprimé. */
  notFound: 'draft_not_found',
  /** L'uid dans l'URL n'est pas un entier décimal : refusé AVANT toute connexion IMAP. */
  invalidUid: 'draft_invalid_uid',
} as const

/**
 * L'uid de l'URL est refusé s'il n'est pas un entier décimal, AVANT toute connexion
 * IMAP — même forme que `parseForwardedMessages` (`lib/forward.ts`), réutilisée plutôt
 * que recopiée.
 */
export function isValidUid(uid: string): boolean {
  return UID_PATTERN.test(uid)
}

/**
 * L'identifiant que le message PORTE, lu dans son propre en-tête.
 *
 * `MailComposer` engendre un `Message-ID` à la compilation : le relire est la seule
 * façon d'annoncer à l'appelant celui qui est réellement parti dans la boîte. Le
 * découpage s'arrête à la première ligne vide — au-delà commence le corps, où une
 * pièce jointe peut contenir n'importe quoi, y compris ce qui ressemble à un en-tête.
 */
export function messageIdOf(raw: Buffer): string | null {
  const headers = raw.toString('utf8', 0, Math.min(raw.length, 64 * 1024)).split(/\r?\n\r?\n/)[0]
  return headers.match(/^message-id:\s*<([^>]+)>/im)?.[1] ?? null
}
