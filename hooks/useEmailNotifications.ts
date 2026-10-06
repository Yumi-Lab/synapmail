'use client'

import { useEffect, useRef } from 'react'
import useSWR from 'swr'
import { SETTINGS_KEY } from '@/lib/settings'
import type { Message } from '@/types/email'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/**
 * Prévient d'un message arrivé dans la liste AFFICHÉE. Le hook ne demande rien au
 * serveur : il observe la page 1 que la liste a déjà chargée (jusqu'au 06/10/2026 il
 * tenait son propre sondage `perPage=5` — une requête de liste de plus par ouverture,
 * pour le même dossier). Le plus récent est le plus grand UID — l'ordre d'arrivée IMAP,
 * quel que soit le tri de la liste. Changer de dossier ou de boîte repart de zéro :
 * le premier message vu n'est pas « nouveau ».
 */
export function useEmailNotifications(messages: readonly Message[], folder: string, accountId?: string) {
  const lastUidRef = useRef<string | null>(null)
  const scopeRef = useRef<string | null>(null)

  const { data: settingsData } = useSWR<{ data: { notifications: boolean } }>(SETTINGS_KEY, fetcher)
  const notificationsEnabled = settingsData?.data?.notifications !== false

  useEffect(() => {
    if (notificationsEnabled && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [notificationsEnabled])

  const newest = messages.reduce<Message | null>((top, m) => (!top || Number(m.uid) > Number(top.uid) ? m : top), null)
  const newestUid = newest?.uid ?? null
  const scope = `${accountId ?? ''}|${folder}`

  useEffect(() => {
    if (!newest || !newestUid) return
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      lastUidRef.current = newestUid
      return
    }
    if (newestUid === lastUidRef.current) return
    lastUidRef.current = newestUid
    if (!notificationsEnabled || Notification.permission !== 'granted') return
    try {
      const senderName = newest.from.name || newest.from.address
      const preview = newest.preview ? newest.preview.slice(0, 120) : newest.subject
      const notification = new Notification(`${senderName}`, {
        body: `${newest.subject}${preview && preview !== newest.subject ? `\n${preview}` : ''}`,
        icon: '/brand/png/synapmail-favicon@64.png',
        tag: `synapmail-${newest.uid}`, // prevent duplicates
        requireInteraction: false,
        silent: false,
      })
      notification.onclick = () => {
        window.focus()
        window.dispatchEvent(new CustomEvent('synapmail:open-message', {
          detail: { uid: newest.uid, accountId: newest.accountId || accountId, folder },
        }))
        notification.close()
      }
    } catch {
      // Notifications not supported
    }
  }, [newest, newestUid, scope, folder, accountId, notificationsEnabled])
}
