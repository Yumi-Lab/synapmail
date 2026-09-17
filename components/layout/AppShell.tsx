'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { useTranslations } from 'next-intl'
import useSWR, { mutate } from 'swr'
import { cn } from '@/lib/utils'
import { Omnibar } from './Omnibar'
import { Sidebar, SIDEBAR, HEADER_ROW_CENTER } from './Sidebar'
import { UpdateBanner } from './UpdateBanner'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/**
 * Round toggle straddling the bar's right edge — half outside, half inside. It
 * lives outside the <aside> (which stays `overflow-hidden` for the width
 * animation) and outside `[data-sidebar]`, so it is not one of the rows the
 * collapse contract measures. `edgeX` is the aside's current width: the button
 * is centred on that edge, and animates with it.
 */
function EdgeToggle({ place, edgeX, label, onClick, className }: {
  /** Which bar this toggle straddles — the desktop bar or the mobile drawer. The
   *  desktop one stays mounted (display:none) below `lg`, so a test driving the
   *  drawer must be able to tell them apart. */
  place: 'bar' | 'drawer'
  edgeX: number
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      data-sidebar-edge-toggle={place}
      className={cn(
        'absolute z-20 items-center justify-center rounded-full',
        'border border-border bg-card text-foreground/70 shadow-sm',
        'hover:text-foreground hover:bg-accent transition-[left,color,background-color]',
        className ?? 'flex',
      )}
      style={{
        width: SIDEBAR.edgeButtonSize,
        height: SIDEBAR.edgeButtonSize,
        left: edgeX - SIDEBAR.edgeButtonSize / 2,
        top: HEADER_ROW_CENTER - SIDEBAR.edgeButtonSize / 2,
        transitionDuration: `${SIDEBAR.transitionMs}ms`,
      }}
    >
      <Menu className="w-4 h-4" />
    </button>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('mail')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // SSR-safe default (false) until the settings SWR resolves after mount — no hydration mismatch.
  const { data: settingsData } = useSWR<{ data: { sidebar_collapsed: boolean } }>('/api/settings', fetcher)
  const sidebarCollapsed = settingsData?.data?.sidebar_collapsed ?? false

  const toggleCollapse = () => {
    const next = !sidebarCollapsed
    mutate('/api/settings', (curr: { data: Record<string, unknown> } | undefined) =>
      curr ? { data: { ...curr.data, sidebar_collapsed: next } } : curr, false)
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sidebar_collapsed: next }),
    }).then(() => mutate('/api/settings'))
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-muted/30">
      {/* Application header, full width, above the bar and the content */}
      <Omnibar onOpenDrawer={() => setSidebarOpen(true)} />

      <div className="relative flex flex-1 min-h-0">
      {/* Desktop sidebar — width animated from the single geometry source */}
      <aside
        className="hidden lg:flex shrink-0 flex-col overflow-hidden border-r border-border transition-[width]"
        style={{
          width: sidebarCollapsed ? SIDEBAR.collapsedWidth : SIDEBAR.expandedWidth,
          transitionDuration: `${SIDEBAR.transitionMs}ms`,
        }}
      >
        <Sidebar collapsed={sidebarCollapsed} />
      </aside>
      <EdgeToggle
        place="bar"
        className="hidden lg:flex"
        edgeX={sidebarCollapsed ? SIDEBAR.collapsedWidth : SIDEBAR.expandedWidth}
        label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
        onClick={toggleCollapse}
      />

      {/* Mobile overlay sidebar */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex" data-sidebar-drawer>
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <aside
            className="relative z-10 h-full flex flex-col overflow-hidden border-r border-border shadow-2xl"
            style={{ width: SIDEBAR.expandedWidth }}
          >
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </aside>
          <EdgeToggle
            place="drawer"
            edgeX={SIDEBAR.expandedWidth}
            label={t('collapseSidebar')}
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Update banner */}
        <UpdateBanner />

        {children}
      </main>
      </div>
    </div>
  )
}
