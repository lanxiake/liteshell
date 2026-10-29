import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { MONITOR_SCRIPT, parseMonitor } from './monitor'
import { bindAddress, probeLatency } from './localnet'
import { decodeText, looksLikeText } from './textfile'
import type { MonitorSnapshot, RemoteText, SaveResult, Transfer } from '../shared/types'
import type { Connection, SessionEvent, SessionInfo, SessionStatus, SftpEntry } from '../shared/types'
import { hostKey, keySecretOf, legacyHostKey, rememberHostKey, secretOf, store } from './store'

type Emit = (ev: SessionEvent) => void

/** A command that ran. `code` is the remote exit status; -1 means the channel
 *  closed without one (dropped link). */
export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  timedOut?: boolean
}

/** The tty hands back colours and a carriage return on every line. A model
 *  reading the captured text wants neither. */
const ANSI =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const plain = (s: string): string => s.replace(ANSI, '').replace(/\r/g, '')

/** How much of a chatty command is kept. Past the agent's 32 KB spill threshold
 *  the whole thing goes to a file anyway; this only stops `yes` from eating RAM. */
const MAX_SHELL_OUT = 256_000

/**
 * Trust-on-first-use, pinned per connection profile rather than per address:
 * two environments can share an IP and each gets its own key. A key that
 * changes for a profile we already know is refused outright.
 *
 * Shared by terminal sessions and the remote-desktop tunnel: both authenticate
 * as the same profile, so they must agree about what the host's key is.
 */
export function checkHostKey(
  conn: Connection,
  key: Buffer,
  onInfo?: (info: { fingerprint: string; known: boolean; changed: boolean }) => void
): boolean {
  const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  const known = hostKey(conn.id)
  if (known) {
    if (known !== fingerprint) {
      onInfo?.({ fingerprint, known: true, changed: true })
      return false
    }
    return true
  }
  // A record from before per-connection pinning has no owner, so it is only
  // adopted when it names this exact key; otherwise this profile is meeting
  // the host for the first time and gets the usual first-contact trust.
  const legacy = legacyHostKey(conn.host, conn.port)
  rememberHostKey(conn, fingerprint)
  if (legacy === fingerprint) return true
  onInfo?.({ fingerprint, known: false, changed: false })
  return true
}

/**
 * Everything ssh2 needs to authenticate, resolved once for both the terminal
 * session and the desktop tunnel. Throws when a key connection has no file —
 * the caller decides whether that becomes a failed tab or a failed launch.
 */
export function connectOptions(
  conn: Connection,
  secret: string | undefined,
  hostVerifier: (key: Buffer) => boolean,
  log: (level: 'debug' | 'info' | 'warn', text: string) => void = () => {}
): Parameters<Client['connect']>[0] {
  // Resolved here, once, so the log line and the socket agree on the answer.
  const source = bindAddress(conn)
  const opts: Parameters<Client['connect']>[0] = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    readyTimeout: 20_000,
    keepaliveInterval: conn.keepalive > 0 ? conn.keepalive * 1000 : 0,
    // Two VPNs can carry the same remote subnet; binding the source address
    // picks the tunnel instead of letting the routing table decide. An
    // interface name is resolved now, so a reconnected tunnel still matches.
    ...(source ? { localAddress: source } : {}),
    hostVerifier,
    // Handshake detail goes to the log panel. It stops once the session is up,
    // so what you read after a failure is exactly the part that failed.
    debug: (msg: string) => log('debug', msg)
  }
  if (conn.localIface && !source) {
    log('warn', `本机网卡 ${conn.localIface} 现在没有地址（VPN 断了？），这次不绑定出口`)
  }

  // A key's own passphrase is the fallback: connections reusing the same key
  // file connect without asking, which is the point of storing it there.
  const pass =
    secret ||
    secretOf(conn) ||
    (conn.authType === 'key' && conn.privateKeyPath ? keySecretOf(conn.privateKeyPath) : '')

  if (conn.authType === 'password') {
    opts.password = pass
    if (!pass) log('warn', '没有可用密码，将以空密码尝试认证')
  } else if (conn.authType === 'key') {
    const path = conn.privateKeyPath
    if (!path || !existsSync(path)) throw new Error(`私钥文件不存在: ${path ?? '(未设置)'}`)
    opts.privateKey = readFileSync(path)
    if (pass) opts.passphrase = pass
  } else {
    opts.agent = conn.agentSocket || process.env.SSH_AUTH_SOCK
  }
  return opts
}

class Session {
  readonly id: string
  readonly conn: Connection
  private client = new Client()
  private stream: ClientChannel | null = null
  private sftpWrapper: SFTPWrapper | null = null
  private sftpPending: Promise<SFTPWrapper> | null = null
  private decoder = new StringDecoder('utf8')
  private closed = false
  /** A full-screen program owns the tty while it is up (vim, top, less). */
  private alt = false
  /** Set while a command is being read back out of the user's own prompt. */
  private tap: ((text: string) => void) | null = null
  /** Called when the link drops mid-command: nobody else will settle that wait. */
  private tapEnd: (() => void) | null = null

  /** @param secret one-shot password from the connect prompt, overriding the stored one */
  constructor(
    conn: Connection,
    id: string,
    private emit: Emit,
    private secret?: string
  ) {
    this.conn = conn
    this.id = id
  }

  private state: SessionStatus = 'connecting'

  private status(status: SessionStatus, error?: string): void {
    this.state = status
    this.emit({ type: 'status', sessionId: this.id, status, error })
  }

  /** What a window attaching to this session needs to draw its tab. */
  info(): SessionInfo {
    return { sessionId: this.id, connectionId: this.conn.id, name: this.conn.name, status: this.state }
  }

  /** Set once the handshake is done; ssh2's debug stream is noise past that point. */
  private up = false

  private log(level: 'debug' | 'info' | 'warn', text: string): void {
    if (level === 'debug' && this.up) return
    this.emit({ type: 'log', sessionId: this.id, level, text })
  }

  connect(cols: number, rows: number): void {
    const c = this.conn
    let opts: Parameters<Client['connect']>[0]
    try {
      opts = connectOptions(
        c,
        this.secret,
        (key: Buffer) => this.verifyHostKey(key),
        (level, text) => this.log(level, text)
      )
    } catch (err) {
      this.status('error', (err as Error).message)
      return
    }

    this.client.on('ready', () => {
      this.up = true
      this.client.shell(
        { term: c.termType || 'xterm-256color', cols, rows },
        (err, stream) => {
          if (err) {
            this.status('error', err.message)
            this.client.end()
            return
          }
          this.up = true
          this.stream = stream
          stream.on('data', (chunk: Buffer) => this.deliver(chunk))
          stream.stderr.on('data', (chunk: Buffer) => this.deliver(chunk))
          stream.on('close', () => {
            this.tapEnd?.()
            this.client.end()
          })
          this.status('ready')
        }
      )
    })

    this.client.on('error', (err: Error) => {
      if (!this.closed) this.status('error', err.message)
    })
    this.client.on('close', () => {
      const tail = this.decoder.end()
      if (tail) this.emit({ type: 'data', sessionId: this.id, data: tail })
      if (!this.closed) this.status('closed')
    })

    this.status('connecting')
    try {
      this.client.connect(opts)
    } catch (err) {
      this.status('error', (err as Error).message)
    }
  }

  /** Trust-on-first-use, shared with the desktop tunnel (see `checkHostKey`). */
  private verifyHostKey(key: Buffer): boolean {
    return checkHostKey(this.conn, key, (info) =>
      this.emit({ type: 'hostkey', sessionId: this.id, ...info })
    )
  }

  /** Ctrl-C. The only way to call off a command already running on the prompt. */
  interrupt(): void {
    if (this.tap) this.stream?.write('\x03')
  }

  private deliver(chunk: Buffer): void {
    const text = this.decoder.write(chunk)
    // While a full-screen program is up the tty is its input, not the shell's:
    // a command typed now lands in vim. Cheap to spot, and it is the difference
    // between "the AI ran my command" and "the AI wrecked my editor".
    for (const m of text.matchAll(/\x1b\[\?(?:1049|1047|47)([hl])/g)) this.alt = m[1] === 'h'
    this.tap?.(text)
    this.emit({ type: 'data', sessionId: this.id, data: text })
  }

  write(data: string): void {
    this.stream?.write(data)
  }

  /**
   * Types a command into the shell the user is looking at, and reads back what
   * it printed.
   *
   * That is the point of the AI panel's exec: the command shows up in the
   * terminal the user already has open and runs there. It also means there is no
   * second channel to read — the output is bracketed in the very stream the
   * terminal is being fed, between two private OSC markers that a real emulator
   * swallows without printing.
   *
   * ponytail: the marker `printf`s share the line with the command, so the line
   * the user sees is `printf '\033]…'; ls -la; printf '\033]…' "$?"` rather than
   * a bare command. One write, ordering guaranteed by the tty, and nothing but
   * the command's own output lands between the markers. If that line ever has to
   * read clean, put the markers on lines of their own and strip their echoes.
   *
   * One command owns the prompt at a time; callers must not overlap.
   */
  runInShell(command: string, timeoutMs = 0): Promise<ExecResult> {
    const stream = this.stream
    if (!stream) return Promise.reject(new Error('这个会话还没有终端'))
    if (!command.trim()) return Promise.reject(new Error('空命令'))
    // A second physical line would be read as a line of its own: the end marker
    // lands on it and the first line's own echo ends up inside the answer.
    if (/[\r\n]/.test(command)) {
      return Promise.reject(
        new Error('一条命令里不能有换行 —— 用 bash -c \'…\' 包成一条，或者先写进脚本再跑')
      )
    }
    if (this.alt) return Promise.reject(new Error('终端里正跑着全屏程序（vim、top 之类），先退出它'))
    if (this.tap) return Promise.reject(new Error('终端里还有一条命令没跑完'))

    const nonce = randomBytes(3).toString('hex')
    const start = `\x1b]1338;${nonce}\x07`
    const end = new RegExp(`\\x1b\\]1339;${nonce}\\s*(\\d*)\\x07`)
    // Ctrl-U first: a half-typed line would otherwise be glued to the front of
    // the command and executed along with it.
    const payload =
      `\x15printf '\\033]1338;${nonce}\\007'; ${command}; ` +
      `printf '\\033]1339;${nonce} %s\\007' "$?"\n`

    return new Promise<ExecResult>((resolve) => {
      let seen = false
      let buf = ''
      let out = ''
      let code = -1
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const finish = (timedOut: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.tap = null
        this.tapEnd = null
        resolve({ stdout: plain(timedOut ? buf : out), stderr: '', code, timedOut })
      }

      this.tap = (text: string): void => {
        buf += text
        if (!seen) {
          const at = buf.indexOf(start)
          if (at < 0) {
            // Everything before the marker is the tty echoing the line back;
            // keep a little in case the marker arrives in the next chunk.
            if (buf.length > 8192) buf = buf.slice(-1024)
            return
          }
          buf = buf.slice(at + start.length)
          seen = true
        }
        // The tail is what matters, and it is where the error being looked for
        // will be.
        if (buf.length > MAX_SHELL_OUT) buf = buf.slice(-MAX_SHELL_OUT)
        const m = end.exec(buf)
        if (!m) return
        out = buf.slice(0, m.index)
        code = m[1] ? Number(m[1]) : -1
        finish(false)
      }

      stream.write(payload)
      // The link dropping ends the wait too: the alternative is an agent turn
      // parked forever on a promise nobody will settle.
      this.tapEnd = () => finish(true)

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Ctrl-C, because there is no closing this channel without hanging up
          // on the user's session with it.
          try {
            stream.write('\x03')
          } catch {
            // already gone
          }
          finish(true)
        }, timeoutMs)
      }
    })
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0)
  }

  sftp(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return Promise.resolve(this.sftpWrapper)
    this.sftpPending ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, wrapper) => {
        if (err) {
          this.sftpPending = null
          reject(err)
          return
        }
        this.sftpWrapper = wrapper
        resolve(wrapper)
      })
    })
    return this.sftpPending
  }

  /**
   * Runs a command on a second channel, so the user's shell stays untouched.
   * The exit status is part of the answer, not an error: `false` is a command that
   * ran and reported failure, and its stdout is empty rather than a reason to throw.
   *
   * @param timeoutMs 0 waits forever. On expiry only this channel dies, so the
   *                  session — and whatever the user is doing on it — carries on.
   */
  exec(command: string, timeoutMs = 0): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let stdout = ''
        let stderr = ''
        let code = -1
        let done = false
        let timer: NodeJS.Timeout | undefined

        const finish = (timedOut: boolean): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({ stdout, stderr, code, timedOut })
        }

        stream.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
        stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
        // The status arrives on 'exit'; 'close' is the last word either way.
        stream.on('exit', (c: number | null) => {
          if (typeof c === 'number') code = c
        })
        stream.on('close', (c: number | null) => {
          if (typeof c === 'number') code = c
          finish(false)
        })

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try {
              stream.close()
            } catch {
              // already gone
            }
            finish(true)
          }, timeoutMs)
        }
      })
    })
  }

  async monitor(): Promise<MonitorSnapshot> {
    // The link probe runs beside the sampling, not after it: it is an
    // independent TCP handshake, and waiting for the 1-second sleep first would
    // make a slow line look like a slow server.
    const probe = this.probeLatency()
    const { stdout, stderr } = await this.exec(MONITOR_SCRIPT)
    // The script is silent when it cannot run at all — say why instead of parsing "".
    if (!stdout.trim()) throw new Error(stderr.trim() || '监控脚本没有输出')
    const snapshot = parseMonitor(stdout)
    snapshot.latency = { rtt: await probe }
    return snapshot
  }

  private rtt = { at: 0, value: -1 }

  /**
   * Every probe is a TCP handshake sshd logs as "connection closed [preauth]",
   * so it runs every half minute rather than on every 2-second poll. A failed
   * probe is not cached: the line may come back before the next poll does.
   */
  private probeLatency(): Promise<number> {
    if (this.rtt.value >= 0 && Date.now() - this.rtt.at < 30_000) {
      return Promise.resolve(this.rtt.value)
    }
    return probeLatency(this.conn.host, this.conn.port, bindAddress(this.conn)).then((rtt) => {
      if (rtt >= 0) this.rtt = { at: Date.now(), value: rtt }
      return rtt
    })
  }

  /**
   * Reads a remote file for the editor. The size is checked before the transfer,
   * so a 4 GB log is refused with a message rather than in one enormous Buffer.
   */
  async readText(remotePath: string): Promise<RemoteText> {
    const wrapper = await this.sftp()
    const st = await new Promise<{ size: number; mtime: number }>((resolve, reject) =>
      wrapper.stat(remotePath, (err, attrs) =>
        err ? reject(err) : resolve({ size: attrs.size, mtime: attrs.mtime })
      )
    )
    const gate = looksLikeText(remotePath, Buffer.alloc(0), st.size)
    if (!gate.ok) return { kind: 'binary', reason: gate.reason }

    const body = await new Promise<Buffer>((resolve, reject) =>
      wrapper.readFile(remotePath, (err, data) => (err ? reject(err) : resolve(data as Buffer)))
    )
    const head = looksLikeText(remotePath, body.subarray(0, 8192), body.length)
    if (!head.ok) return { kind: 'binary', reason: head.reason }
    const decoded = decodeText(body)
    if ('reason' in decoded) return { kind: 'binary', reason: decoded.reason }
    return { kind: 'text', text: decoded.text, size: body.length, mtime: st.mtime }
  }

  /**
   * Writes the editor buffer. It goes to a sibling temp file that is then renamed
   * over the target: a connection that dies mid-write must not leave the original
   * file truncated. The temp gets the original's mode first — a fresh file would
   * otherwise come back as whatever the umask says, losing e.g. `+x` on a script.
   */
  async writeText(
    remotePath: string,
    text: string,
    expectedMtime: number,
    force: boolean
  ): Promise<SaveResult> {
    const wrapper = await this.sftp()
    const st = await new Promise<{ mode: number; mtime: number }>((resolve, reject) =>
      wrapper.stat(remotePath, (err, attrs) =>
        err ? reject(err) : resolve({ mode: attrs.mode, mtime: attrs.mtime })
      )
    )
    if (!force && Math.floor(st.mtime) !== Math.floor(expectedMtime)) return { ok: false, stale: true }

    const tmp = `${remotePath}.liteshell.tmp`
    await new Promise<void>((resolve, reject) =>
      wrapper.writeFile(tmp, Buffer.from(text, 'utf8'), (err) => (err ? reject(err) : resolve()))
    )
    await new Promise<void>((resolve, reject) =>
      wrapper.chmod(tmp, st.mode & 0o7777, (err) => (err ? reject(err) : resolve()))
    )
    await new Promise<void>((resolve, reject) =>
      wrapper.rename(tmp, remotePath, (err) => (err ? reject(err) : resolve()))
    )
    // Re-stat rather than guess: the renderer needs the new mtime to save again.
    const after = await new Promise<number>((resolve, reject) =>
      wrapper.stat(remotePath, (err, attrs) => (err ? reject(err) : resolve(attrs.mtime)))
    )
    return { ok: true, mtime: after }
  }

  close(): void {
    this.closed = true
    try {
      this.stream?.end()
    } catch {
      // stream may already be gone
    }
    this.client.end()
  }
}

export class SshManager {
  private sessions = new Map<string, Session>()
  /** Kept only so a freshly opened panel can show transfers it missed the events for. */
  private transfers = new Map<string, Transfer>()

  constructor(private emit: Emit) {}

  listTransfers(sessionId: string): Transfer[] {
    return [...this.transfers.values()].filter((t) => t.sessionId === sessionId)
  }

  clearTransfers(sessionId: string): void {
    for (const [id, t] of this.transfers) {
      if (t.sessionId === sessionId && t.state !== 'active') this.transfers.delete(id)
    }
  }

  monitor(sessionId: string): Promise<MonitorSnapshot> {
    return this.get(sessionId).monitor()
  }

  exec(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    return this.get(sessionId).exec(command, timeoutMs)
  }

  /** Same command, but typed into the session's own prompt — see runInShell. */
  execInShell(sessionId: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    return this.get(sessionId).runInShell(command, timeoutMs)
  }

  /** Ctrl-C on that session's prompt, if a command is running there. */
  interrupt(sessionId: string): void {
    this.sessions.get(sessionId)?.interrupt()
  }

  /** Whether a session id is still held here — the CLI checks before reusing one. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  info(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId)?.info() ?? null
  }

  connect(
    connectionId: string,
    sessionId: string,
    cols: number,
    rows: number,
    secret?: string
  ): SessionInfo {
    const conn = store().connections.find((c) => c.id === connectionId)
    if (!conn) throw new Error(`未知连接: ${connectionId}`)
    const session = new Session(conn, sessionId, this.emit, secret)
    this.sessions.set(sessionId, session)
    session.connect(cols, rows)
    return { sessionId, connectionId, name: conn.name, status: 'connecting' }
  }

  private get(sessionId: string): Session {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`会话不存在: ${sessionId}`)
    return s
  }

  write(sessionId: string, data: string): void {
    this.get(sessionId).write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    // Best effort by design. The renderer's terminal keeps reporting its size
    // while a tab is torn down, while the window is dragged, and after the CLI
    // dropped a session of its own — there is nothing left to resize, and a
    // rejected IPC here only paints noise over the console.
    this.sessions.get(sessionId)?.resize(cols, rows)
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.close()
    this.sessions.delete(sessionId)
    // close() suppresses the client's own 'close' event, so say it here: the
    // tab menu's 断开 has to turn the dot red, not leave it looking connected.
    this.emit({ type: 'status', sessionId, status: 'closed' })
  }

  disconnectAll(): void {
    for (const s of this.sessions.values()) s.close()
    this.sessions.clear()
  }

  /* ---------------- SFTP ---------------- */

  private async sftp(sessionId: string): Promise<SFTPWrapper> {
    return this.get(sessionId).sftp()
  }

  readText(sessionId: string, remotePath: string): Promise<RemoteText> {
    return this.get(sessionId).readText(remotePath)
  }

  writeText(
    sessionId: string,
    remotePath: string,
    text: string,
    expectedMtime: number,
    force: boolean
  ): Promise<SaveResult> {
    return this.get(sessionId).writeText(remotePath, text, expectedMtime, force)
  }

  async home(sessionId: string): Promise<string> {
    const wrapper = await this.sftp(sessionId)
    return new Promise((resolve) => {
      wrapper.realpath('.', (err, path) => resolve(err ? '/' : path))
    })
  }

  async list(sessionId: string, path: string): Promise<SftpEntry[]> {
    const wrapper = await this.sftp(sessionId)
    return new Promise((resolve, reject) => {
      wrapper.readdir(path, (err, list) => {
        if (err) {
          reject(err)
          return
        }
        const entries: SftpEntry[] = Object.values(list).map((entry) => {
          const attrs = entry.attrs
          const mode = attrs?.mode ?? 0
          return {
            name: entry.filename,
            path: path === '/' ? `/${entry.filename}` : `${path}/${entry.filename}`,
            size: attrs?.size ?? 0,
            mtime: (attrs?.mtime ?? 0) * 1000,
            mode,
            isDir: (mode & 0o170000) === 0o040000,
            isLink: (mode & 0o170000) === 0o120000
          }
        })
        entries.sort((a, b) =>
          a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
        )
        resolve(entries)
      })
    })
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    await new Promise<void>((resolve, reject) =>
      wrapper.mkdir(path, (err) => (err ? reject(err) : resolve()))
    )
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    await new Promise<void>((resolve, reject) =>
      wrapper.rename(from, to, (err) => (err ? reject(err) : resolve()))
    )
  }

  /** Creates an empty file. Truncating is intended: this backs "新建文件". */
  async touch(sessionId: string, path: string): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    await new Promise<void>((resolve, reject) =>
      wrapper.writeFile(path, Buffer.alloc(0), (err) => (err ? reject(err) : resolve()))
    )
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    await new Promise<void>((resolve, reject) =>
      wrapper.chmod(path, mode, (err) => (err ? reject(err) : resolve()))
    )
  }

  /**
   * SFTP has no rm -r, so the recursive walk is ours. `recursive: false` is the
   * plain RMDIR: a non-empty directory is refused by the server, which is the
   * point of having both menu entries.
   */
  async remove(sessionId: string, path: string, isDir: boolean, recursive = true): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    if (isDir) {
      if (recursive) {
        for (const entry of await this.list(sessionId, path)) {
          await this.remove(sessionId, entry.path, entry.isDir, true)
        }
      }
      await new Promise<void>((resolve, reject) =>
        wrapper.rmdir(path, (err) => (err ? reject(err) : resolve()))
      )
      return
    }
    await new Promise<void>((resolve, reject) =>
      wrapper.unlink(path, (err) => (err ? reject(err) : resolve()))
    )
  }

  /** Downloads to `localDir`, returning the written path. */
  async download(sessionId: string, remotePath: string, localDir: string, isDir: boolean): Promise<string> {
    const target = join(localDir, basename(remotePath))
    if (isDir) {
      mkdirSync(target, { recursive: true })
      for (const entry of await this.list(sessionId, remotePath)) {
        await this.download(sessionId, entry.path, target, entry.isDir)
      }
      return target
    }
    mkdirSync(dirname(target), { recursive: true })
    await this.getOne(sessionId, remotePath, target)
    return target
  }

  /**
   * "打包下载": tar on the server (the target machine has tar far more often
   * than we have a local zip library), pull the one file, then clean up the
   * temp on the server. Names are shell-quoted because tar gets a command line.
   */
  async downloadArchive(sessionId: string, remotePath: string, localDir: string): Promise<string> {
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    const name = basename(remotePath)
    const remoteTmp = `/tmp/liteshell-${randomBytes(4).toString('hex')}.tar.gz`
    const packed = await this.exec(
      sessionId,
      `tar -czf ${q(remoteTmp)} -C ${q(dirname(remotePath))} ${q(name)}`
    )
    if (packed.code !== 0) {
      throw new Error(packed.stderr.trim() || packed.stdout.trim() || '服务器上打包失败（需要 tar）')
    }
    const target = join(localDir, `${name}.tar.gz`)
    try {
      await this.getOne(sessionId, remoteTmp, target, `${name}.tar.gz`)
    } finally {
      void this.exec(sessionId, `rm -f ${q(remoteTmp)}`).catch(() => undefined)
    }
    return target
  }

  /** Uploads each local path into `remoteDir`, returning the remote paths written. */
  async upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string[]> {
    const written: string[] = []
    for (const local of localPaths) {
      const remote = remoteDir === '/' ? `/${basename(local)}` : `${remoteDir}/${basename(local)}`
      if (statSync(local).isDirectory()) {
        await this.mkdir(sessionId, remote).catch(() => undefined)
        const { readdirSync } = await import('node:fs')
        // ponytail: recursive dir upload reports no progress; it is a wrapper, not a file
        const nested = readdirSync(local).map((n) => join(local, n))
        written.push(...(await this.upload(sessionId, nested, remote)))
        continue
      }
      await this.putOne(sessionId, local, remote)
      written.push(remote)
    }
    return written
  }

  /** One file, tracked in the transfer list with per-chunk progress. */
  private async putOne(sessionId: string, local: string, remote: string): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    const transfer = this.track(sessionId, 'upload', local, remote, statSync(local).size)
    try {
      await this.pump(transfer, (step, done) => wrapper.fastPut(local, remote, { step }, done))
    } catch (err) {
      this.fail(transfer, err)
      throw err
    }
  }

  /** One remote file down, with the same record and progress as an upload.
   *  `name` overrides the displayed name for the temp file 打包下载 pulls. */
  private async getOne(sessionId: string, remote: string, local: string, name = basename(local)): Promise<void> {
    const wrapper = await this.sftp(sessionId)
    const size = await new Promise<number>((resolve) =>
      wrapper.stat(remote, (err, attrs) => resolve(err ? 0 : attrs.size))
    )
    mkdirSync(dirname(local), { recursive: true })
    const transfer = this.track(sessionId, 'download', local, remote, size, name)
    try {
      await this.pump(transfer, (step, done) => wrapper.fastGet(remote, local, { step }, done))
    } catch (err) {
      this.fail(transfer, err)
      throw err
    }
  }

  private track(
    sessionId: string,
    direction: Transfer['direction'],
    local: string,
    remote: string,
    size: number,
    name = basename(local)
  ): Transfer {
    const transfer: Transfer = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      direction,
      local,
      name,
      remote,
      size,
      transferred: 0,
      state: 'active'
    }
    this.transfers.set(transfer.id, transfer)
    this.emit({ type: 'transfer', sessionId, transfer: { ...transfer } })
    return transfer
  }

  /** Runs one fastPut/fastGet, posting progress. ssh2 only calls `step` every
   *  ~32KB, so the IPC is throttled to ~10/s per file. */
  private pump(
    transfer: Transfer,
    run: (step: (n: number) => void, done: (err?: Error | null) => void) => void
  ): Promise<void> {
    let lastPost = 0
    return new Promise<void>((resolve, reject) => {
      run(
        (n) => {
          transfer.transferred = n
          const now = Date.now()
          if (now - lastPost < 100 && n < transfer.size) return
          lastPost = now
          this.emit({ type: 'transfer', sessionId: transfer.sessionId, transfer: { ...transfer } })
        },
        (err) => {
          if (err) return reject(err)
          transfer.transferred = transfer.size
          transfer.state = 'done'
          this.emit({ type: 'transfer', sessionId: transfer.sessionId, transfer: { ...transfer } })
          resolve()
        }
      )
    })
  }

  private fail(transfer: Transfer, err: unknown): void {
    transfer.state = 'failed'
    transfer.error = (err as Error).message
    this.emit({ type: 'transfer', sessionId: transfer.sessionId, transfer: { ...transfer } })
  }
}
