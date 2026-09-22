import { query } from './db'

/**
 * Le compteur de non-lus, tenu à jour par les actions qui le font bouger.
 *
 * Ce que montre le badge vient de `mailbox_stats.unread_count`, écrit par un
 * `SEARCH UNSEEN` côté serveur (`lib/imap.ts`, page 1 d'un listage) et remis à
 * zéro par les actions de dossier. Lire un message, lui, ne l'écrivait NULLE
 * PART : ni `messages_cache.is_read`, ni `mailbox_stats`. Le nombre restait donc
 * faux jusqu'au balayage du planificateur (3 min), et relire `/api/accounts`
 * plus souvent n'y changeait rien — la valeur relue était la même valeur
 * périmée. C'est la cause racine du compteur « qui ne bouge pas ».
 *
 * Une seule fonction, appelée par TOUTES les routes qui changent l'état lu d'un
 * message, pour que le cache et le compteur ne puissent pas diverger.
 */

/**
 * Enregistre un changement d'état « lu » et décale le compteur d'autant.
 *
 * Le décalage est le nombre de lignes qui ont RÉELLEMENT changé d'état, pas le
 * nombre d'uid demandés : remarquer « lu » un message déjà lu ne doit pas faire
 * descendre le compteur une seconde fois.
 *
 * Portée : ce que le cache connaît. Un message jamais listé n'a pas de ligne, ne
 * compte pour rien, et laisse le compteur inchangé jusqu'au prochain
 * `SEARCH UNSEEN` — qui reste le filet, et la seule source pour ce cas.
 */
export async function applyReadChange(
  accountId: string,
  folder: string,
  uids: string[],
  read: boolean
): Promise<void> {
  if (!uids.length) return
  const flipped = await query(
    `UPDATE messages_cache SET is_read = $4
      WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::varchar[]) AND is_read IS DISTINCT FROM $4
      RETURNING uid`,
    [accountId, folder, uids, read]
  )
  if (!flipped.length) return
  // Jamais sous zéro : le cache peut ignorer des messages que le compteur, lui,
  // connaît (il vient d'un SEARCH sur toute la boîte), et l'écart ne doit pas
  // se transformer en nombre négatif à l'écran.
  await query(
    `UPDATE mailbox_stats SET unread_count = GREATEST(0, unread_count + $3), synced_at = NOW()
      WHERE account_id = $1 AND folder = $2`,
    [accountId, folder, read ? -flipped.length : flipped.length]
  )
}
