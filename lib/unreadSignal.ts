'use client'

import { mutate } from 'swr'
import { IDLE_FOLDER } from './stream'

/**
 * Le compteur de non-lus, côté navigateur : ce qui le fait bouger TOUT DE SUITE.
 *
 * Le nombre affiché vient de `unreadCount` rendu par `GET /api/accounts`, relu
 * par SWR à intervalle. Le serveur dit désormais la vérité à l'instant de
 * l'action (`lib/unreadCount.ts`), mais l'écran, lui, ne la redemandait qu'au
 * tour suivant. Deux gestes suffisent, et aucun second sondage :
 *
 * - lire un message : on décale la valeur EN CACHE sans attendre le serveur
 *   (`unreadShift`), puis on revalide. Si le serveur refuse, la revalidation
 *   remet le vrai nombre — l'optimisme ne peut pas mentir durablement.
 * - un message arrive : `unreadRefresh` relit la liste des comptes, appelé
 *   depuis l'événement que le flux SSE pousse DÉJÀ (IMAP IDLE, lot temps réel).
 *
 * Portée honnête : IDLE ne surveille que la boîte ACTIVE. Pour les autres
 * comptes affichés, le nombre reste celui de la dernière relecture (intervalle
 * de `ACCOUNTS_KEY` côté `AccountAvatar`, plus le balayage serveur toutes les
 * 3 min) — correct, mais pas instantané.
 */

/** La clé SWR de la liste des comptes : le badge et le décalage lisent la MÊME. */
export const ACCOUNTS_KEY = '/api/accounts'

type AccountLike = { id: string; unreadCount?: number }

/**
 * Décale le compteur d'un compte dans le cache, sans requête. `delta` vaut -1
 * par message passé en lu, +1 en non lu. Le résultat ne descend pas sous zéro :
 * le compteur couvre toute la boîte, la liste seulement ce qu'elle a chargé.
 * Ne vise que la boîte de réception — c'est ce que le badge compte.
 */
export function unreadShift(accountId: string, folder: string, delta: number) {
  if (!delta || folder.toUpperCase() !== IDLE_FOLDER) return
  mutate(
    ACCOUNTS_KEY,
    (current?: { data?: AccountLike[] }) => current?.data
      ? { ...current, data: current.data.map(a => a.id === accountId
          ? { ...a, unreadCount: Math.max(0, (a.unreadCount ?? 0) + delta) }
          : a) }
      : current,
    false,
  )
}

/** Redemande les vrais compteurs. Appelé quand la boîte surveillée a changé. */
export const unreadRefresh = () => { void mutate(ACCOUNTS_KEY) }
