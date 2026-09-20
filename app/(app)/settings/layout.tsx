import { auth } from '@/lib/auth'
import { SettingsSidebar } from '@/components/settings/SettingsSidebar'
import { ThinScroll } from '@/components/layout/ThinScroll'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  const isAdmin = (session?.user as { role?: string })?.role === 'admin'

  return (
    <div className="flex h-full overflow-hidden">
      <SettingsSidebar isAdmin={isAdmin} />
      {/* L'ascenseur du thème, comme partout ailleurs : `overflow-y-auto` nu rendait
          la barre native du système sur cet écran-là seulement. */}
      <main className="flex-1 min-w-0 flex">
        <ThinScroll className="flex-1">
          <div className="mx-auto w-full max-w-[900px]">
            {children}
          </div>
        </ThinScroll>
      </main>
    </div>
  )
}
