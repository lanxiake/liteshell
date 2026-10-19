#!/usr/bin/env node
/**
 * Thin client for a running LiteShell.
 *
 * It has no SSH code of its own: the app already holds the credentials, the known
 * hosts and a live session with a tab on screen. This just asks it to run things.
 *
 * One JSON object on stdout, always. Exit 0 when ok, 1 when not.
 */
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where LiteShell leaves its socket address and token when it starts. The tag is
 *  only for a second instance that must not be confused with the real one. */
const NAME = `liteshell-cli${process.env.LITESHELL_CLI_TAG ? `-${process.env.LITESHELL_CLI_TAG.replace(/[^\w-]/g, '')}` : ''}`
const DISCOVERY = join(tmpdir(), `${NAME}.json`)

const USAGE = `用法：
  liteshell-cli conns                                列出可用连接
  liteshell-cli exec    <连接> <命令> [--timeout 秒]   跑一条命令
  liteshell-cli monitor <连接>                        资源快照（CPU/内存/磁盘/网络/GPU）
  liteshell-cli ls      <连接> [远端路径]
  liteshell-cli cat     <连接> <远端路径>
  liteshell-cli get     <连接> <远端路径> <本地目录> [--isDir]
  liteshell-cli put     <连接> <本地路径…> <远端目录>
  liteshell-cli rm      <连接> <远端路径> [--isDir]
  liteshell-cli mv      <连接> <源> <目标>
  liteshell-cli mkdir   <连接> <远端路径>
  liteshell-cli close   <连接>

命令里带 --xxx 的时候整条用引号包起来，或者用管道：
  echo 'ls --color=auto /var/log' | liteshell-cli exec web-1 --stdin`

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(obj?.ok ? 0 : 1)
}

function bail(detail, suggestion) {
  out({ ok: false, error_code: 'bad_args', stage: 'cli', detail, suggestion })
}

const BOOL_FLAGS = new Set(['isDir', 'stdin', 'help'])
const VALUE_FLAGS = new Set(['timeout'])

/** Only our own flags are eaten. Anything else starting with -- belongs to the
 *  remote command the user is trying to run. */
function parse(argv) {
  const flags = {}
  const args = []
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][\w-]*)(?:=(.*))?$/.exec(argv[i])
    if (!m) {
      args.push(argv[i])
      continue
    }
    const key = m[1]
    if (BOOL_FLAGS.has(key)) flags[key] = m[2] === undefined ? true : m[2] !== 'false'
    else if (VALUE_FLAGS.has(key)) flags[key] = m[2] ?? argv[++i]
    else args.push(argv[i])
  }
  return { flags, args }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function call(info, req, timeoutMs) {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const done = (res) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(res)
    }

    const sock = connect(info.pipe)
    sock.setEncoding('utf8')
    // The server's own timeout has to fire first, or we would report "no answer"
    // for a command it is still correctly waiting on.
    sock.setTimeout(timeoutMs + 15_000)
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        done(JSON.parse(buf.slice(0, nl)))
      } catch (err) {
        done({
          ok: false,
          error_code: 'bad_response',
          stage: 'cli',
          detail: `LiteShell 回复的不是 JSON：${err.message}`,
          suggestion: 'LiteShell 和这个脚本可能不是同一版本，重新装一遍再试'
        })
      }
    })
    sock.on('timeout', () =>
      done({
        ok: false,
        error_code: 'timeout',
        stage: 'cli',
        detail: '等 LiteShell 回复超时',
        suggestion: '命令可能还在远端跑，别直接重发；先用 exec 查一下状态'
      })
    )
    sock.on('error', (err) =>
      done({
        ok: false,
        error_code: 'app_not_running',
        stage: 'cli',
        detail: `连不上 LiteShell：${err.message}`,
        suggestion: '先把 LiteShell 打开，再重试'
      })
    )
  })
}

const { flags, args } = parse(process.argv.slice(2))
if (flags.help) {
  process.stdout.write(USAGE + '\n')
  process.exit(0)
}

const op = args.shift()
if (!op) {
  process.stdout.write(USAGE + '\n')
  process.exit(1)
}

const [name, ...rest] = args
const req = { op, conn: name }
const timeoutMs = flags.timeout ? Math.max(1, Number(flags.timeout)) * 1000 : 120_000

switch (op) {
  case 'conns':
    delete req.conn
    break

  case 'exec': {
    let cmd = rest.join(' ')
    // A command with quotes or newlines survives stdin intact; argv does not.
    if ((flags.stdin || !cmd.trim()) && !process.stdin.isTTY) cmd = await readStdin()
    if (!cmd.trim()) bail('没有给出要跑的命令', '用法：liteshell-cli exec <连接> <命令>')
    req.cmd = cmd
    req.timeout = timeoutMs
    break
  }

  case 'monitor':
  case 'close':
    break

  case 'ls':
    req.path = rest[0] ?? '.'
    break

  case 'cat':
    if (!rest[0]) bail('没有给出远端路径', '用法：liteshell-cli cat <连接> <远端路径>')
    req.path = rest[0]
    break

  case 'rm':
  case 'mkdir':
    if (!rest[0]) bail('没有给出远端路径', `用法：liteshell-cli ${op} <连接> <远端路径>`)
    req.path = rest[0]
    req.isDir = !!flags.isDir
    break

  case 'mv':
    if (!rest[0] || !rest[1]) bail('缺少源或目标路径', '用法：liteshell-cli mv <连接> <源> <目标>')
    req.path = rest[0]
    req.to = rest[1]
    break

  case 'get':
    if (!rest[0] || !rest[1]) bail('缺少远端路径或本地目录', '用法：liteshell-cli get <连接> <远端路径> <本地目录>')
    req.path = rest[0]
    req.dir = rest[1]
    req.isDir = !!flags.isDir
    break

  case 'put':
    // Last argument is where they land; everything before it is what to send.
    if (rest.length < 2) bail('缺少本地路径或远端目录', '用法：liteshell-cli put <连接> <本地路径…> <远端目录>')
    req.paths = rest.slice(0, -1)
    req.dir = rest[rest.length - 1]
    break

  default:
    // Not the usage text: stdout has to stay one parseable JSON object.
    bail(`不认识的动作 ${op}`, '跑 liteshell-cli --help 看支持哪些动作')
}

if (op !== 'conns' && !req.conn) bail('没有给出连接名', '先跑 liteshell-cli conns 看有哪些连接')

let info = null
try {
  info = JSON.parse(readFileSync(DISCOVERY, 'utf8'))
} catch {
  // Say where it looked: the usual cause is the app never having been started.
  info = null
}
if (!info?.pipe) {
  out({
    ok: false,
    error_code: 'app_not_running',
    stage: 'cli',
    detail: `没找到 LiteShell 的接入点（${DISCOVERY}）`,
    suggestion: '先把 LiteShell 打开再重试'
  })
}

out(await call(info, { token: info.token, ...req }, timeoutMs))
