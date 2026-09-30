/**
 * Ce qu'une URL peut préremplir dans l'éditeur de règles : les NOMS des paramètres, écrits une
 * fois, et leur lecture, écrite une fois. La page pleine et la modale des réglages passaient
 * par deux copies de cette lecture, et la seconde a oublié chaque paramètre ajouté depuis.
 *
 * Module ordinaire, sans `'use client'` : un composant serveur qui importerait cette fonction
 * d'un module client n'en recevrait qu'une référence, pas la fonction (vécu : l'écran des
 * règles rendait alors un 500 « readRulePrefill is not a function »).
 */
export const RULE_PREFILL_PARAMS = {
  fromAddress: 'prefill_from',
  fromName: 'prefill_from_name',
  subject: 'prefill_subject',
  accountId: 'prefill_account',
  webhookId: 'prefill_webhook',
} as const

export interface RulePrefill {
  fromAddress?: string
  fromName?: string
  subject?: string
  accountId?: string
  /** Venu de l'écran des webhooks : la règle naît déjà armée sur CE webhook. */
  webhookId?: string
}

/**
 * `get` accepte aussi bien un `URLSearchParams.get` que la lecture d'un objet `searchParams`.
 * Rien à préremplir rend `undefined` : l'éditeur s'ouvre alors comme d'habitude.
 */
export function readRulePrefill(get: (key: string) => string | null | undefined): RulePrefill | undefined {
  const entries = Object.entries(RULE_PREFILL_PARAMS)
    .map(([field, param]) => [field, get(param) || undefined] as const)
    .filter(([, value]) => value !== undefined)
  if (!entries.length) return undefined
  return Object.fromEntries(entries) as RulePrefill
}
