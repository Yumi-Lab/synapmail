'use client'

/**
 * Le sélecteur de boîte, en UN endroit : la LIGNE de boîte (son texte) et le FILTRE
 * au clavier du lot M7b. La barre latérale et le tableau de bord n'y ajoutent que
 * leur propre enveloppe — l'un une ligne de la barre qui se replie, l'autre une
 * liste en surface flottante. Ce qui se répétait (le champ, son focus, ↑/↓/Entrée/
 * Échap, le nom au-dessus de l'adresse) vit ici et nulle part ailleurs.
 *
 * La moitié PURE du filtre reste `lib/accountFilter.ts` (auto-contrôlée sans
 * navigateur) : ce module ne porte que le React autour d'elle.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { ACCENT } from './AccountAvatar'
import { ACCOUNT_FILTER_MAX, filterAccounts, type FilterableAccount } from '@/lib/accountFilter'

/** Au-delà de ce nombre de lignes, le sélecteur offre un champ de filtre. */
export const ACCOUNT_PICKER_FILTER_FROM = 3

type PickableAccount = FilterableAccount & { id: string }

/**
 * L'état du filtre et son clavier. `open` est l'ouverture du sélecteur : le champ
 * prend le focus à l'ouverture (jamais au montage — la liste est toujours dans le
 * document, c'est sa hauteur qui s'anime), et le filtre est vidé à la fermeture.
 */
export function useAccountPicker<T extends PickableAccount>({
  open, accounts, onPick, focusDelayMs = 0, enabled = true,
}: {
  open: boolean
  accounts: readonly T[]
  onPick: (id: string) => void
  /** Attendre la fin d'un pli avant de prendre le focus : le champ n'est atteignable qu'une fois visible. */
  focusDelayMs?: number
  /** Une barre repliée n'a pas de champ du tout. */
  enabled?: boolean
}) {
  const [filter, setFilter] = useState('')
  /** Ligne en surbrillance, déplacée par ↑/↓ et validée par Entrée. */
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = filterAccounts(filter, accounts)
  const showFilter = enabled && accounts.length > ACCOUNT_PICKER_FILTER_FROM

  useEffect(() => {
    if (!open) setFilter('')
    setHighlight(0)
  }, [open])

  // La surbrillance ne doit jamais désigner une ligne que le filtre vient de retirer.
  useEffect(() => { setHighlight(0) }, [filter])

  useEffect(() => {
    if (!open || !showFilter) return
    const id = window.setTimeout(() => inputRef.current?.focus(), focusDelayMs)
    return () => window.clearTimeout(id)
  }, [open, showFilter, focusDelayMs])

  /**
   * ↑/↓ déplacent la surbrillance, Entrée bascule sur la ligne en surbrillance (la
   * première par défaut), Échap vide le filtre s'il est rempli et ne ferme la liste
   * que s'il est déjà vide — sinon une frappe de trop refermerait le panneau qu'on
   * vient d'ouvrir.
   *
   * L'Échap qui a servi à vider le champ est arrêté par `stopImmediatePropagation`,
   * et non par le `stopPropagation` de React : le routeur d'applications hydrate le
   * DOCUMENT entier, donc l'écouteur de React et celui qui referme la liste sont
   * posés sur le MÊME nœud. Entre deux écouteurs du même nœud, seule la variante
   * « immediate » arrête le second — mesuré : sans elle, la liste se refermait et le
   * champ perdait le focus, ce qui rendait ↑/↓ inopérants juste après un Échap.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = filtered.length - 1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (last < 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight(i => Math.min(last, Math.max(0, i + step)))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const picked = filtered[highlight]
      if (picked) onPick(picked.id)
      return
    }
    if (e.key === 'Escape' && filter) {
      e.preventDefault()
      e.nativeEvent.stopImmediatePropagation()
      setFilter('')
    }
  }

  return { filter, setFilter, filtered, highlight, showFilter, inputRef, onKeyDown }
}

/** Le champ de filtre lui-même — le `maxLength` et la fonction lisent la MÊME borne. */
export function AccountPickerFilter({
  value, onChange, onKeyDown, inputRef, className,
}: {
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  inputRef: React.RefObject<HTMLInputElement>
  className?: string
}) {
  const t = useTranslations('mail')
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      maxLength={ACCOUNT_FILTER_MAX}
      placeholder={t('searchAccounts')}
      data-account-filter
      className={cn(
        'w-full px-2.5 py-1.5 rounded-md bg-foreground/[0.06] text-sm text-foreground',
        'placeholder:text-muted-foreground outline-none focus:ring-1', ACCENT.ring,
        className,
      )}
    />
  )
}

/**
 * Le texte d'une ligne de boîte : le nom, et l'adresse en dessous quand elle ne
 * répète pas le nom. Une seule mise en forme, pour la barre comme pour le tableau
 * de bord.
 */
export function AccountPickerText({ account, className, style }: {
  account: { email: string; name?: string | null }
  className?: string
  /** Marge que l'enveloppe réserve à ce qu'elle peint À CÔTÉ du texte (repère « partagé »). */
  style?: React.CSSProperties
}) {
  return (
    <span className={cn('flex-1 min-w-0 text-left', className)} style={style}>
      <span className="block text-sm font-medium truncate leading-tight">{account.name || account.email}</span>
      {account.name && (
        <span className="block text-[11px] text-muted-foreground truncate leading-tight">{account.email}</span>
      )}
    </span>
  )
}
