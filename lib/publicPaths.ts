/**
 * Routes reachable WITHOUT a session — one list for the Edge middleware (which lets
 * them through) and for client code, which must not call an authenticated API from
 * one of these pages: the browser logs every 401 as a console error.
 */

/** Prefixes: the entry and everything under it is public (`/api/auth/callback/…`). */
const PUBLIC_PREFIXES = [
  // `/api/branding` : l'icône de l'instance est lue par la page de connexion, donc avant toute session.
  '/login', '/register', '/invite', '/api/auth', '/api/register', '/api/invites', '/api/oauth',
  '/api/branding', '/_next', '/favicon',
] as const

/**
 * Exact entries: ONE document each, so a neighbour that merely starts the same way
 * (`/api/docs-probe`) stays behind the session check.
 * `/api/docs`, `/llms.txt` et `/openapi.json` : un agent doit pouvoir lire ce que l'API propose AVANT
 * d'avoir une clé.
 */
const PUBLIC_EXACT = ['/api/docs', '/llms.txt', '/openapi.json'] as const

export const PUBLIC_PATHS = [...PUBLIC_PREFIXES, ...PUBLIC_EXACT] as const

/** A trailing `/` or `?` still names the same document; anything else does not. */
const isSamePath = (pathname: string, entry: string): boolean =>
  pathname === entry || pathname.startsWith(`${entry}/`) || pathname.startsWith(`${entry}?`)

export const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PREFIXES.some(p => pathname.startsWith(p)) || PUBLIC_EXACT.some(p => isSamePath(pathname, p))
