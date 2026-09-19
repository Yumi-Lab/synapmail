/**
 * QUEL mot de passe le bouton « Tester la connexion » essaie, et pour QUI.
 *
 * Mesuré en prod le 20/09/2026 : le bouton mentait. L'écran d'édition n'affiche jamais le
 * mot de passe enregistré (il ne quitte pas le serveur), donc le champ part vide ; le test
 * envoyait quand même le CONTENU du champ. Vide, la route répondait « Missing fields » ;
 * rempli à l'insu de la personne par le gestionnaire de mots de passe du navigateur, c'est
 * le mot de passe du WEBMAIL qui partait chez l'hébergeur. Chaque essai valait deux
 * authentifications ratées, et l'hébergeur finit par verrouiller pour de bon.
 *
 * La décision vit ici, hors de la route, pour être exécutable seule : pas de base, pas de
 * réseau, pas de navigateur. Elle ne renvoie JAMAIS le mot de passe, ni en clair ni
 * chiffré : elle dit lequel essayer, et la route va le chercher.
 */

/** Ce que la route doit faire, une fois la décision prise. */
export const TEST_DECISION = {
  /** Essayer le mot de passe que la personne vient de taper. */
  SUBMITTED: 'submitted',
  /** Essayer le mot de passe ENREGISTRÉ, déchiffré côté serveur. */
  STORED: 'stored',
  /** Rien à essayer : le compte s'authentifie par jeton. */
  OAUTH: 'oauth',
  /** Refus : le compte n'existe pas, ou la personne n'en est pas propriétaire. */
  DENIED: 'denied',
  /** Refus : aucun mot de passe à essayer (création sans mot de passe saisi). */
  MISSING: 'missing',
} as const

export type TestDecision = (typeof TEST_DECISION)[keyof typeof TEST_DECISION]

/** Le strict minimum que la décision lit d'un compte. Jamais le mot de passe lui-même. */
export interface TestableAccount {
  isOwner: boolean
  oauthProvider: string | null
  hasStoredPassword: boolean
}

export interface TestRequest {
  /** Présent en ÉDITION, absent à la CRÉATION. */
  accountId?: string | null
  /** Ce que contient le champ. Vide en édition veut dire « inchangé ». */
  password?: string | null
}

/**
 * Charge ce que la décision a besoin de savoir d'un compte, ou null s'il est hors de
 * portée. Injecté pour que l'auto-contrôle s'exécute sans base.
 */
export type AccountLoader = (accountId: string) => Promise<TestableAccount | null>

/**
 * Un mot de passe fait de blancs n'est pas un mot de passe : c'est un champ vide qu'on
 * enverrait quand même à l'hébergeur, donc un échec d'authentification de plus.
 */
export const hasSubmittedPassword = (password?: string | null): boolean =>
  typeof password === 'string' && password.trim().length > 0

export async function decideTestPassword(
  req: TestRequest,
  loadAccount: AccountLoader
): Promise<TestDecision> {
  const submitted = hasSubmittedPassword(req.password)

  // Création : il n'y a pas de compte, donc rien d'enregistré. Comportement inchangé.
  if (!req.accountId) return submitted ? TEST_DECISION.SUBMITTED : TEST_DECISION.MISSING

  const account = await loadAccount(req.accountId)
  // Un invité ne teste pas les identifiants d'une boîte partagée : ils ne sont pas à lui.
  // Même réponse qu'un compte inconnu, pour ne pas révéler qu'il existe.
  if (!account || !account.isOwner) return TEST_DECISION.DENIED

  // Un mot de passe TAPÉ l'emporte : c'est le geste de qui change de mot de passe et veut
  // l'essayer avant d'enregistrer.
  if (submitted) return TEST_DECISION.SUBMITTED
  if (account.oauthProvider) return TEST_DECISION.OAUTH
  return account.hasStoredPassword ? TEST_DECISION.STORED : TEST_DECISION.MISSING
}

/** Les deux échecs courants, traduits en une CAUSE au lieu de l'erreur brute du serveur. */
export const TEST_FAILURE = {
  /** L'hôte a répondu, et il a refusé les identifiants. */
  CREDENTIALS: 'credentials',
  /** L'hôte n'a pas répondu : nom introuvable, port fermé, délai dépassé. */
  UNREACHABLE: 'unreachable',
  /** Tout le reste : montré tel quel plutôt que rangé de travers. */
  OTHER: 'other',
} as const

export type TestFailure = (typeof TEST_FAILURE)[keyof typeof TEST_FAILURE]

/**
 * Motifs lus dans les messages réellement renvoyés par IONOS et par les bibliothèques :
 * `535 Invalid login` (SMTP), `Invalid credentials` / `AUTHENTICATIONFAILED` (IMAP) pour
 * le refus ; `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` pour l'injoignable.
 */
const CREDENTIAL_PATTERNS = [
  /\b535\b/,
  /\b(authenticationfailed|authentication failed)\b/i,
  /invalid (login|credentials|user)/i,
  /\bauth(entication)? (failure|unsuccessful)\b/i,
]
const UNREACHABLE_PATTERNS = [
  /\b(enotfound|econnrefused|etimedout|ehostunreach|enetunreach|eai_again|econnreset)\b/i,
  /\btimed? ?out\b/i,
  /getaddrinfo/i,
]

export function classifyTestFailure(message: string): TestFailure {
  if (CREDENTIAL_PATTERNS.some(p => p.test(message))) return TEST_FAILURE.CREDENTIALS
  if (UNREACHABLE_PATTERNS.some(p => p.test(message))) return TEST_FAILURE.UNREACHABLE
  return TEST_FAILURE.OTHER
}
