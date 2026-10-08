'use client'

import { useSession } from 'next-auth/react'

/**
 * Le rôle, côté client, lu en UN seul endroit : trois surfaces le consultent
 * (l'omnibar, la fenêtre des réglages, la page Apparence) et une quatrième
 * recopie finirait par diverger des trois autres.
 *
 * Ce n'est qu'un filtre d'AFFICHAGE : la vraie garde est côté serveur
 * (`lib/requireAdmin.ts`, relu en base par chaque route `/api/admin/*`), parce
 * qu'une session peut porter un rôle périmé.
 */
export function useIsAdmin(): boolean {
  const { data: session } = useSession()
  return (session?.user as { role?: string } | undefined)?.role === 'admin'
}
