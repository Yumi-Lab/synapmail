'use client'

import { ThemeToggle as ThemeToggleBase } from '@/components/ThemeToggle'

/**
 * Point d'import historique (barre latérale, hors périmètre de cette lane) : il
 * traduit l'ancienne prop `collapsed` vers `compact`. Le composant réel vit dans
 * components/ThemeToggle.tsx — source unique.
 */
export function ThemeToggle({ className, collapsed }: { className?: string; collapsed?: boolean }) {
  return <ThemeToggleBase className={className} compact={collapsed} />
}
