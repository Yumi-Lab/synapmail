'use client'

import { useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  BRANDING_ERRORS,
  DEFAULT_APP_NAME,
  type Branding,
  type BrandingError,
  faviconLinks,
  faviconUrl,
} from '@/lib/branding'

const ROUTE = '/api/admin/branding'
const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Les deux tailles auxquelles un navigateur affiche réellement une favicon. */
const PREVIEW_SIZES = [16, 32] as const

const KNOWN_ERRORS: readonly string[] = Object.values(BRANDING_ERRORS)
const isBrandingError = (value: unknown): value is BrandingError =>
  typeof value === 'string' && KNOWN_ERRORS.includes(value)

/**
 * Applique l'identité à l'onglet SANS recharger : le titre, puis les
 * `<link rel="icon">` de la page, reposés depuis `faviconLinks()` — la MÊME
 * source que le rendu serveur, pour qu'une remise à zéro rétablisse les DEUX
 * icônes livrées et non la seule première. Repartir de `<link>` neufs (plutôt
 * que changer leur `href`) est ce qui force les navigateurs à relire l'icône.
 */
function applyToTab(appName: string, faviconVersion: number | null) {
  document.title = appName
  document.head.querySelectorAll('link[rel~="icon"]').forEach(node => node.remove())
  for (const icon of faviconLinks(faviconVersion)) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = icon.url
    if (icon.type) link.type = icon.type
    if (icon.sizes) link.sizes.value = icon.sizes
    document.head.appendChild(link)
  }
}

/**
 * Identité de l'instance, réservée à l'administrateur : le nom affiché dans
 * l'onglet du navigateur et l'icône de cet onglet, pour TOUT LE MONDE, page de
 * connexion comprise. Les icônes PWA / apple-touch et le logo image ne sont pas
 * concernés.
 */
export function BrandingSection() {
  const t = useTranslations('admin.branding')
  const { data, mutate } = useSWR<{ data: Branding }>(ROUTE, fetcher)
  const branding = data?.data

  const [name, setName] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  // URL d'aperçu du fichier choisi : créée UNE fois par choix et révoquée à la
  // suivante, sinon chaque rendu fabriquerait un blob de plus.
  const [filePreview, setFilePreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Tant que l'administrateur n'a rien tapé, le champ montre ce qui est enregistré.
  const nameValue = name ?? branding?.appName ?? ''
  // L'aperçu montre UNE image : la première des icônes livrées, ou celle réglée.
  const iconSrc = branding?.faviconVersion
    ? faviconUrl(branding.faviconVersion)
    : faviconLinks(null)[0].url

  const settle = (next: Branding) => {
    mutate({ data: next }, false)
    applyToTab(next.appName, next.faviconVersion)
    setName(null)
    pickFile(null)
    if (fileRef.current) fileRef.current.value = ''
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const run = async (request: () => Promise<Response>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await request()
      const body = await res.json()
      if (!res.ok) {
        setError(isBrandingError(body.error) ? t(`errors.${body.error}`) : String(body.error))
        return
      }
      settle(body.data as Branding)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const pickFile = (next: File | null) => {
    setFilePreview(previous => {
      if (previous) URL.revokeObjectURL(previous)
      return next ? URL.createObjectURL(next) : null
    })
    setFile(next)
  }

  const save = () => {
    const form = new FormData()
    if (name !== null) form.set('appName', name)
    if (file) form.set('favicon', file)
    return run(() => fetch(ROUTE, { method: 'PUT', body: form }))
  }

  const reset = (target: 'name' | 'favicon') =>
    run(() => fetch(`${ROUTE}?target=${target}`, { method: 'DELETE' }))

  const dirty = (name !== null && name !== branding?.appName) || file !== null

  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('title')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="branding-name">
            {t('nameLabel')}
          </label>
          <Input
            id="branding-name"
            value={nameValue}
            onChange={e => setName(e.target.value)}
            placeholder={DEFAULT_APP_NAME}
            className="h-8 text-sm"
          />
          <button
            type="button"
            data-branding-reset="name"
            onClick={() => reset('name')}
            disabled={busy}
            className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            {t('resetName')}
          </button>
        </div>

        <div>
          <span className="mb-1 block text-xs text-muted-foreground">{t('iconLabel')}</span>
          <div className="flex items-center gap-3">
            {PREVIEW_SIZES.map(size => (
              // Aperçu à la taille RÉELLE d'une favicon : c'est là qu'une icône
              // trop chargée devient illisible, pas dans une vignette agrandie.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={size}
                src={filePreview ?? iconSrc}
                alt={t('preview')}
                width={size}
                height={size}
                style={{ width: size, height: size }}
              />
            ))}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/jpeg,image/webp"
              onChange={e => { pickFile(e.target.files?.[0] ?? null); setError(null) }}
              className="text-xs file:mr-2 file:h-7 file:rounded-md file:border file:border-border file:bg-background file:px-2 file:text-xs"
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('iconHint')}</p>
          <button
            type="button"
            data-branding-reset="favicon"
            onClick={() => reset('favicon')}
            disabled={busy}
            className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            {t('resetIcon')}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={busy || !dirty}>
          {busy ? t('saving') : t('save')}
        </Button>
        {saved && <span className="text-xs text-muted-foreground">{t('saved')}</span>}
      </div>
    </section>
  )
}
