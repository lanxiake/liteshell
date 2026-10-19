import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import type { BundleSecrets, SealedSecrets } from '../shared/types'

/**
 * The passwords in a backup file, sealed under a passphrase the user chose
 * instead of under this machine's keychain. The keychain is the right home for
 * a password that stays put — it is bound to one machine and one user, so a
 * backup carrying its ciphertext would be unreadable on the other side
 * (vault.ts returns '' for a blob it cannot open).
 *
 * Pure node crypto, no Electron import, so scripts/test-sealed.mjs can run it —
 * same reason gate.ts stays out of the main process.
 */

/**
 * scrypt cost is what stands between a stolen backup file and every root
 * password in it. 32 MB / ~100 ms is the "interactive login" setting; it is
 * paid twice per transfer (once sealing, once opening) and never again.
 */
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function keyFrom(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, KDF)
}

export function sealSecrets(secrets: BundleSecrets, passphrase: string): SealedSecrets {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv)
  const data = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()])
  return {
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: c.getAuthTag().toString('base64')
  }
}

/**
 * Throws when the passphrase is wrong or the file was edited: the GCM tag is
 * the check, and there is no way past it but a re-export on the other machine.
 */
export function openSecrets(sealed: SealedSecrets, passphrase: string): BundleSecrets {
  if (sealed?.kdf !== 'scrypt') throw new Error('不认识的加密方式')
  const d = createDecipheriv(
    'aes-256-gcm',
    keyFrom(passphrase, Buffer.from(sealed.salt, 'base64')),
    Buffer.from(sealed.iv, 'base64')
  )
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  const json = Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8')
  return JSON.parse(json) as BundleSecrets
}
