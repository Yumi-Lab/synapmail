export interface EmailAccount {
  id: string
  userId: string
  name: string
  email: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  username: string
  isDefault: boolean
  color: string
  oauthProvider?: 'google' | 'microsoft' | null
  createdAt: string
  /** Unread count in the account's top-level INBOX — authoritative IMAP SEARCH UNSEEN
   *  (mailbox_stats), falling back to cached-row count. GET /api/accounts only. */
  unreadCount?: number
}

export interface User {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
  avatarUrl?: string
  createdAt: string
}

export interface Signature {
  id: string
  userId: string
  accountId: string | null
  name: string
  contentHtml: string
  isDefault: boolean
}

/** Never carries the raw key or its hash — those exist only at creation time / server-side. */
export interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  createdAt: string
}
