'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  User, Palette, BookOpen, Bell, PenSquare,
  Mail, FileSignature, ArrowLeft, ShieldCheck, Users, Filter, LayoutTemplate, Bot, KeyRound, Terminal,
  Image as ImageIcon,
} from 'lucide-react'
import { BRANDING_ANCHOR } from '@/components/admin/BrandingSection'
import { cn } from '@/lib/utils'
import { useAppName } from '@/components/providers'

/** Where an account's sharing is managed — the one place the bar's shared mark points to. */
export const ACCOUNTS_SETTINGS_HREF = '/settings/accounts'

/** La page d'administration — la seule, et le seul endroit où son chemin s'écrit. */
export const ADMIN_HREF = '/admin/users'

/**
 * Source UNIQUE des entrees de reglages : cette barre les rend, et l'omnibar
 * (lot H3f) les propose a la saisie. Ajouter un reglage ici le rend trouvable
 * dans les deux endroits, sans seconde table a tenir a jour ; `key` sert de cle
 * i18n pour le libelle (`settings.nav.<key>`) ET pour les mots-cles de recherche
 * (`omnibar.keywords.<key>`), tous deux controles par check-omnibar-commands.
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

/**
 * Les entrées réservées à l'ADMINISTRATEUR, même forme que `SETTINGS_NAV` et même
 * rôle de source unique : cette barre les rend et l'omnibar (lot H3h) les propose,
 * les deux pour un administrateur SEULEMENT. « Nom et icône de l'onglet » pointe sur
 * l'ancre de la section qui les règle (`BRANDING_ANCHOR`) et non sur le haut de la
 * page d'administration, où rien ne la nomme — c'est le défaut que le lot corrige.
 */
export const ADMIN_NAV = [
  { href: ADMIN_HREF,                          key: 'admin',    icon: ShieldCheck },
  { href: `${ADMIN_HREF}#${BRANDING_ANCHOR}`,  key: 'branding', icon: ImageIcon },
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
            <Link key={href} href={href} className={linkClass(active)}>
              <Icon className="h-4 w-4 shrink-0" />
              <span>{t(key)}</span>
            </Link>
          )
        })}

        {isAdmin && (
          <>
            <div className="my-2 border-t border-border" />
            {ADMIN_NAV.map(({ href, key, icon: Icon }) => (
              // Même motif de ligne que les réglages ci-dessus. L'état actif se lit
              // sur le CHEMIN seul : une ancre ne change pas la page où l'on est.
              <Link key={href} href={href} className={linkClass(pathname.startsWith(ADMIN_HREF))}>
                <Icon className="h-4 w-4 shrink-0" />
                <span>{t(key)}</span>
              </Link>
            ))}
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
