'use client'

/**
 * La bulle qui devient une CASE À COCHER — la règle visuelle de la sélection,
 * une seule fois.
 *
 * Elle vient de la liste des messages, où elle existait déjà en clair dans la
 * ligne : la bulle s'efface au survol pour laisser la case vide, et disparaît
 * au profit de la case cochée quand la ligne est retenue. Le lot H4d demandait
 * « le système de sélecteur qu'on a déjà codé dans les boîtes mail » sur la
 * liste des newsletters : elle est donc SORTIE ici plutôt que recopiée, et les
 * deux écrans en rendent désormais exactement le même.
 *
 * Ce composant ne connaît PAS la règle de sélection (clic / Cmd-clic /
 * Maj-clic) : celle-là vit dans `lib/explorerSelection.ts`. Il ne rend qu'un
 * état, et prévient d'un clic sur la bulle.
 */

import { CheckSquare, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

/** L'attribut qui DIT si la case est cochée — lisible par un banc, sur les deux écrans. */
export const SELECT_BOX_ATTR = 'data-select-box'

export function SelectableBubble({
  checked, onToggle, className, children,
}: {
  checked: boolean
  /** Le clic sur la bulle elle-même. L'appelant décide du geste. */
  onToggle: (e: React.MouseEvent) => void
  /** La taille de la bulle, donnée par l'écran : elle diffère d'une liste à l'autre. */
  className?: string
  /** Ce que la bulle porte quand rien n'est coché ni survolé. */
  children: React.ReactNode
}) {
  return (
    <div
      className={cn('relative shrink-0 group/avatar', className)}
      onClick={onToggle}
      {...{ [SELECT_BOX_ATTR]: checked ? 'checked' : 'unchecked' }}
    >
      {checked ? (
        <div className="w-full h-full rounded-full flex items-center justify-center bg-primary/10 text-primary">
          <CheckSquare className="w-4 h-4" />
        </div>
      ) : (
        <>
          <div className="w-full h-full group-hover/avatar:opacity-0 transition-opacity">
            {children}
          </div>
          <div className="absolute inset-0 rounded-full flex items-center justify-center bg-muted/60 opacity-0 group-hover/avatar:opacity-100 transition-opacity">
            <Square className="w-4 h-4 text-muted-foreground" />
          </div>
        </>
      )}
    </div>
  )
}
