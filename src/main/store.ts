import { app } from 'electron'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  BackupBundle,
  BundleLlm,
  BundleSecrets,
  Connection,
  Folder,
  ImportReport,
  KeyBlob,
  KeyFile,
  LlmSettings,
  QuickCommand,
  Settings,
  Store
} from '../shared/types'
import { openSecrets, sealSecrets } from './sealed'
import { decryptSecret, encryptSecret } from './vault'
import { aliasFor } from './sshconfig'
import * as agentHistory from './agenthistory'

const DEFAULTS: Settings = {
  theme: 'liteshell',
  fontFamily: 'JetBrains Mono, Consolas, Menlo, monospace',
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: true,
  sidebarCollapsed: false,
  agentWidth: 520,
  backgroundImage: '',
  llm: { provider: 'anthropic', baseUrl: '', model: 'claude-opus-5', contextK: 128 }
}

const EMPTY: Store = {
  version: 1,
  folders: [],
  connections: [],
  keys: [],
  quickCommands: [],
  settings: DEFAULTS,
  knownHosts: [],
  history: {}
}

let cache: Store | null = null

function file(): string {
  return join(app.getPath('userData'), 'liteshell.json')
}

export function store(): Store {
  if (cache) return cache
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>
      cache = {
        ...EMPTY,
        ...parsed,
        // Deep-merged one level: a store written before the AI panel existed has
        // no `llm` at all, and one written by an early build may have it half
        // filled in. Spreading the parent alone would drop the other half.
        settings: { ...DEFAULTS, ...parsed.settings, llm: { ...DEFAULTS.llm, ...parsed.settings?.llm } }
      }
    } else {
      cache = structuredClone(EMPTY)
    }
  } catch {
    // A corrupt store must not brick the app; keep the bad file for inspection.
    const bad = file() + '.corrupt'
    try {
      renameSync(file(), bad)
    } catch {
      // nothing else we can do
    }
    cache = structuredClone(EMPTY)
  }
  return cache
}

function persist(): void {
  const target = file()
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(store(), null, 2), 'utf8')
  renameSync(tmp, target)
}

/** One key as the renderer may see it: the ciphertext stays behind. */
export function publicKey(k: KeyFile): KeyFile {
  return { ...k, secret: undefined, hasSecret: !!k.secret }
}

/** Store with secrets stripped — this is what crosses the IPC boundary. */
export function publicStore(): Store {
  const s = store()
  return {
    ...s,
    connections: s.connections.map((c) => ({ ...c, secret: undefined, hasSecret: !!c.secret })),
    keys: s.keys.map(publicKey),
    settings: {
      ...s.settings,
      llm: { ...s.settings.llm, apiKey: undefined, hasKey: !!s.settings.llm.apiKey }
    }
  }
}

export function upsertConnection(conn: Connection, secret: string | null): Connection {
  const s = store()
  const existing = s.connections.find((c) => c.id === conn.id)
  const next: Connection = { ...conn }
  if (secret === null) next.secret = existing?.secret
  else if (secret === '') next.secret = undefined
  else next.secret = encryptSecret(secret)

  const i = s.connections.findIndex((c) => c.id === conn.id)
  if (i >= 0) s.connections[i] = next
  else s.connections.push(next)
  persist()
  return { ...next, secret: undefined }
}

/** Merge an import in place. Existing ids are updated rather than duplicated, and
 *  a connection that already has a saved password keeps it. `secrets` carries
 *  plaintext recovered elsewhere (FinalShell's encrypted passwords); those are
 *  sealed into this machine's keychain on the way in. */
export function mergeImport(
  folders: Folder[],
  connections: Connection[],
  secrets: Record<string, string> = {}
): void {
  const s = store()
  for (const folder of folders) {
    const i = s.folders.findIndex((f) => f.id === folder.id)
    if (i >= 0) s.folders[i] = folder
    else s.folders.push(folder)
  }
  for (const conn of connections) {
    const plain = secrets[conn.id]
    const sealed = plain ? encryptSecret(plain) : undefined
    // An imported alias may belong to a profile that is already here; the
    // import loses the tie, so the local `ssh <ip>` keeps pointing where it did.
    const unique = conn.sshAlias ? aliasFor(conn, s.connections) : undefined
    const merged = unique === undefined ? conn : { ...conn, sshAlias: unique }
    const i = s.connections.findIndex((c) => c.id === conn.id)
    if (i >= 0) s.connections[i] = { ...merged, secret: s.connections[i].secret ?? sealed }
    else s.connections.push(sealed ? { ...merged, secret: sealed } : merged)
  }
  persist()
}

export function duplicateConnection(id: string): void {
  const s = store()
  const src = s.connections.find((c) => c.id === id)
  if (!src) return
  // Cloning keeps the encrypted secret, so the copy connects without retyping.
  // The alias is dropped: two profiles holding one name would make `ssh <ip>`
  // point at whichever block was written last, and the copy gets its own on
  // first setup.
  const { sshAlias: _drop, ...rest } = src
  s.connections.push({ ...rest, id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: `${src.name} 副本` })
  persist()
}

export function removeConnection(id: string): void {
  const s = store()
  s.connections = s.connections.filter((c) => c.id !== id)
  persist()
}

export function upsertFolder(folder: Folder): Folder {
  const s = store()
  const i = s.folders.findIndex((f) => f.id === folder.id)
  if (i >= 0) s.folders[i] = folder
  else s.folders.push(folder)
  persist()
  return folder
}

export function removeFolder(id: string): void {
  const s = store()
  // Depth-first so nested folders do not survive their parent.
  const doomed = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of s.folders) {
      if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
        doomed.add(f.id)
        grew = true
      }
    }
  }
  s.folders = s.folders.filter((f) => !doomed.has(f.id))
  s.connections = s.connections.filter((c) => !c.folderId || !doomed.has(c.folderId))
  persist()
}

export function setQuickCommands(cmds: QuickCommand[]): void {
  store().quickCommands = cmds
  persist()
}

export function setHistory(connectionId: string, commands: string[]): void {
  const s = store()
  // Drop the entry rather than keep an empty array for every connection ever touched.
  if (commands.length) s.history[connectionId] = commands
  else delete s.history[connectionId]
  persist()
}

export function setSettings(settings: Settings): Settings {
  const s = store()
  const incoming: LlmSettings = { ...DEFAULTS.llm, ...settings.llm }
  // The renderer never holds the key, so an absent one means "leave it alone" —
  // the same rule upsertConnection uses for passwords. An empty string is an
  // explicit "forget it".
  const kept = incoming.apiKey === undefined ? s.settings.llm?.apiKey : undefined
  s.settings = {
    ...settings,
    llm: {
      ...incoming,
      apiKey:
        incoming.apiKey === undefined
          ? kept
          : incoming.apiKey === ''
            ? undefined
            : encryptSecret(incoming.apiKey)
    }
  }
  persist()
  return publicStore().settings
}

/** Settings with the LLM key decrypted. Main process only — never sent out. */
export function llmSettings(): LlmSettings {
  const llm = store().settings.llm
  return { ...DEFAULTS.llm, ...llm, apiKey: decryptSecret(llm?.apiKey) }
}

/** The key pinned for this connection profile. */
export function hostKey(connId: string): string | undefined {
  return store().knownHosts.find((h) => h.connId === connId)?.fingerprint
}

/** A key recorded before pinning was per connection. It carries no owner. */
export function legacyHostKey(host: string, port: number): string | undefined {
  return store().knownHosts.find(
    (h) => h.connId === undefined && h.host === host && h.port === port
  )?.fingerprint
}

export function rememberHostKey(
  target: { id?: string; host: string; port: number },
  fingerprint: string
): void {
  const s = store()
  const i = s.knownHosts.findIndex((h) =>
    target.id
      ? h.connId === target.id
      : h.connId === undefined && h.host === target.host && h.port === target.port
  )
  if (i >= 0) s.knownHosts[i].fingerprint = fingerprint
  else s.knownHosts.push({ connId: target.id, host: target.host, port: target.port, fingerprint })
  persist()
}

export function secretOf(conn: Connection): string {
  return decryptSecret(conn.secret)
}

/* ------------------------------------------------------------------ *
 * private key library
 * ------------------------------------------------------------------ */

/** Where filed-away keys are copied to. Originals elsewhere are never touched,
 *  so dropping an entry here cannot break a key that lives outside the app. */
export function keyDir(): string {
  return join(app.getPath('userData'), 'keys')
}

export function findKey(id: string): KeyFile | undefined {
  return store().keys.find((k) => k.id === id)
}

function insideKeyDir(path: string): boolean {
  return dirname(resolve(path)) === resolve(keyDir())
}

/**
 * Files a key for reuse. Idempotent by path — importing the same file twice, or
 * importing a FinalShell key the importer just unpacked, returns the entry that
 * is already there. A file already inside the key directory is indexed where it
 * lies rather than copied.
 */
export function addKey(source: string, name?: string, passphrase?: string): KeyFile {
  const s = store()
  const absolute = resolve(source)
  const existing = s.keys.find((k) => resolve(k.path) === absolute)
  if (existing) {
    // Re-importing is how a passphrase gets attached to a key already in the
    // library; an omitted one means "leave what is stored alone".
    if (passphrase !== undefined) {
      existing.secret = passphrase ? encryptSecret(passphrase) : undefined
      persist()
    }
    return existing
  }

  const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  let target = absolute
  if (!insideKeyDir(absolute)) {
    mkdirSync(keyDir(), { recursive: true })
    target = join(keyDir(), `${id}.pem`)
    copyFileSync(absolute, target)
    try {
      chmodSync(target, 0o600)
    } catch {
      // Windows ACLs under the user profile are already restrictive enough.
    }
  }

  const key: KeyFile = {
    id,
    name: name?.trim() || basename(absolute),
    path: target,
    ...(passphrase ? { secret: encryptSecret(passphrase) } : {}),
    addedAt: Date.now()
  }
  s.keys.push(key)
  persist()
  return key
}

/** The passphrase a connection reusing `path` may use without asking. */
export function keySecretOf(path: string): string {
  return decryptSecret(store().keys.find((k) => k.path === path)?.secret)
}

export function setKeySecret(id: string, passphrase: string): void {
  const key = store().keys.find((k) => k.id === id)
  if (!key) return
  key.secret = passphrase ? encryptSecret(passphrase) : undefined
  persist()
}

/** Only the label and the note are editable; the bytes stay where they are. */
export function updateKey(key: KeyFile): KeyFile {
  const s = store()
  const i = s.keys.findIndex((k) => k.id === key.id)
  if (i < 0) return key
  s.keys[i] = { ...s.keys[i], name: key.name, comment: key.comment }
  persist()
  return s.keys[i]
}

/** Drops the entry, and the copy with it — unless a connection still points there. */
export function removeKey(id: string): void {
  const s = store()
  const key = s.keys.find((k) => k.id === id)
  if (!key) return
  s.keys = s.keys.filter((k) => k.id !== id)
  if (insideKeyDir(key.path) && !s.connections.some((c) => c.privateKeyPath === key.path)) {
    try {
      unlinkSync(key.path)
    } catch {
      // Already gone; the entry was the part that mattered.
    }
  }
  persist()
}

/* ------------------------------------------------------------------ *
 * backup bundle
 * ------------------------------------------------------------------ */

/**
 * A portable snapshot: folders, connections, model settings and the private keys
 * they point at, with the key bytes inlined as base64 so one file is the whole
 * thing.
 *
 * Passwords and the model API key are sealed by this machine's OS keychain, so
 * their ciphertext would be unreadable on the target. With a `passphrase` they
 * are decrypted here and re-sealed under it instead; without one they are
 * dropped, `hasSecret` goes unset, and the connect prompt asks on the other side.
 */
export function exportBundle(
  passphrase = '',
  /** When set, only these connections travel — the "export this connection"
   *  menu item. Nothing else from this machine goes along: no other keys, no
   *  settings, no model config. */
  onlyIds?: string[],
  /** Export one folder and everything below it. The folder becomes the root of
   *  the file, so importing it elsewhere does not leave a dangling parent. */
  folderRoot?: string
): {
  bundle: BackupBundle
  missing: string[]
  passwords: number
} {
  const s = store()
  let scopeIds = onlyIds
  let folderIds: Set<string> | null = null
  if (folderRoot) {
    folderIds = new Set()
    const collect = (id: string): void => {
      if (folderIds!.has(id)) return
      folderIds!.add(id)
      for (const f of s.folders) if (f.parentId === id) collect(f.id)
    }
    collect(folderRoot)
    scopeIds = s.connections
      .filter((c) => c.folderId && folderIds!.has(c.folderId))
      .map((c) => c.id)
  }
  const keep = scopeIds ? new Set(scopeIds) : null
  const scoped = keep !== null
  const picked = keep ? s.connections.filter((c) => keep.has(c.id)) : s.connections
  const missing: string[] = []
  const seen = new Map<string, KeyBlob>() // path -> blob, so one file is stored once
  const keys: KeyBlob[] = []
  /** Key passphrases by blob file name — they ride inside `secrets`, like passwords. */
  const keySecrets: Record<string, string> = {}

  const add = (path: string, base: string, meta?: KeyFile): KeyBlob | null => {
    const cached = seen.get(path)
    if (cached) return cached
    if (!existsSync(path)) return null
    const blob: KeyBlob = {
      name: `${base}.pem`,
      data: readFileSync(path).toString('base64'),
      ...(meta ? { id: meta.id, label: meta.name, comment: meta.comment } : {})
    }
    const passphrase = keySecretOf(path)
    if (passphrase) keySecrets[blob.name] = passphrase
    seen.set(path, blob)
    keys.push(blob)
    return blob
  }

  // Keys nothing references yet still travel: that is the whole point of filing them.
  if (!scoped) for (const k of s.keys) add(k.path, k.id, k)

  const connections = picked.map((c) => {
    const { secret: _drop, hasSecret: _drop2, ...rest } = c
    if (c.authType !== 'key' || !c.privateKeyPath) return rest
    const blob = add(c.privateKeyPath, c.id)
    if (!blob) {
      missing.push(c.name)
      return rest
    }
    return { ...rest, privateKeyPath: blob.name }
  })

  // `secretOf` returns '' for anything this machine's keychain can no longer
  // open — that gets left behind rather than shipped as a blob nobody can read.
  const secrets: BundleSecrets = { connections: {} }
  const byId = secrets.connections!
  for (const c of picked) {
    const plain = secretOf(c)
    if (plain) byId[c.id] = plain
  }
  if (Object.keys(keySecrets).length) secrets.keys = keySecrets
  const llm = llmSettings()
  if (!scoped && llm.apiKey) secrets.llmKey = llm.apiKey
  const passwords =
    Object.keys(byId).length + Object.keys(keySecrets).length + (secrets.llmKey ? 1 : 0)

  const { llm: _llmSettings, ...appearance } = s.settings
  const bundle: BackupBundle = {
    kind: 'liteshell-backup',
    version: 1,
    exportedAt: Date.now(),
    // A scoped export carries only its own folders. The folder being exported
    // becomes the root so it never arrives with a parent that stayed behind.
    folders: folderIds
      ? s.folders
          .filter((f) => folderIds!.has(f.id))
          .map((f) => (f.id === folderRoot ? { ...f, parentId: null } : f))
      : keep
        ? []
        : s.folders,
    connections,
    keys,
    ...(scoped
      ? {
          knownHosts: s.knownHosts.filter((h) =>
            h.connId
              ? picked.some((c) => c.id === h.connId)
              : picked.some((c) => c.host === h.host && c.port === h.port)
          )
        }
      : {
          llm: { provider: llm.provider, baseUrl: llm.baseUrl, model: llm.model, contextK: llm.contextK },
          settings: appearance,
          knownHosts: s.knownHosts
        })
  }
  // What was already asked about these servers travels with them: the answer to
  // "why is this box slow" is worth more than the password that got there.
  const convos = agentHistory.forConnections(picked.map((c) => c.id))
  if (convos.length) bundle.agentHistory = convos
  // Sealing an empty blob would ask the other side for a passphrase that guards
  // nothing, so an export with no secrets to hide stays a plain file.
  if (passphrase && passwords) bundle.secrets = sealSecrets(secrets, passphrase)

  return { bundle, missing, passwords: bundle.secrets ? passwords : 0 }
}

/**
 * @param keyDir keys are unpacked here under their bundle names; the caller owns
 *               the path so this stays free of Electron imports.
 * @param passphrase opens `bundle.secrets`; required exactly when it is present.
 */
export function importBundle(bundle: BackupBundle, keyDir: string, passphrase = ''): ImportReport {
  if (bundle?.kind !== 'liteshell-backup') throw new Error('不是 LiteShell 的备份文件')

  // Unsealed before anything is written: a wrong passphrase has to leave the
  // store untouched, not half-imported with the passwords quietly missing.
  let secrets: BundleSecrets = {}
  if (bundle.secrets) {
    if (!passphrase) throw new Error('这个备份带着加密的密码，需要导出时设的口令')
    try {
      secrets = openSecrets(bundle.secrets, passphrase)
    } catch {
      throw new Error('口令不对，或者备份文件已损坏')
    }
  }

  mkdirSync(keyDir, { recursive: true })

  const keyPaths = new Map<string, string>()
  const library: KeyFile[] = []
  let keyPasswords = 0
  for (const key of bundle.keys ?? []) {
    const target = join(keyDir, key.name)
    writeFileSync(target, Buffer.from(key.data, 'base64'), { mode: 0o600 })
    try {
      chmodSync(target, 0o600)
    } catch {
      // Windows ACLs under the user profile are already restrictive enough.
    }
    keyPaths.set(key.name, target)
    const passphrase = secrets.keys?.[key.name]
    if (passphrase) keyPasswords++
    library.push({
      // Bundles written before the key list existed carry no id or label; the
      // blob name is unique within a bundle, so it doubles as one.
      id: key.id ?? key.name,
      name: key.label ?? key.name,
      path: target,
      comment: key.comment,
      ...(passphrase ? { secret: encryptSecret(passphrase) } : {}),
      addedAt: Date.now()
    })
  }

  let missingKeys = 0
  let passwords = 0
  const connections: Connection[] = (bundle.connections ?? []).map((c) => {
    const { secret: _drop, ...rest } = c
    const bundled = rest.privateKeyPath
    if (bundled) {
      const resolved = keyPaths.get(bundled)
      if (resolved) rest.privateKeyPath = resolved
      else {
        missingKeys++
        rest.privateKeyPath = undefined
      }
    }
    const own = secrets.connections?.[c.id]
    if (!own) return rest
    // Re-sealed under this machine's keychain, so nothing asks for it again.
    passwords++
    return { ...rest, secret: encryptSecret(own) }
  })

  mergeImport(bundle.folders ?? [], connections)
  if (bundle.llm) applyLlm(bundle.llm, secrets.llmKey)
  if (bundle.settings) applyAppearance(bundle.settings)
  for (const h of bundle.knownHosts ?? [])
    rememberHostKey({ id: h.connId, host: h.host, port: h.port }, h.fingerprint)
  if (bundle.agentHistory?.length) agentHistory.merge(bundle.agentHistory)
  const s = store()
  for (const key of library) {
    const i = s.keys.findIndex((k) => k.id === key.id)
    if (i >= 0) s.keys[i] = key
    else s.keys.push(key)
  }
  if (library.length) persist()
  return {
    folders: bundle.folders?.length ?? 0,
    connections: connections.length,
    keys: keyPaths.size,
    missingKeys,
    passwords: passwords + keyPasswords,
    llm: !!bundle.llm,
    settings: !!bundle.settings,
    hostKeys: bundle.knownHosts?.length ?? 0
  }
}

/** Theme, font, panel width — the preferences that make a fresh install feel
 *  like the machine you came from. Model settings are not here on purpose:
 *  `applyLlm` owns those, because only it knows to keep a local API key. */
export function applyAppearance(appearance: Omit<Settings, 'llm'>): void {
  const s = store()
  // `llm` last on purpose: the type keeps it out, an edited file may not.
  s.settings = { ...s.settings, ...appearance, llm: s.settings.llm }
  persist()
}

/**
 * Model settings from a backup. Endpoint and model always come across — that is
 * the point of exporting them. The API key only when the bundle carried one;
 * otherwise this machine keeps the key it already had.
 */
export function applyLlm(llm: BundleLlm, apiKey?: string): void {
  const s = store()
  s.settings = {
    ...s.settings,
    llm: {
      ...DEFAULTS.llm,
      ...llm,
      // A bundle written before the context window existed says nothing about
      // this machine's window; 0 is not a number any dialog types in.
      contextK: llm.contextK || DEFAULTS.llm.contextK,
      apiKey: apiKey ? encryptSecret(apiKey) : s.settings.llm?.apiKey
    }
  }
  persist()
}
