'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { RefreshCw, Search, X, Paperclip, CheckSquare, Square, Eye, EyeOff, Flag } from 'lucide-react'
import { MAIL_SELECTION_COUNT_ATTR, useMailSelection } from '@/lib/mailSelection'
import { DEFAULT_FLAG_KEY, MAIL_LIST_FILTERS, flagByKey, type MailListFilter } from '@/lib/flags'
import { cn } from '@/lib/utils'
import { formatRowDate } from '@/lib/dates'
import {
  SCOPE_ALL, SCOPE_FOLDER, SCOPE_PARAM, SEARCH_PARAM, isSearchQuery, type SearchField, type SearchScope,
} from '@/lib/search'
import useSWR, { mutate as globalMutate } from 'swr'
import type { Message, Folder, ReadReceipt } from '@/types/email'
import type { EmailAccount } from '@/types/account'
import { MessageContextMenu, type ContextMenuState } from '@/components/ui/MessageContextMenu'
import { ScheduledPopover } from '@/components/mail/ScheduledPopover'
import { SnoozePopover } from '@/components/mail/SnoozePopover'

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-pink-500', 'bg-teal-500',
]

const getAvatarColor = (str: string) => {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

const normalizeSubject = (subject: string): string => {
  let prev = ''
  let s = subject.trim()
  while (s !== prev) {
    prev = s
    s = s.replace(/^(Re|Rép|Fwd|Fw|TR|AW|SV|VS):\s*/gi, '').trim()
  }
  return s.toLowerCase()
}

const displaySubject = (subject: string): string => {
  let prev = ''
  let s = subject.trim()
  while (s !== prev) {
    prev = s
    s = s.replace(/^(Re|Rép|Fwd|Fw|TR|AW|SV|VS):\s*/gi, '').trim()
  }
  return s || '(sans objet)'
}

interface ThreadGroup {
  key: string
  subject: string
  messages: Message[]
  lastMessage: Message
  hasUnread: boolean
  count: number
}

const groupIntoThreads = (messages: Message[]): ThreadGroup[] => {
  const map = new Map<string, Message[]>()
  for (const msg of messages) {
    const key = normalizeSubject(msg.subject) || msg.uid
    const existing = map.get(key)
    if (existing) existing.push(msg)
    else map.set(key, [msg])
  }
  const threads: ThreadGroup[] = []
  for (const [key, msgs] of Array.from(map.entries())) {
    const sorted = [...msgs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    threads.push({
      key,
      subject: displaySubject(sorted[0].subject),
      messages: sorted,
      lastMessage: sorted[0],
      hasUnread: sorted.some(m => !m.isRead),
      count: sorted.length,
    })
  }
  threads.sort((a, b) => new Date(b.lastMessage.date).getTime() - new Date(a.lastMessage.date).getTime())
  return threads
}

// ─── time bucketing (Direction B — grouped list) ──────────────────────────
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

type DensityMode = 'comfortable' | 'compact'

// Account-sharing permissions (defense-in-depth UX gating — the real
// enforcement lives server-side, see lib/accountAccess.ts). Owned accounts
// never carry a `permissions` object, so this fallback is fully permissive.
type MailPermissions = NonNullable<EmailAccount['permissions']>
const DEFAULT_PERMISSIONS: MailPermissions = {
  canSend: true, canDelete: true, canOrganize: true, canManageRules: true, canManageSignatures: true,
}

interface Props {
  folder: string
  selectedUid: string | null
  onSelect: (uid: string, accountId: string) => void
  onSelectThread: (messages: Message[], subject: string) => void
  activeAccountId?: string | null
  /** Recherche en cours, portée par l'URL de la boîte et pilotée par la barre d'application. */
  search?: string
  searchScope?: SearchScope
  permissions?: MailPermissions
}

interface AppSettings { thread_view: boolean; messages_per_page: number; mail_density: DensityMode }

export function MessageList({ folder, selectedUid, onSelect, onSelectThread, activeAccountId, search = '', searchScope = SCOPE_FOLDER, permissions }: Props) {
  const perms = permissions ?? DEFAULT_PERMISSIONS
  const t = useTranslations('mail')
  const locale = useLocale()
  // État partagé : la liste est la SEULE à publier et à enregistrer des actions.
  const { publish, register } = useMailSelection()
  const [filter, setFilter] = useState<MailListFilter>('all')
  const [page, setPage] = useState(1)
  const [accumulated, setAccumulated] = useState<Message[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [readUids, setReadUids] = useState<Set<string>>(new Set())
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null)

  const { data: settingsData } = useSWR<{ data: AppSettings }>('/api/settings', fetcher)
  const threadView = settingsData?.data?.thread_view ?? true
  const perPage = settingsData?.data?.messages_per_page ?? 30

  // Direction B — comfortable / compact density
  const density = settingsData?.data?.mail_density ?? 'comfortable'
  const changeDensity = (mode: DensityMode) => {
    globalMutate('/api/settings', (curr: { data: Record<string, unknown> } | undefined) =>
      curr ? { data: { ...curr.data, mail_density: mode } } : curr, false)
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mail_density: mode }),
    }).then(() => globalMutate('/api/settings'))
  }
  const compact = density === 'compact'

  // Bulk selection
  const [checkedUids, setCheckedUids] = useState<Set<string>>(new Set())

  // Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Drag state
  const [draggingUid, setDraggingUid] = useState<string | null>(null)

  // Sélection façon explorateur : la dernière ligne cliquée est l'ancre d'une
  // plage Maj-clic. Une référence suffit — elle ne pilote aucun rendu.
  const rangeAnchorUid = useRef<string | null>(null)

  // Infinite scroll — sentinel + observer replace the "load more" button
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingLockRef = useRef(0) // last page auto-requested — prevents re-firing while in flight

  const prevListKey = useRef(`${folder}|${activeAccountId ?? ''}`)

  useEffect(() => {
    const listKey = `${folder}|${activeAccountId ?? ''}`
    if (prevListKey.current !== listKey) {
      prevListKey.current = listKey
      setPage(1)
      setAccumulated([])
      loadingLockRef.current = 0
      setReadUids(new Set())
      setSelectedThreadKey(null)
      setCheckedUids(new Set())
      rangeAnchorUid.current = null
    }
  }, [folder, activeAccountId])


  const accountParam = activeAccountId ? `&account=${activeAccountId}` : ''

  const isSentFolder = /sent/i.test(folder)

  const isSearchMode = isSearchQuery(search)

  const { data, error, isValidating, mutate } = useSWR<{ messages: Message[]; total: number }>(
    isSearchMode
      ? null
      : `/api/messages?folder=${encodeURIComponent(folder)}&filter=${filter}&page=${page}&perPage=${perPage}${accountParam}`,
    fetcher,
    { refreshInterval: 60000 }
  )

  // `total` = correspondances réelles côté serveur, `fields` = champs interrogés :
  // le bandeau les dit plutôt que de les retaper (source unique : lib/search.ts).
  const { data: searchData, isValidating: isSearching } = useSWR<{ messages: Message[]; total: number; fields: SearchField[] }>(
    isSearchMode
      ? `/api/messages/search?${SEARCH_PARAM}=${encodeURIComponent(search)}&folder=${encodeURIComponent(folder)}` +
        `&${SCOPE_PARAM}=${searchScope}${accountParam}`
      : null,
    fetcher
  )

  // Folders — needed for the move menu, the context menu AND the row "Archive"
  // quick action, so it is fetched whenever an account is active. The key is
  // identical to the Sidebar's, so SWR serves it from one shared fetch.
  const { data: foldersResponse } = useSWR<{ data: Folder[] }>(
    activeAccountId ? `/api/folders?account=${activeAccountId}` : null,
    fetcher
  )
  const folders = useMemo(() => foldersResponse?.data ?? [], [foldersResponse])
  // No RFC-6154 flag survives /api/folders, so fall back to name/path matching.
  const archivePath = useMemo(
    () => folders.find(f => /archives?\b/i.test(f.name) || /archives?\b/i.test(f.path))?.path ?? null,
    [folders]
  )
  // Un résultat porte son CHEMIN IMAP (« INBOX.Clients.2026 ») : le bandeau affiche
  // le nom déjà connu de la liste des dossiers, et à défaut le dernier segment —
  // le séparateur est propre au serveur, il vient donc du dossier lui-même.
  const folderNames = useMemo(() => {
    const byPath = new Map<string, string>()
    const walk = (list: Folder[]) => list.forEach(f => {
      byPath.set(f.path, f.name)
      if (f.children?.length) walk(f.children)
    })
    walk(folders)
    return byPath
  }, [folders])
  const folderLabel = useCallback(
    (path: string) => folderNames.get(path) ?? path.split(/[/.]/).pop() ?? path,
    [folderNames]
  )

  const spamPath = useMemo(
    () => folders.find(f => /(spam|junk|ind[ée]sirable)/i.test(f.name) || /(spam|junk)/i.test(f.path))?.path ?? null,
    [folders]
  )

  useEffect(() => {
    if (!data?.messages) return
    if (page === 1) {
      setAccumulated(data.messages)
    } else {
      setAccumulated(prev => {
        const existingUids = new Set(prev.map(m => m.uid))
        const newMsgs = data.messages.filter(m => !existingUids.has(m.uid))
        return [...prev, ...newMsgs]
      })
    }
  }, [data, page, refreshKey])

  const messages = isSearchMode ? (searchData?.messages ?? []) : accumulated
  const total = data?.total ?? 0
  // Le serveur peut avoir trouvé plus que ce qu'il rend (plafond SEARCH_RESULT_LIMIT) :
  // le bandeau annonce alors « X premiers sur N » au lieu de laisser croire à N = X.
  const searchTotal = searchData?.total ?? messages.length
  const searchTruncated = searchTotal > messages.length
  const showResultFolder = isSearchMode && searchScope === SCOPE_ALL
  const loadError = !isSearchMode && !!error && accumulated.length === 0
  const loading = isSearchMode ? (!searchData && isSearching) : (!data && !error)

  // Infinite scroll — a failed page > 1 keeps the list but shows a retry button
  const morePageError = !isSearchMode && !!error && accumulated.length > 0
  const canLoadMore = !isSearchMode && !error && messages.length > 0 && messages.length < total

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!canLoadMore || !sentinel) return
    const io = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && !isValidating && loadingLockRef.current !== page) {
          loadingLockRef.current = page
          setPage(p => p + 1)
        }
      },
      { root: scrollRef.current, rootMargin: '600px 0px' }
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [canLoadMore, isValidating, page])

  // Tracking status for Sent folder
  const sentSubjects = isSentFolder
    ? messages.map(m => m.subject).filter(Boolean).join('|||')
    : ''
  const trackingKey = isSentFolder && sentSubjects && activeAccountId
    ? `/api/track/status?accountId=${activeAccountId}&subjects=${encodeURIComponent(sentSubjects)}`
    : null
  const { data: trackingData } = useSWR<{ data: Record<string, ReadReceipt> }>(
    trackingKey,
    fetcher,
    { refreshInterval: 30000 }
  )
  const trackingMap = trackingData?.data ?? {}

  const threads = useMemo<ThreadGroup[]>(() => {
    if (!threadView) {
      return [...messages]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .map(msg => ({
          key: msg.uid,
          subject: displaySubject(msg.subject),
          messages: [msg],
          lastMessage: msg,
          hasUnread: !msg.isRead,
          count: 1,
        }))
    }
    return groupIntoThreads(messages)
  }, [messages, threadView])

  // Direction B — bucket threads by recency for sticky date headers.
  const timeBucket = useCallback((iso: string): string => {
    const days = Math.round((startOfDay(new Date()).getTime() - startOfDay(new Date(iso)).getTime()) / 86_400_000)
    if (days <= 0) return t('grpToday')
    if (days === 1) return t('grpYesterday')
    if (days < 7) return t('grpThisWeek')
    if (days < 30) return t('grpThisMonth')
    return new Date(iso).toLocaleDateString([], { month: 'long', year: 'numeric' })
  }, [t])

  const groupedThreads = useMemo(() => {
    if (isSearchMode) return [{ label: null as string | null, items: threads }]
    const out: { label: string | null; items: ThreadGroup[] }[] = []
    for (const thread of threads) {
      const label = timeBucket(thread.lastMessage.date)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(thread)
      else out.push({ label, items: [thread] })
    }
    return out
  }, [threads, isSearchMode, timeBucket])

  const allVisibleUids = useMemo(() => threads.map(t => t.lastMessage.uid), [threads])
  const isAllChecked = allVisibleUids.length > 0 && allVisibleUids.every(uid => checkedUids.has(uid))
  const isIndeterminate = !isAllChecked && allVisibleUids.some(uid => checkedUids.has(uid))

  const toggleAll = () => {
    setCheckedUids(isAllChecked ? new Set() : new Set(allVisibleUids))
  }

  const toggleChecked = (uid: string) => {
    setCheckedUids(prev => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  const toggleUid = (uid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    rangeAnchorUid.current = uid
    toggleChecked(uid)
  }

  /** Maj-clic : plage depuis l'ancre, dans l'ordre affiché. Sans ancre, la ligne seule. */
  const selectRangeTo = (uid: string) => {
    const anchor = rangeAnchorUid.current
    const from = anchor ? allVisibleUids.indexOf(anchor) : -1
    const to = allVisibleUids.indexOf(uid)
    if (to < 0) return
    if (from < 0) {
      rangeAnchorUid.current = uid
      setCheckedUids(new Set([uid]))
      return
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    setCheckedUids(new Set(allVisibleUids.slice(lo, hi + 1)))
  }

  const clearSelection = () => {
    setCheckedUids(new Set())
    rangeAnchorUid.current = null
  }

  const checkedThreadUids = useMemo(() => {
    const uids: string[] = []
    for (const thread of threads) {
      if (checkedUids.has(thread.lastMessage.uid)) {
        thread.messages.forEach(m => uids.push(m.uid))
      }
    }
    return uids
  }, [threads, checkedUids])

  const getAccountId = useCallback(() => {
    for (const thread of threads) {
      if (checkedUids.has(thread.lastMessage.uid)) {
        return thread.lastMessage.accountId || activeAccountId || ''
      }
    }
    return activeAccountId || ''
  }, [threads, checkedUids, activeAccountId])

  // Primitives groupées : elles prennent les uids VISÉS en argument. La barre
  // d'actions de la liste leur passe la sélection cochée, le registre partagé
  // leur passe la sélection OU le message ouvert — une seule requête écrite ici.
  const markReadUids = async (uids: string[], read: boolean) => {
    if (!uids.length) return
    await fetch('/api/messages/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uids, action: read ? 'read' : 'unread', accountId: getAccountId(), folder }),
    })
    setAccumulated(prev => prev.map(m => uids.includes(m.uid) ? { ...m, isRead: read } : m))
    setReadUids(prev => {
      const next = new Set(prev)
      uids.forEach(u => read ? next.add(u) : next.delete(u))
      return next
    })
    clearSelection()
    mutate()
  }

  const deleteUids = async (uids: string[]) => {
    if (!uids.length) return
    await fetch('/api/messages/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uids, accountId: getAccountId(), folder }),
    })
    setAccumulated(prev => prev.filter(m => !uids.includes(m.uid)))
    clearSelection()
    mutate()
  }

  const moveUids = async (uids: string[], destination: string) => {
    if (!uids.length) return
    await fetch('/api/messages/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uids, action: 'move', accountId: getAccountId(), folder, destination }),
    })
    setAccumulated(prev => prev.filter(m => !uids.includes(m.uid)))
    clearSelection()
    mutate()
  }

  const setFlagUids = async (uids: string[], flag: string | null) => {
    if (!uids.length) return
    await fetch('/api/messages/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uids, action: 'flag', accountId: getAccountId(), folder, destination: undefined, flag }),
    })
    setAccumulated(prev => prev.map(m => uids.includes(m.uid) ? { ...m, flag, isStarred: flag !== null, isFlagged: flag !== null } : m))
    mutate()
  }

  /**
   * Reporte les uids visés. Le report est posé message par message (la route
   * porte l'uid dans son chemin) ; les lignes disparaissent d'un coup, comme
   * pour un déplacement, et le popover de la barre se rafraîchit.
   */
  const snoozeUids = async (uids: string[], until: Date) => {
    if (!uids.length) return
    const accountId = getAccountId()
    const byUid = new Map(accumulated.map(m => [m.uid, m]))
    await Promise.all(uids.map(uid => {
      const msg = byUid.get(uid)
      return fetch(`/api/messages/${uid}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          until: until.toISOString(),
          folder,
          accountId,
          subject: msg?.subject,
          fromAddress: msg?.from.address,
          fromName: msg?.from.name,
        }),
      })
    }))
    setAccumulated(prev => prev.filter(m => !uids.includes(m.uid)))
    clearSelection()
    mutate()
    window.dispatchEvent(new CustomEvent('synapmail:snooze-changed'))
  }

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, thread: ThreadGroup) => {
    const msg = thread.lastMessage
    const accId = msg.accountId || activeAccountId || ''
    const uidsToMove = checkedUids.has(msg.uid) ? checkedThreadUids : thread.messages.map(m => m.uid)
    e.dataTransfer.setData('application/synapmail', JSON.stringify({
      uids: uidsToMove,
      accountId: accId,
      folder,
    }))
    e.dataTransfer.effectAllowed = 'move'
    setDraggingUid(msg.uid)
  }, [checkedUids, checkedThreadUids, activeAccountId, folder])

  const handleDragEnd = useCallback(() => setDraggingUid(null), [])

  /**
   * Clic sur une ligne, façon explorateur : Cmd/Ctrl bascule la ligne, Maj
   * étend la plage depuis la dernière ligne cliquée, un clic simple VIDE la
   * sélection et ouvre cette ligne — même quand une sélection est en cours
   * (sinon un clic droit, qui sélectionne, rendrait la liste inouvrable).
   * La case au survol de la bulle (`toggleUid`) reste le chemin qui accumule.
   */
  const handleRowClick = (thread: ThreadGroup, e: React.MouseEvent) => {
    const uid = thread.lastMessage.uid
    if (e.metaKey || e.ctrlKey) {
      toggleChecked(uid)
      rangeAnchorUid.current = uid
      return
    }
    if (e.shiftKey) {
      selectRangeTo(uid)
      return
    }
    // L'ancre est posée APRÈS l'ouverture : `handleSelectThread` vide la
    // sélection, ce qui efface l'ancre — un Maj-clic ensuite doit partir d'ici.
    handleSelectThread(thread)
    rangeAnchorUid.current = uid
  }

  const handleSelectThread = (thread: ThreadGroup) => {
    if (checkedUids.size > 0) clearSelection()
    setSelectedThreadKey(thread.key)
    thread.messages.forEach(msg => {
      if (!msg.isRead && !readUids.has(msg.uid)) {
        setReadUids(prev => new Set(prev).add(msg.uid))
      }
    })
    if (thread.count === 1) {
      onSelect(thread.lastMessage.uid, thread.lastMessage.accountId)
    } else {
      onSelectThread(thread.messages, thread.subject)
    }
  }

  /**
   * Clic droit, façon explorateur : DANS la sélection il la garde entière (le
   * menu agit sur tout) ; hors d'elle il sélectionne cette ligne seule d'abord,
   * pour que la cible visée soit toujours celle qu'on voit surlignée.
   */
  const handleContextMenu = (e: React.MouseEvent, thread: ThreadGroup) => {
    e.preventDefault()
    const msg = thread.lastMessage
    if (!checkedUids.has(msg.uid)) {
      setCheckedUids(new Set(thread.messages.map(m => m.uid)))
      rangeAnchorUid.current = msg.uid
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      isRead: msg.isRead || readUids.has(msg.uid),
      flag: msg.flag ?? (msg.isStarred ? DEFAULT_FLAG_KEY : null),
      folderPath: folder,
    })
  }

  const handleRefresh = () => { setPage(1); loadingLockRef.current = 0; setRefreshKey(k => k + 1); mutate() }
  const hasSelection = checkedUids.size > 0

  const selectedUids = useMemo(() => allVisibleUids.filter(uid => checkedUids.has(uid)), [allVisibleUids, checkedUids])

  /**
   * Cible des actions partagées : la sélection si elle existe, sinon le message
   * OUVERT. Un seul endroit décide — les capacités du contexte suivent la même
   * règle (`targetCount`), donc un bouton actif a toujours quelque chose à viser.
   */
  const targetUids = useMemo(
    () => (checkedThreadUids.length ? checkedThreadUids : selectedUid ? [selectedUid] : []),
    [checkedThreadUids, selectedUid]
  )
  const targetUidsRef = useRef(targetUids)
  targetUidsRef.current = targetUids

  // Les primitives de la liste changent d'identité à chaque rendu : une
  // référence les rend appelables sans ré-enregistrer tout le registre.
  const moveUidsRef = useRef(moveUids)
  moveUidsRef.current = moveUids
  const deleteUidsRef = useRef(deleteUids)
  deleteUidsRef.current = deleteUids
  const markReadUidsRef = useRef(markReadUids)
  markReadUidsRef.current = markReadUids
  const setFlagUidsRef = useRef(setFlagUids)
  setFlagUidsRef.current = setFlagUids
  const snoozeUidsRef = useRef(snoozeUids)
  snoozeUidsRef.current = snoozeUids

  const handleRefreshRef = useRef(handleRefresh)
  handleRefreshRef.current = handleRefresh


  const moveTarget = useCallback((destination: string) => {
    if (!destination) return
    moveUidsRef.current(targetUidsRef.current, destination)
  }, [])

  const deleteTarget = useCallback(() => {
    const uids = targetUidsRef.current
    if (uids.length > 1 && !window.confirm(t('confirmDeleteSelection', { count: uids.length }))) return
    deleteUidsRef.current(uids)
  }, [t])

  // Publie ce qu'une barre d'outils doit connaître, et retire la publication en
  // quittant la boîte (le fournisseur retombe alors sur un état vide).
  useEffect(() => {
    publish({
      accountId: activeAccountId ?? null,
      folder,
      selectedUids,
      openUid: selectedUid ?? null,
      canSend: perms.canSend,
      canDelete: perms.canDelete,
      canOrganize: perms.canOrganize,
      hasArchive: !!archivePath,
      hasSpam: !!spamPath,
    })
    return () => publish(null)
  }, [publish, activeAccountId, folder, selectedUids, selectedUid, perms.canSend, perms.canDelete, perms.canOrganize, archivePath, spamPath])

  useEffect(() => {
    register({
      refresh: () => handleRefreshRef.current(),
      archive: () => { if (archivePath) moveTarget(archivePath) },
      spam: () => { if (spamPath) moveTarget(spamPath) },
      remove: deleteTarget,
      markRead: () => markReadUidsRef.current(targetUidsRef.current, true),
      markUnread: () => markReadUidsRef.current(targetUidsRef.current, false),
      setFlag: (flag) => setFlagUidsRef.current(targetUidsRef.current, flag),
      snooze: (until) => snoozeUidsRef.current(targetUidsRef.current, until),
      moveTo: moveTarget,
    })
  }, [register, archivePath, spamPath, moveTarget, deleteTarget])

  // Clavier de la liste : Cmd/Ctrl+A sélectionne tout le chargé, Échap vide,
  // Suppr supprime la sélection (confirmation au-delà d'un message).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        if (allVisibleUids.length === 0) return
        e.preventDefault()
        setCheckedUids(new Set(allVisibleUids))
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape' && checkedUids.size > 0) { e.preventDefault(); clearSelection(); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && checkedUids.size > 0 && perms.canDelete) {
        e.preventDefault()
        deleteTarget()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [allVisibleUids, checkedUids, perms.canDelete, deleteTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = (thread: ThreadGroup) => {
    const { lastMessage: msg, hasUnread, count } = thread
    const isRead = !hasUnread || readUids.has(msg.uid)
    const isSelected = selectedThreadKey === thread.key
    const isChecked = checkedUids.has(msg.uid)
    const isDragging = draggingUid === msg.uid
    const initial = (msg.from.name || msg.from.address)[0]?.toUpperCase() ?? '?'
    const avatarColor = isRead ? 'bg-muted text-muted-foreground' : cn(getAvatarColor(msg.from.address), 'text-white')

    return (
      <div
        key={thread.key}
        data-mail-row={msg.uid}
        role="option"
        // Sélectionné = coché OU ouvert : ce que l'œil voit surligné est ce que
        // le lecteur d'écran annonce, et c'est ce que les actions visent.
        aria-selected={isChecked || isSelected}
        tabIndex={-1}
        draggable={perms.canOrganize}
        onDragStart={e => handleDragStart(e, thread)}
        onDragEnd={handleDragEnd}
        onContextMenu={e => handleContextMenu(e, thread)}
        className={cn(
          'group/row relative w-full text-left grid grid-cols-[auto_1fr] gap-3 border-b border-border/40 transition-colors duration-150 border-l-[3px] cursor-pointer select-none',
          compact ? 'px-3 py-2' : 'px-4 py-3',
          isDragging && 'opacity-40',
          isChecked ? 'bg-primary/10 border-l-primary'
            : isSelected ? 'bg-primary/10 border-l-primary'
            : !isRead ? 'border-l-primary hover:bg-muted/50 bg-blue-50/60 dark:bg-blue-950/20'
            : 'border-l-transparent hover:bg-muted/50'
        )}
        onClick={e => handleRowClick(thread, e)}
      >
        {/* Avatar / Checkbox */}
        <div
          className={cn('relative shrink-0 group/avatar', compact ? 'w-7 h-7' : 'w-9 h-9')}
          onClick={e => toggleUid(msg.uid, e)}
        >
          {isChecked ? (
            <div className="w-full h-full rounded-full flex items-center justify-center bg-primary/10 text-primary">
              <CheckSquare className="w-4 h-4" />
            </div>
          ) : (
            <>
              <div className={cn(
                'w-full h-full rounded-full flex items-center justify-center font-semibold group-hover/avatar:opacity-0 transition-opacity',
                compact ? 'text-xs' : 'text-sm',
                avatarColor,
              )}>
                {initial}
              </div>
              <div className="absolute inset-0 rounded-full flex items-center justify-center bg-muted/60 opacity-0 group-hover/avatar:opacity-100 transition-opacity">
                <Square className="w-4 h-4 text-muted-foreground" />
              </div>
            </>
          )}
          {count > 1 && !isChecked && (
            <span className="absolute -bottom-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center leading-none shadow-sm">
              {count}
            </span>
          )}
        </div>

        <div className="min-w-0">
          {/* line 1 — sender (truncates first) + full date and time */}
          <div className={cn('flex items-baseline justify-between gap-2', compact ? '' : 'mb-0.5')}>
            <span className={cn('text-sm truncate', !isRead ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
              {count > 1
                ? thread.messages.map(m => m.from.name || m.from.address.split('@')[0]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(', ')
                : (msg.from.name || msg.from.address)
              }
            </span>
            {/* Portée « tous les dossiers » : un résultat ne dit rien s'il ne dit pas
                d'où il vient. Discret, et seulement quand le dossier peut varier. */}
            {showResultFolder && msg.folder && (
              <span className="shrink-0 max-w-[40%] truncate text-[11px] text-muted-foreground/70" data-result-folder>
                {folderLabel(msg.folder)}
              </span>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {(() => {
                const flag = flagByKey(msg.flag ?? (msg.isStarred ? DEFAULT_FLAG_KEY : null))
                if (!flag) return null
                return (
                  <span title={t(`flags.${flag.labelKey}`)}>
                    <Flag className="w-3 h-3 fill-current" style={{ color: flag.color }} />
                  </span>
                )
              })()}
              {thread.messages.some(m => m.hasAttachments) && <Paperclip className="w-3 h-3 text-muted-foreground" />}
              {isSentFolder && (() => {
                const receipt = trackingMap[msg.subject]
                if (!receipt) return null
                return receipt.opened ? (
                  <span title={receipt.openedAt ? `Lu le ${new Date(receipt.openedAt).toLocaleString()}` : 'Lu'}>
                    <Eye className="w-3 h-3 text-emerald-500" />
                  </span>
                ) : (
                  <span title="Non ouvert"><EyeOff className="w-3 h-3 text-muted-foreground/50" /></span>
                )
              })()}
              <span className={cn('text-xs tabular-nums', !isRead ? 'text-primary font-medium' : 'text-muted-foreground')}>
                {formatRowDate(msg.date, locale, t('grpToday'))}
              </span>
            </div>
          </div>

          {/* line 2 — subject (full width) */}
          <div className={cn('text-xs truncate', !isRead ? 'font-semibold text-foreground' : 'text-foreground/60', compact ? '' : 'mb-0.5')}>
            {thread.subject}
          </div>

          {/* line 3 — preview (hidden in compact) */}
          {!compact && (
            <div className={cn('text-[11px] truncate leading-relaxed', isRead ? 'text-muted-foreground/70' : 'text-muted-foreground')}>
              {msg.preview}
            </div>
          )}
        </div>

      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background border-r border-border" {...{ [MAIL_SELECTION_COUNT_ATTR]: selectedUids.length }}>
      {/* Toolbar */}
      {hasSelection ? (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0 bg-primary/5">
          <button
            onClick={toggleAll}
            className="w-7 h-7 flex items-center justify-center rounded text-primary hover:bg-primary/10 transition-colors"
            title={isAllChecked ? 'Tout désélectionner' : 'Tout sélectionner'}
          >
            {isAllChecked
              ? <CheckSquare className="w-4 h-4" />
              : isIndeterminate
                ? <Square className="w-4 h-4 opacity-60" />
                : <CheckSquare className="w-4 h-4" />
            }
          </button>
          <span className="text-xs text-primary font-medium mr-1">{checkedUids.size}</span>
          <div className="flex-1" />
          <button onClick={clearSelection} className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" title="Annuler la sélection">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : !isSearchMode ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          <div className="flex rounded-lg overflow-hidden border border-border text-xs font-medium">
            {MAIL_LIST_FILTERS.map(f => (
              <button key={f} onClick={() => { setFilter(f); setPage(1); setAccumulated([]); loadingLockRef.current = 0 }}
                className={cn('px-3 py-1.5 transition-colors', filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent')}>
                {t(f)}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg overflow-hidden border border-border text-xs font-medium">
            {(['comfortable', 'compact'] as const).map(d => (
              <button key={d} onClick={() => changeDensity(d)}
                title={d === 'comfortable' ? t('densityComfortable') : t('densityCompact')}
                className={cn('px-2.5 py-1.5 transition-colors', density === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent')}>
                {d === 'comfortable' ? t('densityComfortable') : t('densityCompact')}
              </button>
            ))}
          </div>
          <button onClick={handleRefresh} disabled={isValidating} className="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
            <RefreshCw className={cn('w-3.5 h-3.5', isValidating && 'animate-spin')} />
          </button>
          <ScheduledPopover />
          <SnoozePopover activeAccountId={activeAccountId} />
        </div>
      ) : (
        <div className="px-4 py-2 border-b border-border shrink-0">
          <p className="text-xs text-muted-foreground" data-search-summary>
            {isSearching
              ? t('searching')
              : <>
                  {t('searchResults', { count: searchTotal, query: search })}
                  {` · ${t('searchFieldsLabel')}`}
                  {` · ${searchScope === SCOPE_ALL ? t('searchAllFolders') : t('searchThisFolder')}`}
                  {searchTruncated && ` · ${t('searchTruncated', { shown: messages.length, total: searchTotal })}`}
                </>}
          </p>
          {!isSearching && messages.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground/70" data-search-hint>{t('searchNoBodyHint')}</p>
          )}
        </div>
      )}

      {/* Thread List */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        role="listbox"
        aria-multiselectable
        aria-label={t('messageList')}
      >
        {loading && (
          <div className="space-y-0">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="flex gap-3 px-4 py-3 border-b border-border/50">
                <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-2 pt-0.5">
                  <div className="h-3.5 bg-muted animate-pulse rounded-full w-32" />
                  <div className="h-3 bg-muted animate-pulse rounded-full w-full" />
                  <div className="h-3 bg-muted animate-pulse rounded-full w-3/4" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && loadError && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground px-6 text-center">
            <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center mb-3">
              <RefreshCw className="w-6 h-6 text-destructive/60" />
            </div>
            <p className="text-sm font-medium text-foreground">{t('loadError')}</p>
            <p className="text-xs mt-1 mb-4 max-w-xs">{t('loadErrorDesc')}</p>
            <button
              onClick={() => mutate()}
              className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
            >
              {t('retry')}
            </button>
          </div>
        )}

        {!loading && !loadError && threads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-3">
              <Search className="w-6 h-6 opacity-30" />
            </div>
            <p className="text-sm font-medium">{isSearchMode ? t('noSearchResults') : t('noMessages')}</p>
          </div>
        )}

        {groupedThreads.map((group, gi) => (
          <div key={group.label ?? `g${gi}`}>
            {group.label && (
              <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground border-b border-border/40">
                {group.label}
              </div>
            )}
            {group.items.map(renderRow)}
          </div>
        ))}

        {!isSearchMode && messages.length > 0 && (
          messages.length < total ? (
            <div ref={sentinelRef} className="px-4 py-4">
              {morePageError ? (
                <button
                  onClick={() => { loadingLockRef.current = 0; mutate() }}
                  className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  {t('retry')}
                </button>
              ) : (
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={isValidating}
                  className="w-full flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isValidating ? (
                    <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('loadingMore')}</>
                  ) : (
                    t('messagesRemaining', { count: total - messages.length })
                  )}
                </button>
              )}
            </div>
          ) : (
            <div className="py-4 text-center text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              {t('endOfList')}
            </div>
          )
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <MessageContextMenu
          menu={contextMenu}
          folders={folders}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
