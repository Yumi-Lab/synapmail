/**
 * Le seul morceau du contrat des abonnements que le NAVIGATEUR lit aussi.
 *
 * `lib/subscriptions.ts` ouvre `node:dns` et `node:https` : un écran ne peut pas
 * l'importer sans traîner ces modules dans son paquet. Cette limite-là, elle,
 * est annoncée à l'utilisateur AVANT qu'il clique — elle vit donc ici, et
 * `lib/subscriptions.ts` la réexporte pour que le serveur et l'écran lisent le
 * MÊME nombre.
 */

/** Combien de groupes `POST /api/subscriptions/unsubscribe` accepte par appel. */
export const MAX_UNSUBSCRIBE_BATCH = 50
