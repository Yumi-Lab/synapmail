'use client'

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { getStoredIdentity, unlockPrivateKey, type PrivateKeyHandle } from '@/lib/pgp'

interface PgpSessionContextValue {
  isUnlocked: boolean
  unlock: (passphrase: string) => Promise<void>
  lock: () => void
  getUnlockedKey: () => PrivateKeyHandle | null
}

const PgpSessionContext = createContext<PgpSessionContextValue | null>(null)

export function PgpSessionProvider({ children }: { children: ReactNode }) {
  const keyRef = useRef<PrivateKeyHandle | null>(null)
  const [isUnlocked, setIsUnlocked] = useState(false)

  const unlock = useCallback(async (passphrase: string) => {
    const identity = await getStoredIdentity()
    if (!identity) throw new Error('NO_KEY')
    const handle = await unlockPrivateKey(identity.armoredPrivateKey, passphrase)
    keyRef.current = handle
    setIsUnlocked(true)
  }, [])

  const lock = useCallback(() => {
    keyRef.current = null
    setIsUnlocked(false)
  }, [])

  const getUnlockedKey = useCallback(() => keyRef.current, [])

  return (
    <PgpSessionContext.Provider value={{ isUnlocked, unlock, lock, getUnlockedKey }}>
      {children}
    </PgpSessionContext.Provider>
  )
}

export function usePgpSession(): PgpSessionContextValue {
  const ctx = useContext(PgpSessionContext)
  if (!ctx) throw new Error('usePgpSession must be used within a PgpSessionProvider')
  return ctx
}
