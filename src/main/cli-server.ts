import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { Connection, SessionEvent, SessionStatus } from '../shared/types'
import { store } from './store'
import type { SshManager } from './ssh'

/**
 * Lets an agent drive this app instead of opening its own SSH client.
 *
 * Everything hard about connecting already lives in the main process — credentials
 * sealed by the OS keychain, known hosts, a live session with a real tab on screen —
 * so the CLI is a thin client over a local socket rather than a second SSH stack that
 * would have to be told the passwords all over again.
 *
 * Protocol: one JSON line in, one JSON line out, then the socket closes.
 */

/** The CLI is a plain node script with no idea where Electron puts userData, so the
 *  address and the token meet it half way. The token is the actual gate; the pipe
 *  name is just where to knock.
 *
 *  One address per machine is right for real users — one app, one CLI. A tag keeps
 *  a second instance (a test run with its own profile) from stealing that address. */
const TAG = (process.env.LITESHELL_CLI_TAG ?? '').replace(/[^\w-]/g, '')
const NAME = `liteshell-cli${TAG ? `-${TAG}` : ''}`
const DISCOVERY = join(tmpdir(), `${NAME}.json`)
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\${NAME}` : join(tmpdir(), `${NAME}.sock`)

/** One reply, one line. Past this the caller wanted a file, not a command — it
 *  should use get instead of catting a 2 GB log into an agent's context. */
const MAX_OUT = 200_000

/** The shape every failure takes, matching the rest of this machine's tooling:
 *  a code to branch on, a stage to say where it broke, and what to do next. */
type Err = {
  ok: false
  detail: string
  error_code: string
  stage: string
  suggestion: string
  [key: string]: unknown
}

function fail(error_code: string, stage: string, detail: string, suggestion: string): Err {
  return { ok: false, error_code, stage, detail, suggestion }
}

export type Req = {
  token?: string
  op?: string
  conn?: string
  cmd?: string
  path?: string
  to?: string
  dir?: string
  paths?: string[]
  isDir?: boolean
  timeout?: number
  /** Run on this session instead of one of our own. The AI panel passes the tab
   *  the user is already looking at, so a conversation does not open a second
   *  one — and so the agent's commands share the connection the user is paying
   *  for rather than opening another handshake. */
  sessionId?: string
}

function clampTimeout(v: number | undefined): number {
  if (!v || v <= 0) return 120_000
  return Math.min(v, 3_600_000)
}

/** Name first — that is what the agent was told, and ids are for machines. */
function findConn(key: string): { conn: Connection } | { err: Err } {
  const all = store().connections
  const byId = all.find((c) => c.id === key)
  if (byId) return { conn: byId }
  const hits = all.filter((c) => c.name === key)
  if (hits.length === 1) return { conn: hits[0] }
  const names = all.map((c) => c.name)
  if (!hits.length) {
    return {
      err: {
        ...fail('unknown_connection', 'input', `没有叫「${key}」的连接`, '先跑 liteshell-cli conns 看有哪些可用连接'),
        connections: names
      }
    }
  }
  // Same trap as every other name-resolving tool here: two connections with one
  // name is not a reason to guess which machine gets written to.
  return {
    err: {
      ...fail('ambiguous_connection', 'input', `有 ${hits.length} 个连接都叫「${key}」`, '改用 conns 返回的 id 指定连接'),
      candidates: hits.map((c) => ({ id: c.id, host: c.host, username: c.username }))
    }
  }
}

export class CliServer {
  private server: Server | null = null
  private readonly token = randomBytes(24).toString('base64url')
  /** connectionId -> sessionId: one SSH connection per profile, reused by every
   *  call, so a run of commands pays the handshake once. */
  private live = new Map<string, string>()
  private status = new Map<string, SessionStatus>()
  private lastError = new Map<string, string>()
  /** Sessions whose host key failed the check, so the refusal can be reported as a
   *  refusal instead of a generic handshake failure. */
  private refused = new Set<string>()
  private waiters = new Map<string, (s: SessionStatus) => void>()

  constructor(
    private manager: SshManager,
    private openTab: (connectionId: string, sessionId: string) => void
  ) {}

  /** Fed the same events the renderer sees, so the CLI can tell a live session from
   *  one the user just closed the tab on. */
  onEvent(ev: SessionEvent): void {
    if (ev.type === 'status') {
      this.status.set(ev.sessionId, ev.status)
      if (ev.error) this.lastError.set(ev.sessionId, ev.error)
      if (ev.status === 'ready' || ev.status === 'error' || ev.status === 'closed') {
        this.waiters.get(ev.sessionId)?.(ev.status)
        this.waiters.delete(ev.sessionId)
      }
      return
    }
    if (ev.type === 'hostkey' && ev.changed) this.refused.add(ev.sessionId)
  }

  listen(): void {
    if (process.platform !== 'win32') {
      try {
        unlinkSync(PIPE)
      } catch {
        // no stale socket
      }
    }
    this.server = createServer((sock) => this.accept(sock))
    // A second instance losing the race for the pipe is not a failure: the first
    // one is the app the CLI should be talking to. Deliberately does not write the
    // discovery file — that would hand out a token the live socket rejects.
    this.server.on('error', () => undefined)
    this.server.listen(PIPE, () => {
      writeFileSync(
        DISCOVERY,
        JSON.stringify({ pipe: PIPE, token: this.token, pid: process.pid }, null, 2),
        { mode: 0o600 }
      )
    })
  }

  close(): void {
    this.server?.close()
    this.server = null
    for (const f of process.platform === 'win32' ? [DISCOVERY] : [DISCOVERY, PIPE]) {
      try {
        unlinkSync(f)
      } catch {
        // already gone
      }
    }
  }

  private accept(sock: Socket): void {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('error', () => sock.destroy())
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      sock.removeAllListeners('data')

      let req: Req
      try {
        req = JSON.parse(buf.slice(0, nl)) as Req
      } catch {
        sock.end(JSON.stringify(fail('bad_args', 'input', '请求不是合法 JSON', '这是内部协议，用 liteshell-cli 脚本发请求')) + '\n')
        return
      }
      void this.run(req)
        .then((res) => sock.end(JSON.stringify(res) + '\n'))
        .catch((err: Error) =>
          sock.end(JSON.stringify(fail('internal_error', 'cli', err.message, '看起来是 LiteShell 的 bug，把这条消息报告出来')) + '\n')
        )
    })
  }

  /** Ctrl-C on a session's prompt: the AI panel's stop button reaches the
   *  command through here, now that commands run where the user can see them. */
  interrupt(sessionId: string): void {
    this.manager.interrupt(sessionId)
  }

  private async run(req: Req): Promise<unknown> {
    if (req.token !== this.token) {
      return fail('bad_token', 'auth', '令牌不匹配', '令牌是 LiteShell 启动时写入的；如果刚重启过它，重试一次即可')
    }
    return this.dispatch(req)
  }

  /**
   * The operations themselves, with no token check — the AI panel is already
   * inside the process, so making it fetch its own credential would only be a
   * second place for that credential to leak.
   *
   * `clipAt` exists for that same caller: it spills long output to a file and
   * needs the whole thing to spill, not the first 200 KB of it.
   */
  async dispatch(req: Req, clipAt = MAX_OUT): Promise<unknown> {
    const clip = (s: string): string => (s.length > clipAt ? s.slice(0, clipAt) : s)
    if (!req.op) return fail('bad_args', 'input', '缺少 op', '用 liteshell-cli 脚本，别手搓协议')

    if (req.op === 'conns') {
      const s = store()
      return {
        ok: true,
        connections: s.connections.map((c) => ({
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          username: c.username,
          authType: c.authType,
          folder: s.folders.find((f) => f.id === c.folderId)?.name ?? null,
          // Whether a password is on file is the agent's business; the password is not.
          hasSecret: !!c.secret
        }))
      }
    }

    if (!req.conn) return fail('bad_args', 'input', '缺少连接名', '用法：liteshell-cli <op> <连接名> …')
    const found = findConn(req.conn)
    if ('err' in found) return found.err
    const conn = found.conn

    if (req.op === 'close') {
      const sid = this.live.get(conn.id)
      this.live.delete(conn.id)
      if (sid) this.manager.disconnect(sid)
      return { ok: true, closed: !!sid }
    }

    const session = await this.session(conn, req.sessionId)
    if (typeof session !== 'string') return session

    let stage = 'transfer'
    try {
      switch (req.op) {
        // `exec` runs on a channel of its own; `shell` types the same command
        // into the terminal the user is looking at, which is what the AI panel
        // wants — they should watch it happen, not read about it afterwards.
        case 'exec':
        case 'shell': {
          stage = 'exec'
          if (!req.cmd) return fail('bad_args', 'input', '缺少命令', '用法：liteshell-cli exec <连接名> <命令>')
          const t0 = Date.now()
          const r =
            req.op === 'shell'
              ? await this.manager.execInShell(session, req.cmd, clampTimeout(req.timeout))
              : await this.manager.exec(session, req.cmd, clampTimeout(req.timeout))
          const ms = Date.now() - t0
          this.audit(conn, req.op, req.cmd, r.code, ms)
          if (r.timedOut) {
            // Partial output gets its own field: a half-read log must not be mistaken
            // for the whole answer.
            return {
              ...fail(
                'timeout',
                'exec',
                req.op === 'shell'
                  ? `命令跑了 ${Math.round(ms / 1000)} 秒还没结束，已经往终端里按了 Ctrl-C`
                  : `命令跑了 ${Math.round(ms / 1000)} 秒还没结束，已掐断这个通道`,
                '远端进程可能还在跑；长任务用 nohup/setsid 丢到后台，或调大 --timeout'
              ),
              partial_stdout: clip(r.stdout),
              partial_stderr: clip(r.stderr)
            }
          }
          return {
            ok: true,
            stdout: clip(r.stdout),
            stderr: clip(r.stderr),
            code: r.code,
            ms,
            truncated: r.stdout.length > MAX_OUT || r.stderr.length > MAX_OUT
          }
        }

        case 'monitor':
          return { ok: true, snapshot: await this.manager.monitor(session) }

        case 'ls':
          return { ok: true, entries: await this.manager.list(session, req.path || '.') }

        case 'cat': {
          if (!req.path) return fail('bad_args', 'input', '缺少远端路径', '用法：liteshell-cli cat <连接名> <远端路径>')
          const r = await this.manager.readText(session, req.path)
          if (r.kind === 'binary') {
            return fail('binary_file', 'transfer', `${req.path} 不是文本文件：${r.reason}`, '用 get 下到本地再看')
          }
          return { ok: true, text: r.text, size: r.size, mtime: r.mtime }
        }

        case 'put': {
          if (!req.paths?.length || !req.dir) {
            return fail('bad_args', 'input', '缺少本地路径或远端目录', '用法：liteshell-cli put <连接名> <本地路径…> <远端目录>')
          }
          const written = await this.manager.upload(session, req.paths, req.dir)
          this.audit(conn, 'put', `${req.paths.join(' ')} -> ${req.dir}`, 0, 0)
          return { ok: true, written }
        }

        case 'get': {
          if (!req.path || !req.dir) {
            return fail('bad_args', 'input', '缺少远端路径或本地目录', '用法：liteshell-cli get <连接名> <远端路径> <本地目录> [--isDir]')
          }
          const written = await this.manager.download(session, req.path, req.dir, !!req.isDir)
          this.audit(conn, 'get', `${req.path} -> ${req.dir}`, 0, 0)
          return { ok: true, written }
        }

        case 'rm': {
          if (!req.path) return fail('bad_args', 'input', '缺少远端路径', '用法：liteshell-cli rm <连接名> <远端路径> [--isDir]')
          await this.manager.remove(session, req.path, !!req.isDir)
          this.audit(conn, 'rm', req.path, 0, 0)
          return { ok: true }
        }

        case 'mkdir': {
          if (!req.path) return fail('bad_args', 'input', '缺少远端路径', '用法：liteshell-cli mkdir <连接名> <远端路径>')
          await this.manager.mkdir(session, req.path)
          this.audit(conn, 'mkdir', req.path, 0, 0)
          return { ok: true }
        }

        case 'mv': {
          if (!req.path || !req.to) {
            return fail('bad_args', 'input', '缺少源或目标路径', '用法：liteshell-cli mv <连接名> <源> <目标>')
          }
          await this.manager.rename(session, req.path, req.to)
          this.audit(conn, 'mv', `${req.path} -> ${req.to}`, 0, 0)
          return { ok: true }
        }

        default:
          return fail('bad_args', 'input', `不认识的动作 ${req.op}`, '跑 liteshell-cli --help 看支持哪些')
      }
    } catch (err) {
      this.audit(conn, req.op, `失败`, -1, 0)
      return fail('sftp_error', stage, (err as Error).message, '检查远端路径是否存在、权限够不够')
    }
  }

  /** The session a request runs on: the caller's own if it named one, otherwise
   *  one opened here and kept warm for the next call. */
  private async session(conn: Connection, preferred?: string): Promise<string | Err> {
    if (preferred && this.manager.has(preferred)) return preferred
    const alive = this.live.get(conn.id)
    if (alive) {
      const st = this.status.get(alive)
      // A tab the user closed, or a link that dropped, must not be reported as a
      // working session — reconnect instead of failing the command.
      if (this.manager.has(alive) && st !== 'error' && st !== 'closed') return alive
      this.live.delete(conn.id)
    }

    // A password the app does not hold is a prompt nobody is there to answer.
    if (conn.authType === 'password' && !conn.secret) {
      return fail(
        'needs_password',
        'connect',
        `${conn.name} 用密码认证，但 LiteShell 里没有已保存的密码`,
        '在 LiteShell 界面里手动连一次这个连接并保存密码，再让 agent 重试'
      )
    }
    // Same class of dead end, and the one FinalShell imports land in: the profile
    // says "key" but points at no file, so every attempt fails at the handshake
    // with a message that reads like a network problem.
    if (conn.authType === 'key' && (!conn.privateKeyPath || !existsSync(conn.privateKeyPath))) {
      return fail(
        'needs_key',
        'connect',
        `${conn.name} 用密钥认证，但${conn.privateKeyPath ? `私钥文件不存在：${conn.privateKeyPath}` : '没指定私钥文件'}`,
        '在 LiteShell 里编辑这个连接，从私钥库里选一把密钥'
      )
    }

    const sessionId = `cli-${conn.id}-${Date.now().toString(36)}`
    const ready = new Promise<SessionStatus>((resolve) => this.waiters.set(sessionId, resolve))
    this.manager.connect(conn.id, sessionId, 100, 30)
    this.openTab(conn.id, sessionId)

    const status: SessionStatus | 'timeout' = await Promise.race([
      ready,
      new Promise<SessionStatus | 'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25_000))
    ])
    this.waiters.delete(sessionId)

    if (status !== 'ready') {
      const reason = this.lastError.get(sessionId)
      const changed = this.refused.delete(sessionId)
      this.manager.disconnect(sessionId)
      this.status.delete(sessionId)
      this.lastError.delete(sessionId)
      if (changed) {
        return fail(
          'host_key_changed',
          'connect',
          `${conn.name} 的主机密钥和 LiteShell 记下的不一样，已拒绝连接`,
          '先在 LiteShell 界面里人工确认这台机器是不是换了密钥；确认无误后手动连一次让新指纹被记下'
        )
      }
      return fail(
        'connect_failed',
        'connect',
        `连不上 ${conn.name}：${reason ?? (status === 'timeout' ? '25 秒内没能完成握手' : status)}`,
        '确认服务器可达、凭据有效；在 LiteShell 里手动连一次能看到完整握手日志'
      )
    }

    this.live.set(conn.id, sessionId)
    return sessionId
  }

  /** Every command that changes something lands here, so the user can audit what the
   *  agent did without having watched the screen. */
  private audit(conn: Connection, op: string, detail: string, code: number | string, ms: number): void {
    const line = `${new Date().toISOString()}\t${conn.name}\t${op}\tcode=${code}\t${ms}ms\t${detail.slice(0, 500)}\n`
    try {
      appendFileSync(join(app.getPath('userData'), 'cli-audit.log'), line, { mode: 0o600 })
    } catch {
      // A log we cannot write must not fail a command that already ran.
    }
  }
}
