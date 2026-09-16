/**
 * Local persistence for the user's PGP identity — native IndexedDB, browser-only.
 * The private key blob stored here is already passphrase-protected by openpgp.js
 * (baked in at generation/import time) — it is never stored or transmitted in
 * decrypted form, and never leaves this browser.
 */

const DB_NAME = 'synapmail-pgp'
const DB_VERSION = 1
const STORE_NAME = 'identity'
const RECORD_KEY = 'default'

export interface StoredIdentity {
  armoredPublicKey: string
  armoredPrivateKey: string
  fingerprint: string
  email: string
  name: string
  createdAt: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(identity, RECORD_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function getStoredIdentity(): Promise<StoredIdentity | null> {
  const db = await openDb()
  const identity = await new Promise<StoredIdentity | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(RECORD_KEY)
    req.onsuccess = () => resolve((req.result as StoredIdentity | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return identity
}

export async function clearStoredIdentity(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(RECORD_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
