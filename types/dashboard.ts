// Shapes returned by GET /api/dashboard — the command-center overview.

export type FocusReason =
  | 'invoice'
  | 'deadline'
  | 'reply'
  | 'vip'
  | 'frequent'
  | 'starred'
  | 'attachment'

export interface DashboardKpis {
  unreadTotal: number
  unreadToday: number
  sentToday: number
  trackedOpens7d: number
  trackedOpensToday: number
  scheduledPending: number
  nextScheduledAt: string | null
}

export interface DashboardAccount {
  id: string
  name: string
  email: string
  // La couleur CHOISIE par le propriétaire, telle quelle : c'est `accountColor()`
  // qui tranche entre elle et celle du RANG, du même côté que la barre latérale.
  // Jamais la vieille colonne `email_accounts.color`.
  badgeColor: string | null
  unread: number
}

export interface ActivityPoint {
  date: string // YYYY-MM-DD
  received: number
  sent: number
}

export interface FocusItem {
  uid: string
  accountId: string
  accountName: string
  folder: string
  subject: string
  fromName: string | null
  fromAddress: string | null
  date: string
  reason: FocusReason
}

export interface ReceiptItem {
  subject: string | null
  sentTo: string
  openedAt: string
  openCount: number
  accountName: string | null
  /** La boîte, par son id : le client y lit sa bulle (nom, initiales, couleur). */
  accountId: string | null
}

export interface ScheduledItem {
  id: string
  subject: string
  to: string[]
  sendAt: string
  accountName: string | null
  accountId: string | null
}

export interface RuleActivityItem {
  id: string
  name: string
  enabled: boolean
  matched7d: number
}

export interface FollowUpContact {
  name: string
  email: string
  frequency: number
  lastContactAt: string
}

export interface DashboardData {
  /** Which account the widgets are scoped to; null = all accounts combined. */
  accountFilter: string | null
  kpis: DashboardKpis
  accounts: DashboardAccount[]
  activity: ActivityPoint[]
  focus: FocusItem[]
  receipts: ReceiptItem[]
  scheduled: ScheduledItem[]
  rules: {
    items: RuleActivityItem[]
    activeCount: number
    actions7d: number
  }
  followUps: FollowUpContact[]
}
