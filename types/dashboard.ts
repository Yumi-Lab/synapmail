// Shapes returned by GET /api/dashboard — the command-center overview.

export type FocusReason =
  | 'invoice'
  | 'deadline'
  | 'reply'
  | 'vip'
  | 'frequent'
  | 'starred'
  | 'attachment'
  | 'echeance'
  | 'spam'
  | 'tag'

/** Une composante du score, lisible dans l'infobulle : un signal de surface ou une étiquette pesée. */
export type FocusPart =
  | { kind: 'reason'; reason: Exclude<FocusReason, 'tag'>; points: number }
  | { kind: 'tag'; question: string; valeur: string; points: number }

/** Ce que `scoreFocus()` (lib/focus.ts) rend — LA priorité du dépôt, à traiter comme tri par priorité. */
export interface FocusScore {
  score: number
  /** La composante la plus forte, pour la pastille. */
  reason: FocusReason
  parts: FocusPart[]
}

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
  // Le RANG de la boîte dans la liste PARTAGÉE de l'utilisateur (`listAccessibleAccounts`),
  // celle que sert aussi `/api/accounts`. La couleur automatique est une fonction de ce
  // rang : le recalculer sur la liste du tableau de bord, plus courte, repeindrait la
  // même boîte d'une autre couleur que la barre latérale.
  rank: number
  unread: number
}

export interface ActivityPoint {
  date: string // YYYY-MM-DD
  received: number
  sent: number
}

export interface FocusItem extends FocusScore {
  uid: string
  /** `Message-ID` RFC ('' si le mail n'en a pas) : la liste s'en sert pour retrouver la ligne déjà chargée. */
  messageId: string
  accountId: string
  accountName: string
  folder: string
  subject: string
  fromName: string | null
  fromAddress: string | null
  date: string
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
