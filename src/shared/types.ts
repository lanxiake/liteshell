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
  /**
   * Local address the outbound socket binds to. The escape hatch for two VPNs
   * whose routes cover the same remote subnet: the OS picks one route for a
   * destination, but binding to a tunnel's own address sends the connection
   * down that tunnel. Empty means let the OS choose.
   */
  localAddress?: string
  /**
   * Bind to whichever address this interface has right now. Preferred over
   * `localAddress` for VPN tunnels: reconnecting a VPN hands out a new address,
   * and a pinned one silently stops matching anything.
   */
  localIface?: string
  /** The name `ssh <alias>` uses, assigned the first time passwordless login is
   *  configured. Kept so a second profile on the same IP does not steal it. */
  sshAlias?: string
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
  /**
   * Remote desktop (RDP) reached through this connection's SSH tunnel. Only
   * the address of the service is remembered; the desktop's own credentials
   * are typed into the system RDP client, never stored here.
   */
  rdpPort?: number
  /** Login shown in the RDP client; defaults to the SSH user when absent. */
  rdpUsername?: string
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
  /** The model's context window, in K tokens. Used only to decide when the
   *  conversation has to be compressed — nothing here counts tokens exactly. */
  contextK: number
}

/* ---------------- AI 对话：两种方言共用的消息形状 ---------------- */

export interface Call {
  id: string
  name: string
  /** null when the streamed JSON did not parse — the caller must not run it. */
  args: Record<string, unknown> | null
}

export interface ToolResult {
  id: string
  text: string
  isError: boolean
}

/** The conversation in a shape both dialects can read. `echo` is what goes back
 *  verbatim as the assistant turn: Anthropic's content blocks, OpenAI's
 *  tool_calls plus whatever reasoning channel the endpoint uses. */
export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: Call[]; echo: unknown }
  | { role: 'result'; results: ToolResult[] }

export interface Settings {
  theme: string
  fontFamily: string
  fontSize: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  /** The connection list folded away to a strip, for a narrow screen. */
  sidebarCollapsed: boolean
  /** Pixels the AI panel takes from the terminal. Dragged, so it is a view
   *  preference like the font — not something to re-decide every launch. */
  agentWidth: number
  /** Absolute path of a picture drawn behind the terminal. Empty = none. The
   *  renderer never reads the path itself: main turns it into a data URL, which
   *  is what the page's CSP allows. */
  backgroundImage: string
  llm: LlmSettings
}

export interface HostKeyRecord {
  host: string
  port: number
  fingerprint: string
  /**
   * Connection profile this key is pinned to. Identity is the profile, not the
   * address: two environments (a test and a prod cluster, say) can hand out the
   * same IP. Records written before pinning was per connection have no
   * `connId`; a connection adopts one only when it names the exact same key.
   */
  connId?: string
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

/** Cumulative counters for one interface, from /proc/net/dev. */
export interface NetCounter {
  name: string
  rxBytes: number
  txBytes: number
}

/** The ssh transport's own view of the link: the time a TCP round trip takes
 *  to the server. Independent of the box, and the number that answers "is the
 *  line slow or is the machine busy". */
export interface NetLatency {
  /** Round-trip milliseconds, or -1 when the probe could not connect. */
  rtt: number
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

/** One row of the panel's process table: what `ps` would tell you about the
 *  busiest processes, pruned down to what the eye can scan. */
export interface ProcInfo {
  pid: number
  user: string
  /** Percent of one core, the way top reports it. */
  cpu: number
  /** Percent of RAM. */
  mem: number
  /** Resident set size in bytes. */
  rss: number
  /** Bytes this process has read from and written to storage since it started. */
  diskRead: number
  diskWrite: number
  name: string
  /** Full command line, when ps gives one. */
  cmd: string
  /** The file that command line started, if it could be resolved without sudo. */
  path?: string
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
  /** Totals since boot, for the traffic figure — the rates alone reset on reboot. */
  netTotals: NetCounter[]
  /** Measured from this machine to the server, not on it. */
  latency?: NetLatency
  disk: DiskInfo[]
  gpu: GpuInfo[]
  /** The busiest few processes, for the panel's process table. */
  proc: ProcInfo[]
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
  direction: 'upload' | 'download'
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
  /** AI conversations for the connections in this file. Carried so a machine
   *  that takes over a server also gets what was already asked about it. */
  agentHistory?: AgentConversation[]
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
  /** Passwords decrypted from FinalShell's ciphertext and stored in the keychain. */
  passwords: number
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

/** What starting a remote desktop handed back. The tunnel closes itself when
 *  the external client exits; `tunnelId` is there for an early close too. */
export interface DesktopLaunch {
  tunnelId: string
  /** Loopback port the SSH tunnel listens on. */
  localPort: number
  /** Which client was started, for the status line. */
  client: string
  /** The temporary `.rdp` file, when the client takes one. */
  rdpFile?: string
}

/** An embedded desktop window was created; `id` is what the window attaches
 *  with. No credentials are in this shape. */
export interface DesktopEmbedded {
  id: string
  name: string
}

/** What the dedicated window needs from the main process. The password is
 *  handed over once, in memory, and never stored. */
export interface DesktopEmbeddedInfo extends DesktopEmbedded {
  /** Loopback WebSocket URL of the RDCleanPath proxy. */
  url: string
  username: string
  password: string
  /** RDP port on the remote's loopback. */
  port: number
}

/** The installer for this machine, as the release publishes it. */
export interface UpdateAsset {
  name: string
  url: string
  size: number
  /** URL of the `.sha256` the release carries beside the installer, if any. */
  sha256?: string
}

export type UpdateCheck =
  | { kind: 'latest'; current: string; latest: string }
  | { kind: 'available'; current: string; latest: string; notes: string; asset: UpdateAsset | null }
  | { kind: 'error'; message: string }

/** Outcome of configuring plain `ssh <host>` on this machine. */
export interface PasswordlessResult {
  /** `ssh <alias>` — unique per connection, since two profiles can share an
   *  address and must not overwrite each other's config block. */
  alias: string
  host: string
  port: number
  username: string
  keyPath: string
  configPath: string
  /** false when the server already had this key in authorized_keys. */
  added: boolean
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

  /** Opens an SSH tunnel to the connection's RDP service and starts the
   *  system RDP client. Credentials for the desktop itself are not part of
   *  this call — the client asks for them. */
  desktopOpen(
    connectionId: string,
    opts: { port?: number; username?: string; secret?: string }
  ): Promise<DesktopLaunch>
  /** Closes a tunnel early; the external client window is left to the OS. */
  desktopClose(tunnelId: string): Promise<void>
  /** Opens the in-app desktop window (IronRDP in a WebView) for this
   *  connection. The password is the RDP login, not the SSH one. */
  desktopEmbedded(
    connectionId: string,
    opts: { port?: number; username?: string; password?: string; secret?: string }
  ): Promise<DesktopEmbedded>
  /** Called by the desktop window to get its proxy URL and login. */
  desktopAttach(id: string): Promise<DesktopEmbeddedInfo | null>
  desktopCloseEmbedded(id: string): Promise<void>

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
  /** Continues a saved conversation in this session: its events are replayed
   *  into every window through `onAgentCleared`, and its messages become the
   *  model's history. False when the tab is busy or the id is not this host's. */
  agentResume(sessionId: string, connectionId: string, conversationId: string): Promise<boolean>
  /** Conversations saved for one connection, newest first. */
  agentHistory(connectionId: string): Promise<AgentConversationInfo[]>
  agentHistoryGet(id: string): Promise<AgentConversation | null>
  agentHistoryDelete(id: string): Promise<void>
  /** Writes one conversation to a file the user picks; returns the path. */
  agentHistoryExport(id: string): Promise<string | null>

  /** Model ids the endpoint reports, for the settings picker. `apiKey` is used
   *  only if given here — otherwise the saved one. Throws with the URL it
   *  tried, so a missing `/v1` is visible instead of a bare 404. */
  listModels(cfg: { provider: LlmSettings['provider']; baseUrl: string; apiKey?: string }): Promise<string[]>

  /** Repaints the OS window buttons so they match the active theme. */
  setWindowChrome(background: string, foreground: string): Promise<void>

  /** Asks GitHub for the latest published release. Never throws — a failure
   *  comes back as `{ kind: 'error' }` so the dialog can say what happened. */
  updateCheck(): Promise<UpdateCheck>
  /** Downloads the installer and reports progress. Resolves to its path. */
  updateDownload(): Promise<string>
  /** Runs the downloaded installer (or opens it, on macOS/Linux). */
  updateInstall(path: string): Promise<void>
  onUpdateProgress(cb: (received: number, total: number) => void): () => void
  /** Opens the release page in the user's browser. */
  updateReleasesUrl(): Promise<void>
  /** This build's version, as package.json says. */
  appVersion(): Promise<string>

  /** Opens the picture picker. Null when the user cancels; otherwise the path to
   *  save and the picture itself as a data URL, for an immediate preview. */
  pickBackgroundImage(): Promise<{ path: string; data: string } | null>
  /** The saved picture as a data URL, or null. Read on boot and after a change. */
  backgroundImage(): Promise<string | null>

  /** Writes the agent skill package (SKILL.md + CLI) into a folder the user
   *  picks, for another AI client. Resolves to the created path, null if the
   *  user cancels. */
  exportSkill(): Promise<string | null>

  /** Absolute path of a dropped File; Electron keeps it out of the DOM. */
  pathForFile(file: File): string

  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>

  /** Imports a FinalShell install directory; resolves null if the user cancels. */
  importFinalshell(): Promise<ImportSummary | null>
  /** One `*_connect_config.json`; `folderId` files it below that folder. */
  importFinalshellFile(folderId?: string | null): Promise<ImportSummary | null>
  /** `passphrase` seals the passwords and the API key into the file; empty
   *  leaves them behind, as before. */
  exportConnections(passphrase?: string): Promise<ExportReport | null>
  /** A bundle for one connection only — its password travels under the same
   *  passphrase rule as the full export. */
  exportConnection(id: string, passphrase?: string): Promise<ExportReport | null>
  /** A bundle for one folder and everything below it. */
  exportFolder(id: string, passphrase?: string): Promise<ExportReport | null>
  /** Installs LiteShell's local key on the server and writes the ssh config
   *  block, so `ssh <host>` works here without a password afterwards. */
  setupPasswordless(id: string, secret?: string): Promise<PasswordlessResult>
  /** Local IPv4 addresses by interface, for the "bind to this tunnel" picker. */
  netInterfaces(): Promise<{ name: string; address: string }[]>
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
  /** Opens the conversation in its own window. The panel stays where it is;
   *  agent events are mirrored to both. */
  popOutAgent(sessionId: string, connectionId: string): Promise<boolean>
  /** Registers this window for a session's agent events and returns the
   *  transcript so far, so the new window starts filled in. */
  attachAgentWindow(sessionId: string): Promise<AgentEvent[]>
  /** The transcript so far, without registering anything — for a window that is
   *  already attached and has just been told to redraw. */
  agentTranscript(sessionId: string): Promise<AgentEvent[]>
  /** Fired when the conversation is cleared anywhere, so every window showing
   *  it empties together. */
  onAgentCleared(cb: (sessionId: string) => void): () => void
  /** The saved connections changed somewhere other than this window — today,
   *  because the AI assistant wrote one. */
  onStoreChanged(cb: () => void): () => void
  /** Closes the window this renderer lives in. Used by windows that are just
   *  a panel, where the header's X means "this window", not "hide the panel". */
  closeWindow(): Promise<void>

  onSessionEvent(cb: (ev: SessionEvent) => void): () => void
}

/**
 * One line of the AI panel's transcript. Every one of these is something the
 * user should be able to read back later — especially `ask`, which is the only
 * place a command can be stopped.
 */
export type AgentEvent =
  /** What the user sent. Emitted by main so every window — and the stored
   *  transcript — has the same record of the turn. */
  | { kind: 'user'; text: string; files?: string[] }
  /** Text streaming out of the model, appended to the message already shown. */
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  /** A tool is about to run without asking (read-only). */
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; name: string; ok: boolean; summary: string }
  /** Parked: nothing happens until the user answers. Answered cards are
   *  resolved by whoever clicked them; anything still open when `done` arrives
   *  was cancelled. */
  /** Parked: nothing happens until the user answers. Answered cards are
   *  resolved by whoever clicked them; anything still open when `done` arrives
   *  was cancelled. `settled` is set on the stored copy only, so a replayed
   *  conversation does not offer buttons for a session that no longer exists. */
  | { kind: 'ask'; askId: string; name: string; detail: string; risk: string; why: string; settled?: boolean }
  | { kind: 'error'; message: string }
  /** The history was summarised because it outgrew the context window; `note`
   *  is what the model was left with, shown folded so it can be checked. */
  | { kind: 'compact'; note: string }
  | { kind: 'done' }

/** One saved conversation. Deltas are not kept: every answer also arrives once,
 *  whole, so a stored transcript is the settled events only. `messages` is the
 *  model-side history — it is what reopening the conversation continues from,
 *  because the events above have lost the tool-call pairing. */
export interface AgentConversation {
  id: string
  connectionId: string
  /** The first thing the user said, trimmed — a list of untitled entries is
   *  the same as no list. */
  title: string
  createdAt: number
  updatedAt: number
  events: AgentEvent[]
  messages?: Msg[]
  /** Whose dialect `messages` is written in (`provider|baseUrl|model`), so
   *  reopening it after switching models starts over instead of 400ing. */
  endpoint?: string
}

/** Identity only, for the history list. */
export type AgentConversationInfo = Omit<AgentConversation, 'events' | 'messages'>

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
