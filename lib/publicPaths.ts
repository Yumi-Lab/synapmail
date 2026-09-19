/**
 * Routes reachable WITHOUT a session — one list for the Edge middleware (which lets
 * them through) and for client code, which must not call an authenticated API from
 * one of these pages: the browser logs every 401 as a console error.
 */
export const PUBLIC_PATHS = [
  // `/api/branding` : l'icône de l'instance est lue par la page de connexion, donc avant toute session.
  // `/api/docs` et `/llms.txt` : un agent doit pouvoir lire ce que l'API propose AVANT d'avoir une clé.
  '/login', '/register', '/invite', '/api/auth', '/api/register', '/api/invites', '/api/oauth',
  '/api/branding', '/api/docs', '/llms.txt', '/_next', '/favicon',
] as const

export const isPublicPath = (pathname: string): boolean => PUBLIC_PATHS.some(p => pathname.startsWith(p))
