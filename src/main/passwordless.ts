import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client, utils } from 'ssh2'
import type { Connection, PasswordlessResult } from '../shared/types'
import { hostKey, keySecretOf, rememberHostKey, secretOf } from './store'
import { bindAddress } from './localnet'
import { installCommand, sshConfigWith } from './sshconfig'

/** Where the generated key lives. `ssh` also reads it through IdentityFile in
 *  the config block, and the user can find it without digging into app data. */
export const localKeyPath = (): string => join(homedir(), '.ssh', 'liteshell_ed25519')

function ensureKey(): { path: string; publicKey: string } {
  const path = localKeyPath()
  const pubPath = `${path}.pub`
  if (existsSync(path) && existsSync(pubPath)) {
    return { path, publicKey: readFileSync(pubPath, 'utf8').trim() }
  }
  mkdirSync(join(homedir(), '.ssh'), { recursive: true })
  const pair = utils.generateKeyPairSync('ed25519')
  // No passphrase: plain `ssh <host>` has to work without an agent or prompt.
  writeFileSync(path, pair.private, { mode: 0o600 })
  const publicKey = `${pair.public.trim()} liteshell`
  writeFileSync(pubPath, `${publicKey}\n`, { mode: 0o644 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows: icacls below is the one that matters.
  }
  if (process.platform === 'win32') {
    // OpenSSH for Windows refuses keys readable by anyone but the owner. A file
    // created by Node inherits the profile ACL, so tighten it explicitly.
    spawnSync(
      'icacls',
      [path, '/inheritance:r', '/grant:r', `${process.env.USERNAME ?? ''}:F`],
      { stdio: 'ignore' }
    )
  }
  return { path, publicKey }
}

function verifier(conn: Connection): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fingerprint =
      'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
    const known = hostKey(conn.id)
    if (!known) {
      rememberHostKey(conn, fingerprint)
      return true
    }
    return known === fingerprint
  }
}

/** One-off connection with the same auth rules as a session. `identity` is the
 *  freshly installed key, used to prove it actually works. */
function connect(conn: Connection, secret?: string, identity?: Buffer): Promise<Client> {
  const opts: Parameters<Client['connect']>[0] = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    readyTimeout: 20_000,
    ...(bindAddress(conn) ? { localAddress: bindAddress(conn) } : {}),
    hostVerifier: verifier(conn)
  }

  if (identity) {
    opts.privateKey = identity
  } else if (conn.authType === 'password') {
    opts.password =
      secret ||
      secretOf(conn) ||
      ''
  } else if (conn.authType === 'key') {
    if (!conn.privateKeyPath || !existsSync(conn.privateKeyPath)) {
      return Promise.reject(new Error(`私钥文件不存在: ${conn.privateKeyPath ?? '(未设置)'}`))
    }
    opts.privateKey = readFileSync(conn.privateKeyPath)
    const passphrase =
      secret || secretOf(conn) || keySecretOf(conn.privateKeyPath)
    if (passphrase) opts.passphrase = passphrase
  } else {
    opts.agent = conn.agentSocket || process.env.SSH_AUTH_SOCK
  }

  return new Promise<Client>((resolve, reject) => {
    const client = new Client()
    let settled = false
    client.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    client.once('ready', () => {
      settled = true
      resolve(client)
    })
    client.connect(opts)
  })
}

function exec(
  client: Client,
  command: string,
  timeoutMs = 20_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let code = -1
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ stdout, stderr, code })
      }
      stream.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      stream.on('exit', (c: number | null) => {
        if (typeof c === 'number') code = c
      })
      stream.on('close', (c: number | null) => {
        if (typeof c === 'number') code = c
        finish()
      })
      const timer = setTimeout(() => {
        try {
          stream.close()
        } catch {
          // already gone
        }
        finish()
      }, timeoutMs)
    })
  })
}

function updateSshConfig(conn: Connection, alias: string): string {
  const dir = join(homedir(), '.ssh')
  const file = join(dir, 'config')
  mkdirSync(dir, { recursive: true })
  const old = existsSync(file) ? readFileSync(file, 'utf8') : ''
  // Only a pinned address goes into the file. An interface's address would be
  // frozen at today's lease, and plain `ssh` has no port of ours to resolve it
  // again — a stale BindAddress there fails every login after a reconnect.
  writeFileSync(file, sshConfigWith(old, { ...conn, alias }), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows ACLs under the user profile are already restrictive enough.
  }
  return file
}

/**
 * Generates (once) a local key, installs it on the server, proves a key-only
 * login works, then points the local ssh config at it. Any step can throw; the
 * key is only written into `config` after the server accepted it.
 */
export async function setupPasswordless(
  conn: Connection,
  secret?: string,
  alias = conn.host
): Promise<PasswordlessResult> {
  const key = ensureKey()

  const first = await connect(conn, secret)
  let added = false
  try {
    const result = await exec(first, installCommand(key.publicKey))
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `写入 authorized_keys 失败（退出码 ${result.code}）`
      )
    }
    added = result.stdout.includes('added')
  } finally {
    first.end()
  }

  // Installing a key is not the same as being allowed to use it: sshd may have
  // `PubkeyAuthentication no`. Log in with only the new key before claiming it works.
  const check = await connect(conn, undefined, readFileSync(key.path))
  try {
    const result = await exec(check, 'true')
    if (result.code !== 0) {
      throw new Error(
        '公钥已经写入服务器，但用新密钥登录失败（服务器可能禁用了 PubkeyAuthentication）'
      )
    }
  } finally {
    check.end()
  }

  const configPath = updateSshConfig(conn, alias)
  return {
    alias,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    keyPath: key.path,
    configPath,
    added
  }
}
