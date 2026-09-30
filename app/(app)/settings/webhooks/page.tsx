'use client'

import { useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Webhook as WebhookIcon, Plus, Pencil, Trash2, KeyRound, Send, Copy, Check,
  TriangleAlert, ChevronDown, RotateCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountAvatar } from '@/components/layout/AccountAvatar'
import { SettingsPage, SettingsHeader } from '@/components/settings/primitives'
import { RowMenu, ContextMenuItem, ContextMenuSeparator, MENU_ICON } from '@/components/ui/ContextMenu'
import { WEBHOOKS_ENDPOINT, webhookTriggerHref } from '@/lib/webhookRoutes'
import { cn } from '@/lib/utils'
import type { EmailRule } from '@/types/rule'
import type { EmailAccount } from '@/types/account'
import type { Webhook, WebhookDelivery, WebhookWithSecret } from '@/types/webhook'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Ce qu'une URL garde à l'écran : assez pour reconnaître la destination, pas la ligne entière. */
const shortUrl = (raw: string) => {
  try {
    const u = new URL(raw)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return raw
  }
}

/** Ce qu'une règle vise : le webhook nommé par la valeur de son action. */
const rulesTargeting = (rules: EmailRule[], webhookId: string) =>
  rules.filter(r => r.actions.some(a => a.type === 'webhook' && a.value === webhookId))

interface Draft {
  id: string | null
  accountId: string
  name: string
  url: string
}

export default function WebhooksSettingsPage() {
  const t = useTranslations('settings.webhooks')
  const tRow = useTranslations('settings.rowActions')

  const { data: accountsData } = useSWR<{ data: EmailAccount[] }>('/api/accounts', fetcher)
  // Une boîte PARTAGÉE est écartée comme dans l'écran de tri : créer un webhook exige la
  // permission `manageRules`, et la lister ici ne promettrait qu'un refus au premier clic.
  const accounts = (accountsData?.data ?? []).filter(a => !a.isShared)

  const { data, mutate } = useSWR<{ data: Webhook[] }>(WEBHOOKS_ENDPOINT, fetcher)
  const webhooks = data?.data ?? []

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [testedAt, setTestedAt] = useState<string | null>(null)

  const rankOf = (accountId: string) => accounts.findIndex(a => a.id === accountId)

  async function save() {
    if (!draft) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(draft.id ? `${WEBHOOKS_ENDPOINT}/${draft.id}` : WEBHOOKS_ENDPOINT, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: draft.accountId, name: draft.name.trim(), url: draft.url.trim() }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? String(res.status)); return }
      // Le secret ne sort qu'à la création : c'est ici, et nulle part ailleurs, qu'il s'affiche.
      if (!draft.id) setSecret((json.data as WebhookWithSecret).secret)
      setDraft(null)
      await mutate()
    } finally {
      setSaving(false)
    }
  }

  async function rotate(hook: Webhook) {
    if (!window.confirm(t('rotateConfirm', { name: hook.name }))) return
    const res = await fetch(`${WEBHOOKS_ENDPOINT}/${hook.id}/secret`, { method: 'POST' })
    const json = await res.json()
    if (res.ok) setSecret((json.data as WebhookWithSecret).secret)
    else setError(json.error ?? String(res.status))
  }

  async function remove(hook: Webhook) {
    if (!window.confirm(tRow('webhookDeleteConfirm', { name: hook.name }))) return
    await fetch(`${WEBHOOKS_ENDPOINT}/${hook.id}`, { method: 'DELETE' })
    await mutate()
  }

  async function sendTest(hook: Webhook) {
    setError(null)
    const res = await fetch(`${WEBHOOKS_ENDPOINT}/${hook.id}/test`, { method: 'POST' })
    if (!res.ok) { setError((await res.json()).error ?? String(res.status)); return }
    // L'envoi part du planificateur : l'écran dit qu'il est INSCRIT, pas qu'il est arrivé.
    setTestedAt(hook.id)
    setOpen(hook.id)
  }

  async function toggle(hook: Webhook) {
    await fetch(`${WEBHOOKS_ENDPOINT}/${hook.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !hook.enabled }),
    })
    await mutate()
  }

  const form = draft && (
    <div className="mb-5 space-y-3 rounded-2xl border border-border bg-card/80 p-5 shadow-sm backdrop-blur-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('name')}
          <Input value={draft.name} placeholder={t('namePlaceholder')} className="h-8 text-sm"
            onChange={e => setDraft(d => d && { ...d, name: e.target.value })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('url')}
          <Input value={draft.url} placeholder={t('urlPlaceholder')} spellCheck={false}
            className="h-8 font-mono text-xs"
            onChange={e => setDraft(d => d && { ...d, url: e.target.value })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('account')}
          {/* La boîte d'un webhook ne change pas après coup : ses envois et ses règles y sont liés. */}
          <select value={draft.accountId} disabled={!!draft.id}
            onChange={e => setDraft(d => d && { ...d, accountId: e.target.value })}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60">
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.email}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving || !draft.name.trim() || !draft.url.trim() || !draft.accountId}>
          {saving ? t('saving') : draft.id ? t('save') : t('create')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setError(null) }}>{t('cancel')}</Button>
      </div>
    </div>
  )

  return (
    <SettingsPage width="3xl">
      <SettingsHeader
        icon={<WebhookIcon className="h-4 w-4" />}
        title={t('title')}
        description={t('description')}
      />

      {secret && (
        <div className="mb-5 rounded-2xl border border-violet-500/30 bg-violet-500/5 p-5 shadow-sm">
          <div className="flex items-start gap-2 text-sm font-medium text-violet-700 dark:text-violet-300">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {t('secretWarn')}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code data-webhook-secret className="flex-1 break-all rounded-lg border border-border bg-background px-3 py-2 text-xs">
              {secret}
            </code>
            <Button size="sm" variant="outline" className="shrink-0 gap-1.5"
              onClick={() => { navigator.clipboard.writeText(secret); setCopied(true) }}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t('secretCopied') : t('secretCopy')}
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="mt-3"
            onClick={() => { setSecret(null); setCopied(false) }}>
            {t('secretDone')}
          </Button>
        </div>
      )}

      {!draft && (
        <div className="mb-4 flex">
          <Button size="sm" className="gap-1.5" disabled={!accounts.length}
            onClick={() => { setDraft({ id: null, accountId: accounts[0]?.id ?? '', name: '', url: '' }); setError(null) }}>
            <Plus className="h-3.5 w-3.5" /> {t('new')}
          </Button>
        </div>
      )}

      {form}
      {!draft && error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {!webhooks.length && !draft && (
        <p className="text-sm text-muted-foreground">{accounts.length ? t('empty') : t('noAccount')}</p>
      )}

      <div className="space-y-2">
        {webhooks.map(hook => (
          <WebhookRow
            key={hook.id}
            hook={hook}
            account={accounts[rankOf(hook.accountId)]}
            rank={rankOf(hook.accountId)}
            expanded={open === hook.id}
            justTested={testedAt === hook.id}
            onToggleOpen={() => setOpen(o => (o === hook.id ? null : hook.id))}
            onEdit={() => setDraft({ id: hook.id, accountId: hook.accountId, name: hook.name, url: hook.url })}
            onRotate={() => rotate(hook)}
            onTest={() => sendTest(hook)}
            onEnable={() => toggle(hook)}
            onRemove={() => remove(hook)}
          />
        ))}
      </div>
    </SettingsPage>
  )
}

/**
 * Un webhook = UNE ligne : sa boîte, son nom, sa destination, son état, son dernier envoi.
 * Le reste (ses déclencheurs, son journal) se DÉPLIE sous elle, et n'est demandé au serveur
 * qu'une fois déplié : une page qui liste dix webhooks n'a pas à charger dix journaux.
 */
function WebhookRow({
  hook, account, rank, expanded, justTested,
  onToggleOpen, onEdit, onRotate, onTest, onEnable, onRemove,
}: {
  hook: Webhook
  account: EmailAccount | undefined
  rank: number
  expanded: boolean
  justTested: boolean
  onToggleOpen: () => void
  onEdit: () => void
  onRotate: () => void
  onTest: () => void
  onEnable: () => void
  onRemove: () => void
}) {
  const t = useTranslations('settings.webhooks')
  const tRow = useTranslations('settings.rowActions')

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        {/* Cliquer la ligne la déplie : l'action évidente de l'objet, pas un bouton de plus. */}
        <button type="button" onClick={onToggleOpen} aria-expanded={expanded}
          data-webhook-row={hook.id}
          className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180')} />
          {account && <AccountAvatar account={account} colorIndex={rank} size="sm" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{hook.name}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{shortUrl(hook.url)}</span>
          </span>
        </button>

        <span className={cn('shrink-0 text-xs', hook.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
          {hook.enabled ? t('enabled') : t('disabled')}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
          {hook.lastDelivery ? new Date(hook.lastDelivery.at).toLocaleString() : t('never')}
        </span>

        <RowMenu label={tRow('menu', { name: hook.name })} itemsKey={hook.id}>
          {close => (<>
            <ContextMenuItem itemKey="edit" icon={<Pencil className={MENU_ICON} />} label={tRow('edit')}
              onClick={onEdit} onClose={close} enabled />
            <ContextMenuItem itemKey="enabled" icon={<WebhookIcon className={MENU_ICON} />}
              label={hook.enabled ? t('disable') : t('enable')} onClick={onEnable} onClose={close} enabled />
            <ContextMenuItem itemKey="test" icon={<Send className={MENU_ICON} />} label={t('test')}
              onClick={onTest} onClose={close} enabled />
            <ContextMenuItem itemKey="rotate" icon={<KeyRound className={MENU_ICON} />} label={t('rotate')}
              onClick={onRotate} onClose={close} enabled />
            <ContextMenuSeparator />
            <ContextMenuItem itemKey="delete" icon={<Trash2 className={MENU_ICON} />} label={tRow('webhookDelete')}
              onClick={onRemove} onClose={close} enabled danger />
          </>)}
        </RowMenu>
      </div>

      {expanded && <WebhookPanel hook={hook} justTested={justTested} />}
    </div>
  )
}

/** Ce qu'un webhook fait vraiment : qui le déclenche, et ce qui est parti. */
function WebhookPanel({ hook, justTested }: { hook: Webhook; justTested: boolean }) {
  const t = useTranslations('settings.webhooks')

  const { data: rulesData } = useSWR<{ data: EmailRule[] }>(`/api/rules?account=${hook.accountId}`, fetcher)
  const triggers = rulesTargeting(rulesData?.data ?? [], hook.id)

  const { data: deliveriesData, mutate } = useSWR<{ data: WebhookDelivery[] }>(
    `${WEBHOOKS_ENDPOINT}/${hook.id}/deliveries`, fetcher,
  )
  const deliveries = deliveriesData?.data ?? []

  const retry = async (delivery: WebhookDelivery) => {
    await fetch(`${WEBHOOKS_ENDPOINT}/deliveries/${delivery.id}/retry`, { method: 'POST' })
    await mutate()
  }

  return (
    <div className="grid gap-5 border-t border-border px-3.5 py-3 lg:grid-cols-2">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('triggers')}</h3>
        {triggers.length === 0
          ? <p className="text-xs text-muted-foreground">{t('triggersNone')}</p>
          : (
            <ul className="space-y-1">
              {triggers.map(rule => (
                <li key={rule.id} data-webhook-trigger={rule.id}
                  className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{rule.name}</span>
                  <span className={cn('shrink-0', rule.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                    {rule.enabled ? t('enabled') : t('disabled')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        {/* Un déclencheur EST une règle : il s'écrit dans l'éditeur de règles, prérempli
            sur CE webhook, plutôt que dans un second éditeur qui en divergerait. */}
        <Link href={webhookTriggerHref(hook)} data-webhook-add-trigger
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-violet-700 hover:underline dark:text-violet-300">
          <Plus className="h-3 w-3" /> {t('triggersAdd')}
        </Link>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('deliveries')}</h3>
        {justTested && <p className="mb-2 text-xs text-muted-foreground">{t('testQueued')}</p>}
        {deliveries.length === 0
          ? <p className="text-xs text-muted-foreground">{t('deliveriesNone')}</p>
          : (
            <ul className="space-y-1">
              {deliveries.map(d => (
                <li key={d.id} data-webhook-delivery={d.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span className="shrink-0 text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</span>
                  <span className="min-w-0 flex-1 truncate">{d.subject || d.ruleName || d.event}</span>
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 font-mono font-medium',
                    d.status === 'ok' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : d.status === 'failed' ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                      : 'text-muted-foreground')}>
                    {d.responseStatus ?? d.status}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {d.durationMs === null ? '' : `${d.durationMs} ms`}
                  </span>
                  <button type="button" onClick={() => retry(d)} data-webhook-retry={d.id}
                    className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                    <RotateCw className="h-3 w-3" />
                    <span className="sr-only">{t('retry')}</span>
                  </button>
                  {d.error && <span className="w-full text-[11px] text-red-700 dark:text-red-400">{d.error}</span>}
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
