import { query } from './db'
import { encrypt, decrypt } from './encrypt'
import { getAccessibleAccount } from './accountAccess'

export interface DbEmailAccount {
  id: string
  user_id: string
  name: string
  email: string
  imap_host: string
  imap_port: number
  imap_secure: boolean
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  username: string
  password_encrypted: string
  oauth_provider: string | null
  oauth_access_token: string | null
  oauth_refresh_token: string | null
  oauth_expires_at: number | null
  is_default: boolean
  color: string
  /** La couleur CHOISIE pour la pastille, ou null quand c'est celle du rang. */
  badge_color: string | null
  /** Prompt-injection guard for this mailbox — see lib/promptGuard.ts. */
  prompt_guard: boolean
  created_at: string
}

export async function getDefaultAccount(userId: string): Promise<DbEmailAccount | null> {
  const accounts = await query<DbEmailAccount>(
    'SELECT * FROM email_accounts WHERE user_id = $1 AND is_default = true LIMIT 1',
    [userId]
  )
  return accounts[0] ?? null
}

export async function getAccountById(id: string, userId: string): Promise<DbEmailAccount | null> {
  const accounts = await query<DbEmailAccount>(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 LIMIT 1',
    [id, userId]
  )
  return accounts[0] ?? null
}

/**
 * Whether the prompt-injection guard applies to a piece of mail content.
 *
 * Fails CLOSED: the guard is only ever lifted when the mailbox is found and its
 * owner has explicitly switched it off. A mailbox that cannot be resolved — an
 * unknown or malformed id, one the caller has no access to, a database error —
 * keeps the guard on, as does a user with no mailbox at all. A mailbox reached
 * through a share is read with the same access rule as the message routes, and
 * the setting that applies is the one its OWNER chose.
 *
 * With no mailbox named by the caller, the guard is on as soon as ONE of the
 * user's mailboxes asks for it, so unattributed content is never trusted.
 */
export async function promptGuardApplies(userId: string, accountId?: string | null): Promise<boolean> {
  try {
    if (accountId) {
      const account = await getAccessibleAccount(accountId, userId)
      return account?.prompt_guard ?? true
    }
    const rows = await query<{ on: boolean | null }>(
      'SELECT bool_or(prompt_guard) AS on FROM email_accounts WHERE user_id = $1',
      [userId]
    )
    return rows[0]?.on ?? true
  } catch {
    return true
  }
}

export const encryptPassword = encrypt
export const decryptPassword = decrypt

/**
 * Ligne `email_accounts` → configuration IMAP. La conversion était recopiée dans chaque
 * route qui ouvre une connexion ; une colonne renommée y aurait survécu en silence.
 * Elle accepte tout ce qui porte ces colonnes (ligne complète ou `SELECT` partiel).
 */
export type ImapAccountRow = Pick<
  DbEmailAccount,
  'id' | 'imap_host' | 'imap_port' | 'imap_secure' | 'username' | 'password_encrypted'
  | 'oauth_provider' | 'oauth_access_token' | 'oauth_refresh_token' | 'oauth_expires_at'
>

export function toImapConfig(a: ImapAccountRow) {
  return {
    id: a.id,
    imapHost: a.imap_host,
    imapPort: a.imap_port,
    imapSecure: a.imap_secure,
    username: a.username,
    passwordEncrypted: a.password_encrypted,
    oauthProvider: a.oauth_provider,
    oauthAccessToken: a.oauth_access_token,
    oauthRefreshToken: a.oauth_refresh_token,
    oauthExpiresAt: a.oauth_expires_at,
  }
}
