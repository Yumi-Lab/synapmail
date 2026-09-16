'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  applyResolvedTheme,
  resolveTheme,
  themeCookieValue,
  toTheme,
  type ResolvedTheme,
  type Theme,
} from '@/lib/theme'

interface ThemeContextValue {
  /** Préférence de l'utilisateur : light | dark | system. */
  theme: Theme
  /** Ce qui est réellement affiché (`system` déjà résolu). */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_MEDIA_QUERY).matches
}

export function ThemeProvider({
  initialTheme = DEFAULT_THEME,
  children,
}: {
  /** Valeur du cookie lue au SSR : évite tout flash au premier rendu. */
  initialTheme?: Theme
  children: React.ReactNode
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme)
  const [systemDark, setSystemDark] = useState(false)

  // `user_settings.theme` fait autorité (multi-appareil) ; le cookie n'est qu'un
  // miroir local pour le SSR. On ne l'applique qu'une fois, sinon une préférence
  // changée dans l'onglet serait écrasée à chaque revalidation SWR.
  const { data: settings } = useSWR<{ data?: { theme?: string } }>('/api/settings', fetcher)
  const hydratedFromServer = useRef(false)

  useEffect(() => {
    const serverTheme = settings?.data?.theme
    if (hydratedFromServer.current || serverTheme === undefined) return
    hydratedFromServer.current = true
    const next = toTheme(serverTheme)
    setThemeState(next)
    document.cookie = themeCookieValue(next)
  }, [settings])

  // `system` suit les changements de l'OS en direct, sans rechargement.
  useEffect(() => {
    const media = window.matchMedia(DARK_MEDIA_QUERY)
    setSystemDark(media.matches)
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolvedTheme = resolveTheme(theme, systemDark)

  useEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    setSystemDark(prefersDark())
    document.cookie = themeCookieValue(next)
    // Optimiste sur la clé SWR partagée, puis revalidation quand le PATCH a atterri.
    globalMutate(
      '/api/settings',
      (curr: { data?: Record<string, unknown> } | undefined) =>
        curr?.data ? { ...curr, data: { ...curr.data, theme: next } } : curr,
      false
    )
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    })
      .catch(() => undefined)
      .then(() => globalMutate('/api/settings'))
  }, [])

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}
