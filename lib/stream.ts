/**
 * Contrat du flux SSE `/api/stream`, partagé par le serveur et le navigateur.
 * Séparé de `lib/idle.ts` : la surveillance IMAP est du code serveur (`tls`), un
 * composant client ne peut pas l'importer pour lire une simple constante.
 */

/** Type d'événement poussé quand la boîte surveillée a changé. */
export const MAILBOX_CHANGED = 'mailbox_changed'

/** Paramètre de `/api/stream` qui désigne le compte à surveiller. */
export const STREAM_ACCOUNT_PARAM = 'account'

/** Boîte surveillée en temps réel : celle qui reçoit le courrier. */
export const IDLE_FOLDER = 'INBOX'
