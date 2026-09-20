'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Palette } from 'lucide-react'
import {
  SettingsPage, SettingsHeader, SettingsSection, Chips, SaveBar,
} from '@/components/settings/primitives'
import { DEFAULT_LOCALE, LOCALES, setLocale, type Locale } from '@/lib/locales'
import { ThemeToggle } from '@/components/ThemeToggle'
import { BrandingSection } from '@/components/admin/BrandingSection'
import { useIsAdmin } from '@/hooks/useIsAdmin'

interface UserSettings {
  language: string
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function AppearancePage() {
  const t = useTranslations('settings.appearance')
  const tc = useTranslations('settings.common')
  const { data } = useSWR<{ data: UserSettings }>('/api/settings', fetcher)
  const settings = data?.data
  // Lot H4a : l'identité de l'instance (nom et icône de l'onglet) se règle ICI,
  // là où Nicolas l'a cherchée deux fois. Le composant est RÉUTILISÉ tel quel,
  // jamais recopié, et un non-administrateur ne voit rien de plus sur cette page.
  const isAdmin = useIsAdmin()

  const [selectedLang, setSelectedLang] = useState<string>(DEFAULT_LOCALE)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings) {
      setSelectedLang(settings.language)
    }
  }, [settings])

  const dirty = !!settings && selectedLang !== settings.language

  const handleSave = async () => {
    setSaving(true)
    try {
      // Meme mecanisme que l'omnibar : cookie + preference + rechargement, une
      // seule fois ecrit (lib/locales.ts). Il ne rend pas la main (la page se
      // recharge), donc l'etat « enregistre » n'a plus lieu d'etre ici.
      await setLocale(selectedLang as Locale)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsPage width="xl">
      <SettingsHeader icon={<Palette className="h-4 w-4" />} title={t('title')} description={t('description')} />

      <div className="space-y-6">
        {isAdmin && <BrandingSection />}

        <SettingsSection title={t('theme')} description={t('themeDesc')}>
          <ThemeToggle />
        </SettingsSection>

        <SettingsSection title={t('language')} description={t('languageDesc')}>
          <Chips
            value={selectedLang}
            onChange={setSelectedLang}
            options={LOCALES.map(({ code, label }) => ({ value: code, label }))}
          />
        </SettingsSection>

        <SaveBar
          dirty={dirty}
          saving={saving}
          saved={false}
          onSave={handleSave}
          labels={{ save: tc('save'), saving: tc('saving'), saved: tc('saved'), unsaved: tc('unsaved') }}
        />
      </div>
    </SettingsPage>
  )
}
