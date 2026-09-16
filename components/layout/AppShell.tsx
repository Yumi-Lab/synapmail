'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import useSWR, { mutate } from 'swr'
import { Sidebar, SIDEBAR } from './Sidebar'
import { UpdateBanner } from './UpdateBanner'

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function AppShell({ children }: { children: React.ReactNode }) {
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
    <div className="flex h-screen overflow-hidden bg-muted/30">
      {/* Desktop sidebar — width animated from the single geometry source */}
      <aside
        className="hidden lg:flex shrink-0 flex-col overflow-hidden border-r border-border transition-[width]"
        style={{
          width: sidebarCollapsed ? SIDEBAR.collapsedWidth : SIDEBAR.expandedWidth,
          transitionDuration: `${SIDEBAR.transitionMs}ms`,
        }}
      >
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleCollapse} />
      </aside>

      {/* Mobile overlay sidebar */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
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
        </div>
      )}

      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Update banner */}
        <UpdateBanner />

        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center px-4 py-3 border-b border-border bg-background shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>

        {children}
      </main>
    </div>
  )
}
