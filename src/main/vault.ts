import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * Secrets at rest. Prefers the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Where no keychain is available we fall back to AES-256-GCM
 * under a 32-byte key file that only the current user can read.
 */
let fallbackKey: Buffer | null = null

function keyFile(): string {
  return join(app.getPath('userData'), 'vault.key')
}

function fallback(): Buffer {
  if (fallbackKey) return fallbackKey
  const file = keyFile()
  if (existsSync(file)) {
    fallbackKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
  } else {
    fallbackKey = randomBytes(32)
    writeFileSync(file, fallbackKey.toString('base64'), { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows ACLs already scope this to the user profile.
    }
  }
  if (fallbackKey.length !== 32) throw new Error('vault key is corrupt')
  return fallbackKey
}

export function encryptSecret(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'v1:' + safeStorage.encryptString(plain).toString('base64')
  }
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', fallback(), iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return 'v2:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}

export function decryptSecret(stored: string | undefined | null): string {
  if (!stored) return ''
  const [tag, payload] = [stored.slice(0, 3), stored.slice(3)]
  try {
    if (tag === 'v1:') return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    if (tag === 'v2:') {
      const raw = Buffer.from(payload, 'base64')
      const d = createDecipheriv('aes-256-gcm', fallback(), raw.subarray(0, 12))
      d.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
    }
  } catch {
    // Fall through: a secret we cannot decrypt must fail closed, not leak.
    return ''
  }
  return ''
}
