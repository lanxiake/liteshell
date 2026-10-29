import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { app } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import type {
  Connection,
  DesktopEmbedded,
  DesktopEmbeddedInfo,
  DesktopLaunch
} from '../shared/types'
import { startRDCleanPathProxy } from './rdp/rdcleanpath'
import { checkHostKey, connectOptions } from './ssh'
import { store } from './store'

/** Where the desktop service listens **on the remote machine**. The tunnel is
 *  the only thing that reaches it; nothing is exposed on the local network. */
const RDP_HOST = '127.0.0.1'
const DEFAULT_RDP_PORT = 3389

interface Tunnel {
  id: string
  localPort: number
  server: Server
  client: Client
  sockets: Set<Socket>
}

/** One embedded desktop: the SSH connection, the RDCleanPath proxy, and what
 *  the dedicated window needs to attach. The password lives here until the
 *  window closes and is never written to disk. */
interface Embedded {
  id: string
  name: string
  connectionId: string
  url: string
  username: string
  password: string
  port: number
  client: Client
  proxy: { close(): void }
}

/**
 * Opens a `direct-tcpip` channel to the remote's RDP service and listens on a
 * random loopback port. The system RDP client connects to that port, so the
 * desktop never has to be reachable from the network — only sshd is.
 *
 * The tunnel owns the external client process: when it exits, the listener and
 * the SSH connection go with it.
 */
export class DesktopManager {
  private tunnels = new Map<string, Tunnel>()
  private embedded = new Map<string, Embedded>()

  async open(
    connectionId: string,
    opts: { port?: number; username?: string; secret?: string }
  ): Promise<DesktopLaunch> {
    const conn = store().connections.find((c) => c.id === connectionId)
    if (!conn) throw new Error(`未知连接: ${connectionId}`)

    const port = clampPort(opts.port ?? conn.rdpPort ?? DEFAULT_RDP_PORT)
    const username = (opts.username ?? conn.rdpUsername ?? conn.username).trim()
    const tunnel = await this.openTunnel(conn, port, opts.secret)

    try {
      const launched = await launchClient(tunnel.localPort, username, () =>
        this.close(tunnel.id)
      )
      return {
        tunnelId: tunnel.id,
        localPort: tunnel.localPort,
        client: launched.client,
        rdpFile: launched.rdpFile
      }
    } catch (err) {
      this.close(tunnel.id)
      throw err
    }
  }

  /**
   * Starts the embedded client: an SSH connection, then a local RDCleanPath
   * WebSocket proxy the WASM client talks to. The proxy terminates TLS because
   * the browser-side client cannot; the SSH host key is what authenticates the
   * machine, so the RDP certificate is accepted after being logged.
   */
  async openEmbedded(
    connectionId: string,
    opts: { port?: number; username?: string; password?: string; secret?: string }
  ): Promise<DesktopEmbedded> {
    const conn = store().connections.find((c) => c.id === connectionId)
    if (!conn) throw new Error(`未知连接: ${connectionId}`)

    const port = clampPort(opts.port ?? conn.rdpPort ?? DEFAULT_RDP_PORT)
    const username = (opts.username ?? conn.rdpUsername ?? conn.username).trim()
    const client = await connectClient(conn, opts.secret)

    let proxy: { close(): void; url: string }
    try {
      // The vendored module is plain JavaScript, so its inferred signature is
      // narrower than the functions actually passed here.
      const startProxy = startRDCleanPathProxy as unknown as (
        openUpstream: (destination: string, signal: AbortSignal) => Promise<Duplex>,
        checkCertificate: (
          fingerprint: string,
          valid: boolean,
          reason: string,
          details: unknown
        ) => Promise<void>,
        log: (line: string) => void,
        options: Record<string, unknown>
      ) => Promise<{ url: string; close(): void }>
      proxy = await startProxy(
        (_destination, signal) => forwardTo(client, port, signal),
        async (fingerprint) => {
          console.log(`[rdp] ${conn.name} 服务器证书 ${fingerprint}（SSH 主机密钥已认证）`)
        },
        (line) => console.log(`[rdp] ${conn.name} ${line}`),
        {
          // GNOME uses NLA; xrdp often doesn't. The password travels inside the
          // SSH tunnel in both cases, so a server without NLA is allowed.
          autologon: true,
          withoutNla: async () => undefined,
          handshakeTimeoutMs: 45_000
        }
      )
    } catch (err) {
      client.end()
      throw err
    }

    const id = `e${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    this.embedded.set(id, {
      id,
      name: conn.name,
      connectionId,
      url: proxy.url,
      username,
      password: opts.password ?? '',
      port,
      client,
      proxy
    })
    // The SSH link dropping ends the desktop: the proxy closes, and the window
    // sees its WebSocket go away. `closeEmbedded` takes the entry out first, so
    // the `close` it causes finds nothing and stops there.
    client.on('close', () => {
      proxy.close()
      this.closeEmbedded(id)
    })
    client.on('error', (err: Error) => console.log(`[rdp] ${conn.name} SSH: ${err.message}`))
    return { id, name: conn.name }
  }

  /** What the dedicated window needs to start the WASM client. */
  attachEmbedded(id: string): DesktopEmbeddedInfo | null {
    const entry = this.embedded.get(id)
    if (!entry) return null
    return {
      id: entry.id,
      name: entry.name,
      url: entry.url,
      username: entry.username,
      password: entry.password,
      port: entry.port
    }
  }

  /** Closes an embedded desktop. Safe to call more than once. */
  closeEmbedded(id: string): void {
    const entry = this.embedded.get(id)
    if (!entry) return
    this.embedded.delete(id)
    entry.proxy.close()
    entry.client.end()
  }

  /** Closes a tunnel early. Safe to call more than once. */
  close(id: string): void {
    const tunnel = this.tunnels.get(id)
    if (!tunnel) return
    this.tunnels.delete(id)
    for (const socket of tunnel.sockets) socket.destroy()
    tunnel.sockets.clear()
    tunnel.server.close()
    tunnel.client.end()
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id)
    for (const id of [...this.embedded.keys()]) this.closeEmbedded(id)
  }

  private openTunnel(conn: Connection, port: number, secret?: string): Promise<Tunnel> {
    const client = new Client()
    const id = `d${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

    // `hostVerifier` is synchronous, so the reason a key was refused has to be
    // remembered here to become a readable error below.
    let hostChanged = false
    let hostFingerprint = ''
    let lastLog = ''
    const opts = connectOptions(
      conn,
      secret,
      (key: Buffer) =>
        checkHostKey(conn, key, (info) => {
          hostChanged = info.changed
          hostFingerprint = info.fingerprint
        }),
      (_level, text) => {
        lastLog = text
      }
    )

    return new Promise<Tunnel>((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        client.end()
        reject(
          hostChanged
            ? new Error(`主机密钥已改变（${hostFingerprint}），已拒绝连接`)
            : err
        )
      }

      client.on('error', (err: Error) => {
        if (!settled) {
          fail(err)
          return
        }
        // The link can drop while the desktop is open; take the listener down
        // so the client sees a closed connection instead of a dead port.
        this.close(id)
      })
      client.on('close', () => {
        if (!settled) {
          fail(new Error(lastLog || 'SSH 连接在建立隧道前关闭'))
          return
        }
        this.close(id)
      })

      client.once('ready', () => {
        const sockets = new Set<Socket>()
        const server = createServer((socket) => {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
          client.forwardOut('127.0.0.1', 0, RDP_HOST, port, (err, channel) => {
            if (err) {
              socket.destroy()
              return
            }
            pipeBoth(socket, channel)
          })
        })
        server.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            client.end()
            reject(err)
            return
          }
          this.close(id)
        })
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address === 'string') {
            settled = true
            server.close()
            client.end()
            reject(new Error('无法分配本地端口'))
            return
          }
          settled = true
          const tunnel: Tunnel = { id, localPort: address.port, server, client, sockets }
          this.tunnels.set(id, tunnel)
          resolve(tunnel)
        })
      })

      try {
        client.connect(opts)
      } catch (err) {
        fail(err as Error)
      }
    })
  }
}

/** Authenticates the SSH connection the embedded proxy will ride on. The same
 *  host-key rules as the terminal: a changed key is refused, not passed on. */
function connectClient(conn: Connection, secret: string | undefined): Promise<Client> {
  const client = new Client()
  let hostChanged = false
  let hostFingerprint = ''
  let lastLog = ''
  const opts = connectOptions(
    conn,
    secret,
    (key: Buffer) =>
      checkHostKey(conn, key, (info) => {
        hostChanged = info.changed
        hostFingerprint = info.fingerprint
      }),
    (_level, text) => {
      lastLog = text
    }
  )

  return new Promise<Client>((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      client.end()
      reject(
        hostChanged ? new Error(`主机密钥已改变（${hostFingerprint}），已拒绝连接`) : err
      )
    }
    client.on('error', fail)
    client.on('close', () => fail(new Error(lastLog || 'SSH 连接在建立桌面隧道前关闭')))
    client.once('ready', () => {
      settled = true
      // The proxy owns the stream from here on; the close listener attached by
      // `openEmbedded` is what tears the desktop down.
      resolve(client)
    })
    try {
      client.connect(opts)
    } catch (err) {
      fail(err as Error)
    }
  })
}

/** The RDCleanPath proxy asks for a raw stream to the server; that stream is
 *  an SSH direct-tcpip channel to the remote's loopback. */
function forwardTo(client: Client, port: number, signal: AbortSignal): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('客户端已离开'))
      return
    }
    client.forwardOut('127.0.0.1', 0, RDP_HOST, port, (err, channel) => {
      if (err) {
        reject(new Error(`转发到远端 ${RDP_HOST}:${port} 失败：${err.message}`))
        return
      }
      if (signal.aborted) {
        channel.destroy()
        reject(new Error('客户端已离开'))
        return
      }
      resolve(channel as unknown as Duplex)
    })
  })
}

/** Copies bytes in both directions and tears the pair down together. */
function pipeBoth(socket: Socket, channel: ClientChannel): void {
  socket.on('error', () => channel.destroy())
  channel.on('error', () => socket.destroy())
  socket.on('close', () => channel.destroy())
  channel.on('close', () => socket.destroy())
  socket.pipe(channel).pipe(socket)
}

function clampPort(value: number): number {
  const port = Math.trunc(Number(value))
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`RDP 端口无效: ${value}`)
  }
  return port
}

interface LaunchResult {
  client: string
  rdpFile?: string
}

/**
 * Writes the temporary `.rdp` file. It carries only the address and the
 * login; the password is asked for by the client, as it is with any other
 * `mstsc` launch. `authentication level:i:2` keeps the certificate warning —
 * the tunnel is authenticated, but the name on a 127.0.0.1 connection is not
 * the server's, and silently skipping that check is not ours to decide.
 */
function writeRdpFile(port: number, username: string): string {
  const lines = [
    `full address:s:127.0.0.1:${port}`,
    'prompt for credentials:i:1',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    'redirectclipboard:i:1',
    'audiomode:i:0',
    'screen mode id:i:2',
    'use multimon:i:0'
  ]
  if (username) lines.push(`username:s:${username}`)
  const file = join(
    app.getPath('temp'),
    `liteshell-rdp-${randomBytes(4).toString('hex')}.rdp`
  )
  writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
  return file
}

function removeQuietly(file: string | undefined): void {
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    // A temp file that outlives the session is harmless.
  }
}

/**
 * Starts the platform's RDP client and resolves once it is running. `onExit`
 * fires whenever the process goes away, which is what closes the tunnel.
 */
async function launchClient(
  localPort: number,
  username: string,
  onExit: () => void
): Promise<LaunchResult> {
  if (process.platform === 'win32') return launchWindows(localPort, username, onExit)
  if (process.platform === 'darwin') return launchMac(localPort, username, onExit)
  return launchLinux(localPort, username, onExit)
}

function launchWindows(
  localPort: number,
  username: string,
  onExit: () => void
): Promise<LaunchResult> {
  const rdpFile = writeRdpFile(localPort, username)
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mstsc.exe')
  return spawnWatched(exe, [rdpFile], () => removeQuietly(rdpFile), onExit).then(() => ({
    client: 'mstsc',
    rdpFile
  }))
}

function launchMac(
  localPort: number,
  username: string,
  onExit: () => void
): Promise<LaunchResult> {
  const rdpFile = writeRdpFile(localPort, username)
  // `open -Ra` checks that the app exists without launching it. Newer Microsoft
  // clients are called "Windows App"; older ones "Microsoft Remote Desktop".
  const candidates = ['Windows App', 'Microsoft Remote Desktop']
  const app = candidates.find((name) => spawnSync('open', ['-Ra', name]).status === 0)
  if (!app) {
    removeQuietly(rdpFile)
    return Promise.reject(
      new Error('未找到 Windows App / Microsoft Remote Desktop，请先从 App Store 安装')
    )
  }
  return spawnWatched('open', ['-W', '-a', app, rdpFile], () => removeQuietly(rdpFile), onExit).then(
    () => ({ client: app, rdpFile })
  )
}

function launchLinux(
  localPort: number,
  username: string,
  onExit: () => void
): Promise<LaunchResult> {
  const freerdp = findCommand('xfreerdp3') ?? findCommand('xfreerdp')
  if (freerdp) {
    const args = [
      `/v:127.0.0.1:${localPort}`,
      '+clipboard',
      '/dynamic-resolution',
      // The server's certificate names the real host, not 127.0.0.1; the SSH
      // tunnel already authenticated the machine, so trust it on first use.
      '/cert:tofu'
    ]
    if (username) args.push(`/u:${username}`)
    return spawnWatched(freerdp, args, () => undefined, onExit).then(() => ({
      client: 'xfreerdp'
    }))
  }

  const remmina = findCommand('remmina')
  if (remmina) {
    const target = username
      ? `rdp://${encodeURIComponent(username)}@127.0.0.1:${localPort}`
      : `rdp://127.0.0.1:${localPort}`
    return spawnWatched(remmina, ['-c', target], () => undefined, onExit).then(() => ({
      client: 'remmina'
    }))
  }

  return Promise.reject(
    new Error('未找到 RDP 客户端。请安装 FreeRDP（sudo apt install freerdp2-x11）或 Remmina')
  )
}

/** Resolves once the process is up; cleanup runs on both failure and exit. */
function spawnWatched(
  command: string,
  args: string[],
  cleanup: () => void,
  onExit: () => void
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let spawned = false
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      cleanup()
      onExit()
    }

    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('spawn', () => {
      spawned = true
      resolve(child)
    })
    child.once('error', (err) => {
      if (!spawned) {
        finished = true
        cleanup()
        reject(err)
        return
      }
      finish()
    })
    // `close` follows `exit` and covers a process that never emitted `exit`.
    child.once('exit', finish)
    child.once('close', finish)
  })
}

/** A bare command on PATH, without going through a shell. */
function findCommand(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const path = join(dir, name)
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // not in this directory
    }
  }
  return null
}
