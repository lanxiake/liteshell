import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import des from 'des.js'
import type { Connection, Folder, ImportSummary } from '../shared/types'

/**
 * Importer for FinalShell's on-disk connection tree. Handles both shapes it writes:
 *
 * 1. **Install tree** — `<install>/conn/` holds one directory per folder (named by
 *    folder id) each with `folder.json`, plus one `<id>_connect_config.json` per
 *    connection. Private keys live base64-encoded in `<install>/config.json`.
 * 2. **Exported tree** — what 右键 → 导出 produces: the same `*_connect_config.json`
 *    files, but **no `folder.json`**. The folder name is the directory name and the
 *    hierarchy is the directory hierarchy; the configs' `parent_id` still points at
 *    the source machine's folder ids, so it is useless here and the path wins.
 *
 * A single `*_connect_config.json` is accepted too — that is what exporting one
 * connection gives you, and it is how passwords arrive from another machine.
 *
 * Passwords are stored with a key derived from the ciphertext itself (DES +
 * MD5, ported from FinalShell's `ranDomKey`). Decryption therefore needs no
 * local FinalShell install, and recovered passwords are returned in plaintext
 * for the caller to seal into this machine's keychain.
 */

interface FsFolder {
  id: string
  name: string
  parent_id?: string
}

interface FsConnection {
  id: string
  name?: string
  host?: string
  port?: number
  user_name?: string
  /** 1 = password, 2 = public key */
  authentication_type?: number
  parent_id?: string
  secret_key_id?: string
  /** 100 = SSH; other transports are not supported here. */
  conection_type?: number
  /** FinalShell's encrypted password (base64: 8-byte head + DES ciphertext). */
  password?: string
}

interface FsKey {
  id: string
  name?: string
  /** base64 of a plaintext PEM private key */
  key_data?: string
}

export interface ImportResult extends ImportSummary {
  folders_new: Folder[]
  connections_new: Connection[]
  /** Plaintext by connection id; the caller seals these into the keychain. */
  passwords_new: Record<string, string>
}

const SSH_TRANSPORT = 100
const ROOT_ID = 'root'

/* ------------------------------------------------------------------ *
 * password decryption (Java `java.util.Random` + DES)
 * ------------------------------------------------------------------ */

const RANDOM_MULT = 0x5deece66dn
const RANDOM_ADD = 0xbn
const RANDOM_MASK = (1n << 48n) - 1n

/** Bit-for-bit port of `java.util.Random`: its seed is 48 bits, `nextLong`
 *  concatenates two signed 32-bit draws, and overflow wraps like Java's long. */
class JavaRandom {
  private seed: bigint

  constructor(seed: bigint) {
    this.seed = (BigInt.asUintN(64, seed) ^ RANDOM_MULT) & RANDOM_MASK
  }

  private next(bits: number): number {
    this.seed = (this.seed * RANDOM_MULT + RANDOM_ADD) & RANDOM_MASK
    let value = Number(this.seed >> BigInt(48 - bits))
    if (bits >= 32 && value >= 0x80000000) value -= 0x100000000
    return value
  }

  nextInt(bound: number): number {
    const bits = this.next(31)
    const mask = bound - 1
    if ((bound & mask) === 0) return (bound * bits) >> 31
    let value = bits
    let remainder = value % bound
    while (value - remainder + mask < 0) {
      value = this.next(31)
      remainder = value % bound
    }
    return remainder
  }

  nextLong(): bigint {
    const hi = BigInt(this.next(32))
    const lo = BigInt(this.next(32))
    return BigInt.asIntN(64, (hi << 32n) + lo)
  }
}

const signed = (byte: number): number => (byte >= 128 ? byte - 256 : byte)

/** FinalShell's `ranDomKey`: the first 8 bytes seed a deterministic pseudo-random
 *  sequence whose longs are hashed into the DES key. */
function randomKey(head: Buffer): Buffer {
  const divisor = new JavaRandom(BigInt(signed(head[5]))).nextInt(127) || 1
  const ks = 3680984568597093857n / BigInt(divisor)
  const random = new JavaRandom(ks)
  const skip = signed(head[0])
  for (let i = 0; i < skip; i++) random.nextLong()
  const n = random.nextLong()
  const r2 = new JavaRandom(n)
  const longs = [
    BigInt(signed(head[4])),
    r2.nextLong(),
    BigInt(signed(head[7])),
    BigInt(signed(head[3])),
    r2.nextLong(),
    BigInt(signed(head[1])),
    random.nextLong(),
    BigInt(signed(head[2]))
  ]
  const seed = Buffer.alloc(64)
  longs.forEach((value, i) => seed.writeBigInt64BE(value, i * 8))
  return createHash('md5').update(seed).digest()
}

/** Decrypts one `password` field. Throws when the value is not valid ciphertext. */
export function decodeFinalShellPassword(encoded: string): string {
  const text = encoded.trim()
  if (!text) return ''
  const buf = Buffer.from(text, 'base64')
  if (buf.length <= 8 || (buf.length - 8) % 8 !== 0) {
    throw new Error('不是有效的 FinalShell 密码密文')
  }
  const cipher = new des.DES({ type: 'decrypt', key: randomKey(buf.subarray(0, 8)).subarray(0, 8) })
  let plain = Buffer.from(cipher.update(buf.subarray(8)))
  const tail = cipher.final()
  if (tail) plain = Buffer.concat([plain, Buffer.from(tail)])

  // PKCS#5: the last byte is the pad length, repeated that many times.
  const pad = plain[plain.length - 1]
  if (pad >= 1 && pad <= 8 && plain.subarray(-pad).every((byte) => byte === pad)) {
    plain = plain.subarray(0, -pad)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(plain)
}

/* ------------------------------------------------------------------ *
 * importer
 * ------------------------------------------------------------------ */

function decryptPassword(cfg: FsConnection, warnings: string[]): string {
  if (!cfg.password) return ''
  try {
    return decodeFinalShellPassword(cfg.password)
  } catch (err) {
    warnings.push(`连接「${cfg.name || cfg.host || cfg.id}」的密码解不开，需要手动补录: ${(err as Error).message}`)
    return ''
  }
}

/** One exported `*_connect_config.json`: no folders, no key store, just the connection. */
function importSingle(source: string, parentId: string | null): ImportResult {
  const cfg = JSON.parse(readFileSync(source, 'utf8')) as FsConnection
  if (cfg.conection_type !== undefined && cfg.conection_type !== SSH_TRANSPORT) {
    throw new Error('这个文件不是 SSH 连接配置')
  }
  if (!cfg.host) throw new Error('连接配置里没有主机地址')

  const warnings: string[] = []
  const id = `fs-${cfg.id || basename(source).replace(/_connect_config\.json$/i, '')}`
  const isKeyAuth = cfg.authentication_type === 2
  const passwords: Record<string, string> = {}
  let needsPassword = 0

  if (isKeyAuth) {
    if (cfg.secret_key_id) {
      warnings.push(`连接「${cfg.name || cfg.host}」引用了私钥 ${cfg.secret_key_id}，但单个连接文件不带私钥，需要手动选择`)
    }
  } else {
    const plain = decryptPassword(cfg, warnings)
    if (plain) passwords[id] = plain
    else needsPassword++
  }

  const connection: Connection = {
    id,
    name: cfg.name || cfg.host,
    folderId: parentId,
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.user_name || 'root',
    authType: isKeyAuth ? 'key' : 'password',
    termType: 'xterm-256color',
    keepalive: 30
  }

  return {
    folders_new: [],
    connections_new: [connection],
    passwords_new: passwords,
    folders: 0,
    connections: 1,
    keys: 0,
    passwords: Object.keys(passwords).length,
    needsPassword,
    skipped: 0,
    warnings
  }
}

/**
 * @param source   FinalShell install/export directory, or one `*_connect_config.json`
 * @param keyDir   where recovered private keys are written; caller owns the path
 *                 so this module stays free of Electron imports.
 * @param parentId import a single config (or a whole tree) below this folder.
 */
export function importFinalshell(
  source: string,
  keyDir: string,
  parentId: string | null = null
): ImportResult {
  if (statSync(source).isFile()) return importSingle(source, parentId)

  const nested = join(source, 'conn')
  const connDir = existsSync(nested) && statSync(nested).isDirectory() ? nested : source
  if (!existsSync(connDir)) throw new Error(`找不到 FinalShell 的 conn 目录: ${connDir}`)

  const configPath = join(source, 'config.json')
  const keys = new Map<string, FsKey>()
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { secret_key_list?: FsKey[] }
    for (const key of config.secret_key_list ?? []) keys.set(key.id, key)
  }

  const rawFolders = new Map<string, FsFolder>()
  const rawConnections: { cfg: FsConnection; folderId: string | null }[] = []
  /** Folders that exist only as a directory name (FinalShell's export format). */
  const dirFolders: Folder[] = []

  /**
   * @param rel      path segments below connDir, used as a stable id for export folders
   * @param parentId resolved id of the enclosing folder, or null at the root
   */
  const walk = (dir: string, rel: string[], parentId: string | null): void => {
    const folderFile = join(dir, 'folder.json')
    const hasFolderJson = existsSync(folderFile)

    let selfId = parentId
    if (hasFolderJson) {
      const folder = JSON.parse(readFileSync(folderFile, 'utf8')) as FsFolder
      if (folder.id) {
        rawFolders.set(folder.id, folder)
        selfId = `fs-${folder.id}`
      }
    } else if (rel.length) {
      // No metadata file: the directory name is the folder, the path is its identity.
      selfId = `fs-dir:${rel.join('/')}`
      dirFolders.push({ id: selfId, name: rel[rel.length - 1], parentId })
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, [...rel, entry.name], selfId)
      } else if (entry.name === 'folder.json') {
        continue // already handled above
      } else if (entry.name.endsWith('_connect_config.json')) {
        rawConnections.push({
          cfg: JSON.parse(readFileSync(full, 'utf8')) as FsConnection,
          folderId: selfId
        })
      }
    }
  }
  walk(connDir, [], null)

  const warnings: string[] = []
  let skipped = 0
  let needsPassword = 0
  let importedKeys = 0

  const keyPathFor = (key: FsKey): string | null => {
    if (!key.key_data) return null
    try {
      mkdirSync(keyDir, { recursive: true })
      const target = join(keyDir, `${key.id}.pem`)
      writeFileSync(target, Buffer.from(key.key_data, 'base64').toString('utf8'), { mode: 0o600 })
      try {
        chmodSync(target, 0o600)
      } catch {
        // Windows ACLs under the user profile are already restrictive enough.
      }
      importedKeys++
      return target
    } catch (err) {
      warnings.push(`私钥 ${key.name ?? key.id} 写出失败: ${(err as Error).message}`)
      return null
    }
  }

  // Only materialise keys a connection actually references.
  const writtenKeys = new Map<string, string | null>()
  const takeKey = (id: string): string | null => {
    if (writtenKeys.has(id)) return writtenKeys.get(id) ?? null
    const key = keys.get(id)
    const path = key ? keyPathFor(key) : null
    if (!key) warnings.push(`连接引用的私钥 ${id} 已不在 config.json 中，需要手动补上`)
    writtenKeys.set(id, path)
    return path
  }

  const folders: Folder[] = [
    ...[...rawFolders.values()].map((f) => ({
      // Prefix so ids never collide with locally created ones and re-imports overwrite.
      id: `fs-${f.id}`,
      name: f.name || '(未命名文件夹)',
      parentId: !f.parent_id || f.parent_id === ROOT_ID ? null : `fs-${f.parent_id}`
    })),
    ...dirFolders
  ]

  const connections: Connection[] = []
  const passwords: Record<string, string> = {}
  for (const { cfg: c, folderId } of rawConnections) {
    if (c.conection_type !== undefined && c.conection_type !== SSH_TRANSPORT) {
      skipped++
      continue
    }
    if (!c.host) {
      skipped++
      continue
    }
    const isKeyAuth = c.authentication_type === 2
    const id = `fs-${c.id}`
    if (!isKeyAuth) {
      const plain = decryptPassword(c, warnings)
      if (plain) passwords[id] = plain
      else needsPassword++
    }

    connections.push({
      id,
      name: c.name || c.host,
      // In an install tree parent_id resolves; in an export it points at a folder
      // from the source machine, so fall back to where the file actually sits.
      folderId: c.parent_id && rawFolders.has(c.parent_id) ? `fs-${c.parent_id}` : folderId,
      host: c.host,
      port: c.port || 22,
      username: c.user_name || 'root',
      authType: isKeyAuth ? 'key' : 'password',
      privateKeyPath: isKeyAuth && c.secret_key_id ? (takeKey(c.secret_key_id) ?? undefined) : undefined,
      termType: 'xterm-256color',
      keepalive: 30
    })
  }

  // Importing into a folder: whatever sat at the source root moves under it.
  if (parentId) {
    for (const folder of folders) if (folder.parentId === null) folder.parentId = parentId
    for (const connection of connections) if (!connection.folderId) connection.folderId = parentId
  }

  return {
    folders_new: folders,
    connections_new: connections,
    passwords_new: passwords,
    folders: folders.length,
    connections: connections.length,
    keys: importedKeys,
    passwords: Object.keys(passwords).length,
    needsPassword,
    skipped,
    warnings
  }
}
