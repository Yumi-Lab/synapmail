/**
 * Pure openpgp.js wrapper — no I/O, no persistence.
 * `openpgp` is dynamically imported inside each function (not at module top level)
 * so its ~1MB bundle only loads on the code paths that actually touch PGP
 * (compose encrypt, reading-pane decrypt, PGP settings page) instead of every page load.
 */
import type { PrivateKey } from 'openpgp'

export type PrivateKeyHandle = PrivateKey

export interface GeneratedKeypair {
  armoredPublicKey: string
  armoredPrivateKey: string
  fingerprint: string
}

const PGP_MESSAGE_RE = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/

export function isInlinePgpMessage(text: string): boolean {
  return PGP_MESSAGE_RE.test(text)
}

export function extractInlinePgpMessage(text: string): string | null {
  const match = PGP_MESSAGE_RE.exec(text)
  return match ? match[0] : null
}

export async function generateKeypair(passphrase: string, name: string, email: string): Promise<GeneratedKeypair> {
  const openpgp = await import('openpgp')
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name, email }],
    passphrase,
    format: 'armored',
  })
  const publicKeyObj = await openpgp.readKey({ armoredKey: publicKey })
  return {
    armoredPublicKey: publicKey,
    armoredPrivateKey: privateKey,
    fingerprint: publicKeyObj.getFingerprint(),
  }
}

export async function unlockPrivateKey(armoredEncryptedKey: string, passphrase: string): Promise<PrivateKeyHandle> {
  const openpgp = await import('openpgp')
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredEncryptedKey })
  return openpgp.decryptKey({ privateKey, passphrase })
}

export async function readPublicKeyInfo(armoredKey: string): Promise<{ fingerprint: string; name: string; email: string }> {
  const openpgp = await import('openpgp')
  const key = await openpgp.readKey({ armoredKey })
  const userId = key.getUserIDs()[0] ?? ''
  const match = /^(.*?)\s*<(.+)>$/.exec(userId)
  return {
    fingerprint: key.getFingerprint(),
    name: match ? match[1].trim() : '',
    email: match ? match[2].trim() : userId,
  }
}

export async function encryptText(plaintext: string, recipientArmoredPublicKeys: string[]): Promise<string> {
  const openpgp = await import('openpgp')
  const message = await openpgp.createMessage({ text: plaintext })
  const encryptionKeys = await Promise.all(
    recipientArmoredPublicKeys.map(armoredKey => openpgp.readKey({ armoredKey }))
  )
  const result = await openpgp.encrypt({ message, encryptionKeys, format: 'armored' })
  return result as string
}

export async function decryptText(armoredCiphertext: string, unlockedPrivateKey: PrivateKeyHandle): Promise<string> {
  const openpgp = await import('openpgp')
  const message = await openpgp.readMessage({ armoredMessage: armoredCiphertext })
  const { data } = await openpgp.decrypt({ message, decryptionKeys: unlockedPrivateKey })
  return data as string
}
