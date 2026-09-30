/**
 * Les chemins des webhooks, écrits UNE fois : l'écran des webhooks, l'éditeur de règles et le
 * lien qui mène de l'un à l'autre les lisent ici. Un chemin retapé ailleurs se serait décalé au
 * premier renommage de route.
 */
// Chemin relatif, comme partout dans `lib/` : les bancs importent ces modules avec node,
// qui ne connaît pas l'alias `@/` pour une valeur (un import de TYPE, lui, est effacé).
import { RULE_PREFILL_PARAMS } from './rulePrefill'
import type { Webhook } from '@/types/webhook'

export const WEBHOOKS_ENDPOINT = '/api/webhooks'

/** Les webhooks d'UNE boîte : ce que l'éditeur de règles propose à l'action « webhook ». */
export const webhooksOfAccount = (accountId: string) => `${WEBHOOKS_ENDPOINT}?account=${accountId}`

/**
 * Écrire un déclencheur pour ce webhook = écrire une RÈGLE (décision 1). Le lien ouvre donc
 * l'éditeur de règles existant, préréglé sur la boîte du webhook et sur l'action qui le vise.
 */
export const webhookTriggerHref = (hook: Pick<Webhook, 'id' | 'accountId'>) =>
  `/settings/rules?${new URLSearchParams({
    [RULE_PREFILL_PARAMS.accountId]: hook.accountId,
    [RULE_PREFILL_PARAMS.webhookId]: hook.id,
  })}`
