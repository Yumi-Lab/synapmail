/**
 * Ce qu'une clé API a le droit de faire — LA source unique.
 *
 * Lue par `lib/apiAuth.ts` (qui refuse), par l'écran Réglages → Clés API (qui
 * coche), par `docs/API.md` et par `scripts/check-api-scopes.mjs` (qui vérifie
 * qu'aucune route n'échappe à la table). Aucune chaîne de portée n'est écrite
 * en dur ailleurs : un libellé, une route ou une portée se change ICI.
 *
 * Les portées sont DÉDUITES des routes existantes, une par famille de capacité,
 * jamais une par route. Seule exception voulue : le cycle de vie d'une boîte se
 * découpe en créer / modifier / supprimer, parce que c'est la granularité
 * demandée (« interdire de supprimer, mais pouvoir ajouter »).
 *
 * Une session humaine n'est JAMAIS limitée par une portée — elles ne
 * concernent que les clés.
 */

export const API_SCOPES = {
  'accounts:read': 'Lire la liste des boîtes',
  'accounts:create': 'Ajouter une boîte',
  'accounts:update': 'Modifier une boîte',
  'accounts:delete': 'Supprimer une boîte',
  'messages:read': 'Lire, chercher et suivre les messages',
  'messages:write': 'Marquer, déplacer et supprimer des messages',
  'messages:send': 'Envoyer des messages',
  'folders:read': 'Lire les dossiers',
  'folders:write': 'Créer, renommer et supprimer des dossiers',
  'contacts:read': 'Lire les contacts',
  'subscriptions:read': 'Lire les abonnements aux newsletters',
  'subscriptions:write': 'Se désabonner des newsletters',
  'ai:use': "Utiliser les actions d'assistance",
} as const

export type ApiScope = keyof typeof API_SCOPES

export const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[]

/** Les portées nouvelles de ce lot, accordées à personne par défaut. */
export const ACCOUNT_WRITE_SCOPES: ApiScope[] = ['accounts:create', 'accounts:update', 'accounts:delete']

/**
 * Ce qu'une clé créée AVANT les portées pouvait déjà faire : les 14 routes qui
 * acceptaient le Bearer. La migration donne exactement cela aux clés existantes,
 * donc aucune ne cesse de fonctionner. Les capacités NOUVELLES — l'écriture sur
 * les boîtes — n'y sont pas : il faut les cocher.
 */
export const LEGACY_SCOPES: ApiScope[] = ALL_SCOPES.filter(s => !ACCOUNT_WRITE_SCOPES.includes(s))

/**
 * La portée exigée par chaque méthode de chaque route ouverte au Bearer.
 * Un segment entre crochets est un joker (`/api/messages/[id]`).
 * Une route absente de cette table n'est pas ouverte aux clés.
 */
export const ROUTE_SCOPES: Record<string, ApiScope> = {
  'GET /api/accounts': 'accounts:read',
  'POST /api/accounts': 'accounts:create',
  'POST /api/accounts/test': 'accounts:create',
  'PATCH /api/accounts/[id]': 'accounts:update',
  'DELETE /api/accounts/[id]': 'accounts:delete',
  'GET /api/messages': 'messages:read',
  'GET /api/messages/[id]': 'messages:read',
  'GET /api/messages/search': 'messages:read',
  'GET /api/messages/thread': 'messages:read',
  'PATCH /api/messages/[id]': 'messages:write',
  'DELETE /api/messages/[id]': 'messages:write',
  'PATCH /api/messages/bulk': 'messages:write',
  'DELETE /api/messages/bulk': 'messages:write',
  'POST /api/messages/send': 'messages:send',
  'GET /api/folders': 'folders:read',
  'POST /api/folders': 'folders:write',
  'PATCH /api/folders': 'folders:write',
  'DELETE /api/folders': 'folders:write',
  'POST /api/folders/actions': 'folders:write',
  'GET /api/contacts': 'contacts:read',
  'GET /api/subscriptions': 'subscriptions:read',
  'GET /api/subscriptions/unsubscribed': 'subscriptions:read',
  'POST /api/subscriptions/unsubscribe': 'subscriptions:write',
  'POST /api/ai/action': 'ai:use',
}

export const isApiScope = (value: unknown): value is ApiScope =>
  typeof value === 'string' && value in API_SCOPES

/** Ne garde que des portées connues, sans doublon, dans l'ordre de référence. */
export const sanitizeScopes = (values: unknown): ApiScope[] =>
  Array.isArray(values) ? ALL_SCOPES.filter(scope => values.includes(scope)) : []

/**
 * La portée exigée par `METHOD /chemin/concret`, ou `null` si la route n'est pas
 * ouverte aux clés. Le chemin vient de la requête : ses segments dynamiques sont
 * des valeurs (`/api/accounts/9f2…`), pas des motifs.
 */
export function scopeForRequest(method: string, pathname: string): ApiScope | null {
  const wanted = pathname.replace(/\/+$/, '').split('/')
  for (const [key, scope] of Object.entries(ROUTE_SCOPES)) {
    const [routeMethod, routePath] = key.split(' ')
    if (routeMethod !== method.toUpperCase()) continue
    const pattern = routePath.split('/')
    if (pattern.length !== wanted.length) continue
    if (pattern.every((seg, i) => seg.startsWith('[') || seg === wanted[i])) return scope
  }
  return null
}
