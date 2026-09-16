import type { Metadata } from 'next'
import './globals.css'
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

export const metadata: Metadata = {
  title: 'Synapmail',
  description: 'Self-hosted AI-powered email client',
  icons: {
    icon: [
      { url: '/favicon.ico', type: 'image/x-icon', sizes: 'any' },
      { url: '/brand/png/synapmail-favicon@64.png', type: 'image/png', sizes: '64x64' },
    ],
    apple: { url: '/brand/png/synapmail-icone@512.png', sizes: '512x512' },
  },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()
  const theme = toTheme(cookies().get(THEME_COOKIE)?.value)
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
          <Providers initialTheme={theme}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
