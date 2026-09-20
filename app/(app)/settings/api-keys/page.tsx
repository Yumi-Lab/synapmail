'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, Terminal, Copy, Check, TriangleAlert, ChevronDown, Activity, BookOpen, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ApiKey, ApiKeyRequestLog } from '@/types/account'
import { SettingsPage, SettingsHeader, SettingsSection } from '@/components/settings/primitives'
import { API_DOC_PATH } from '@/lib/apiDocs'
import { ALL_SCOPES, API_SCOPES, type ApiScope } from '@/lib/apiScopes'
import { RowMenu, ContextMenuItem, MENU_ICON } from '@/components/ui/ContextMenu'
import { cn } from '@/lib/utils'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/**
 * `ApiKey` vit dans `types/account.ts`, hors du périmètre de ce lot : la portée
 * est ajoutée ici, là où elle est consommée, plutôt qu'en touchant un type partagé.
 */
type ScopedApiKey = ApiKey & { scopes: ApiScope[] }

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

function ActivityPanel({ keyId }: { keyId: string }) {
  const { data, isLoading } = useSWR<{ data: ApiKeyRequestLog[] }>(`/api/api-keys/${keyId}/logs`, fetcher)
  const logs = data?.data ?? []

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      {isLoading && <p className="text-xs text-muted-foreground">Chargement…</p>}
      {!isLoading && logs.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucune requête enregistrée pour cette clé.</p>
      )}
      {logs.length > 0 && (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="flex items-center gap-2 text-xs">
              <span className="shrink-0 w-14 font-mono font-medium text-muted-foreground">{log.method}</span>
              <span className="flex-1 min-w-0 truncate font-mono">{log.path}</span>
              <span className="shrink-0 text-muted-foreground">{log.ipAddress ?? '—'}</span>
              <span className="shrink-0 text-muted-foreground">{formatDateTime(log.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Les autorisations d'une clé existante, modifiables sans la recréer. */
function ScopeEditor({ apiKey, onSave }: { apiKey: ScopedApiKey; onSave: (scopes: ApiScope[]) => Promise<void> }) {
  const [draft, setDraft] = useState<ApiScope[]>(apiKey.scopes)
  const [saving, setSaving] = useState(false)
  const dirty = draft.length !== apiKey.scopes.length || draft.some(s => !apiKey.scopes.includes(s))

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
      <ScopePicker value={draft} onChange={setDraft} />
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || !draft.length || saving}
          onClick={async () => { setSaving(true); try { await onSave(draft) } finally { setSaving(false) } }}
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

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newScopes, setNewScopes] = useState<ApiScope[]>(DEFAULT_SCOPES)
  const [editingScopesFor, setEditingScopesFor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null)

  const createKey = async () => {
    if (!newName.trim()) { setError('Nom requis'); return }
    if (!newScopes.length) { setError('Cochez au moins une autorisation'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, scopes: newScopes }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Erreur')
      await mutate()
      setCreating(false)
      setNewName('')
      setNewScopes(DEFAULT_SCOPES)
      setRevealedKey(d.data.key)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const saveScopes = async (key: ScopedApiKey, scopes: ApiScope[]) => {
    const res = await fetch(`/api/api-keys/${key.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes }),
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
            Cette clé ne sera plus jamais affichée. Copiez-la maintenant.
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
                    <ChevronDown className={cn('w-3 h-3 transition-transform', editingScopes && 'rotate-180')} />
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
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
              {editingScopes && <ScopeEditor apiKey={key} onSave={scopes => saveScopes(key, scopes)} />}
              {expanded && <ActivityPanel keyId={key.id} />}
            </div>
          )
        })}
      </div>
    </SettingsPage>
  )
}
