'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  User, Palette, BookOpen, Bell, PenSquare,
  Mail, FileSignature, ArrowLeft, ShieldCheck, Users, Filter, LayoutTemplate, Bot, KeyRound, Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppName } from '@/components/providers'

/** The settings area: an INTERCEPTED route (`app/(app)/@modal/(.)settings`) opened as a window over the current page. */
export const SETTINGS_ROOT = '/settings'

/**
 * THE link to the settings: everything that leads to `SETTINGS_ROOT` or one of its tabs
 * goes through it, and it NEVER prefetches. `next/link` prefetches a visible link in a
 * production build without the header that activates the intercepted route; a click
 * during that prefetch reuses the in-flight response and the navigation never completes —
 * the window does not open (measured 2-3 times out of 3 from the account menu on a slow
 * network). One component rather than a `prefetch={false}` per link: the next link to the
 * settings cannot forget it.
 */
export function SettingsLink(props: Omit<ComponentProps<typeof Link>, 'prefetch'>) {
  return <Link {...props} prefetch={false} />
}

/** Where an account's sharing is managed — the one place the bar's shared mark points to. */
export const ACCOUNTS_SETTINGS_HREF = `${SETTINGS_ROOT}/accounts`

/**
 * The ONE source of settings entries: this bar renders them, and the omnibar
 * offers them as you type. Adding an entry here makes it reachable from both
 * places, with no second table to keep in sync; `key` is the i18n key for the
 * label (`settings.nav.<key>`) AND for the search keywords
 * (`omnibar.keywords.<key>`), both checked by check-omnibar-commands.
 */
export const SETTINGS_NAV = [
  { href: '/settings/profile',       key: 'profile',       icon: User },
  { href: '/settings/appearance',    key: 'appearance',    icon: Palette },
  { href: '/settings/reading',       key: 'reading',       icon: BookOpen },
  { href: '/settings/notifications', key: 'notifications', icon: Bell },
  { href: '/settings/composition',   key: 'composition',   icon: PenSquare },
  { href: ACCOUNTS_SETTINGS_HREF,    key: 'accounts',      icon: Mail },
  { href: '/settings/signatures',    key: 'signatures',    icon: FileSignature },
  { href: '/settings/templates',     key: 'templates',     icon: LayoutTemplate },
  { href: '/settings/contacts',      key: 'contacts',      icon: Users },
  { href: '/settings/rules',         key: 'rules',         icon: Filter },
  { href: '/settings/ai',            key: 'ai',            icon: Bot },
  { href: '/settings/pgp',           key: 'pgp',           icon: KeyRound },
  { href: '/settings/api-keys',      key: 'apiKeys',       icon: Terminal },
] as const

export function SettingsSidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname()
  const t = useTranslations('settings.nav')
  const appName = useAppName()

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
      active
        ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 font-medium'
        : 'text-muted-foreground hover:text-foreground hover:bg-accent',
    )

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-background">
      {/* Back to mail */}
      <div className="border-b border-border px-3 pb-3 pt-4">
        <Link
          href="/mail"
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span>{t('backToMail')}</span>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {SETTINGS_NAV.map(({ href, key, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <SettingsLink key={href} href={href} className={linkClass(active)}>
              <Icon className="h-4 w-4 shrink-0" />
              <span>{t(key)}</span>
            </SettingsLink>
          )
        })}

        {isAdmin && (
          <>
            <div className="my-2 border-t border-border" />
            <Link href="/admin/users" className={linkClass(pathname.startsWith('/admin'))}>
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>{t('admin')}</span>
            </Link>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="border-t border-border px-4 pb-4 pt-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50">{appName}</p>
      </div>
    </aside>
  )
}
