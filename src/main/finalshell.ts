import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * Stored passwords are encrypted with a runtime-assembled key and are NOT
 * imported — those connections come across with credentials left blank.
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
}

const SSH_TRANSPORT = 100
const ROOT_ID = 'root'

/**
 * @param installDir FinalShell install (or its `conn` directory directly)
 * @param keyDir     where recovered private keys are written; caller owns the path
 *                   so this module stays free of Electron imports.
 */
export function importFinalshell(installDir: string, keyDir: string): ImportResult {
  const nested = join(installDir, 'conn')
  const connDir = existsSync(nested) && statSync(nested).isDirectory() ? nested : installDir
  if (!existsSync(connDir)) throw new Error(`找不到 FinalShell 的 conn 目录: ${connDir}`)

  const configPath = join(installDir, 'config.json')
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
    if (!isKeyAuth) needsPassword++

    connections.push({
      id: `fs-${c.id}`,
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

  return {
    folders_new: folders,
    connections_new: connections,
    folders: folders.length,
    connections: connections.length,
    keys: importedKeys,
    needsPassword,
    skipped,
    warnings
  }
}
