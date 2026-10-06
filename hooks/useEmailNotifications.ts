'use client'

import { useEffect, useRef } from 'react'
import useSWR from 'swr'
import type { Message } from '@/types/email'

const fetcher = (url: string) => fetch(url).then(r => r.json())

/** Highest UID already seen in a scope (`account|folder`). */
export type Watermark = { scope: string; uid: number }

/**
 * The message to announce, if any, given what the list shows now and the
 * watermark of the previous look. Only a STRICTLY higher UID is an arrival: a
 * list filter (unread, starred…) or a deletion can lower the top UID, and
 * going back up to a UID already seen is not new either. A scope change
 * starts over — the first message seen there is not "new".
 */
export function arrival(
  messages: readonly Message[],
  scope: string,
  mark: Watermark | null,
): { mark: Watermark | null; announce: Message | null } {
  const newest = messages.reduce<Message | null>((top, m) => (!top || Number(m.uid) > Number(top.uid) ? m : top), null)
  if (!newest) return { mark, announce: null }
  const uid = Number(newest.uid)
  if (!mark || mark.scope !== scope) return { mark: { scope, uid }, announce: null }
  if (uid <= mark.uid) return { mark, announce: null }
  return { mark: { scope, uid }, announce: newest }
}

/**
 * Notifies of a message that arrived in the DISPLAYED list. The hook asks the
 * server for nothing: it observes the page 1 the list has already loaded (it used
 * to run its own `perPage=5` poll — one more list request per opening, for the
 * same folder). The newest is the highest UID — IMAP arrival order, whatever the
 * list's sort or filter.
 */
export function useEmailNotifications(messages: readonly Message[], folder: string, accountId?: string) {
  const markRef = useRef<Watermark | null>(null)

  const { data: settingsData } = useSWR<{ data: { notifications: boolean } }>('/api/settings', fetcher)
  const notificationsEnabled = settingsData?.data?.notifications !== false

  useEffect(() => {
    if (notificationsEnabled && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [notificationsEnabled])

  const scope = `${accountId ?? ''}|${folder}`

  useEffect(() => {
    const { mark, announce } = arrival(messages, scope, markRef.current)
    markRef.current = mark
    if (!announce) return
    if (!notificationsEnabled || Notification.permission !== 'granted') return
    try {
      const senderName = announce.from.name || announce.from.address
      const preview = announce.preview ? announce.preview.slice(0, 120) : announce.subject
      const notification = new Notification(`${senderName}`, {
        body: `${announce.subject}${preview && preview !== announce.subject ? `\n${preview}` : ''}`,
        icon: '/brand/png/synapmail-favicon@64.png',
        tag: `synapmail-${announce.uid}`, // prevent duplicates
        requireInteraction: false,
        silent: false,
      })
      notification.onclick = () => {
        window.focus()
        window.dispatchEvent(new CustomEvent('synapmail:open-message', {
          detail: { uid: announce.uid, accountId: announce.accountId || accountId, folder },
        }))
        notification.close()
      }
    } catch {
      // Notifications not supported
    }
  }, [messages, scope, notificationsEnabled, accountId, folder])
}
