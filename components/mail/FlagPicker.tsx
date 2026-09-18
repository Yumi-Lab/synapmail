'use client'

/**
 * Les sept drapeaux de couleur, plus « retirer ». Un seul rendu pour tous les
 * endroits qui posent un drapeau (volet de lecture, menu contextuel) : l'ordre,
 * les couleurs et les libellés viennent de lib/flags.ts et ne se recopient pas.
 */

import { Flag, FlagOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { MAIL_FLAGS } from '@/lib/flags'
import { cn } from '@/lib/utils'

interface Props {
  /** Couleur posée, pour cocher la pastille courante. */
  current?: string | null
  onPick: (flag: string | null) => void
  className?: string
}

export function FlagPicker({ current, onPick, className }: Props) {
  const t = useTranslations('mail')
  return (
    <div className={cn('flex items-center gap-0.5 p-1', className)}>
      {MAIL_FLAGS.map(f => (
        <button
          key={f.key}
          type="button"
          title={t(`flags.${f.labelKey}`)}
          aria-label={t(`flags.${f.labelKey}`)}
          aria-pressed={current === f.key}
          data-flag={f.key}
          onClick={() => onPick(f.key)}
          className={cn(
            'w-7 h-7 flex items-center justify-center rounded hover:bg-accent transition-colors',
            current === f.key && 'bg-accent'
          )}
        >
          <Flag className={cn('w-3.5 h-3.5 fill-current', f.colorClass)} />
        </button>
      ))}
      <button
        type="button"
        title={t('flagRemove')}
        aria-label={t('flagRemove')}
        data-flag=""
        onClick={() => onPick(null)}
        className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <FlagOff className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
