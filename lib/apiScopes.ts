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

import type { AccountPermission } from './accountAccess'

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
  'contacts:write': 'Ajouter, modifier et supprimer des contacts',
  'signatures:read': 'Lire les signatures',
  'signatures:write': 'Créer, modifier et supprimer des signatures',
  'templates:read': 'Lire les modèles de message',
  'templates:write': 'Créer, modifier et supprimer des modèles',
  'rules:read': 'Lire les règles de tri',
  'rules:write': 'Créer, modifier et supprimer des règles de tri',
  'settings:read': "Lire les réglages de l'utilisateur",
  'settings:write': "Modifier les réglages de l'utilisateur",
  'subscriptions:read': 'Lire les abonnements aux newsletters',
  'subscriptions:write': 'Se désabonner des newsletters',
  'subscriptions:purge': "Vider l'historique d'une newsletter",
  'ai:use': "Utiliser les actions d'assistance",
} as const

export type ApiScope = keyof typeof API_SCOPES

export const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[]

/** Le cycle de vie d'une boîte, ouvert au lot P8. */
export const ACCOUNT_WRITE_SCOPES: ApiScope[] = ['accounts:create', 'accounts:update', 'accounts:delete']

/**
 * Les portées apparues APRÈS la migration des clés, donc accordées à PERSONNE par
 * défaut : il faut les cocher. C'est cette liste — et non son complément — qui est
 * tenue à jour, pour qu'ajouter une portée ici ne la distribue jamais en silence aux
 * clés existantes. `LEGACY_SCOPES` s'en déduit.
 */
export const OPT_IN_SCOPES: ApiScope[] = [
  ...ACCOUNT_WRITE_SCOPES,
  'contacts:write',
  'signatures:read',
  'signatures:write',
  'templates:read',
  'templates:write',
  'rules:read',
  'rules:write',
  'settings:read',
  'settings:write',
]

/**
 * Ce qu'une clé créée AVANT les portées pouvait déjà faire : les 14 routes qui
 * acceptaient le Bearer. La migration donne exactement cela aux clés existantes,
 * donc aucune ne cesse de fonctionner. Les capacités NOUVELLES — l'écriture sur
 * les boîtes — n'y sont pas : il faut les cocher.
 */
export const LEGACY_SCOPES: ApiScope[] = ALL_SCOPES.filter(s => !OPT_IN_SCOPES.includes(s))

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
  'POST /api/contacts': 'contacts:write',
  'DELETE /api/contacts': 'contacts:write',
  'PATCH /api/contacts/[id]': 'contacts:write',
  'DELETE /api/contacts/[id]': 'contacts:write',
  'GET /api/signatures': 'signatures:read',
  'POST /api/signatures': 'signatures:write',
  'PATCH /api/signatures/[id]': 'signatures:write',
  'DELETE /api/signatures/[id]': 'signatures:write',
  'GET /api/templates': 'templates:read',
  'POST /api/templates': 'templates:write',
  'PATCH /api/templates/[id]': 'templates:write',
  'DELETE /api/templates/[id]': 'templates:write',
  'GET /api/rules': 'rules:read',
  'GET /api/rules/[id]': 'rules:read',
  'POST /api/rules': 'rules:write',
  'PATCH /api/rules/[id]': 'rules:write',
  'DELETE /api/rules/[id]': 'rules:write',
  'GET /api/settings': 'settings:read',
  'PATCH /api/settings': 'settings:write',
  'GET /api/subscriptions': 'subscriptions:read',
  'GET /api/subscriptions/unsubscribed': 'subscriptions:read',
  'POST /api/subscriptions/unsubscribe': 'subscriptions:write',
  'GET /api/subscriptions/history': 'subscriptions:read',
  // La purge DÉPLACE du courrier vers la corbeille : sa propre portée, jamais celle du
  // désabonnement. Une clé autorisée à se désinscrire ne doit pas pouvoir vider un historique.
  'POST /api/subscriptions/purge': 'subscriptions:purge',
  'POST /api/ai/action': 'ai:use',
}

/**
 * La permission de PARTAGE qu'exige chaque route ouverte au Bearer, quand elle en
 * exige une. Même clé que `ROUTE_SCOPES` (`METHOD /chemin`), même matcher.
 *
 * Pourquoi une table par ROUTE et non par PORTÉE : `messages:write` couvre le
 * marquage (`organize`) ET la suppression (`delete`). Une table par portée devrait
 * choisir l'une des deux, et le choix serait faux dans un cas sur deux — un partage
 * qui autorise à ranger sans autoriser à supprimer verrait ses PATCH refusés, ou
 * bien ses DELETE passer. La route, elle, sait laquelle elle exige : c'est
 * exactement ce que dit cette table, avec la MÊME valeur que le `required` que le
 * handler passe déjà à `getAccessibleAccount`. `scripts/check-api-share-limits.mjs`
 * refuse que les deux divergent.
 *
 * Une route absente n'exige aucune permission de partage : la lecture. Un partage
 * actif EST l'accès en lecture — il n'y a pas de `canRead` (voir `lib/accountAccess.ts`).
 */
export const ROUTE_ACCOUNT_PERMISSION: Record<string, AccountPermission> = {
  'PATCH /api/messages/[id]': 'organize',
  'DELETE /api/messages/[id]': 'delete',
  'PATCH /api/messages/bulk': 'organize',
  'DELETE /api/messages/bulk': 'delete',
  'POST /api/messages/send': 'send',
  'POST /api/folders': 'organize',
  'PATCH /api/folders': 'organize',
  'DELETE /api/folders': 'delete',
  'POST /api/folders/actions': 'organize',
  'POST /api/signatures': 'manageSignatures',
  'PATCH /api/signatures/[id]': 'manageSignatures',
  'DELETE /api/signatures/[id]': 'manageSignatures',
  'POST /api/rules': 'manageRules',
  'PATCH /api/rules/[id]': 'manageRules',
  'DELETE /api/rules/[id]': 'manageRules',
  'POST /api/subscriptions/unsubscribe': 'send',
  'POST /api/subscriptions/purge': 'delete',
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
export function routeKey(method: string, pathname: string): string | null {
  const wanted = pathname.replace(/\/+$/, '').split('/')
  for (const key of Object.keys(ROUTE_SCOPES)) {
    const [routeMethod, routePath] = key.split(' ')
    if (routeMethod !== method.toUpperCase()) continue
    const pattern = routePath.split('/')
    if (pattern.length !== wanted.length) continue
    if (pattern.every((seg, i) => seg.startsWith('[') || seg === wanted[i])) return key
  }
  return null
}

export function scopeForRequest(method: string, pathname: string): ApiScope | null {
  const key = routeKey(method, pathname)
  return key ? ROUTE_SCOPES[key] : null
}

/**
 * La permission de partage qu'exige cette requête concrète, ou `null` si elle n'en
 * exige aucune. Même matcher que la portée : une route reconnue d'un côté l'est de
 * l'autre, sans second inventaire de chemins.
 */
export function accountPermissionForRequest(method: string, pathname: string): AccountPermission | null {
  const key = routeKey(method, pathname)
  return key ? ROUTE_ACCOUNT_PERMISSION[key] ?? null : null
}
