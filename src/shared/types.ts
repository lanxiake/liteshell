/** Types shared by main and renderer. Keep this file dependency-free. */

export type AuthType = 'password' | 'key' | 'agent'

export interface Folder {
  id: string
  name: string
  parentId: string | null
}

export interface Connection {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  username: string
  authType: AuthType
  /** Encrypted-at-rest secret (password or key passphrase). Never plaintext on disk. */
  secret?: string
  /**
   * Set on the copy the renderer gets (where `secret` is stripped) so the UI can
   * tell a connection with a saved password from one that never had one — e.g.
   * everything imported from FinalShell, whose passwords are not recoverable.
   */
  hasSecret?: boolean
  privateKeyPath?: string
  agentSocket?: string
  termType: string
  /** Keepalive interval in seconds; 0 disables. */
  keepalive: number
}

export interface QuickCommand {
  id: string
  name: string
  command: string
}

/**
 * A private key the user has filed away for reuse. Connections still point at
 * one by path (`Connection.privateKeyPath`), so this list is an index: it exists
 * so the same key can be picked from a menu instead of re-browsed for, and so a
 * backup carries keys nothing references yet.
 */
export interface KeyFile {
  id: string
  /** Label shown in menus; editable, defaults to the file name. */
  name: string
  /** Where the bytes live. Copies live under the app's own key directory. */
  path: string
  /** Free text — "生产跳板机" and the like. */
  comment?: string
  /** Passphrase for an encrypted key, sealed by the vault. Every connection
   *  pointing at this file picks it up, so nobody types it twice. */
  secret?: string
  /** Renderer-side view of `secret`, which never crosses the IPC boundary. */
  hasSecret?: boolean
  addedAt: number
}

export interface LlmSettings {
  /** 'anthropic' uses Anthropic's own API shape; 'openai' covers every endpoint
   *  that speaks /chat/completions — OpenAI, DeepSeek, Moonshot, a self-hosted
   *  gateway. Anthropic's OpenAI-compatible endpoint is deliberately not an
   *  option: it drops thinking and ignores `strict`. */
  provider: 'anthropic' | 'openai'
  /** Empty means the vendor's own endpoint. Set it for a proxy or a gateway. */
  baseUrl: string
  model: string
  /** Encrypted at rest by the same vault the connection passwords use. Only the
   *  main process ever sees this; the renderer gets `hasKey` instead. */
  apiKey?: string
  hasKey?: boolean
}

export interface Settings {
  theme: string
  fontFamily: string
  fontSize: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  rightClickPaste: boolean
  /** Pixels the AI panel takes from the terminal. Dragged, so it is a view
   *  preference like the font — not something to re-decide every launch. */
  agentWidth: number
  llm: LlmSettings
}

export interface HostKeyRecord {
  host: string
  port: number
  fingerprint: string
}

export interface Store {
  version: number
  folders: Folder[]
  connections: Connection[]
  /** Filed-away private keys, available for reuse in any connection. */
  keys: KeyFile[]
  quickCommands: QuickCommand[]
  settings: Settings
  knownHosts: HostKeyRecord[]
  /** Commands typed in each session, oldest first, keyed by connection id. */
  history: Record<string, string[]>
}

export interface SftpEntry {
  name: string
  path: string
  size: number
  mtime: number
  mode: number
  isDir: boolean
  isLink: boolean
}

/* ---------------- resource monitor ---------------- */

export interface CpuCore {
  /** Jiffies since boot, split the way /proc/stat splits them. */
  total: number
  idle: number
}

export interface NetIface {
  rx: number
  tx: number
}

export interface GpuInfo {
  name: string
  util: number
  memUsed: number
  memTotal: number
  temp: number
}

export interface DiskInfo {
  fs: string
  mount: string
  size: number
  used: number
}

export interface MonitorSnapshot {
  at: number
  /** Percentage over the interval between the two samples. */
  cpu: number
  cpuCores: number
  load: [number, number, number]
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  /** Bytes/second over the sampling interval. */
  netDown: number
  netUp: number
  net: { name: string; rx: number; tx: number }[]
  disk: DiskInfo[]
  gpu: GpuInfo[]
  uptime: number
  info: {
    hostname: string
    os: string
    kernel: string
    arch: string
    cpuModel: string
  }
}

/* ---------------- remote text files ---------------- */

/** Result of trying to open a remote file in the built-in editor. */
export type RemoteText =
  | { kind: 'text'; text: string; size: number; mtime: number }
  | { kind: 'binary'; reason: string }

/** `stale` means the file changed on the server since it was read. */
export type SaveResult = { ok: true; mtime: number } | { ok: false; stale: true }

/* ---------------- transfers ---------------- */

export type TransferState = 'queued' | 'active' | 'done' | 'failed'

export interface Transfer {
  id: string
  sessionId: string
  /** Local filesystem path. */
  local: string
  name: string
  remote: string
  size: number
  transferred: number
  state: TransferState
  error?: string
}

/* ---------------- backup bundle ---------------- */

export interface KeyBlob {
  /** File name the key is written back under inside the key directory. */
  name: string
  /** Key-list id and label, so an import can rebuild the list, not just the file. */
  id?: string
  label?: string
  comment?: string
  /** base64 of the PEM file, same shape FinalShell uses for its own keys. */
  data: string
}

/** What travels inside the sealed blob: passwords and key passphrases by
 *  connection id, plus the model API key. */
export interface BundleSecrets {
  connections?: Record<string, string>
  /** Key passphrases, by the key blob's file name inside the bundle. */
  keys?: Record<string, string>
  llmKey?: string
}

/** AES-256-GCM under a key derived from a passphrase the user typed, instead of
 *  under this machine's keychain — which does not travel (see vault.ts). */
export interface SealedSecrets {
  kdf: 'scrypt'
  salt: string
  iv: string
  data: string
  tag: string
}

/** Model settings without the key: the endpoint travels in the clear, the key
 *  only inside `secrets`. */
export type BundleLlm = Omit<LlmSettings, 'apiKey' | 'hasKey'>

export interface BackupBundle {
  kind: 'liteshell-backup'
  version: number
  exportedAt: number
  folders: Folder[]
  /** Passwords are absent unless the export was sealed — see `secrets`. */
  connections: Connection[]
  keys: KeyBlob[]
  llm?: BundleLlm
  /** Appearance preferences — theme, font, panel width. Not the model settings:
   *  those are `llm`, which is the half that has a secret in it. */
  settings?: Omit<Settings, 'llm'>
  /** Fingerprints already accepted on the exporting machine, so the other side
   *  does not re-confirm every server. Trust travels with the file — which is
   *  also why the file has to be treated like the keys inside it. */
  knownHosts?: HostKeyRecord[]
  secrets?: SealedSecrets
}

export interface ExportReport {
  path: string
  connections: number
  keys: number
  /** Passwords, key passphrases and the API key that went along; 0 when the
   *  export was not sealed. */
  passwords: number
  /** Trusted host fingerprints in the file. */
  hostKeys: number
  /** Names of connections whose private key file was gone at export time. */
  missing: string[]
}

export interface ImportReport {
  folders: number
  connections: number
  keys: number
  /** Connections that referenced a key the bundle did not carry. */
  missingKeys: number
  /** Passwords now sealed by this machine's keychain, so they stop being asked for. */
  passwords: number
  /** The bundle carried model settings and they were applied. */
  llm: boolean
  /** Trusted host fingerprints the bundle carried. */
  hostKeys: number
  /** The bundle carried appearance settings and they were applied. */
  settings: boolean
}

/** The bundle is sealed: ask for the passphrase and call import again with it. */
export interface ImportNeedsPassphrase {
  needsPassphrase: true
  /** The file already picked, so the second call does not reopen the dialog. */
  path: string
}

export type SessionStatus = 'connecting' | 'ready' | 'closed' | 'error'

export interface ImportSummary {
  folders: number
  connections: number
  keys: number
  /** Connections whose stored password could not be recovered. */
  needsPassword: number
  /** Connections skipped because their transport is not SSH. */
  skipped: number
  warnings: string[]
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  name: string
  status: SessionStatus
  error?: string
}

/** Renderer -> main invoke channels. */
export interface Api {
  getStore(): Promise<Store>
  saveConnection(conn: Connection, secret: string | null): Promise<Connection>
  deleteConnection(id: string): Promise<void>
  duplicateConnection(id: string): Promise<void>
  saveFolder(folder: Folder): Promise<Folder>
  deleteFolder(id: string): Promise<void>
  saveQuickCommands(cmds: QuickCommand[]): Promise<void>
  saveSettings(settings: Settings): Promise<Settings>
  saveHistory(connectionId: string, commands: string[]): Promise<void>

  /** Pick one or more PEM files and file them under the app's key directory. */
  importKeys(): Promise<KeyFile[] | null>
  saveKey(key: KeyFile): Promise<KeyFile>
  deleteKey(id: string): Promise<void>
  /** Stores (or, with an empty string, forgets) the key's passphrase. */
  setKeySecret(id: string, passphrase: string): Promise<void>
  /** Writes a copy of the key wherever the user asks; resolves the target path. */
  exportKey(id: string): Promise<string | null>

  /** `secret` overrides the stored password for this session only (one-shot prompt). */
  connect(
    connectionId: string,
    sessionId: string,
    cols: number,
    rows: number,
    secret?: string
  ): Promise<SessionInfo>
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  disconnect(sessionId: string): Promise<void>
  disconnectAll(): Promise<void>

  sftpList(sessionId: string, path: string): Promise<SftpEntry[]>
  sftpHome(sessionId: string): Promise<string>
  sftpMkdir(sessionId: string, path: string): Promise<void>
  sftpRename(sessionId: string, from: string, to: string): Promise<void>
  /** `recursive` only matters for directories: false leaves a non-empty one alone. */
  sftpRemove(sessionId: string, path: string, isDir: boolean, recursive?: boolean): Promise<void>
  /** Creates an empty file (or truncates one) — the "新建文件" action. */
  sftpTouch(sessionId: string, path: string): Promise<void>
  /** Octal permission bits, e.g. 0o644. */
  sftpChmod(sessionId: string, path: string, mode: number): Promise<void>
  sftpDownload(sessionId: string, remotePath: string, isDir: boolean): Promise<string | null>
  /** Packs the remote path with tar on the server, then pulls the archive down. */
  sftpDownloadArchive(sessionId: string, remotePath: string): Promise<string | null>
  /** Pulls the file into the OS temp dir and hands it to the default app. */
  sftpOpen(sessionId: string, remotePath: string): Promise<string>
  /** Reads a remote file for the built-in editor, refusing binaries and huge files. */
  sftpReadText(sessionId: string, remotePath: string): Promise<RemoteText>
  /** Writes the editor buffer back. `expectedMtime` guards against clobbering edits
   *  made elsewhere; `force` skips that check. */
  sftpWriteText(
    sessionId: string,
    remotePath: string,
    text: string,
    expectedMtime: number,
    force: boolean
  ): Promise<SaveResult>
  sftpUpload(sessionId: string, remoteDir: string): Promise<string[]>
  /** Drag-and-drop path: absolute local paths picked up by the renderer. */
  sftpUploadPaths(sessionId: string, localPaths: string[], remoteDir: string): Promise<string[]>
  sftpTransfers(sessionId: string): Promise<Transfer[]>
  sftpClearTransfers(sessionId: string): Promise<void>

  monitor(sessionId: string): Promise<MonitorSnapshot>

  /** One turn of the conversation: what the user typed, plus the SSH session it
   *  should act on. `files` are local paths to put on the server first, so the
   *  agent can read them with its own tools. Events come back through
   *  `onSessionEvent`. */
  agentSend(sessionId: string, connectionId: string, text: string, files?: string[]): Promise<void>
  /** Answers a parked approval. `command` replaces what the model proposed —
   *  it is re-checked before it runs. */
  agentApprove(askId: string, allowed: boolean, command?: string): Promise<void>
  agentAbort(sessionId: string): Promise<void>
  /** Drops the conversation but keeps the panel. */
  agentReset(sessionId: string): Promise<void>

  /** Model ids the endpoint reports, for the settings picker. `apiKey` is used
   *  only if given here — otherwise the saved one. Throws with the URL it
   *  tried, so a missing `/v1` is visible instead of a bare 404. */
  listModels(cfg: { provider: LlmSettings['provider']; baseUrl: string; apiKey?: string }): Promise<string[]>

  /** Repaints the OS window buttons so they match the active theme. */
  setWindowChrome(background: string, foreground: string): Promise<void>

  /** Absolute path of a dropped File; Electron keeps it out of the DOM. */
  pathForFile(file: File): string

  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>

  /** Imports a FinalShell install directory; resolves null if the user cancels. */
  importFinalshell(): Promise<ImportSummary | null>
  /** `passphrase` seals the passwords and the API key into the file; empty
   *  leaves them behind, as before. */
  exportConnections(passphrase?: string): Promise<ExportReport | null>
  /** A bundle for one connection only — its password travels under the same
   *  passphrase rule as the full export. */
  exportConnection(id: string, passphrase?: string): Promise<ExportReport | null>
  /** `path` is only for the second call, after a `needsPassphrase` answer. */
  importConnections(
    passphrase?: string,
    path?: string
  ): Promise<ImportReport | ImportNeedsPassphrase | null>

  /** Registers this window as the viewer of a session, so its events stop
   *  going to whichever window opened it. Returns the session's current state
   *  when main already has it (a CLI or popped-out session). */
  attachSession(sessionId: string): Promise<SessionInfo | null>
  releaseSession(sessionId: string): Promise<void>
  /** Moves a live tab into its own window. The caller must drop its tab after
   *  this resolves — events for the session go to the new window from here on. */
  popOutSession(sessionId: string, connectionId: string): Promise<boolean>

  onSessionEvent(cb: (ev: SessionEvent) => void): () => void
}

/**
 * One line of the AI panel's transcript. Every one of these is something the
 * user should be able to read back later — especially `ask`, which is the only
 * place a command can be stopped.
 */
export type AgentEvent =
  /** Text streaming out of the model, appended to the message already shown. */
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  /** A tool is about to run without asking (read-only). */
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; name: string; ok: boolean; summary: string }
  /** Parked: nothing happens until the user answers. Answered cards are
   *  resolved by whoever clicked them; anything still open when `done` arrives
   *  was cancelled. */
  | { kind: 'ask'; askId: string; name: string; detail: string; risk: string; why: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' }

export type SessionEvent =
  /** Main opened this one on its own (the CLI asked for it); the renderer's job is
   *  only to put a tab around a session that already exists. */
  | { type: 'cli-session'; sessionId: string; connectionId: string }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'status'; sessionId: string; status: SessionStatus; error?: string }
  | { type: 'hostkey'; sessionId: string; fingerprint: string; known: boolean; changed: boolean }
  | { type: 'log'; sessionId: string; level: 'debug' | 'info' | 'warn'; text: string }
  | { type: 'transfer'; sessionId: string; transfer: Transfer }
  | { type: 'agent'; sessionId: string; event: AgentEvent }
