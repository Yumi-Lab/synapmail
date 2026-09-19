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
  /**
   * Refus : le formulaire vise un AUTRE serveur (ou un autre identifiant) que celui
   * enregistré, et personne n'a tapé de mot de passe. Le mot de passe enregistré ne part
   * que vers les hôtes enregistrés : sinon une session volée suffirait à le faire lire en
   * clair par un serveur choisi par l'attaquant, dans la commande LOGIN.
   */
  PASSWORD_REQUIRED: 'password_required',
} as const

export type TestDecision = (typeof TEST_DECISION)[keyof typeof TEST_DECISION]

/** Ports par défaut, quand ni le compte ni le formulaire n'en donnent un utilisable. */
export const DEFAULT_IMAP_PORT = 993
export const DEFAULT_SMTP_PORT = 587

/** Où et comment se connecter. Le mot de passe voyage à part : il n'est pas un réglage. */
export interface TestConnection {
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  username: string
}

/** Le strict minimum que la décision lit d'un compte. Jamais le mot de passe lui-même. */
export interface TestableAccount {
  isOwner: boolean
  oauthProvider: string | null
  hasStoredPassword: boolean
  /** Les réglages ENREGISTRÉS : les seules destinations du mot de passe enregistré. */
  imapHost: string | null
  imapPort?: number | null
  imapSecure?: boolean | null
  smtpHost: string | null
  smtpPort?: number | null
  smtpSecure?: boolean | null
  username: string | null
}

export interface TestRequest {
  /** Présent en ÉDITION, absent à la CRÉATION. */
  accountId?: string | null
  /** Ce que contient le champ. Vide en édition veut dire « inchangé ». */
  password?: string | null
  /** Ce que vise le FORMULAIRE. Comparé à l'enregistré avant d'envoyer un secret. */
  imapHost?: string | null
  imapPort?: number | string | null
  imapSecure?: boolean | null
  smtpHost?: string | null
  smtpPort?: number | string | null
  smtpSecure?: boolean | null
  username?: string | null
}

/**
 * Charge ce que la décision a besoin de savoir d'un compte, ou null s'il est hors de
 * portée. Injecté pour que l'auto-contrôle s'exécute sans base.
 */
export type AccountLoader = (accountId: string) => Promise<TestableAccount | null>

/**
 * Va chercher le mot de passe ENREGISTRÉ, en clair. N'est appelé qu'après une décision
 * `STORED` : toute autre décision doit le laisser tranquille, et l'auto-contrôle le mesure.
 */
export type StoredPasswordLoader = () => Promise<string>

/**
 * Un mot de passe fait de blancs n'est pas un mot de passe : c'est un champ vide qu'on
 * enverrait quand même à l'hébergeur, donc un échec d'authentification de plus.
 */
export const hasSubmittedPassword = (password?: string | null): boolean =>
  typeof password === 'string' && password.trim().length > 0

/**
 * Un nom d'hôte et un identifiant se comparent sans tenir compte de la casse ni des blancs
 * de bord : `IMAP.Example.com ` et `imap.example.com` sont le même serveur, et refuser le
 * test pour une majuscule ferait passer la règle pour un bug.
 */
const sameSetting = (a?: string | null, b?: string | null): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * Le formulaire vise-t-il EXACTEMENT le serveur enregistré ? Le port et l'option TLS
 * restent libres : on corrige un port et on réessaie sans avoir à retaper son mot de passe,
 * et un port ne change pas à qui le secret est confié. L'hôte et l'identifiant, si.
 */
export const targetsSavedServer = (req: TestRequest, account: TestableAccount): boolean =>
  sameSetting(req.imapHost, account.imapHost) &&
  sameSetting(req.smtpHost, account.smtpHost) &&
  sameSetting(req.username, account.username)

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
  if (!account.hasStoredPassword) return TEST_DECISION.MISSING

  // Le mot de passe enregistré ne va QUE là où il est déjà connu. Le formulaire vient du
  // navigateur : sans cette règle, une session volée demanderait le test vers un serveur
  // pirate et le lirait en clair dans la commande LOGIN, pour chaque boîte.
  return targetsSavedServer(req, account)
    ? TEST_DECISION.STORED
    : TEST_DECISION.PASSWORD_REQUIRED
}

/**
 * L'étape serveur entière : décider, PUIS n'aller chercher le secret que si la décision le
 * demande. Le mot de passe enregistré n'est déchiffré que sur un `STORED` ; tout autre
 * verdict laisse le chargeur au repos, et l'auto-contrôle le vérifie.
 */
const port = (value: number | string | null | undefined, fallback: number): number =>
  Number(value) || fallback

const text = (value: string | null | undefined): string => (value ?? '').trim()

/** Les réglages du FORMULAIRE : ce qu'on essaie quand la personne a tapé son mot de passe. */
export const formConnection = (req: TestRequest): TestConnection => ({
  imapHost: text(req.imapHost),
  imapPort: port(req.imapPort, DEFAULT_IMAP_PORT),
  imapSecure: req.imapSecure ?? true,
  smtpHost: text(req.smtpHost),
  smtpPort: port(req.smtpPort, DEFAULT_SMTP_PORT),
  smtpSecure: req.smtpSecure ?? false,
  username: text(req.username),
})

/**
 * Les réglages ENREGISTRÉS : ce qu'on essaie quand c'est le mot de passe enregistré qui
 * part. `targetsSavedServer` a déjà établi que le formulaire désigne ce serveur-là ; s'y
 * connecter avec les valeurs du compte supprime la dernière différence entre ce qui est
 * COMPARÉ et ce qui est JOINT (une espace de bord, une majuscule, suffisaient à joindre un
 * hôte que la comparaison avait accepté sous une autre écriture).
 */
export const savedConnection = (account: TestableAccount): TestConnection => ({
  imapHost: text(account.imapHost),
  imapPort: port(account.imapPort, DEFAULT_IMAP_PORT),
  imapSecure: account.imapSecure ?? true,
  smtpHost: text(account.smtpHost),
  smtpPort: port(account.smtpPort, DEFAULT_SMTP_PORT),
  smtpSecure: account.smtpSecure ?? false,
  username: text(account.username),
})

export async function resolveTestPassword(
  req: TestRequest,
  loadAccount: AccountLoader,
  loadStoredPassword: StoredPasswordLoader
): Promise<{ decision: TestDecision; password: string | null; connection: TestConnection | null }> {
  let loaded: TestableAccount | null = null
  const decision = await decideTestPassword(req, async id => {
    loaded = await loadAccount(id)
    return loaded
  })
  if (decision === TEST_DECISION.STORED && loaded) {
    return {
      decision,
      password: await loadStoredPassword(),
      connection: savedConnection(loaded),
    }
  }
  if (decision === TEST_DECISION.SUBMITTED) {
    return { decision, password: req.password ?? null, connection: formConnection(req) }
  }
  return { decision, password: null, connection: null }
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
