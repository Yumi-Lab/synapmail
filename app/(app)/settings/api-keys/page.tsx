'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, Terminal, Copy, Check, TriangleAlert, ChevronDown, Activity, BookOpen, KeyRound, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import type { ApiKey, ApiKeyRequestLog } from '@/types/account'
import { SettingsPage, SettingsHeader, SettingsSection } from '@/components/settings/primitives'
import { API_DOC_PATH } from '@/lib/apiDocs'
import { ALL_SCOPES, API_SCOPES, type ApiScope } from '@/lib/apiScopes'
import { AccountAvatar } from '@/components/layout/AccountAvatar'
import type { EmailAccount } from '@/types/account'
import { RowMenu, ContextMenuItem, MENU_ICON } from '@/components/ui/ContextMenu'
import { cn } from '@/lib/utils'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/**
 * `ApiKey` vit dans `types/account.ts`, hors du périmètre de ce lot : la portée
 * est ajoutée ici, là où elle est consommée, plutôt qu'en touchant un type partagé.
 */
type ScopedApiKey = ApiKey & {
  scopes: ApiScope[]
  /** Les boîtes cochées pour cette clé. */
  accountIds: string[]
  /** Les boîtes que la clé a CONNECTÉES : à elle, sans qu'on ait rien coché. */
  ownedAccountIds: string[]
  /** Faux pour une clé créée avant le lot P14 : son clair n'existe nulle part. */
  revealable: boolean
}

/**
 * Ré-afficher le clair d'une clé. Le mot de passe du compte est re-saisi ici, comme
 * pour toute opération sensible : il part vers `POST /api/api-keys/[id]/reveal`, qui
 * déchiffre et inscrit la révélation au journal de la clé.
 *
 * Une clé d'AVANT ce lot ne propose aucun bouton — son clair n'existe pas — mais dit
 * pourquoi, plutôt que de laisser un bouton mort.
 */
function RevealPanel({ apiKey, onRevealed }: { apiKey: ScopedApiKey; onRevealed: (key: string) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (!apiKey.revealable) {
    return (
      <p className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        Clé créée avant la fonction de ré-affichage : son contenu n&apos;est stocké nulle part,
        elle n&apos;est pas récupérable. Créez-en une nouvelle si vous l&apos;avez perdue.
      </p>
    )
  }

  const reveal = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const res = await fetch(`/api/api-keys/${apiKey.id}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const d = await res.json()
      if (!res.ok) { setFailure(res.status === 403 ? 'Mot de passe incorrect.' : (d.error ?? 'Erreur')); return }
      setPassword('')
      onRevealed(d.data.key)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Saisissez le mot de passe de votre compte pour réafficher cette clé. La révélation
        est inscrite au journal de la clé.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <PasswordInput
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && password && !busy) reveal() }}
          placeholder="Mot de passe du compte"
          autoComplete="current-password"
          containerClassName="min-w-[14rem] flex-1"
          className="h-8 text-sm"
        />
        <Button size="sm" onClick={reveal} disabled={busy || !password}>
          {busy ? 'Vérification…' : 'Afficher la clé'}
        </Button>
      </div>
      {failure && <p className="mt-2 text-xs text-destructive">{failure}</p>}
    </div>
  )
}

/**
 * Les boîtes sur lesquelles la clé a le droit d'agir. Les portées disent quelle
 * capacité, cette liste dit sur quelle boîte — les deux sont exigées.
 *
 * La pastille est `AccountAvatar`, la MÊME que la barre latérale et le tableau de
 * bord : sa couleur vient du RANG de la boîte dans la liste servie par
 * `/api/accounts`, donc une boîte garde ici la couleur qu'elle a partout ailleurs.
 * Une boîte connectée PAR la clé lui appartient : cochée, verrouillée, et dite
 * telle — la décocher n'aurait aucun effet, mieux vaut ne pas le laisser croire.
 */
function AccountPicker({
  accounts, value, owned = [], onChange,
}: {
  accounts: EmailAccount[]
  value: string[]
  owned?: string[]
  onChange: (next: string[]) => void
}) {
  if (!accounts.length) {
    return <p className="text-xs text-muted-foreground">Aucune boîte à autoriser.</p>
  }
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(a => a !== id) : [...value, id])

  return (
    <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {accounts.map((account, rank) => {
        const isOwned = owned.includes(account.id)
        return (
          <label
            key={account.id}
            className={cn(
              'flex items-center gap-2 rounded-lg px-2 py-1.5',
              isOwned ? 'opacity-70' : 'cursor-pointer hover:bg-muted',
            )}
          >
            <input
              type="checkbox"
              checked={isOwned || value.includes(account.id)}
              disabled={isOwned}
              onChange={() => toggle(account.id)}
              className="h-3.5 w-3.5 shrink-0 accent-violet-600"
            />
            <AccountAvatar account={account} colorIndex={rank} size="sm" />
            <span className="min-w-0">
              <span className="block truncate text-sm leading-tight">{account.name || account.email}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {isOwned ? 'Connectée par cette clé' : account.email}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

/** Ce qu'une clé reçoit quand on n'y touche pas : lire, rien d'autre. */
const DEFAULT_SCOPES: ApiScope[] = ['accounts:read', 'messages:read', 'folders:read']

/**
 * Les portées à cocher. La liste et les libellés viennent de `lib/apiScopes.ts` :
 * rien n'est retapé ici, donc une portée ajoutée là apparaît ici toute seule.
 */
function ScopePicker({ value, onChange }: { value: ApiScope[]; onChange: (next: ApiScope[]) => void }) {
  const toggle = (scope: ApiScope) =>
    onChange(value.includes(scope) ? value.filter(s => s !== scope) : [...value, scope])

  return (
    <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {ALL_SCOPES.map(scope => (
        <label key={scope} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
          <input
            type="checkbox"
            checked={value.includes(scope)}
            onChange={() => toggle(scope)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-violet-600"
          />
          <span className="min-w-0">
            <span className="block text-sm leading-tight">{API_SCOPES[scope]}</span>
            <span className="block font-mono text-[11px] text-muted-foreground">{scope}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Ce qu'un refus veut dire, en clair. Le motif vient de la barrière elle-même
 * (`lib/apiLog.ts`), le détail porte ce qui manquait : une portée — dont le libellé
 * est celui de `API_SCOPES`, jamais réécrit ici — ou une boîte, nommée par sa bulle.
 */
function denialLabel(log: ApiKeyRequestLog): string | null {
  if (!log.denialReason) return null
  if (log.denialReason === 'scope') {
    const scope = log.denialDetail as ApiScope | null
    return scope && scope in API_SCOPES ? `Autorisation manquante : ${API_SCOPES[scope]}` : 'Autorisation manquante'
  }
  if (log.denialReason === 'account') return 'Boîte non autorisée'
  return 'Clé non reconnue'
}

/**
 * Une requête et CE QU'ELLE A DONNÉ : statut, durée, boîte visée, motif du refus.
 * Le statut porte la couleur de son issue — un refus se repère sans lire le nombre.
 * La boîte est la MÊME bulle que partout ailleurs (`AccountAvatar`, rang dans la
 * liste servie par `/api/accounts`), pas une seconde façon de désigner une boîte.
 */
function ActivityRow({ log, accounts }: { log: ApiKeyRequestLog; accounts: EmailAccount[] }) {
  const rank = accounts.findIndex(a => a.id === log.accountId)
  const account = rank >= 0 ? accounts[rank] : null
  const denial = denialLabel(log)
  const ok = log.status !== null && log.status < 400

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="shrink-0 w-14 font-mono font-medium text-muted-foreground">{log.method}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{log.path}</span>
      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-0.5 font-mono font-medium',
          log.status === null ? 'text-muted-foreground'
            : ok ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
            : 'bg-red-500/15 text-red-700 dark:text-red-400',
        )}
      >
        {log.status ?? '—'}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {log.durationMs === null ? '—' : `${log.durationMs} ms`}
      </span>
      {account && <AccountAvatar account={account} colorIndex={rank} size="xs" />}
      <span className="shrink-0 text-muted-foreground">{log.ipAddress ?? '—'}</span>
      <span className="shrink-0 text-muted-foreground">{formatDateTime(log.createdAt)}</span>
      {denial && (
        <span className="w-full text-[11px] text-red-700 dark:text-red-400">
          {denial}
          {log.denialReason === 'account' && account ? ` — ${account.name || account.email}` : ''}
        </span>
      )}
    </div>
  )
}

function ActivityPanel({ keyId, accounts }: { keyId: string; accounts: EmailAccount[] }) {
  const { data, isLoading } = useSWR<{ data: ApiKeyRequestLog[] }>(`/api/api-keys/${keyId}/logs`, fetcher)
  const logs = data?.data ?? []

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      {isLoading && <p className="text-xs text-muted-foreground">Chargement…</p>}
      {!isLoading && logs.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucune requête enregistrée pour cette clé.</p>
      )}
      {logs.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {logs.map(log => <ActivityRow key={log.id} log={log} accounts={accounts} />)}
        </div>
      )}
    </div>
  )
}

/** Les autorisations d'une clé existante, modifiables sans la recréer. */
function ScopeEditor({ apiKey, accounts, onSave }: {
  apiKey: ScopedApiKey
  accounts: EmailAccount[]
  onSave: (scopes: ApiScope[], accountIds: string[]) => Promise<void>
}) {
  const [draft, setDraft] = useState<ApiScope[]>(apiKey.scopes)
  const [accountDraft, setAccountDraft] = useState<string[]>(apiKey.accountIds)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every(v => b.includes(v))
  const [saving, setSaving] = useState(false)
  const dirty = !same(draft, apiKey.scopes) || !same(accountDraft, apiKey.accountIds)

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      <ScopePicker value={draft} onChange={setDraft} />
      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Boîtes autorisées. Une boîte non cochée reste fermée, quelles que soient les autorisations.
        </p>
        <AccountPicker accounts={accounts} value={accountDraft} owned={apiKey.ownedAccountIds} onChange={setAccountDraft} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || !draft.length || saving}
          onClick={async () => { setSaving(true); try { await onSave(draft, accountDraft) } finally { setSaving(false) } }}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
        {!draft.length && (
          <span className="text-xs text-muted-foreground">Une clé sans autorisation ne pourrait rien faire.</span>
        )}
      </div>
    </div>
  )
}

export default function ApiKeysPage() {
  const tRow = useTranslations('settings.rowActions')
  const tDocs = useTranslations('settings.apiKeys')
  const { data, mutate } = useSWR<{ data: ScopedApiKey[] }>('/api/api-keys', fetcher)
  const keys = data?.data ?? []
  // La MÊME liste que la barre latérale : son ORDRE décide de la couleur des pastilles,
  // donc une boîte est de la même couleur ici que partout ailleurs.
  const { data: accountsData } = useSWR<{ data: EmailAccount[] }>('/api/accounts', fetcher)
  const accounts = accountsData?.data ?? []

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newScopes, setNewScopes] = useState<ApiScope[]>(DEFAULT_SCOPES)
  // Rien de coché par défaut : une clé neuve n'atteint que les boîtes qu'elle connecte
  // elle-même, jamais celles de quelqu'un d'autre sans un geste explicite.
  const [newAccounts, setNewAccounts] = useState<string[]>([])
  const [editingScopesFor, setEditingScopesFor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null)
  const [revealingKeyId, setRevealingKeyId] = useState<string | null>(null)

  const createKey = async () => {
    if (!newName.trim()) { setError('Nom requis'); return }
    if (!newScopes.length) { setError('Cochez au moins une autorisation'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, scopes: newScopes, accountIds: newAccounts }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Erreur')
      await mutate()
      setCreating(false)
      setNewName('')
      setNewScopes(DEFAULT_SCOPES)
      setNewAccounts([])
      setRevealedKey(d.data.key)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const saveScopes = async (key: ScopedApiKey, scopes: ApiScope[], accountIds: string[]) => {
    const res = await fetch(`/api/api-keys/${key.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes, accountIds }),
    })
    if (!res.ok) { setError((await res.json()).error ?? 'Erreur'); return }
    setError(null)
    setEditingScopesFor(null)
    await mutate()
  }

  const revokeKey = async (key: ApiKey) => {
    if (!confirm(tRow('apiKeyRevokeConfirm', { name: key.name }))) return
    await fetch(`/api/api-keys/${key.id}`, { method: 'DELETE' })
    await mutate()
  }

  const copyKey = () => {
    if (!revealedKey) return
    navigator.clipboard.writeText(revealedKey).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <SettingsPage width="2xl">
      <SettingsHeader
        icon={<Terminal className="h-4 w-4" />}
        title="Clés API"
        description="Accès Bearer en lecture et écriture pour un script ou un agent externe, en plus de la connexion navigateur"
      />

      <SettingsSection className="mb-6">
        <div className="flex items-start gap-3">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{tDocs('docsTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{tDocs('docsDescription')}</p>
          </div>
          <a
            href={API_DOC_PATH}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-sm font-medium text-violet-600 hover:underline dark:text-violet-400"
          >
            {tDocs('docsLink')}
          </a>
        </div>
      </SettingsSection>

      {revealedKey && (
        <div className="mb-6 rounded-2xl border border-violet-500/30 bg-violet-500/5 p-5 shadow-sm">
          <div className="flex items-start gap-2 text-sm font-medium text-violet-700 dark:text-violet-300">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
            Traitez cette clé comme un mot de passe : elle donne à qui la détient tout ce
            qui lui est coché.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-background border border-border px-3 py-2 text-xs break-all">
              {revealedKey}
            </code>
            <Button size="sm" variant="outline" onClick={copyKey} className="gap-1.5 shrink-0">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copié' : 'Copier'}
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setRevealedKey(null)}>
            J&apos;ai copié ma clé
          </Button>
        </div>
      )}

      <div className="mb-4 flex">
        <Button size="sm" onClick={() => { setCreating(true); setError(null) }} className="gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Nouvelle clé
        </Button>
      </div>

      {error && <p className="text-sm text-destructive mb-4">{error}</p>}

      {creating && (
        <div className="mb-6 space-y-3 rounded-2xl border border-border bg-card/80 p-5 shadow-sm backdrop-blur-sm">
          <h2 className="text-sm font-semibold">Nouvelle clé API</h2>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Nom</label>
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Agent de synchronisation IONOS"
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Autorisations</label>
            <p className="mb-2 text-xs text-muted-foreground">
              La clé ne pourra faire que ce qui est coché. Tout refus indique la portée qui manque.
            </p>
            <ScopePicker value={newScopes} onChange={setNewScopes} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Boîtes autorisées</label>
            <p className="mb-2 text-xs text-muted-foreground">
              La clé n&apos;atteindra que les boîtes cochées, plus celles qu&apos;elle connecte elle-même.
            </p>
            <AccountPicker accounts={accounts} value={newAccounts} onChange={setNewAccounts} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={createKey} disabled={saving}>
              {saving ? 'Création…' : 'Créer'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setError(null) }}>
              Annuler
            </Button>
          </div>
        </div>
      )}

      {keys.length === 0 && !creating && (
        <p className="text-sm text-muted-foreground">Aucune clé API. Créez-en une pour donner un accès lecture/écriture à un script ou un agent externe.</p>
      )}

      <div className="space-y-3">
        {keys.map(key => {
          const expanded = expandedKeyId === key.id
          const editingScopes = editingScopesFor === key.id
          const revealing = revealingKeyId === key.id
          return (
            <div key={key.id} className="border border-border rounded-xl bg-card shadow-sm p-4">
              <div className="flex items-center justify-between gap-3">
                {/* La carte EST le bouton : cliquer une clé déplie ses autorisations, sans
                    passer par un bouton séparé. L'action évidente d'un objet est son clic. */}
                <button
                  type="button"
                  onClick={() => setEditingScopesFor(editingScopes ? null : key.id)}
                  aria-expanded={editingScopes}
                  className="min-w-0 flex-1 text-left cursor-pointer rounded"
                  data-api-key-row={key.id}
                >
                  <div className="font-medium text-sm">{key.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-mono">{key.keyPrefix}…</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Créée le {formatDate(key.createdAt)}
                    {key.lastUsedAt ? ` · Dernière utilisation le ${formatDate(key.lastUsedAt)}` : ' · Jamais utilisée'}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <KeyRound className="w-3 h-3" />
                    {key.scopes.length} autorisation{key.scopes.length > 1 ? 's' : ''}
                    {' · '}
                    {key.accountIds.length + key.ownedAccountIds.length} boîte
                    {key.accountIds.length + key.ownedAccountIds.length > 1 ? 's' : ''}
                    <ChevronDown className={cn('w-3 h-3 transition-transform', editingScopes && 'rotate-180')} />
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setRevealingKeyId(revealing ? null : key.id)}
                    className="h-8 px-2.5 flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title="Réafficher la clé"
                    aria-expanded={revealing}
                    data-api-key-reveal={key.id}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Afficher
                  </button>
                  <button
                    onClick={() => setExpandedKeyId(expanded ? null : key.id)}
                    className="h-8 px-2.5 flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title="Voir l'activité récente"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    {key.requestCount24h > 0 ? `${key.requestCount24h} / 24h` : 'Activité'}
                    <ChevronDown className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
                  </button>
                  <RowMenu label={tRow('menu', { name: key.name })} itemsKey={key.id}>
                    {close => (
                      <ContextMenuItem
                        itemKey="revoke" icon={<Trash2 className={MENU_ICON} />} label={tRow('apiKeyRevoke')}
                        onClick={() => revokeKey(key)} onClose={close} enabled danger
                      />
                    )}
                  </RowMenu>
                </div>
              </div>
              {editingScopes && (
                <ScopeEditor
                  apiKey={key} accounts={accounts}
                  onSave={(scopes, accountIds) => saveScopes(key, scopes, accountIds)}
                />
              )}
              {revealing && (
                <RevealPanel
                  apiKey={key}
                  onRevealed={k => { setRevealingKeyId(null); setRevealedKey(k) }}
                />
              )}
              {expanded && <ActivityPanel keyId={key.id} accounts={accounts} />}
            </div>
          )
        })}
      </div>
    </SettingsPage>
  )
}
