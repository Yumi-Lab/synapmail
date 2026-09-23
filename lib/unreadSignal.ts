'use client'

import { mutate } from 'swr'
import { IDLE_FOLDER } from './stream'
import { originKey, type MessageOrigin } from './mailOrigin'

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
 * L'état « ce message est-il déjà compté comme lu » par origine.
 *
 * Un même message est passé en lu par DEUX chemins qui s'ignorent : le clic de
 * la liste (qui grise la ligne tout de suite) et le volet de lecture (qui écrit
 * vraiment, une fois le message chargé). Sans mémoire, ouvrir un message ferait
 * descendre le compteur DEUX fois. Avec elle, seul le premier des deux agit, et
 * le repasser en non lu refait bien remonter le compteur.
 */
const counted = new Map<string, boolean>()

/**
 * Décale le compteur des comptes concernés dans le cache, sans requête.
 * `read` vrai = ces messages viennent d'être lus (-1 chacun), faux = non lus
 * (+1). Le résultat ne descend pas sous zéro : le compteur couvre toute la
 * boîte, la liste seulement ce qu'elle a chargé. Ne vise que la boîte de
 * réception — c'est ce que le badge compte.
 */
export function unreadShift(origins: readonly MessageOrigin[], read: boolean) {
  const deltas = new Map<string, number>()
  for (const origin of origins) {
    if (!origin.accountId || !origin.folder || !origin.uid) continue
    if (origin.folder.toUpperCase() !== IDLE_FOLDER) continue
    const key = originKey(origin)
    if (counted.get(key) === read) continue
    counted.set(key, read)
    deltas.set(origin.accountId, (deltas.get(origin.accountId) ?? 0) + (read ? -1 : 1))
  }
  if (!deltas.size) return
  mutate(
    ACCOUNTS_KEY,
    (current?: { data?: AccountLike[] }) => current?.data
      ? { ...current, data: current.data.map(a => deltas.has(a.id)
          ? { ...a, unreadCount: Math.max(0, (a.unreadCount ?? 0) + deltas.get(a.id)!) }
          : a) }
      : current,
    false,
  )
}

/** Redemande les vrais compteurs. Appelé quand la boîte surveillée a changé. */
export const unreadRefresh = () => { void mutate(ACCOUNTS_KEY) }
