import { createRequire } from 'node:module'

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

let adapter: SafeStorageAdapter | undefined

export function setSafeStorageAdapter(next: SafeStorageAdapter): void {
  adapter = next
}

export function encryptSecret(plaintext: string): string {
  const safeStorage = getAdapter()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available')
  }
  return safeStorage.encryptString(plaintext).toString('hex')
}

export function decryptSecret(encryptedHex: string): string {
  const safeStorage = getAdapter()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available')
  }
  return safeStorage.decryptString(Buffer.from(encryptedHex, 'hex'))
}

function getAdapter(): SafeStorageAdapter {
  if (adapter) return adapter
  const require = createRequire(import.meta.url)
  const electron = require('electron') as { safeStorage: SafeStorageAdapter }
  return electron.safeStorage
}
