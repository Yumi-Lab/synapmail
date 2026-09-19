import type { Metadata } from 'next'
import './globals.css'
import { BUNDLED_APPLE_ICON, faviconLinks } from '@/lib/branding'
import { readBranding } from '@/lib/brandingStore'
import { Providers } from '@/components/providers'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { cookies } from 'next/headers'
import {
  DARK_CLASS,
  THEME_COOKIE,
  themeInitScript,
  toTheme,
} from '@/lib/theme'

/**
 * Le titre de l'onglet et son icône viennent du réglage d'instance quand il en
 * existe un, sinon de ce qui est livré : une instance qui n'a rien réglé ne
 * change pas d'aspect à la mise à jour. Les icônes PWA / apple-touch ne sont
 * PAS concernées par ce réglage (hors périmètre) : `apple` reste le fichier livré.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { appName, faviconVersion } = await readBranding()
  return {
    title: appName,
    description: 'Self-hosted AI-powered email client',
    icons: { icon: [...faviconLinks(faviconVersion)], apple: BUNDLED_APPLE_ICON },
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()
  const theme = toTheme(cookies().get(THEME_COOKIE)?.value)
  const { appName } = await readBranding()
  // `light`/`dark` sont résolus ici même (aucun flash) ; `system` dépend du client,
  // d'où le script bloquant ci-dessous, qui vaut `null` pour les deux autres cas.
  const initScript = themeInitScript(theme)

  return (
    <html lang={locale} className={theme === 'dark' ? DARK_CLASS : undefined} suppressHydrationWarning>
      {/* Pas de `<head>` écrit à la main : l'App Router le compose lui-même (metadata,
          feuilles de style) et un `<head>` manuel casse l'hydratation. Le script
          d'initialisation est donc le PREMIER enfant de `<body>` — il s'exécute avant
          le rendu du contenu, donc toujours sans flash. */}
      <body className="font-sans antialiased">
        {initScript !== null && <script dangerouslySetInnerHTML={{ __html: initScript }} />}
        <NextIntlClientProvider messages={messages}>
          <Providers initialTheme={theme} appName={appName}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
