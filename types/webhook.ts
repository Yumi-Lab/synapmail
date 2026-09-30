/**
 * Ce qu'un webhook et un envoi valent VUS DE DEHORS — la forme que rendent les routes
 * `/api/webhooks/**` et que lit l'écran.
 *
 * Le secret n'est PAS ici : il ne sort qu'une fois, à la création et à la régénération, sous
 * une clé à part (`WebhookWithSecret`). Une forme qui le porterait en permanence finirait par
 * le rendre à chaque lecture.
 */
export interface Webhook {
  id: string
  accountId: string
  name: string
  url: string
  enabled: boolean
  createdAt: string
  /** Le dernier envoi connu, ou `null` si ce webhook n'a jamais rien reçu. */
  lastDelivery: { at: string; status: string; responseStatus: number | null } | null
  /** Combien de règles le visent — ses déclencheurs. */
  ruleCount: number
}

/** À la création et à la régénération SEULEMENT : le secret en clair, une fois. */
export interface WebhookWithSecret extends Webhook {
  secret: string
}

export interface WebhookDelivery {
  id: string
  webhookId: string
  ruleId: string | null
  ruleName: string | null
  messageId: string | null
  subject: string | null
  event: string
  status: string
  attempts: number
  responseStatus: number | null
  durationMs: number | null
  error: string | null
  nextAttemptAt: string | null
  createdAt: string
}
