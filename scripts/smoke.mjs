/**
 * End-to-end smoke test.
 *
 * Starts a throwaway SSH server on 127.0.0.1, launches the built app with a
 * temporary profile that already contains one connection, then drives the real
 * window over the Chrome DevTools Protocol: click the connection in the tree and
 * assert the terminal actually renders the remote banner.
 *
 *   node scripts/smoke.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE } = utils.sftp

const PORT = 2222
const DEBUG_PORT = 9333
/** The stand-in model. Same host, its own port, OpenAI-compatible. */
const LLM_PORT = 9334
/** Where the last (current) breadcrumb points — i.e. the directory on screen. */
const CRUMBS = `document.querySelector('.crumbs .crumb:last-child').dataset.path`
const BANNER = 'SMOKE_READY_42'

/** Canned answer to the monitor's sampling script; the parser has its own unit test. */
const MONITOR_OUTPUT = `@@A
cpu  12345 100 2000 50000 300 0 50 0 0 0
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 500000 400 0 0 0 0 0 0 200000 300 0 0 0 0 0 0
@@B
cpu  12445 100 2010 50200 300 0 50 0 0 0
    lo: 2000 20 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
  eth0: 512000 500 0 0 0 0 0 0 204800 400 0 0 0 0 0 0
@@MEM
MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    4000000 kB
SwapTotal:       2048000 kB
SwapFree:        1015808 kB
@@DISK
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1       41000000  30000000   9000000      77% /
tmpfs            8000000         0   8000000       0% /dev/shm
@@LOAD
0.52 0.58 0.59 1/234 5678
98765.43 1234567.89
@@INFO
hostname=smoke-host
kernel=Linux 5.15.0-91-generic
arch=x86_64
cores=8
cpu= Intel(R) Xeon(R) Platinum 8269CY CPU @ 2.50GHz
os=Ubuntu 22.04.3 LTS
@@GPU
Tesla T4, 37, 1024, 15360, 45
@@END`
let execCount = 0
let connCount = 0
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const work = mkdtempSync(join(tmpdir(), 'liteshell-smoke-'))
const profile = join(work, 'profile')
const sftpRoot = join(work, 'root')
mkdirSync(profile, { recursive: true })
mkdirSync(join(sftpRoot, 'tree', 'a', 'b'), { recursive: true })
writeFileSync(join(sftpRoot, 'hello.txt'), 'hello world')
writeFileSync(join(sftpRoot, 'tree', 'a', 'b', 'deep.txt'), 'deep')

/* ---------------- minimal in-memory SFTP server ---------------- */

/** Map an SFTP absolute path onto the fixture directory, refusing escapes. */
function resolve(p) {
  const full = resolvePath(sftpRoot, String(p ?? '/').replace(/^\/+/, ''))
  if (full !== sftpRoot && !full.startsWith(sftpRoot + sep)) throw new Error('path escape')
  return full
}

function statOf(p) {
  const s = lstatSync(p)
  const isDir = s.isDirectory()
  return {
    mode: (isDir ? 0o040000 : 0o100000) | (s.mode & 0o777),
    size: s.size,
    uid: 0,
    gid: 0,
    atime: Math.floor(s.atimeMs / 1000),
    mtime: Math.floor(s.mtimeMs / 1000)
  }
}

function serveSftp(accept) {
  const sftp = accept()
  const handles = new Map()
  // A counter, not handles.size: handles get removed, and a reused key would
  // hand a new request someone else's open file.
  let nextHandle = 0

  sftp.on('REALPATH', (reqid) => sftp.name(reqid, [{ filename: '/', longname: '/', attrs: statOf(sftpRoot) }]))
  sftp.on('STAT', (reqid, p) => sftp.attrs(reqid, statOf(resolve(p))))
  sftp.on('LSTAT', (reqid, p) => sftp.attrs(reqid, statOf(resolve(p))))
  sftp.on('OPENDIR', (reqid, p) => {
    const key = String(nextHandle++)
    handles.set(key, { path: resolve(p), sent: false })
    sftp.handle(reqid, Buffer.from(key))
  })
  // ssh2's fastPut opens once then writes chunks (possibly out of order when
  // concurrent), so writes must be positional; readFile opens the same way and
  // reads by offset, so the open flags decide whether this truncates.
  sftp.on('OPEN', (reqid, p, flags) => {
    const key = String(nextHandle++)
    const path = resolve(p)
    const writing = (flags & 0x00000002) !== 0
    handles.set(key, { path, fd: openSync(path, writing ? 'w' : 'r') })
    sftp.handle(reqid, Buffer.from(key))
  })
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const slot = handles.get(handle.toString())
    if (!slot?.fd) return sftp.status(reqid, STATUS_CODE.FAILURE)
    writeSync(slot.fd, data, 0, data.length, Number(offset))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('READ', (reqid, handle, offset, length) => {
    const slot = handles.get(handle.toString())
    if (!slot?.fd) return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buf = Buffer.alloc(Number(length))
    const read = readSync(slot.fd, buf, 0, buf.length, Number(offset))
    if (read <= 0) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.data(reqid, buf.subarray(0, read))
  })
  sftp.on('SETSTAT', (reqid, p, attrs) => {
    if (typeof attrs?.mode === 'number') chmodSync(resolve(p), attrs.mode & 0o7777)
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('FSTAT', (reqid, handle) => {
    const slot = handles.get(handle.toString())
    if (!slot) return sftp.status(reqid, STATUS_CODE.FAILURE)
    sftp.attrs(reqid, statOf(slot.path))
  })
  sftp.on('READDIR', (reqid, handle) => {
    const slot = handles.get(handle.toString())
    // The client keeps issuing READDIR until we answer with EOF.
    if (!slot || slot.sent) return sftp.status(reqid, STATUS_CODE.EOF)
    slot.sent = true
    const names = readdirSync(slot.path).map((n) => ({
      filename: n,
      longname: n,
      attrs: statOf(join(slot.path, n))
    }))
    if (names.length) sftp.name(reqid, names)
    else sftp.status(reqid, STATUS_CODE.EOF)
  })
  sftp.on('CLOSE', (reqid, handle) => {
    const slot = handles.get(handle.toString())
    if (slot?.fd !== undefined) closeSync(slot.fd)
    handles.delete(handle.toString())
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('MKDIR', (reqid, p) => {
    mkdirSync(resolve(p))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('RMDIR', (reqid, p) => {
    rmdirSync(resolve(p))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('REMOVE', (reqid, p) => {
    unlinkSync(resolve(p))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('RENAME', (reqid, from, to) => {
    const dst = resolve(to)
    // POSIX rename overwrites; renameSync on Windows refuses an existing target.
    if (existsSync(dst)) unlinkSync(dst)
    renameSync(resolve(from), dst)
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('error', () => {})
}

const { private: hostKey } = utils.generateKeyPairSync('ed25519')
const { private: userKey, public: userPub } = utils.generateKeyPairSync('ed25519')
/** A PEM the library has never seen, for the import path (and "不在私钥库"). */
const looseKeyPath = join(work, 'id_ed25519')
writeFileSync(looseKeyPath, userKey)

let server
let llm
let child
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function startServer() {
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    connCount++
    client
      .on('error', () => {}) // the app being killed mid-session is expected here
      .on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && ctx.username === 'smoke') ctx.accept()
        else if (ctx.method === 'none') ctx.reject(['publickey'])
        else ctx.reject(['publickey'])
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('sftp', serveSftp)
          session.on('pty', (a) => a && a())
          // A one-line stand-in for a login shell: it echoes what is typed (that
          // is the proof the write path works) and answers the AI panel's
          // marked-up command line the way a real one does — start marker, the
          // command's output, end marker carrying the exit status.
          session.on('shell', (accept) => {
            const stream = accept()
            stream.write(`${BANNER}\r\n`)
            stream.on('data', (chunk) => {
              const text = chunk.toString('utf8')
              // Ctrl-U clears the line and is not echoed; neither are the markers.
              stream.write(text.replace(/\x15/g, ''))
              const nonce = /\]1338;(\w+)/.exec(text)?.[1]
              if (!nonce) return
              stream.write(`\x1b]1338;${nonce}\x07`)
              const cmd = /\\007'; ([\s\S]*?); printf /.exec(text)?.[1] ?? ''
              const answer = shellAnswer(cmd)
              if (answer.out) stream.write(answer.out)
              stream.write(`\x1b]1339;${nonce} ${answer.code}\x07`)
            })
          })
          session.on('window-change', (a) => a && a())
          // The resource monitor runs on its own exec channel; answer with the
          // same canned layout a Linux box would print. The CLI test sends a marked
          // command instead, so one place covers both.
          session.on('exec', (accept, _reject, info) => {
            const stream = accept()
            execCount++
            const cmd = info?.command ?? ''
            if (cmd.includes('CLI_MARK')) {
              // Three separate answers on purpose: the CLI has to keep stdout,
              // stderr and a non-zero exit status apart from one another.
              stream.write(`ran:${cmd}\n`)
              stream.stderr.write('warning line\n')
              stream.exit(3)
            } else if (cmd.includes('SMOKE_BIG')) {
              // Past the agent's spill threshold, so the whole round trip —
              // truncate, hand over a handle, read the middle back — gets run.
              for (let i = 1; i <= 900; i++) stream.write(`line ${i} ${'x'.repeat(60)}\n`)
              stream.exit(0)
            } else {
              stream.write(MONITOR_OUTPUT)
              stream.exit(0)
            }
            stream.end()
          })
        })
      })
  })
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
}

/** What the stand-in shell answers. The agent's exec runs on the prompt now, so
 *  the commands the model asks for arrive here instead of on an exec channel. */
function shellAnswer(cmd) {
  if (cmd.includes('CLI_MARK')) {
    // stderr and stdout come back as one stream through a tty — the exit status
    // is the part that still has to survive.
    return { out: `ran:${cmd}\nwarning line\n`, code: 3 }
  }
  if (cmd.includes('SMOKE_BIG')) {
    // Past the agent's spill threshold, so the whole round trip — truncate, hand
    // over a handle, read the middle back — gets run.
    let out = ''
    for (let i = 1; i <= 900; i++) out += `line ${i} ${'x'.repeat(60)}\n`
    return { out, code: 0 }
  }
  return { out: '', code: 0 }
}

/* ------------------------------------------------------------------ *
 * the stand-in model
 *
 * An OpenAI-compatible SSE endpoint. What it answers is a function of the
 * conversation it was handed, so the app sets the pace: the test never sleeps
 * waiting for "a model" to finish thinking, and the rounds are reproducible.
 * ------------------------------------------------------------------ */

/** Every request body, in order. The assertions read these to check what the
 *  app actually sent, not just what it drew. */
const llmSeen = []
/** The same, for the Anthropic dialect. Kept apart: the two bodies share almost
 *  no field names, and mixing them would make every assertion a guessing game. */
const claudeSeen = []

const chunk = (delta, finish = null) => ({
  id: 'chatcmpl-smoke',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'smoke-model',
  choices: [{ index: 0, delta, finish_reason: finish }]
})

function sayFrames(text) {
  // Two frames: the renderer's live bubble is fed by deltas, and one frame
  // would not exercise it.
  const cut = Math.ceil(text.length / 2)
  return [chunk({ role: 'assistant', content: text.slice(0, cut) }), chunk({ content: text.slice(cut) }), chunk({}, 'stop')]
}

function toolFrames(name, args) {
  const json = JSON.stringify(args)
  const cut = Math.ceil(json.length / 2)
  // The arguments are split across chunks on purpose — that is what real
  // gateways do, and the adapter has to accumulate before it can parse.
  return [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_smoke', type: 'function', function: { name, arguments: json.slice(0, cut) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(cut) } }] }),
    chunk({}, 'tool_calls')
  ]
}

/** The script. Every branch is keyed on the last message, which is either the
 *  user's words or the result of the call the previous round asked for. */
function framesFor(messages) {
  const last = messages[messages.length - 1] ?? {}
  const text = typeof last.content === 'string' ? last.content : ''

  if (last.role === 'user') {
    if (text.includes('附件')) return toolFrames('cat', { path: '/tmp/attach-smoke.txt' })
    if (text.includes('停下来')) return toolFrames('exec', { command: 'rm -rf /tmp/slow' })
    // Destructive on purpose: under the current gate only the commands that
    // lose data stop to ask, and this test is about what happens at that card.
    if (text.includes('长输出')) return toolFrames('exec', { command: 'rm -rf /tmp/old && SMOKE_BIG' })
    if (text.includes('清空')) return toolFrames('exec', { command: 'rm -rf /' })
    if (text.includes('根目录')) return toolFrames('ls', { path: '/' })
    if (text.includes('慢慢地')) return sayFrames('来了，慢是因为它在想。')
    return toolFrames('exec', { command: 'echo CLI_MARK' })
  }
  if (text.startsWith('用户拒绝')) return sayFrames('好，那我不动它。')
  const spilled = /已存为 (\S+\.txt)/.exec(text)
  if (spilled) return toolFrames('read_output', { handle: spilled[1], startLine: 150, maxLines: 5 })
  if (text.startsWith('第 ')) return sayFrames('中间那段看到了。')
  if (text.startsWith('exit=')) return sayFrames('跑完了。')
  if (text.startsWith('{')) return sayFrames('看了，根目录没什么特别的。')
  return sayFrames('好。')
}

function startLlm() {
  llm = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // The model list both dialects read, so the settings dialog can be filled
      // from the endpoint instead of from memory.
      if (req.method === 'GET') {
        // A gateway with a website on the bare host, the way a real one has:
        // the wrong address answers 200 with a page, not with an error.
        if (!req.url.startsWith('/v1/')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<!doctype html><html><body>网关首页</body></html>')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'smoke-model' }, { id: 'smoke-small' }] }))
        return
      }

      const payload = JSON.parse(body)
      const claude = req.url.startsWith('/v1/messages')
      ;(claude ? claudeSeen : llmSeen).push(payload)

      // A model name the endpoint does not have: the failure a user is most
      // likely to hit, and the one that used to look like nothing happening.
      // The wrong-address case the user actually hit: 200 with a web page. The
      // SDK sees a stream with no chunks in it and the turn comes back empty.
      if (payload.model === 'empty-page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><body>网关首页</body></html>')
        return
      }

      if (payload.model === 'no-such-model') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }))
        return
      }

      const answer = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = claude ? anthropicFrames(payload) : framesFor(payload.messages ?? [])
      for (const frame of frames) {
        // The Anthropic API names each event as well as carrying it in the body.
        res.write(claude ? `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n` : `data: ${JSON.stringify(frame)}\n\n`)
      }
      // Only the OpenAI dialect has a sentinel; the Anthropic one ends with
      // the message_stop frame itself.
      if (!claude) res.write('data: [DONE]\n\n')
      res.end()
      }

      // One slow reply on purpose: sending and the first frame used to be
      // indistinguishable from a dead button, and this is the only way to catch
      // that the panel says something in between.
      const last = (payload.messages ?? []).at(-1)
      const slow = typeof last?.content === 'string' && last.content.includes('慢慢地')
      if (slow) setTimeout(answer, 1500)
      else answer()
    })
  })
  return new Promise((resolve) => llm.listen(LLM_PORT, '127.0.0.1', resolve))
}

/* ---------------- the Anthropic dialect ---------------- */

/** Same script, told in blocks, streamed the way the SDK accumulates them. */
function anthropicFrames(body) {
  const messages = body.messages ?? []
  const last = messages[messages.length - 1] ?? {}
  const blocks = []

  if (typeof last.content === 'string') {
    // Two read-only calls in ONE turn on purpose: that is the shape the
    // results have to be merged back into a single user message for, and
    // splitting them would quietly teach the model to stop doing it.
    blocks.push({ type: 'tool_use', id: 'toolu_smoke_1', name: 'ls', args: { path: '/' } })
    blocks.push({ type: 'tool_use', id: 'toolu_smoke_2', name: 'monitor', args: {} })
  } else {
    blocks.push({ type: 'text', text: '这台机器看过了。' })
  }

  const frames = [
    {
      type: 'message_start',
      message: {
        id: 'msg_smoke',
        type: 'message',
        role: 'assistant',
        model: 'smoke-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    }
  ]

  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      const cut = Math.ceil(b.text.length / 2)
      frames.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      frames.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(0, cut) } })
      frames.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(cut) } })
    } else {
      const json = JSON.stringify(b.args)
      const cut = Math.ceil(json.length / 2)
      frames.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} }
      })
      frames.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } })
      frames.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } })
    }
    frames.push({ type: 'content_block_stop', index })
  })

  frames.push({
    type: 'message_delta',
    delta: { stop_reason: typeof last.content === 'string' ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 }
  })
  frames.push({ type: 'message_stop' })
  return frames
}

/** Pre-seed the profile so the window opens with a connection in the tree. */
/** A key already filed in the library; `smoke` points at it. */
const libraryKey = join(profile, 'keys', 'seeded.pem')

function seedProfile() {
  mkdirSync(join(profile, 'keys'), { recursive: true })
  writeFileSync(libraryKey, userKey, { mode: 0o600 })
  writeFileSync(
    join(profile, 'liteshell.json'),
    JSON.stringify(
      {
        version: 1,
        folders: [{ id: 'f1', name: '冒烟测试', parentId: null }],
        connections: [
          {
            id: 'smoke',
            name: 'local-smoke',
            folderId: 'f1',
            host: '127.0.0.1',
            port: PORT,
            username: 'smoke',
            authType: 'key',
            privateKeyPath: libraryKey,
            termType: 'xterm-256color',
            keepalive: 0
          },
          {
            // No stored secret, like every password connection imported from
            // FinalShell: connecting must ask rather than try an empty password.
            id: 'smoke-pw',
            name: 'local-pw',
            folderId: 'f1',
            host: '127.0.0.1',
            port: PORT,
            username: 'smoke',
            authType: 'password',
            termType: 'xterm-256color',
            keepalive: 0
          },
          {
            // A key nobody filed in the library — the shape an imported or
            // hand-typed path has. The picker must keep it rather than drop it.
            id: 'loose',
            name: 'local-loose',
            folderId: 'f1',
            host: '127.0.0.1',
            port: PORT,
            username: 'nobody',
            authType: 'key',
            privateKeyPath: looseKeyPath,
            termType: 'xterm-256color',
            keepalive: 0
          }
        ],
        keys: [
          { id: 'k1', name: '冒烟密钥', path: libraryKey, comment: '本地测试', addedAt: 1 }
        ],
        quickCommands: [
          // One that exists in the palette (so it picks up its description on
          // hover) and one hand-written (so it must fall back to the command).
          { id: 'q1', name: '看访问日志', command: 'tail -f /var/log/nginx/access.log' },
          { id: 'q2', name: '问好', command: 'echo hi' }
        ],
        settings: {
          theme: 'liteshell',
          fontFamily: 'monospace',
          fontSize: 12,
          cursorStyle: 'block',
          cursorBlink: true,
          scrollback: 500,
          copyOnSelect: true,
          // The model is the fake endpoint above; the key is typed into the
          // settings dialog during the run, since a seeded one would be
          // ciphertext this machine cannot read.
          // Deliberately unconfigured: the panel has to be reachable and go
          // through its first-run path before anything here can be trusted.
          llm: { provider: 'openai', baseUrl: '', model: '' }
        },
        knownHosts: []
      },
      null,
      2
    )
  )
}

function launchApp() {
  // LITESHELL_EXE points the same test at a packaged build instead of the source tree.
  const packaged = process.env.LITESHELL_EXE
  const bin = packaged ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = packaged
    ? [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`]
    : ['.', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`]
  console.log(`       (running ${packaged ? 'packaged build' : 'source tree'})`)
  // The tag keeps this instance's CLI socket away from a real LiteShell the user
  // may have open — without it the app would try to bind the same address.
  child = spawn(bin, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LITESHELL_CLI_TAG: 'smoke' }
  })
  const log = []
  child.stdout.on('data', (d) => log.push(['out', d.toString()]))
  child.stderr.on('data', (d) => log.push(['err', d.toString()]))
  return log
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** PowerShell 一行。收尾那两条托盘断言要用它跟窗口说话。 */
function ps(body) {
  return execFileSync('powershell', ['-NoProfile', '-Command', body], { encoding: 'utf8' }).trim()
}

/** PostMessage 和 IsWindowVisible —— 问窗口本人，别猜。 */
function win32(body) {
  return ps(
    [
      'Add-Type @"',
      'using System; using System.Runtime.InteropServices;',
      'public class SmokeWin {',
      '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '}',
      '"@',
      body
    ].join('\n')
  )
}

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // not up yet
    }
    await sleep(500)
  }
  throw new Error('devtools endpoint never came up')
}

/** Minimal CDP client. Node 24 ships a global WebSocket, so no dependency needed. */
function connect(url, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let seq = 0
    ws.addEventListener('open', () =>
      resolve({
        send(method, params) {
          const id = ++seq
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            // A page that stops answering — hidden, tearing down, or gone —
            // would otherwise hang the whole run with no output to show for it.
            const timer = setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP ${method} 超时`))
            }, 30000)
            timer.unref()
          })
        },
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method) return onEvent?.(msg)
      const slot = pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      msg.error ? slot.rej(new Error(msg.error.message)) : slot.res(msg.result)
    })
  })
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' :: ' + expression)
  return res.result.value
}

async function waitFor(cdp, expression, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return true
    await sleep(300)
  }
  check(label, false, `timed out after ${timeout}ms`)
  return false
}

async function main() {
  await startServer()
  await startLlm()
  seedProfile()
  const log = launchApp()

  const page = await target()
  let cdp
  let dialogs = 0
  // The app uses window.confirm for destructive actions; accept it for the test —
  // except where we deliberately want the user to back out.
  let acceptDialogs = true
  const console_ = []
  cdp = await connect(page.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs++
      void cdp.send('Page.handleJavaScriptDialog', { accept: acceptDialogs }).catch(() => {})
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      console_.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console_.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  if (!(await evaluate(cdp, `typeof window.api === 'object' && typeof window.api.getStore === 'function'`))) {
    check('preload 暴露了 window.api', false)
    console.log(console_.join('\n') || '(renderer console was empty)')
    throw finish(1)
  }
  // #tree exists in the static HTML, so the real readiness signal is the tree
  // having been *rendered* — otherwise the first assertions race the store load.
  if (!(await waitFor(cdp, `document.querySelectorAll('.node').length > 0`, '连接树渲染完成'))) {
    console.log(console_.join('\n') || '(renderer console was empty)')
    throw finish(1)
  }

  check('连接树渲染出预置连接', await evaluate(cdp, `!!document.querySelector('.node .label')`))
  check(
    '连接与文件夹都在树里',
    (await evaluate(cdp, `[...document.querySelectorAll('.node .label')].map(n => n.textContent).join('|')`)) ===
      '冒烟测试|local-smoke|local-pw|local-loose'
  )
  check('文件夹已展开显示子节点', (await evaluate(cdp, `document.querySelectorAll('.node').length`)) >= 2)

  /* ---------------- sidebar: collapse, right-click, drag ---------------- */

  await evaluate(cdp, `document.querySelector('#btn-side').click()`)
  check('标题栏能收起连接列表', await evaluate(cdp, `document.body.classList.contains('side-off') && !document.querySelector('#sidebar').offsetParent`))
  await evaluate(cdp, `document.querySelector('#btn-side').click()`)
  check('再点一次展开', await evaluate(cdp, `!document.body.classList.contains('side-off') && !!document.querySelector('#sidebar').offsetParent`))

  await evaluate(cdp, `(() => {
    const tree = document.querySelector('#tree')
    tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 400 }))
  })()`)
  check('列表空白处右键能新建',
    await evaluate(cdp, `(() => {
      const labels = [...document.querySelectorAll('#menu div')].map(d => d.textContent)
      return labels.includes('新建连接') && labels.includes('新建文件夹')
    })()`))
  await evaluate(cdp, `document.querySelector('#menu').remove()`)

  // Drag a connection out of its folder onto the root, the same way the
  // pointer does it: dragstart on the node, then drop on the tree's blank area.
  await evaluate(cdp, `(() => {
    const src = [...document.querySelectorAll('.node')].find(n => n.querySelector('.label')?.textContent === 'local-loose')
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const tree = document.querySelector('#tree')
    tree.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: 40, clientY: 500 }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  })()`)
  check(
    '把连接拖到空白处就是移到根目录',
    await waitFor(
      cdp,
      `window.api.getStore().then(s => s.connections.find(c => c.id === 'loose')?.folderId == null)`,
      '拖到根目录',
      8000
    )
  )

  // Clicking now only selects; opening is the double click.
  await evaluate(cdp, `document.querySelectorAll('.node')[1].click()`)
  check('单击只是选中，不会自己连上去',
    await evaluate(cdp, `document.querySelectorAll('.node')[1].classList.contains('sel') && document.querySelectorAll('#tabs .tab').length === 0`),
    await evaluate(cdp, `document.querySelectorAll('#tabs .tab').length`))
  await evaluate(cdp, `document.querySelectorAll('.node')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)

  const gotBanner = await waitFor(
    cdp,
    `document.querySelector('.xterm-rows')?.textContent?.includes('${BANNER}')`,
    '终端渲染出远端 banner'
  )
  if (gotBanner) {
    check('终端渲染出远端 banner', true)
  }

  check(
    '状态栏显示已连接',
    /已连接/.test(await evaluate(cdp, `document.querySelector('#status-text').textContent`))
  )
  check('标签页已创建', (await evaluate(cdp, `document.querySelectorAll('.tab').length`)) === 1)
  check('快捷命令条已渲染', (await evaluate(cdp, `document.querySelectorAll('.quickbar .chip').length`)) >= 2)
  const chipTips = JSON.parse(
    await evaluate(cdp, `JSON.stringify([...document.querySelectorAll('.quickbar .chip')].map(c => c.title))`)
  )
  check('快捷命令悬停给出作用', chipTips.some((t) => t.includes('实时访问日志')), JSON.stringify(chipTips))
  check('自造的命令只显示命令本身', chipTips.includes('echo hi'), JSON.stringify(chipTips))

  // Typing must reach the server and come back — proves the write path.
  await evaluate(cdp, `document.querySelector('.xterm-helper-textarea').focus()`)
  await cdp.send('Input.insertText', { text: 'typecheck' })
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: type === 'keyDown' ? '\r' : undefined
    })
  }
  if (
    await waitFor(
      cdp,
      `document.querySelector('.xterm-rows')?.textContent?.includes('typecheck')`,
      '输入回显 (写入通道)'
    )
  ) {
    check('输入回显 (写入通道)', true)
  }

  /* ---------------- command history ---------------- */

  /**
   * `key` is what the page reads as ev.key, and for a letter that is the bare
   * character while ev.code is `KeyX` — xterm resolves its control characters
   * from ev.key, so 'KeyU' would not produce a Ctrl-U.
   */
  const key = async (name, keyCode, modifiers = 0) => {
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: name,
        code,
        modifiers,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      })
    }
  }

  await evaluate(cdp, `document.querySelector('.xterm-helper-textarea').focus()`)
  await cdp.send('Input.insertText', { text: 'type' })
  check(
    '输入前缀时弹出历史候选',
    await waitFor(
      cdp,
      `!document.querySelector('.suggest').hidden && document.querySelector('.suggest-cmd')?.textContent === 'typecheck'`,
      '输入前缀时弹出历史候选'
    )
  )

  // ↓ walks into the panel from the top; ↑ walks back out of the selection.
  await key('ArrowDown', 40)
  check(
    '↓ 从顶部进入候选面板',
    await evaluate(
      cdp,
      `document.querySelector('.suggest-row').classList.contains('sel')
       && document.querySelector('.suggest-row .suggest-cmd').textContent === 'typecheck'`
    )
  )
  await key('ArrowUp', 38)
  check('↑ 从候选里退出来', await evaluate(cdp, `!document.querySelector('.suggest-row.sel')`))
  await key('ArrowDown', 40)

  await key('Tab', 9)
  check('Tab 补全并收起候选', await waitFor(cdp, `document.querySelector('.suggest').hidden`, 'Tab 补全并收起候选'))

  // The candidate box must sit under the prompt line, not on top of the output.
  await key('u', 85, 2) // Ctrl-U: clear the line the Tab left behind
  check(
    'Tab 之后按键仍然归终端（Ctrl-U 清空命令行）',
    await waitFor(
      cdp,
      `document.querySelector('.pane.active').dataset.line === ''`,
      'Tab 之后按键仍然归终端'
    )
  )
  await cdp.send('Input.insertText', { text: 'sys' })
  check(
    '内置常用命令也能补全',
    await waitFor(
      cdp,
      `document.querySelector('.suggest-cmd')?.textContent === 'systemctl'`,
      '内置常用命令也能补全'
    )
  )
  check(
    '字典候选带中文说明',
    /服务/.test(await evaluate(cdp, `document.querySelector('.suggest-desc')?.textContent ?? ''`)),
    await evaluate(cdp, `document.querySelector('.suggest-desc')?.textContent`)
  )
  // Native xterm re-lays its rows out a frame after the resize, hence the beat.
  await sleep(400)
  const geo = JSON.parse(
    await evaluate(
      cdp,
      `(() => {
         const box = document.querySelector('.suggest').getBoundingClientRect()
         const screen = document.querySelector('.xterm-screen').getBoundingClientRect()
         const pane = document.querySelector('.pane.active').getBoundingClientRect()
         return JSON.stringify({
           boxTop: Math.round(box.top), boxBottom: Math.round(box.bottom),
           boxWidth: Math.round(box.width), screenTop: Math.round(screen.top),
           screenBottom: Math.round(screen.bottom), paneWidth: Math.round(pane.width),
           position: getComputedStyle(document.querySelector('.suggest')).position
         })
       })()`
    )
  )
  // The candidate box floats over the terminal instead of taking a row of it:
  // an in-flow box resized the terminal every time the list changed, and the
  // shell redrew its prompt a few lines higher. That was the jump.
  check('候选框是浮层，不占布局', geo.position === 'absolute', JSON.stringify(geo))
  check('候选框落在输入行下面（像输入法）', geo.boxTop >= geo.screenTop, JSON.stringify(geo))
  check('候选框没有横跨整个面板', geo.boxWidth <= 460 && geo.boxWidth < geo.paneWidth, JSON.stringify(geo))
  // Rows and pty stay put while the list comes and goes.
  const dims = await evaluate(
    cdp,
    `(() => { const s = document.querySelector('.pane.active');
       return JSON.stringify({ rows: s.querySelector('.xterm-screen').getBoundingClientRect().height }) })()`
  )
  await key('u', 85, 2)
  await sleep(200)
  const dimsAfter = await evaluate(
    cdp,
    `(() => { const s = document.querySelector('.pane.active');
       return JSON.stringify({ rows: s.querySelector('.xterm-screen').getBoundingClientRect().height }) })()`
  )
  check('候选框出现或消失时终端尺寸不动（输入框不跳）', dims === dimsAfter, `${dims} vs ${dimsAfter}`)

  /* ---------------- follow-up options ---------------- */

  await cdp.send('Input.insertText', { text: 'docker p' })
  check(
    '命令名打完后给出后续选项',
    await waitFor(cdp, `document.querySelector('.suggest-cmd')?.textContent === 'docker ps -a'`, '后续选项')
  )
  check(
    '后续选项带中文说明',
    /容器/.test(await evaluate(cdp, `document.querySelector('.suggest-desc')?.textContent ?? ''`)),
    await evaluate(cdp, `document.querySelector('.suggest-desc')?.textContent`)
  )
  check(
    '候选行悬停显示完整命令与作用',
    /^docker ps -a\n所有容器$/.test(await evaluate(cdp, `document.querySelector('.suggest-row').title`)),
    JSON.stringify(await evaluate(cdp, `document.querySelector('.suggest-row').title`))
  )
  // Nothing highlighted yet, so ↑ is the shell's history — the panel gets out of its way.
  await key('ArrowUp', 38)
  check('没选中时 ↑ 交还给 shell', await waitFor(cdp, `document.querySelector('.suggest').hidden`, '↑ 交还 shell'))
  await key('u', 85, 2)

  await sleep(1500)
  const saved = JSON.parse(readFileSync(join(profile, 'liteshell.json'), 'utf8'))
  check('历史命令落到磁盘（按连接分开）', (saved.history?.smoke ?? []).includes('typecheck'), JSON.stringify(saved.history))

  await evaluate(cdp, `[...document.querySelectorAll('.tbtn')].find(b => b.textContent === '历史').click()`)
  check(
    '历史命令面板列出已输入的命令',
    await waitFor(cdp, `document.querySelector('.hist-row')?.textContent === 'typecheck'`, '历史面板列出命令')
  )
  await evaluate(cdp, `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '关闭').click()`)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '历史面板关闭')

  /* ---------------- shortcuts ---------------- */

  await evaluate(cdp, `document.querySelector('.xterm-helper-textarea').focus()`)
  await key('Slash', 191, 2)
  check(
    'Ctrl+/ 打开快捷键一览',
    await waitFor(cdp, `document.querySelectorAll('.key-row').length >= 10`, 'Ctrl+/ 打开快捷键一览')
  )
  await evaluate(cdp, `document.querySelector('#overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '快捷键面板关闭')

  check(
    '首次连接展示主机密钥指纹 (TOFU)',
    /SHA256:/.test(await evaluate(cdp, `document.querySelector('.notice').textContent`))
  )
  check(
    '连接过程未产生错误提示',
    await evaluate(cdp, `!document.querySelector('.notice').classList.contains('error')`)
  )

  /* ---------------- SFTP panel ---------------- */

  await evaluate(cdp, `document.querySelector('[data-act="files"]').click()`)
  if (
    await waitFor(
      cdp,
      `document.querySelectorAll('.files-list .row').length >= 2`,
      '文件面板列出远端目录'
    )
  ) {
    check('文件面板列出远端目录', true)
  }
  check(
    '目录排在文件前面',
    await evaluate(cdp, `document.querySelector('.files-list .row').classList.contains('dir')`)
  )
  check(
    '文件大小已格式化',
    /11 B/.test(
      await evaluate(
        cdp,
        `[...document.querySelectorAll('.files-list .row .sz')].map(n => n.textContent).join('|')`
      )
    )
  )

  await evaluate(
    cdp,
    `(() => {
       const row = [...document.querySelectorAll('.files-list .row')].find(r => r.textContent.includes('tree'))
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
       return true
     })()`
  )
  const entered = await waitFor(
    cdp,
    `${CRUMBS} === '/tree'`,
    '双击进入子目录'
  )
  check('双击进入子目录', entered)

  const openDir = (name) =>
    evaluate(
      cdp,
      `(() => {
         const row = [...document.querySelectorAll('.files-list .row')].find(r => r.textContent.includes(${JSON.stringify(name)}))
         row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
         return true
       })()`
    )

  await evaluate(cdp, `document.querySelector('[title^="上一级"]').click()`)
  await waitFor(cdp, `${CRUMBS} === '/'`, '返回上级')
  check('返回上级目录', true)

  // Breadcrumb navigation: clicking an ancestor jumps straight there.
  await openDir('tree')
  await waitFor(cdp, `${CRUMBS} === '/tree'`, '再次进入 /tree')
  await evaluate(cdp, `document.querySelector('.crumbs .crumb').click()`)
  check('点面包屑回根目录', await waitFor(cdp, `${CRUMBS} === '/'`, '点面包屑回根目录'))

  // Typing a path jumps directly.
  await evaluate(cdp, `document.querySelector('[title="输入路径跳转"]').click()`)
  await waitFor(cdp, `!!document.querySelector('.path-edit input')`, '路径输入框出现')
  await evaluate(
    cdp,
    `(() => {
       const box = document.querySelector('.path-edit input')
       box.value = '/tree/a/b'
       box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
       return true
     })()`
  )
  check('输入路径直接跳转', await waitFor(cdp, `${CRUMBS} === '/tree/a/b'`, '输入路径直接跳转'))
  await evaluate(cdp, `document.querySelector('.crumbs .crumb').click()`)
  await waitFor(cdp, `${CRUMBS} === '/'`, '回到根目录')

  // Create a directory through the real dialog.
  await evaluate(cdp, `document.querySelector('[title="新建目录"]').click()`)
  await waitFor(cdp, `!!document.querySelector('.modal input')`, '新建目录对话框弹出')
  await evaluate(
    cdp,
    `(() => { document.querySelector('.modal input').value = 'created-by-test'; return true })()`
  )
  await evaluate(cdp, `[...document.querySelectorAll('.modal .btn')].find(b => b.textContent === '确定').click()`)
  await waitFor(
    cdp,
    `[...document.querySelectorAll('.files-list .row')].some(r => r.textContent.includes('created-by-test'))`,
    '新建的目录出现在列表'
  )
  check('通过界面新建目录 (MKDIR)', existsSync(join(sftpRoot, 'created-by-test')))

  // Recursive delete through the row context menu, exercising the walk. Plain
  // 删除 is RMDIR and would (correctly) refuse this non-empty directory.
  await evaluate(
    cdp,
    `(() => {
       const row = [...document.querySelectorAll('.files-list .row')].find(r => r.textContent.includes('tree'))
       row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
       return true
     })()`
  )
  check('文件右键菜单弹出', await evaluate(cdp, `!!document.querySelector('#menu')`))
  check(
    '文件菜单有上传/下载/打包/新建/权限/删除/递归删除/刷新',
    await evaluate(
      cdp,
      `(() => {
         const labels = [...document.querySelectorAll('#menu div')].map(d => d.textContent)
         return ['上传到此处', '下载', '新建文件夹', '新建文件', '删除', '递归删除', '刷新']
           .every(l => labels.includes(l)) &&
           labels.some(l => l.startsWith('打包下载')) && labels.some(l => l.startsWith('文件权限'))
       })()`
    )
  )
  await evaluate(cdp, `[...document.querySelectorAll('#menu div')].find(d => d.textContent === '递归删除').click()`)
  if (
    await waitFor(
      cdp,
      `![...document.querySelectorAll('.files-list .row')].some(r => r.textContent.includes('tree'))`,
      '删除后列表刷新'
    )
  ) {
    check('删除后列表刷新', true)
  }
  check('删除确认框已弹出', dialogs >= 1, `dialogs=${dialogs}`)
  check('递归删除目录及其嵌套文件 (RMDIR/REMOVE)', !existsSync(join(sftpRoot, 'tree')))
  check('无关文件未被误删', existsSync(join(sftpRoot, 'hello.txt')))

  /* ---------------- resource monitor ---------------- */

  // A tab opens onto a live box with the panel already shown, so this is
  // "make sure it is open", not "toggle": clicking a visible button hides it and
  // every measurement below then reads a zero-width panel.
  const MON_BTN = `[...document.querySelectorAll('.pane.active .tbtn')].find(b => b.textContent === '监控')`
  const ensureMon = (open) =>
    evaluate(cdp, `(() => {
      const b = ${MON_BTN}
      const on = document.querySelector('.pane.active .monitor').style.display !== 'none'
      if (on !== ${open}) b.click()
      return true
    })()`)
  await ensureMon(true)
  if (
    await waitFor(cdp, `document.querySelector('.mon-host')?.textContent === 'smoke-host'`, '监控面板取到服务器信息')
  ) {
    check('监控面板打开并读到主机名', true)
  }

  // The level bars animate into place (0.15s), so measure them after they land.
  await sleep(250)

  const mon = JSON.parse(
    await evaluate(
      cdp,
      `(() => {
         const gauges = [...document.querySelectorAll('.gauge')]
         const val = (i) => gauges[i].querySelector('.gauge-value').textContent
         const detail = (i) => gauges[i].querySelector('.gauge-detail').textContent
         // By title: the sections are added to over time, and an index silently
         // starts pointing at a different reading when one is.
         const section = (title) =>
           [...document.querySelectorAll('.mon-section')]
             .find(s => s.querySelector('.mon-title')?.textContent === title)?.textContent ?? ''
         return JSON.stringify({
           labels: gauges.map(g => g.querySelector('.gauge-label').textContent),
           cpu: val(0), mem: val(1), memDetail: detail(1), swap: val(2),
           netDown: val(3), netUp: detail(3),
           netMeta: gauges[3].querySelector('.mon-line').textContent,
           netRows: [...document.querySelectorAll('.mon-net')].map(r => r.textContent).join('|'),
           gpu: section('GPU'), disk: section('磁盘'),
           diskTitles: [...document.querySelectorAll('.mon-disk')].map(r => r.title).join('|'),
           info: document.querySelector('.mon-info').textContent,
           sparks: document.querySelectorAll('.spark').length,
           painted: [...document.querySelectorAll('.spark')].map(c => {
             const ctx = c.getContext('2d')
             if (!ctx || !c.width) return 0
             const px = ctx.getImageData(0, 0, c.width, c.height).data
             let n = 0
             for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++
             return n
           }).join(','),
           // The card's bar has to describe the number printed beside it.
           gpuRow: (() => {
             const r = document.querySelector('.gpu-row')
             const f = r.querySelector('.pbar-fill')
             return {
               label: r.querySelector('.gpu-label').textContent,
               text: r.querySelector('.mon-val').textContent,
               bar: Math.round(f.getBoundingClientRect().width / f.parentElement.clientWidth * 100)
             }
           })(),
           fills: gauges.map(g => {
             const f = g.querySelector('.pbar-fill')
             return f ? Math.round(f.getBoundingClientRect().width / f.parentElement.clientWidth * 100) : -1
           }).join(','),
           alerts: document.querySelector('.mon-alerts').textContent,
           alertTone: document.querySelector('.mon-alerts').dataset.tone,
           scroll: document.querySelector('.monitor').scrollHeight,
           client: document.querySelector('.monitor').clientHeight
         })
       })()`
    )
  )

  check('仪表按 CPU/内存/Swap/网络 排列', mon.labels.join(',') === 'CPU,内存,Swap,网络', mon.labels.join(','))
  check('CPU 百分比来自两次采样（110/310）', mon.cpu === '35%', mon.cpu)
  check('内存按 MemAvailable 算并给出用量', mon.mem === '76%' && mon.memDetail === '12 GB / 16 GB', `${mon.mem} ${mon.memDetail}`)
  check('Swap 用掉一半', mon.swap === '50%', mon.swap)
  check('网速取两次采样的差值', mon.netDown === '↓ 12 KB/s' && mon.netUp === '↑ 4.7 KB/s', `${mon.netDown} ${mon.netUp}`)
  // eth0's counters from the canned capture: 512000 / 204800 bytes.
  check('每个网卡一行，速率和累计都分开', /eth0/.test(mon.netRows) && /↓500 KB/.test(mon.netRows) && /↑200 KB/.test(mon.netRows), mon.netRows)
  check('延迟和累计流量写在仪表下面', /延迟/.test(mon.netMeta) && /累计/.test(mon.netMeta), mon.netMeta)
  check('GPU 卡片显示编号/型号/温度/显存', /#0/.test(mon.gpu) && /Tesla T4/.test(mon.gpu) && /45°C/.test(mon.gpu) && /1\.0 GB \/ 15 GB/.test(mon.gpu), mon.gpu)
  // Reported bug: an unlabelled bar sat above the vram line, so the two looked
  // like they described each other. One labelled row, one number, one bar.
  // 1024/15360 = 6.7%, which is what the bar has to show.
  check(
    '显存行有标签，条跟紧挨着的百分比一致',
    mon.gpuRow.label === '显存' && /^7%/.test(mon.gpuRow.text) && Math.abs(mon.gpuRow.bar - 7) <= 2,
    `${mon.gpuRow.bar}% vs 显示 ${mon.gpuRow.text}`
  )
  // The visible line is mount + bar + percent; the device file moved into the
  // hover title, so the tmpfs filter is checked there.
  check('磁盘卡片按已用/总量算', mon.disk.includes('/73%') && mon.disk.includes('29 GB / 39 GB'), mon.disk)
  check('磁盘滤掉 tmpfs，设备名在悬停里', mon.diskTitles.includes('/dev/sda1') && !mon.diskTitles.includes('/dev/shm'), mon.diskTitles)
  check('服务器信息含主机名/内核/核心数/负载', /Linux 5\.15/.test(mon.info) && /8 核/.test(mon.info) && /负载 0\.52/.test(mon.info), mon.info)
  check('三条曲线（CPU/内存/网络）已绘制', mon.sparks === 3, `sparks=${mon.sparks}`)
  // A canvas in the DOM proves nothing — the first sample used to draw a lone dot
  // in the corner, i.e. a card that looked empty.
  check('第一条采样就有可见的曲线', mon.painted.split(',').every((n) => Number(n) > 40), mon.painted)
  // Within a couple of points: the fill is a percentage of a fractional pixel
  // width. 网络 has no bar at all, hence the -1.
  const fills = mon.fills.split(',').map(Number)
  check(
    '进度条长度和数字对得上',
    [35, 76, 50].every((want, i) => Math.abs(fills[i] - want) <= 2) && fills[3] === -1,
    `CPU/内存/Swap/网络 = ${mon.fills}`
  )
  check('一切正常时预警条是绿的', mon.alertTone === 'ok' && mon.alerts.includes('正常范围'), `${mon.alertTone} ${mon.alerts}`)
  check('监控面板一屏看完，不用下拉', mon.scroll <= mon.client + 2, `${mon.scroll} / ${mon.client}`)
  check('监控走的是独立的 exec 通道', execCount > 0, `execCount=${execCount}`)

  // Polling must stop when the panel is closed, not keep running in the background.
  await ensureMon(false)
  const before = execCount
  await sleep(3200)
  check('关闭面板后停止采样', execCount === before, `${before} -> ${execCount}`)

  /* ---------------- upload + transfer list ---------------- */

  // A drag-and-drop cannot be synthesized (a fake File has no filesystem path),
  // but everything downstream of it — fastPut, progress events, the list — is
  // the same code the drop handler calls.
  const uploadSrc = join(work, 'dropped.bin')
  writeFileSync(uploadSrc, Buffer.alloc(300 * 1024, 0x5a))
  const sid = await evaluate(cdp, `document.querySelector('.pane').dataset.session`)
  await evaluate(
    cdp,
    `window.api.sftpUploadPaths(${JSON.stringify(sid)}, [${JSON.stringify(uploadSrc)}], '/')`
  )

  const uploaded = await waitFor(
    cdp,
    `document.querySelector('.xfer .xfer-pct')?.textContent === '完成'`,
    '上传进度行出现并转为完成'
  )
  check('上传进度行出现并转为完成', uploaded)
  check(
    '进度条走到 100%',
    (await evaluate(cdp, `document.querySelector('.xfer .pbar-fill').style.width`)) === '100%'
  )
  // The arrow is the direction at a glance; the name is what was uploaded.
  check(
    '上传清单显示文件名与已完成状态',
    (await evaluate(
      cdp,
      `document.querySelector('.xfer .xfer-name').textContent + '|' + document.querySelector('.xfer-count').textContent`
    )) === '↑ dropped.bin|1 项'
  )
  check('文件确实写到了远端', existsSync(join(sftpRoot, 'dropped.bin')))
  check(
    '远端内容与源文件等长',
    existsSync(join(sftpRoot, 'dropped.bin')) && statOf(join(sftpRoot, 'dropped.bin')).size === 300 * 1024
  )

  await evaluate(cdp, `[...document.querySelectorAll('.xfer-head-bar .tbtn')].find(b => b.textContent === '清除已完成').click()`)
  await waitFor(cdp, `document.querySelector('.transfers').style.display === 'none'`, '上传清单已收起')
  check('清除已完成后清单收起', (await evaluate(cdp, `document.querySelectorAll('.xfer').length`)) === 0)

  /* ---------------- built-in editor ---------------- */

  const confPath = join(sftpRoot, 'app.conf')
  const photoPath = join(sftpRoot, 'photo.png')
  writeFileSync(confPath, 'port = 80\n')
  writeFileSync(photoPath, Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n'), Buffer.alloc(32, 7)]))

  /** Poll the fixture directory — the save happens over the wire, not in the DOM. */
  const diskIs = async (path, want) => {
    for (let i = 0; i < 40; i++) {
      if (existsSync(path) && readFileSync(path, 'utf8') === want) return true
      await sleep(100)
    }
    return false
  }
  const rowOf = (name) =>
    `[...document.querySelectorAll('.files-list .row')].find(r => r.textContent.includes('${name}'))`
  const clickHead = (label) =>
    evaluate(cdp, `[...document.querySelectorAll('.editor-head .btn')].find(b => b.textContent === '${label}').click()`)
  const dblclickRow = (name) =>
    evaluate(cdp, `(() => { ${rowOf(name)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`)

  await evaluate(cdp, `document.querySelector('[title="刷新"]').click()`)
  await waitFor(cdp, `!!${rowOf('app.conf')}`, '新文件出现在列表')
  await dblclickRow('app.conf')
  if (await waitFor(cdp, `!!document.querySelector('.editor-win')`, '双击文本文件打开内置编辑器')) {
    check('双击文本文件打开内置编辑器', true)
  }
  const opened = JSON.parse(
    await evaluate(
      cdp,
      `JSON.stringify({
         path: document.querySelector('.editor-path').textContent,
         text: document.querySelector('.editor-area').value,
         state: document.querySelector('.editor-state').textContent
       })`
    )
  )
  check('编辑器载入远端内容与路径', opened.text === 'port = 80\n' && opened.path === '/app.conf', JSON.stringify(opened))
  check('刚打开时标记为已同步', opened.state === '已同步', opened.state)

  await evaluate(
    cdp,
    `(() => {
       const area = document.querySelector('.editor-area')
       area.value = 'port = 8080\\n'
       area.dispatchEvent(new Event('input', { bubbles: true }))
       return true
     })()`
  )
  check('改动后标记为未保存', (await evaluate(cdp, `document.querySelector('.editor-state').textContent`)) === '● 未保存')
  await clickHead('保存')
  if (await waitFor(cdp, `document.querySelector('.editor-state')?.textContent?.startsWith('已保存')`, '保存后回显成功')) {
    check('保存后回显成功', true)
  }
  check('保存真的写回了远端 (WRITE + SETSTAT + RENAME)', await diskIs(confPath, 'port = 8080\n'), readFileSync(confPath, 'utf8'))
  check('没有留下临时文件', !existsSync(`${confPath}.liteshell.tmp`))
  await waitFor(
    cdp,
    `${rowOf('app.conf')}?.querySelector('.sz').textContent === '12 B'`,
    '保存后列表刷新出新大小'
  )
  check(
    '保存后列表按新内容刷新大小',
    (await evaluate(cdp, `${rowOf('app.conf')}?.querySelector('.sz')?.textContent`)) === '12 B'
  )

  // Someone else rewrites the file while we are still holding it: the save must
  // notice the newer mtime and ask before clobbering.
  await evaluate(
    cdp,
    `(() => {
       const area = document.querySelector('.editor-area')
       area.value = 'port = 9090\\n'
       area.dispatchEvent(new Event('input', { bubbles: true }))
       return true
     })()`
  )
  writeFileSync(confPath, 'port = 1234\n')
  utimesSync(confPath, new Date(), new Date(Date.now() + 60_000))
  const staleDialogs = dialogs
  await clickHead('保存')
  // Without the prompt the write is refused, so the file would keep the other
  // writer's content and this poll times out.
  const forced = await diskIs(confPath, 'port = 9090\n')
  check('远端被改过时先弹确认再覆盖', dialogs > staleDialogs, `dialogs=${dialogs}`)
  check('确认后强制写入成功', forced, readFileSync(confPath, 'utf8'))

  await clickHead('关闭')
  check('关闭按钮收起编辑器', await waitFor(cdp, `!document.querySelector('.editor-win')`, '编辑器已关闭'))

  // A binary file must never reach the editor.
  acceptDialogs = false
  const pngDialogs = dialogs
  await dblclickRow('photo.png')
  if (await waitFor(cdp, `document.querySelector('#status-text')?.textContent?.startsWith('已跳过 photo.png')`, '二进制文件被挡下')) {
    check('二进制文件被挡下', true)
  }
  check('没有为二进制文件开编辑器', !(await evaluate(cdp, `!!document.querySelector('.editor-win')`)))
  check(
    '拒绝理由来自扩展名规则',
    /压缩包或二进制/.test(await evaluate(cdp, `document.querySelector('#status-text').textContent`))
  )
  check('挡下之前问过用户是否改用本机程序', dialogs > pngDialogs, `dialogs=${dialogs}`)
  acceptDialogs = true

  /* ---------------- file-type colors ---------------- */

  writeFileSync(join(sftpRoot, 'deploy.sh'), '#!/bin/sh\n')
  writeFileSync(join(sftpRoot, 'logs.tar.gz'), 'not really a tarball')
  await evaluate(cdp, `document.querySelector('[title="刷新"]').click()`)
  await waitFor(cdp, `!!${rowOf('deploy.sh')}`, '类型着色用的样本文件就位')
  const colors = JSON.parse(
    await evaluate(
      cdp,
      `(() => {
         const find = (n) => [...document.querySelectorAll('.files-list .row')].find(r => r.textContent.includes(n))
         const color = (n) => {
           const row = find(n)
           return row ? getComputedStyle(row.querySelector('.nm')).color : null
         }
         return JSON.stringify({
           dir: color('created-by-test'),
           exec: color('deploy.sh'),
           archive: color('logs.tar.gz'),
           media: color('photo.png'),
           code: color('app.conf'),
           text: color('hello.txt')
         })
       })()`
    )
  )
  check('目录与文件颜色不同', colors.dir !== colors.text, JSON.stringify(colors))
  check('可执行脚本是绿的', colors.exec === 'rgb(63, 185, 80)', colors.exec)
  check('压缩包是红的', colors.archive === 'rgb(229, 83, 75)', colors.archive)
  check('图片是紫的', colors.media === 'rgb(188, 140, 255)', colors.media)
  check('配置/代码是青的', colors.code === 'rgb(57, 197, 207)', colors.code)
  check('普通文本保持默认色', colors.text === 'rgb(201, 209, 221)', colors.text)

  /* ---------------- text you can actually copy ---------------- */

  const selectable = JSON.parse(
    await evaluate(
      cdp,
      `JSON.stringify({
         row: getComputedStyle(document.querySelector('.files-list .row')).userSelect,
         info: getComputedStyle(document.querySelector('.mon-info')).userSelect,
         btn: getComputedStyle(document.querySelector('#btn-log')).userSelect
       })`
    )
  )
  check('文件行可以选中复制', selectable.row === 'text', JSON.stringify(selectable))
  check('监控信息可以选中复制', selectable.info === 'text', JSON.stringify(selectable))
  check('按钮不回应用户选择', selectable.btn === 'none', JSON.stringify(selectable))

  // Anything dragged over gets a one-click trip to the clipboard. (Not the
  // terminal: xterm keeps its own selection and hides the DOM one.)
  const menuAfterSelect = await evaluate(
    cdp,
    `(() => {
       const node = document.querySelector('.notice')
       const range = document.createRange()
       range.selectNodeContents(node)
       const sel = getSelection()
       sel.removeAllRanges()
       sel.addRange(range)
       node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
       return [...document.querySelectorAll('#menu div')].map(d => d.textContent).join('|')
     })()`
  )
  check('选中文本后菜单里有「复制选中内容」', /复制选中内容/.test(menuAfterSelect), menuAfterSelect)
  await evaluate(
    cdp,
    `(() => {
       getSelection().removeAllRanges()
       document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
       return true
     })()`
  )

  /* ---------------- narrow inputs + shortcut entry ---------------- */

  await evaluate(cdp, `[...document.querySelectorAll('.tbtn')].find(b => b.textContent === '查找').click()`)
  await waitFor(cdp, `!!document.querySelector('.find-input')`, '查找框出现')
  check(
    '查找框不是一条长条',
    (await evaluate(cdp, `Math.round(document.querySelector('.find-input').getBoundingClientRect().width)`)) <= 240
  )
  await evaluate(cdp, `document.querySelector('.find-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  await evaluate(cdp, `document.querySelector('#btn-keys').click()`)
  if (await waitFor(cdp, `document.querySelectorAll('.key-row').length >= 10`, '标题栏能直接打开快捷键一览')) {
    check('标题栏能直接打开快捷键一览', true)
  }
  check(
    '快捷键一览分「应用」和「终端」两段',
    (await evaluate(cdp, `document.querySelectorAll('.keys-title').length`)) === 2
  )
  check(
    '内置快捷键表包含编辑器与常用 shell 键',
    /Ctrl \+ S/.test(await evaluate(cdp, `[...document.querySelectorAll('.keys kbd')].map(k => k.textContent).join('|')`)) &&
      /Ctrl \+ R/.test(await evaluate(cdp, `[...document.querySelectorAll('.keys kbd')].map(k => k.textContent).join('|')`))
  )
  await evaluate(cdp, `document.querySelector('#overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '快捷键面板关闭')

  /* ---------------- private key library ---------------- */

  await evaluate(cdp, `document.querySelector('#btn-keyring').click()`)
  if (await waitFor(cdp, `document.querySelectorAll('.key-item').length === 1`, '私钥管理列出已归档的密钥')) {
    check('私钥管理列出已归档的密钥', true)
  }
  check(
    '私钥行显示名称、备注与路径',
    (await evaluate(cdp, `document.querySelector('.key-item .key-name').textContent`)) === '冒烟密钥' &&
      (await evaluate(cdp, `document.querySelector('.key-item .key-path').textContent`)).includes('本地测试')
  )

  await evaluate(cdp, `document.querySelector('.key-item').click()`)
  await waitFor(cdp, `document.querySelectorAll('.modal .field input').length === 2`, '私钥编辑面板出现')
  await evaluate(
    cdp,
    `(() => {
       const [name, comment] = document.querySelectorAll('.modal .field input')
       name.value = '生产跳板机'
       comment.value = '只给 prod 用'
       ;[...document.querySelectorAll('.modal footer .btn')].find(b => b.textContent === '保存').click()
       return true
     })()`
  )
  await sleep(300)
  const keySaved = JSON.parse(readFileSync(join(profile, 'liteshell.json'), 'utf8'))
  check(
    '私钥改名与备注落盘',
    keySaved.keys?.[0]?.name === '生产跳板机' && keySaved.keys?.[0]?.comment === '只给 prod 用',
    JSON.stringify(keySaved.keys)
  )
  check(
    '保存后回到列表并刷新',
    await waitFor(cdp, `document.querySelector('.key-item .key-name')?.textContent === '生产跳板机'`, '列表刷新')
  )
  await evaluate(cdp, `document.querySelector('#overlay .modal footer .btn.primary').click()`)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '私钥面板关闭')

  /* ---------------- folder context menu ---------------- */

  const folderMenu = await evaluate(
    cdp,
    `(() => {
       const node = document.querySelector('.node[data-kind="folder"]')
       node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 180 }))
       return [...document.querySelectorAll('#menu > div')].map(d => d.textContent).join('|')
     })()`
  )
  check(
    '目录右键有导入与导出',
    /导入 FinalShell 连接文件/.test(folderMenu) && /导出此文件夹/.test(folderMenu),
    folderMenu
  )
  await evaluate(cdp, `document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)

  const connMenu = await evaluate(
    cdp,
    `(() => {
       const node = document.querySelector('.node[data-kind="connection"]')
       node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 220 }))
       return [...document.querySelectorAll('#menu > div')].map(d => d.textContent).join('|')
     })()`
  )
  check('连接右键有配置免密登录', /配置本机免密登录/.test(connMenu), connMenu)
  await evaluate(cdp, `document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)

  /* ---------------- pick a key in the connection editor ---------------- */

  // Identified by an option carrying the library path: the modal has several selects.
  const KEY_SELECT = `[...document.querySelectorAll('.modal select')].find(s => [...s.options].some(o => o.value === ${JSON.stringify(libraryKey)}))`

  const openEditor = async (label) => {
    await evaluate(
      cdp,
      `(() => {
         const node = [...document.querySelectorAll('.node')].find(n => n.textContent.includes('${label}'))
         node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 }))
         return true
       })()`
    )
    await waitFor(cdp, `!!document.querySelector('#menu')`, '连接右键菜单')
    await evaluate(cdp, `[...document.querySelectorAll('#menu > div')].find(d => d.textContent === '编辑').click()`)
    await waitFor(cdp, `!!document.querySelector('.modal select')`, '连接编辑面板')
  }

  await openEditor('local-smoke')
  check('私钥下拉自动选中连接已有的密钥', (await evaluate(cdp, `${KEY_SELECT}?.value`)) === libraryKey)
  check(
    '下拉里列的是密钥名称而不是路径',
    (await evaluate(cdp, `${KEY_SELECT}?.selectedOptions[0].textContent`)).startsWith('生产跳板机 — '),
    await evaluate(cdp, `${KEY_SELECT}?.selectedOptions[0].textContent`)
  )
  check(
    '选中项下方给出实际路径',
    (await evaluate(cdp, `document.querySelector('.modal .key-path').textContent`)) === libraryKey
  )
  check(
    '编辑面板提供导入与浏览',
    (await evaluate(cdp, `[...document.querySelectorAll('.modal .row-inline .btn')].map(b => b.textContent).join('|')`)) ===
      '导入|浏览'
  )

  // Saving without touching the picker must not clear the path.
  await evaluate(cdp, `[...document.querySelectorAll('.modal footer .btn')].find(b => b.textContent === '保存').click()`)
  await sleep(400)
  const afterSave = JSON.parse(readFileSync(join(profile, 'liteshell.json'), 'utf8'))
  check(
    '原样保存不会丢掉私钥路径',
    afterSave.connections.find((c) => c.id === 'smoke')?.privateKeyPath === libraryKey,
    JSON.stringify(afterSave.connections.find((c) => c.id === 'smoke')?.privateKeyPath)
  )

  // A path outside the library must survive too — that is the imported/hand-typed case.
  await openEditor('local-loose')
  check(
    '不在私钥库的路径仍然保留为可选项',
    (await evaluate(cdp, `${KEY_SELECT}?.selectedOptions[0].textContent`)).includes('不在私钥库'),
    await evaluate(cdp, `${KEY_SELECT}?.selectedOptions[0].textContent`)
  )
  await evaluate(cdp, `[...document.querySelectorAll('.modal footer .btn')].find(b => b.textContent === '保存').click()`)
  await sleep(400)
  const looseSave = JSON.parse(readFileSync(join(profile, 'liteshell.json'), 'utf8'))
  check(
    '不在库里的路径原样保住',
    looseSave.connections.find((c) => c.id === 'loose')?.privateKeyPath === looseKeyPath,
    JSON.stringify(looseSave.connections.find((c) => c.id === 'loose')?.privateKeyPath)
  )

  /* ---------------- command palette ---------------- */

  await evaluate(cdp, `document.querySelector('#btn-quick').click()`)
  if (await waitFor(cdp, `document.querySelectorAll('.pal-item').length > 50`, '命令面板列出内置命令')) {
    check('命令面板列出内置命令', true)
  }
  const palCount = await evaluate(cdp, `document.querySelectorAll('.pal-item').length`)
  check('内置命令数量够多', palCount >= 100, `${palCount} 条`)
  check('面板按分组分段', (await evaluate(cdp, `document.querySelectorAll('.palette .keys-title').length`)) >= 8)
  check(
    '每条命令都配中文说明',
    await evaluate(cdp, `[...document.querySelectorAll('.pal-hint')].every(h => h.textContent.trim().length > 1)`)
  )

  const typeInPalette = (value) =>
    evaluate(
      cdp,
      `(() => {
         const box = document.querySelector('.palette-body input')
         box.value = ${JSON.stringify(value)}
         box.dispatchEvent(new Event('input', { bubbles: true }))
         return true
       })()`
    )

  await typeInPalette('显存')
  const filtered = await evaluate(cdp, `[...document.querySelectorAll('.pal-item code')].map(c => c.textContent).join('|')`)
  check('按说明搜索能筛出命令', filtered.includes('nvidia-smi'), filtered)
  check('过滤后条数变少', (await evaluate(cdp, `document.querySelectorAll('.pal-item').length`)) < palCount)

  await typeInPalette('')
  await evaluate(cdp, `[...document.querySelectorAll('.pal-item')].find(r => r.textContent.startsWith('free -h')).click()`)
  check('点选后命令面板关闭', await waitFor(cdp, `document.querySelector('#overlay').hidden`, '命令面板关闭'))
  check(
    '命令被填进输入行而不是直接执行',
    await waitFor(cdp, `document.querySelector('.xterm-rows')?.textContent?.includes('free -h')`, '命令填入输入行')
  )
  await key('u', 85, 2)

  /* ---------------- theme switching ---------------- */

  const themeBefore = await evaluate(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)
  await evaluate(cdp, `document.querySelector('#btn-theme').click()`)
  if (await waitFor(cdp, `document.querySelectorAll('.theme-card').length >= 6`, '主题面板列出多个主题')) {
    check('主题面板列出多个主题', true)
  }
  await evaluate(cdp, `document.querySelector('.theme-card[data-theme-key="paper"]').click()`)
  // pickTheme persists first, so the recolor lands a tick after the click.
  await waitFor(cdp, `document.body.dataset.theme === 'paper'`, '主题切换已生效')
  const themeAfter = await evaluate(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)
  check('切换主题会改掉界面底色', themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`)
  check('亮色主题把 chrome 也切了', (await evaluate(cdp, `document.body.dataset.chrome`)) === 'light')
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '完成').click()`
  )
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '主题面板关闭')
  // Back to the default so the later assertions read against a known palette.
  await evaluate(cdp, `document.querySelector('#btn-theme').click()`)
  await evaluate(cdp, `document.querySelector('.theme-card[data-theme-key="liteshell"]').click()`)
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '完成').click()`
  )

  /* ---------------- password prompt + log panel ---------------- */

  // Click the password connection, which has no stored secret. It must ask first.
  await evaluate(
    cdp,
    `(() => {
       const n = [...document.querySelectorAll('.node')].find(n => n.querySelector('.label')?.textContent === 'local-pw')
       n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
     })()`
  )
  if (
    await waitFor(
      cdp,
      `!!document.querySelector('#overlay .modal h2')?.textContent?.includes('需要密码')`,
      '密码认证连接弹出补录密码框'
    )
  ) {
    check('无密码的连接会先问密码，而不是空密码硬连', true)
  }
  check(
    '密码框标题带上目标主机',
    /smoke@127\.0\.0\.1/.test(await evaluate(cdp, `document.querySelector('#overlay .modal .field label').textContent`))
  )

  // The smoke server only accepts publickey, so this lands in the failure path —
  // which is exactly what the log panel has to explain.
  await evaluate(cdp, `document.querySelector('#overlay .modal input[type=password]').value = 'wrong-on-purpose'`)
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '连接').click()`
  )
  if (
    await waitFor(
      cdp,
      `document.querySelectorAll('.tab').length === 2 && document.querySelectorAll('.notice.error').length > 0`,
      '密码错误时给出失败提示'
    )
  ) {
    check('认证失败会新建标签页并提示错误', true)
  }
  if (process.env.SMOKE_DEBUG) {
    await evaluate(cdp, `document.querySelector('#btn-log').click()`)
    console.log('DEBUG\n' + (await evaluate(cdp, `document.querySelector('.log-view').textContent`)))
  }
  check(
    '错误提示内容非空',
    (await evaluate(cdp, `document.querySelector('.notice.error').textContent.length`)) > 10
  )

  // The log has to carry both the connection attempt and the failure.
  await evaluate(cdp, `document.querySelector('#btn-log').click()`)
  if (await waitFor(cdp, `!!document.querySelector('.log-view')`, '日志面板打开')) {
    check('日志面板可打开', true)
  }
  const logText = await evaluate(cdp, `document.querySelector('.log-view').textContent`)
  check('日志记录了连接尝试', /连接 smoke@127\.0\.0\.1:\d+（password）/.test(logText))
  check('日志记录了失败原因', /连接失败：/.test(logText))
  check('日志记录了 SSH 握手细节', /\[local-pw\]/.test(logText))
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '关闭').click()`
  )
  check('日志面板可关闭', await evaluate(cdp, `document.querySelector('#overlay').hidden`))

  /* ---------------- CLI：agent 走的就是这条路 ---------------- */

  const CLI = join(root, 'skills', 'liteshell', 'bin', 'liteshell-cli.mjs')
  // Async on purpose: this process also runs the fake SSH server, so blocking the
  // event loop here would stall the very handshake we are waiting on.
  const cli = (...args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, LITESHELL_CLI_TAG: 'smoke' }
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => p.kill(), 60_000)
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('close', (status) => {
        clearTimeout(timer)
        let json = null
        try {
          json = JSON.parse(out.trim().split('\n').pop())
        } catch {
          // json stays null; the check printing raw output is the diagnosis
        }
        resolve({ status, json, raw: out + err })
      })
    })

  // The installed copy is the one an agent actually runs. If it has drifted from
  // the one just exercised, this test would be vouching for the wrong file.
  const installedCli = join(homedir(), '.claude', 'skills', 'liteshell', 'bin', 'liteshell-cli.mjs')
  if (existsSync(installedCli)) {
    check(
      '技能目录里装的那份 CLI 和仓库这份一致',
      readFileSync(installedCli, 'utf8') === readFileSync(CLI, 'utf8'),
      '把 skills/liteshell 重新复制到 ~/.claude/skills/'
    )
  }

  const listed = await cli('conns')
  check(
    'CLI 列出可用连接，且不带出私钥路径',
    listed.json?.ok === true &&
      listed.json.connections?.some((c) => c.name === 'local-smoke' && c.host === '127.0.0.1') &&
      !JSON.stringify(listed.json).includes('privateKeyPath'),
    listed.raw.trim()
  )

  const tabsBeforeCli = await evaluate(cdp, `document.querySelectorAll('.tab').length`)
  const connsBeforeCli = connCount
  const ran = await cli('exec', 'local-smoke', 'echo CLI_MARK')
  check(
    'CLI 跑通一条命令，stdout/stderr/退出码各归各位',
    ran.json?.ok === true &&
      ran.json.stdout.trim() === 'ran:echo CLI_MARK' &&
      ran.json.stderr.trim() === 'warning line' &&
      ran.json.code === 3,
    JSON.stringify(ran.json)
  )
  // The whole point of the exit-status split: a command that ran and failed is
  // success for the tooling, and the caller reads `code`.
  check('远端退出码是数据不是失败，CLI 自己仍退 0', ran.status === 0, `exit=${ran.status}`)
  check(
    'CLI 的会话在界面上开了标签页，用户能看着',
    (await evaluate(cdp, `document.querySelectorAll('.tab').length`)) === tabsBeforeCli + 1,
    `tabs ${tabsBeforeCli} -> ${await evaluate(cdp, `document.querySelectorAll('.tab').length`)}`
  )
  // Asked for by id this time: both ways of naming a connection have to land on the
  // same live session, not a second handshake.
  const again = await cli('exec', 'smoke', 'echo CLI_MARK')
  check('用 id 也能找到同一条连接', again.json?.ok === true, JSON.stringify(again.json))
  check('第二次调用复用同一条连接，不再握手', connCount === connsBeforeCli + 1, `connections=${connCount}`)

  const cliMon = await cli('monitor', 'local-smoke')
  check(
    'CLI 拿到的是结构化资源快照',
    cliMon.json?.ok === true && Math.round(cliMon.json.snapshot?.cpu) === 35,
    JSON.stringify(cliMon.json?.snapshot?.cpu)
  )

  const made = await cli('mkdir', 'local-smoke', '/cli-made')
  check('CLI 能在远端建目录', made.json?.ok === true && existsSync(join(sftpRoot, 'cli-made')), made.raw.trim())
  const listing = await cli('ls', 'local-smoke', '/')
  check(
    'CLI 列目录看得到刚建的目录',
    !!listing.json?.entries?.some((e) => e.name === 'cli-made' && e.isDir),
    JSON.stringify(listing.json?.entries?.map((e) => e.name))
  )

  const localFile = join(work, 'cli-upload.txt')
  writeFileSync(localFile, 'hello from cli\n')
  const put = await cli('put', 'local-smoke', localFile, '/')
  check('CLI 上传文件', put.json?.ok === true && existsSync(join(sftpRoot, 'cli-upload.txt')), put.raw.trim())
  const back = await cli('cat', 'local-smoke', '/cli-upload.txt')
  check('CLI 读回远端文本', back.json?.ok === true && back.json.text === 'hello from cli\n', JSON.stringify(back.json))
  const removed = await cli('rm', 'local-smoke', '/cli-made', '--isDir')
  check('CLI 删除远端目录', removed.json?.ok === true && !existsSync(join(sftpRoot, 'cli-made')), removed.raw.trim())

  const bogus = await cli('exec', 'no-such-host', 'id')
  check(
    '连接名不存在时给出错误码和可用连接列表',
    bogus.json?.ok === false && bogus.json.error_code === 'unknown_connection' && Array.isArray(bogus.json.connections),
    JSON.stringify(bogus.json)
  )
  check('失败时退出码非 0', bogus.status === 1, `exit=${bogus.status}`)

  /* ---------------- AI 面板：从一句人话到一条真跑过的命令 ---------------- */

  // No key seeded: it would have to be ciphertext this machine can read, so it
  // gets typed in like a user would. Everything after this rides on the real
  // path — settings store, provider adapter, agent loop, gate, approval.
  const AI_BTN = `.pane.active [data-act="agent"]`
  const LOG = `document.querySelector('.pane.active .agent-log').textContent`
  const askCard = (cls) => `.pane.active .agent-ask${cls}`
  // What the user sees, not what the attribute says: a `display` rule beats
  // `[hidden]`, so a panel can be "hidden" and still be sitting on the screen.
  const shown = (sel) =>
    `((e) => !!e && getComputedStyle(e).display !== 'none')(document.querySelector('${sel}'))`
  // Waiting for idle first, because a still-running turn refuses the next Enter
  // by design (the button is "stop" then) — racing it makes the test drop
  // messages and blame the app for it.
  const sendMsg = async (text) => {
    await waitFor(
      cdp,
      `!document.querySelector('.pane.active .agent-go').classList.contains('stop')`,
      '上一轮收尾',
      60000
    )
    return evaluate(
      cdp,
      `(() => { const i = document.querySelector('.pane.active .agent-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`
    )
  }
  const answer = (label) =>
    evaluate(
      cdp,
      `[...document.querySelectorAll('.pane.active .agent-ask:not(.answered) .agent-btn')].find(b => b.textContent === ${JSON.stringify(label)}).click()`
    )

  check('当前标签页就是刚才 CLI 用的那条连接',
    (await evaluate(cdp, `document.querySelector('.tab.active .label')?.textContent`)) === 'local-smoke')
  check('还没配任何东西也看得见 AI 入口', (await evaluate(cdp, `!!document.querySelector('${AI_BTN}')`)) === true)

  // The first-run path, exactly as a new user walks it: the panel says what it
  // needs and hands over the button that gets it.
  const urlBox = `[...document.querySelectorAll('#overlay .modal input')].find(i => i.value.startsWith('http') || i.placeholder.includes('/v1'))`
  const modelBox = `[...document.querySelectorAll('#overlay .modal input[list=llm-models]')][0]`
  const save = `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '保存').click()`
  const llmState = async () => (await evaluate(cdp, `window.api.getStore().then(s => s.settings.llm)`)) ?? {}

  await evaluate(cdp, `document.querySelector('${AI_BTN}').click()`)
  check('没配置时面板明说要什么，而不是空白',
    await waitFor(cdp, `${shown('.pane.active .agent-setup')} && !${shown('.pane.active .agent-compose')}`, '未配置状态'))
  check('没配好时对话区不占着地方', (await evaluate(cdp, `${shown('.pane.active .agent-log')}`)) === false)
  await evaluate(cdp, `document.querySelector('.pane.active .agent-setup .agent-btn').click()`)
  check('面板里的按钮直接打开设置', await waitFor(cdp, `!!document.querySelector('#overlay .modal input[type=password]')`, '设置里有 AI 字段'))

  // The address goes in first, then the model comes from the endpoint — the
  // path that avoids typing a model name from memory and getting a 404.
  // Addressed the way a person addresses a gateway — host and port, no /v1.
  // The lookup has to work anyway, and it has to say the box was fixed.
  await evaluate(cdp, `(() => { const el = ${urlBox}; el.value = 'http://127.0.0.1:${LLM_PORT}' })()`)
  await evaluate(cdp, `[...document.querySelectorAll('#overlay .modal button')].find(b => b.textContent === '拉取模型').click()`)
  check('模型列表从接口拉回来，不用自己背模型名',
    await waitFor(cdp, `document.querySelectorAll('#llm-models option').length === 2 && ${modelBox}.value === 'smoke-model'`, '拉到模型列表'),
    await evaluate(cdp, `JSON.stringify({ n: document.querySelectorAll('#llm-models option').length, v: ${modelBox}.value, note: document.querySelector('#overlay .modal .llm-note').textContent })`))
  check('地址少了 /v1 时自己补上，并且说出来补了',
    (await evaluate(cdp, `document.querySelector('#overlay .modal .llm-note').textContent`)).includes('地址少了 /v1') &&
      (await evaluate(cdp, `${urlBox}.value`)) === `http://127.0.0.1:${LLM_PORT}/v1`,
    await evaluate(cdp, `document.querySelector('#overlay .modal .llm-note').textContent`))
  check('拉到几个也告诉了用户',
    (await evaluate(cdp, `document.querySelector('#overlay .modal .llm-note').textContent`)).includes('拉到 2 个模型'))

  await evaluate(cdp, save)
  check('只填地址和模型、不填 key 也算配好了',
    await waitFor(cdp, `!${shown('.pane.active .agent-setup')} && ${shown('.pane.active .agent-compose')}`, '面板就绪'))
  check('配好之后那句「还没配置模型接口」真的不在屏幕上',
    (await evaluate(cdp, `!${shown('.pane.active .agent-setup')} && ${shown('.pane.active .agent-log')}`)) === true)
  check('没有附件时那一行不占位置', (await evaluate(cdp, `!${shown('.pane.active .agent-files')}`)) === true)
  check('这条就绪状态确实没靠 key 撑', (await llmState()).hasKey !== true)

  // Now the key, which is optional but has to survive being left blank later.
  await evaluate(cdp, `document.querySelector('#btn-settings').click()`)
  await waitFor(cdp, `!!document.querySelector('#overlay .modal input[type=password]')`, '再开设置')
  // Reopening has to show what was saved — address and model are two fields,
  // and both of them are the user's to see and change.
  check('设置里那两个框还在（地址、模型分开填）',
    (await evaluate(cdp, `${urlBox}.value`)) === `http://127.0.0.1:${LLM_PORT}/v1` &&
      (await evaluate(cdp, `${modelBox}.value`)) === 'smoke-model',
    await evaluate(cdp, `JSON.stringify([...document.querySelectorAll('#overlay .modal input')].map(i => i.value))`))

  await evaluate(cdp, `document.querySelector('#overlay .modal input[type=password]').value = 'smoke-key'`)
  await evaluate(cdp, save)
  check('保存后设置自己关掉', await waitFor(cdp, `document.querySelector('#overlay').hidden`, '设置关闭'))
  check('key 填了就存下来', (await llmState()).hasKey === true, JSON.stringify(await llmState()))

  // Reading it is half the feature: the panel has to be wide enough for a
  // command and its output, and able to take the whole pane when it needs it.
  check('AI 面板比终端时代默认宽得多',
    (await evaluate(cdp, `document.querySelector('.pane.active .agent').getBoundingClientRect().width`)) >= 500)
  const wideBtn = `document.querySelector('.pane.active .agent-wide')`
  await evaluate(cdp, `${wideBtn}.click()`)
  check('⤢ 之后终端让位，面板真的占满',
    await waitFor(cdp, `!${shown('.pane.active .term-box')}`, '终端让位') &&
      (await evaluate(cdp, `(() => {
        const a = document.querySelector('.pane.active .agent').getBoundingClientRect()
        const r = document.querySelector('.pane.active .term-row').getBoundingClientRect()
        window.__wide = a.width + ' / ' + r.width
        return a.width >= r.width - 2
      })()`)) === true,
    await evaluate(cdp, `window.__wide`))
  await evaluate(cdp, `${wideBtn}.click()`)
  check('再点一次终端回来', await waitFor(cdp, `${shown('.pane.active .term-box')}`, '终端回来'))

  const beforeA = llmSeen.length
  await sendMsg('根目录有什么')
  check('只读的 ls 不问就直接跑了', await waitFor(cdp, `!!document.querySelector('.pane.active .agent-log .agent-step-body')`, 'ls 结果', 30000))
  check('工具行写的是它真的要跑的那条',
    (await evaluate(cdp, `document.querySelector('.pane.active .agent-step-head').textContent`)) === 'ls /')
  check('命令和它的输出在同一个折叠块里，不是两个各自漂着的块',
    (await evaluate(cdp, `(() => {
      const s = document.querySelector('.pane.active .agent-step')
      return !!s.querySelector('.agent-step-body') && s.textContent.length > s.querySelector('.agent-step-head').textContent.length
    })()`)) === true)
  check('只读工具一张确认卡都没弹', (await evaluate(cdp, `document.querySelectorAll('.pane.active .agent-ask').length`)) === 0)
  check('模型拿到的是系统提示 + 用户那句话',
    llmSeen[beforeA]?.messages?.[0]?.role === 'system' &&
      llmSeen[beforeA].messages.some((m) => m.role === 'user' && m.content === '根目录有什么'),
    JSON.stringify(llmSeen[beforeA]?.messages?.[0]))

  await sendMsg('把根目录清空')
  check('改动服务器的命令要确认，且这条被标成最高风险',
    await waitFor(cdp, `!!document.querySelector('${askCard('.risk-critical')}')`, '高危确认卡', 30000))
  check('卡片上就是模型要跑的那条命令',
    (await evaluate(cdp, `document.querySelector('${askCard('.risk-critical')} .agent-ask-cmd').value`)) === 'rm -rf /')
  await answer('拒绝')
  check('拒绝后卡片落定', await waitFor(cdp, `${LOG}.includes('已拒绝')`, '卡片收尾'))
  check('拒绝这件事本身回给了模型，它没有换个写法硬来',
    await waitFor(cdp, `${LOG}.includes('好，那我不动它。')`, '模型接受拒绝', 30000) &&
      llmSeen.at(-1).messages.some((m) => m.role === 'tool' && String(m.content).startsWith('用户拒绝')))

  await sendMsg('跑一下 echo 试试')
  // `echo` only prints, so it is not destructive and goes straight through.
  // The whole point of this route: the command the model asked for is typed
  // into the terminal the user is looking at, not run out of sight.
  check('只读的 exec 不问就直接跑了：输出和退出码都在结果里',
    await waitFor(cdp, `${LOG}.includes('ran:echo CLI_MARK') && ${LOG}.includes('exit=3') && ${LOG}.includes('warning line')`, '命令结果', 30000))
  check('那条命令是打在左边终端里的',
    await waitFor(cdp, `document.querySelector('.pane.active .xterm-rows')?.textContent?.includes('echo CLI_MARK')`, '命令进终端', 30000))
  check('既然不问，就真的不该有卡停在那里等人点',
    (await evaluate(cdp, `document.querySelectorAll('.pane.active .agent-ask:not(.answered)').length`)) === 0)

  await sendMsg('来点长输出')
  await waitFor(cdp, `!!document.querySelector('${askCard(':not(.answered)')}')`, '长输出确认卡', 30000)
  await answer('执行')
  check('长输出溢出成文件，模型拿着 handle 读回了中间那段',
    await waitFor(cdp, `${LOG}.includes('已存为') && ${LOG}.includes('第 150-154 行')`, 'read_output 结果', 30000))
  check('溢出后的对话还能继续', (await evaluate(cdp, `${LOG}.includes('中间那段看到了。')`)) === true)

  // The paperclip, driven through the preload API instead of a click — the
  // native picker cannot be driven from here, and this is the same call the
  // button makes. The model then reads the file back off the server itself, so
  // the whole chain (local file → upload → remote path in the prompt → tool) is
  // under test, not just the upload call.
  const attachLocal = join(work, 'attach-smoke.txt')
  writeFileSync(attachLocal, 'ATTACH_BODY_9\n')
  await cli('mkdir', 'local-smoke', '/tmp')
  const attachSid = await evaluate(cdp, `document.querySelector('.pane.active').dataset.session`)
  await evaluate(
    cdp,
    `void window.api.agentSend(${JSON.stringify(attachSid)}, 'smoke', '看看我刚传上去的附件', [${JSON.stringify(attachLocal)}])`
  )
  check('附件传上去了，面板说得也明白',
    await waitFor(cdp, `${LOG}.includes('已上传到服务器：/tmp/attach-smoke.txt')`, '附件上传', 30000))
  check('落地的就是那个文件的字节',
    existsSync(join(sftpRoot, 'tmp', 'attach-smoke.txt')) &&
      readFileSync(join(sftpRoot, 'tmp', 'attach-smoke.txt'), 'utf8') === 'ATTACH_BODY_9\n')
  check('远端路径跟着那句话一起给了模型，它才知道去哪读',
    llmSeen.at(-1)?.messages?.some(
      (m) => m.role === 'user' && String(m.content).includes('【附件已经传到服务器上了：/tmp/attach-smoke.txt】')
    ) === true)
  check('模型顺着那个路径把附件读回来了',
    await waitFor(cdp, `${LOG}.includes('ATTACH_BODY_9')`, '读到附件内容', 30000))

  // "Sent, and then nothing" — the report this test exists to prevent. The
  // endpoint stalls on purpose; the panel has to say so the whole time.
  await sendMsg('慢慢地想想')
  check('请求还没回来时，面板上写着它在等',
    (await evaluate(cdp, `document.querySelector('.pane.active .agent-msg.pending')?.textContent ?? ''`)).includes('正在请求'))
  check('回复一到，那一行就换成了真内容',
    await waitFor(cdp, `${LOG}.includes('来了，慢是因为它在想。') && !document.querySelector('.pane.active .agent-msg.pending')`, '慢回复落地', 30000))

  await sendMsg('停下来试试')
  check('等确认的时候那颗按钮是「停止」',
    await waitFor(cdp, `!!document.querySelector('${askCard(':not(.answered)')}') && document.querySelector('.pane.active .agent-go').classList.contains('stop')`, '等确认卡', 30000))
  await evaluate(cdp, `document.querySelector('.pane.active .agent-go').click()`)
  check('同一颗按钮，跑着的时候按下去就是停',
    await waitFor(cdp, `${LOG}.includes('已取消') && !document.querySelector('.pane.active .agent-go').classList.contains('stop')`, '停止生效', 30000))
  check('中止和「用户拒绝」分开说，模型不会以为是自己被否了', (await evaluate(cdp, `${LOG}.includes('已停止')`)) === true)

  /* ---------------- 换成 Anthropic：同一套循环，另一套协议 ---------------- */

  // Only the key is left alone here — the dialog sends no apiKey, which has to
  // mean "keep what is on file" rather than "wipe it".
  await evaluate(cdp, `document.querySelector('#btn-settings').click()`)
  await waitFor(cdp, `!!document.querySelector('#overlay .modal input[type=password]')`, '再开设置')
  await evaluate(
    cdp,
    `(() => {
      const modal = document.querySelector('#overlay .modal')
      const pick = (v) => [...modal.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === v))
      pick('anthropic').value = 'anthropic'
      ;[...modal.querySelectorAll('input')].find(i => i.value.startsWith('http')).value = 'http://127.0.0.1:${LLM_PORT}'
    })()`
  )
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '保存').click()`
  )
  check('保存后设置自己关掉', await waitFor(cdp, `document.querySelector('#overlay').hidden`, '设置关闭'))
  check('密钥留空保存不会把它抹掉', (await llmState()).hasKey === true, JSON.stringify(await llmState()))

  await sendMsg('根目录有什么')
  // The reset lands with the first message to the new endpoint — that is the
  // moment the transcript would otherwise be sent somewhere it cannot be read.
  check('换了接口，旧对话不再硬塞给新接口', await waitFor(cdp, `${LOG}.includes('从这里重新开始')`, '接口切换提示'))
  check('Anthropic 那边也跑起来了：一轮里两个只读调用都执行了',
    await waitFor(
      cdp,
      `(() => {
         const heads = [...document.querySelectorAll('.pane.active .agent-step-head')].map(h => h.textContent)
         return heads.includes('ls /') && heads.some(h => h.startsWith('monitor'))
       })()`,
      '两个工具都跑了',
      30000))
  check('Anthropic 的 system 是顶层参数，没被忘掉',
    typeof claudeSeen[0]?.system === 'string' && claudeSeen[0].system.includes('规矩'))
  check('换接口之后的历史是干净的（只有这一句话）',
    claudeSeen[0]?.messages?.length === 1 && claudeSeen[0].messages[0].role === 'user')
  check('并行调用的结果并回一条 user 消息里，不是拆成两条',
    claudeSeen[1]?.messages?.at(-1)?.role === 'user' &&
      Array.isArray(claudeSeen[1].messages.at(-1).content) &&
      claudeSeen[1].messages.at(-1).content.length === 2 &&
      claudeSeen[1].messages.at(-1).content.every((b) => b.type === 'tool_result'),
    JSON.stringify(claudeSeen[1]?.messages?.at(-1))?.slice(0, 200))
  check('上一轮的 tool_use 原样回传（改动过的 thinking/tool 块会 400）',
    (claudeSeen[1]?.messages?.at(-2)?.content ?? []).some((b) => b.type === 'tool_use' && b.id === 'toolu_smoke_1') &&
      (claudeSeen[1]?.messages?.at(-2)?.content ?? []).some((b) => b.type === 'tool_use' && b.id === 'toolu_smoke_2'))
  check('Anthropic 这一轮也收尾了', await waitFor(cdp, `${LOG}.includes('这台机器看过了。')`, 'Anthropic 回复', 30000))

  // A model name the endpoint does not have. The request fails in under a
  // second, and the panel has to show why instead of leaving the user staring
  // at a button that did nothing.
  await evaluate(cdp, `document.querySelector('#btn-settings').click()`)
  await waitFor(cdp, `!!document.querySelector('#overlay .modal input[type=password]')`, '开设置改模型')
  await evaluate(cdp, `(() => { ${modelBox}.value = 'no-such-model' })()`)
  await evaluate(cdp, save)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '设置关闭')
  await sendMsg('随便问问')
  check('模型名不对时错在面板上，不是一片安静',
    await waitFor(cdp, `${LOG}.includes('模型名或接口地址不对（404）')`, '404 显示出来', 30000))

  // The same silence from the other direction: the endpoint answers 200 with a
  // web page, the stream carries no chunks, and the turn comes back empty.
  // This is what "发送你好没有响应" actually was.
  await evaluate(cdp, `document.querySelector('#btn-settings').click()`)
  await waitFor(cdp, `!!document.querySelector('#overlay .modal input[type=password]')`, '开设置改模型')
  // Back to the OpenAI dialect, and with the address left as the bare host —
  // the exact configuration that produced the silence.
  await evaluate(
    cdp,
    `(() => {
      const modal = document.querySelector('#overlay .modal')
      const pick = (v) => [...modal.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === v))
      pick('openai').value = 'openai'
      ;${modelBox}.value = 'empty-page'
    })()`
  )
  await evaluate(cdp, save)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '设置关闭')
  await sendMsg('你好')
  check('接口回了空内容也说出来，而不是一声不吭',
    await waitFor(cdp, `${LOG}.includes('接口回了空内容')`, '空回复提示', 30000),
    await evaluate(cdp, LOG))

  /* ---------------- ai panel in its own window ---------------- */

  await evaluate(cdp, `document.querySelector('.pane.active [title="在独立窗口中打开 AI 面板"]').click()`)
  await sleep(1500)
  const pages = async () => (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json())
  const aiTarget = (await pages()).find((t) => t.type === 'page' && t.url.includes('agent='))
  check('AI 面板能弹成独立窗口', !!aiTarget)
  if (aiTarget) {
    const cdpAi = await connect(aiTarget.webSocketDebuggerUrl)
    check(
      '独立窗口里只有 AI 面板',
      await evaluate(cdpAi, `!!document.querySelector('.agent.agent-standalone') && !document.querySelector('#body').offsetParent`)
    )
    check(
      '已经聊过的内容被带进独立窗口',
      await waitFor(cdpAi, `document.querySelectorAll('.agent-msg').length > 0`, '回放对话', 15000)
    )
    check(
      '回复以卡片和渲染后的 Markdown 呈现',
      await evaluate(cdpAi, `!!document.querySelector('.agent-msg.assistant.md p')`)
    )
    check(
      '弹出去之后原来那个侧面板自己收起来（对话只有一个输入框）',
      await waitFor(cdp, `document.querySelector('.pane.active .agent').style.display === 'none'`, '侧面板收起', 15000)
    )
    // Typing in the window reaches the same conversation, and the reply comes
    // back here — that is the whole point of handing it over.
    await evaluate(cdpAi, `(() => {
      const box = document.querySelector('.agent-input')
      box.value = '跑一下 echo 试试'
      document.querySelector('.agent-go').click()
    })()`)
    check('在独立窗口里发的话，回复也落在独立窗口',
      await waitFor(cdpAi, `document.querySelector('.agent-log').textContent.includes('跑完了')`, '独立窗口交互', 30000))
    check('主窗口的侧面板没有跟着再长出一条新消息',
      (await evaluate(cdp, `document.querySelectorAll('.pane.active .agent-log .agent-msg.user').length`)) === 0 ||
        (await evaluate(cdp, `document.querySelector('.pane.active .agent').style.display === 'none'`)))
    await evaluate(cdpAi, `document.querySelector('.panel-x').click()`)
    await sleep(800)
    check('独立窗口的 X 关掉窗口', !(await pages()).some((t) => t.type === 'page' && t.url.includes('agent=')))
    cdpAi.close()
  }

  /* ---------------- saved conversations ---------------- */

  // Everything sent above lands in a saved transcript, keyed by the connection
  // rather than the tab: closing the tab keeps what was asked.
  const history = JSON.parse(
    await evaluate(cdp, `window.api.agentHistory('smoke').then(l => JSON.stringify(l))`)
  )
  check('聊过的话存进了这台机器的历史', history.length >= 1, `got ${history.length}`)
  check('标题是这段对话里的第一句话', typeof history[0]?.title === 'string' && history[0].title.length > 0, JSON.stringify(history[0]))
  check('别的机器看不到这段对话',
    JSON.parse(await evaluate(cdp, `window.api.agentHistory('smoke-pw').then(l => JSON.stringify(l))`)).length === 0)

  await evaluate(cdp, `document.querySelector('.pane.active [title="查看并导出这台机器的历史对话"]').click()`)
  check('面板上的「历史」列出存下来的对话',
    await waitFor(cdp, `document.querySelectorAll('#overlay .hist-item').length >= 1`, '历史列表'))
  await evaluate(cdp, `document.querySelector('#overlay .hist-item').click()`)
  check('打开一条历史能看到当时的提问',
    await waitFor(cdp, `!!document.querySelector('#overlay .history-view .agent-msg.user')`, '历史正文'))
  check('历史里的回复也是渲染过的 Markdown',
    await evaluate(cdp, `!!document.querySelector('#overlay .history-view .agent-msg.assistant.md')`))
  check('历史对话里能接着问', await evaluate(cdp,
    `[...document.querySelectorAll('#overlay .modal footer .btn')].some(b => b.textContent === '继续这个对话')`))
  await evaluate(cdp, `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '继续这个对话').click()`)
  check('继续之后的历史真的回到了面板里（面板打开、问题都在、确认卡不能点）',
    await waitFor(cdp, `(() => {
      const log = document.querySelector('.pane.active .agent-log')
      const panel = document.querySelector('.pane.active .agent')
      return document.querySelector('#overlay').hidden && panel.style.display !== 'none' &&
        log.querySelectorAll('.agent-msg.user').length > 0 &&
        [...log.querySelectorAll('.agent-ask')].every(c => !c.querySelector('.agent-ask-btns'))
    })()`, '继续历史对话'))
  await evaluate(cdp, `document.querySelector('.pane.active [title="查看并导出这台机器的历史对话"]').click()`)
  check('返回回到列表', await waitFor(cdp, `document.querySelectorAll('#overlay .hist-item').length >= 1`, '回到列表'))
  await evaluate(cdp, `document.querySelector('#overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '历史面板关闭')

  /* ---------------- popped-out tab ---------------- */

  check('已连接的标签打着绿点', await evaluate(cdp, `!!document.querySelector('#tabs .tab.live .tdot')`))
  const tabCount = await evaluate(cdp, `document.querySelectorAll('#tabs .tab').length`)
  check('至少有一个标签可以弹出', tabCount > 0, `tabs=${tabCount}`)
  await evaluate(
    cdp,
    `(() => {
       const tab = document.querySelector('#tabs .tab.live') || document.querySelector('#tabs .tab')
       tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))
       return true
     })()`
  )
  check(
    '标签右键菜单列出了会话操作',
    await evaluate(
      cdp,
      `(() => {
         const labels = [...document.querySelectorAll('#menu div')].map(d => d.textContent)
         return ['复制标签', '连接', '连接全部', '断开', '关闭', '关闭其他', '关闭全部']
           .every(l => labels.includes(l))
       })()`
    )
  )
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#menu div')].find(d => d.textContent === '在新窗口中打开').click()`
  )
  await sleep(2000)
  const popTarget = (
    await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  ).find((t) => t.type === 'page' && t.url.includes('attach='))
  check('独立窗口开了出来', !!popTarget)
  if (popTarget) {
    const cdpPop = await connect(popTarget.webSocketDebuggerUrl)
    check(
      '独立窗口里的标签也是绿的',
      await evaluate(cdpPop, `!!document.querySelector('#tabs .tab.live .tdot')`)
    )
    check('独立窗口里有终端', await evaluate(cdpPop, `!!document.querySelector('.term-box .xterm')`))
    check(
      '原来那个窗口里的标签移走了',
      await waitFor(
        cdp,
        `document.querySelectorAll('#tabs .tab').length === ${tabCount - 1}`,
        '原窗口标签移出'
      )
    )
    // Closing it is the end of that session; the main window's own tabs stay.
    await evaluate(cdpPop, `window.close()`).catch(() => undefined)
    cdpPop.close()
    await sleep(500)
  }

  // 断开 leaves the tab in place and turns its dot red.
  if (await evaluate(cdp, `!!document.querySelector('#tabs .tab.live')`)) {
    await evaluate(
      cdp,
      `(() => {
         document.querySelector('#tabs .tab.live')
           .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))
         return true
       })()`
    )
    await evaluate(cdp, `[...document.querySelectorAll('#menu div')].find(d => d.textContent === '断开').click()`)
    check(
      '断开之后标签还在，点变红',
      await waitFor(cdp, `!!document.querySelector('#tabs .tab.failed .tdot')`, '断开后的红点')
    )
  }

  /* ---------------- embedded remote desktop ---------------- */

  // The smoke SSH server has no RDP service and refuses direct-tcpip. That is
  // enough to exercise the whole path through its failure: menu → dialog → SSH
  // → proxy → WASM client in its own window → a readable error. The happy path
  // needs a real GNOME/xrdp host, which a smoke run cannot provide.
  await evaluate(cdp, `(() => {
    const node = [...document.querySelectorAll('.node')].find(n => n.querySelector('.label')?.textContent === 'local-smoke')
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }))
  })()`)
  await evaluate(
    cdp,
    `[...document.querySelectorAll('#menu div')].find(d => d.textContent === '远程桌面 (RDP)…').click()`
  )
  check(
    '连接菜单能打开远程桌面对话框',
    await waitFor(
      cdp,
      `document.querySelector('#overlay .modal h2')?.textContent === '远程桌面 — local-smoke'`,
      '远程桌面对话框'
    )
  )
  await evaluate(cdp, `(() => {
    const wrap = [...document.querySelectorAll('#overlay .field')].find(f => f.querySelector('label')?.textContent.includes('RDP 密码'))
    wrap.querySelector('input').value = 'smoke-rdp'
    ;[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '内嵌打开').click()
  })()`)
  let deskTarget
  for (let i = 0; i < 60 && !deskTarget; i++) {
    await sleep(500)
    deskTarget = (
      await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    ).find((t) => t.type === 'page' && t.url.includes('desktop='))
  }
  check('内嵌远程桌面有自己的窗口', !!deskTarget)
  if (deskTarget) {
    const deskConsole = []
    const cdpDesk = await connect(deskTarget.webSocketDebuggerUrl, (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        deskConsole.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        deskConsole.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
      }
    })
    await cdpDesk.send('Runtime.enable')
    check(
      '窗口里是桌面画布，不是普通标签页',
      await evaluate(
        cdpDesk,
        `document.body.classList.contains('desktop-popout') && !!document.querySelector('canvas.desktop-canvas')`
      )
    )
    check(
      '没有 RDP 服务时显示可读的错误，而不是空白画布',
      await waitFor(
        cdpDesk,
        `!document.querySelector('.desktop-error').hidden && document.querySelector('.desktop-error').textContent.trim().length > 0`,
        '桌面错误提示',
        45000
      ),
      await evaluate(cdpDesk, `document.querySelector('.desktop-error').textContent`)
    )
    check(
      '状态条说连接失败',
      await evaluate(cdpDesk, `document.querySelector('.desktop-status').textContent === '连接失败'`)
    )
    const appOut = log.map(([, d]) => d).join('')
    check(
      '主进程记下了转发失败的原因和目标端口',
      /RDCleanPath failed: 转发到远端 127\.0\.0\.1:3389/.test(appOut),
      appOut.split('\n').filter((l) => l.includes('[rdp]')).slice(-5).join(' | ')
    )
    check(
      'WASM 组件在 CSP 下加载，没有安全策略报错',
      !deskConsole.some((l) => /Content Security Policy|Refused to/.test(l)),
      deskConsole.join(' | ')
    )
    await evaluate(cdpDesk, `document.querySelector('.desktop-btn[title="关闭"]').click()`).catch(() => undefined)
    cdpDesk.close()
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(300)
      gone = !(await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).some(
        (t) => t.type === 'page' && t.url.includes('desktop=')
      )
    }
    check('关掉窗口就结束了这条内嵌会话', gone)
  }

  /* ---------------- panel dividers and the updater ---------------- */

  // The monitor's divider: a drag has to change its width, not just look like a handle.
  await ensureMon(true)
  await waitFor(cdp, `!!document.querySelector('.pane.active .monitor .panel-grip')`, '监控面板把手')
  const widthBefore = await evaluate(cdp, `Math.round(document.querySelector('.pane.active .monitor').getBoundingClientRect().width)`)
  await evaluate(cdp, `(() => {
    const grip = document.querySelector('.pane.active .monitor .panel-grip')
    const r = grip.getBoundingClientRect()
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 40 }))
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left - 120, clientY: r.top + 40 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })()`)
  const widthAfter = await evaluate(cdp, `Math.round(document.querySelector('.pane.active .monitor').getBoundingClientRect().width)`)
  check('拖监控面板左侧的分隔线能改宽度', widthAfter > widthBefore + 80, `${widthBefore} → ${widthAfter}`)
  check(
    '文件面板也有同一根分隔线',
    await evaluate(cdp, `!!document.querySelector('.pane.active .files .panel-grip')`)
  )
  await ensureMon(false)

  await evaluate(cdp, `document.querySelector('#btn-settings').click()`)
  await waitFor(cdp, `!!document.querySelector('#overlay .modal h2')?.textContent?.includes('设置')`, '开设置找更新')
  check(
    '设置里有检查更新，并显示当前版本',
    await waitFor(cdp, `[...document.querySelectorAll('#overlay .modal .mon-sub')].some(s => /当前版本 \\d/.test(s.textContent))`, '版本号'),
    await evaluate(cdp, `document.querySelector('#overlay .modal').textContent`)
  )
  await evaluate(cdp, `[...document.querySelectorAll('#overlay .modal button')].find(b => b.textContent === '检查更新').click()`)
  check(
    '检查更新会去问 GitHub，并把结果（新版/最新/失败）说出来',
    await waitFor(
      cdp,
      `document.querySelector('#overlay .modal h2')?.textContent === '检查更新' &&
       /(已经是最新版本|发现新版本|检查失败)/.test(document.querySelector('#overlay .modal .content').textContent)`,
      '更新结果',
      30000
    ),
    await evaluate(cdp, `document.querySelector('#overlay .modal .content').textContent`)
  )
  await evaluate(cdp, `[...document.querySelectorAll('#overlay .modal footer .btn')].find(b => b.textContent === '关闭').click()`)
  await waitFor(cdp, `document.querySelector('#overlay').hidden`, '关掉两个对话框')

  // Last on purpose: this parks the window, so anything after it would have no
  // page left to talk to. The X has to be sent as WM_CLOSE, the message the
  // system close button sends. window.close() from the renderer is a different
  // path — it destroys the window outright and never reaches the close handler
  // — so it would prove nothing about what the user's X does.
  if (process.platform === 'win32') {
    // The handle is read before the window goes away and asked about afterwards:
    // a hidden window still has one, a destroyed window does not answer.
    const hwnd = ps(`(Get-Process -Id ${child.pid}).MainWindowHandle.ToInt64()`)
    const sent = win32(`[SmokeWin]::PostMessage([IntPtr]${hwnd}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`)
    await sleep(1500)

    // The process has to survive it: the tray is the point, and so is the CLI,
    // which is left with no main process if the app quits with the window.
    const afterClose = await cli('conns')
    check(
      '点 X 之后进程还在，CLI 照样连得上它',
      afterClose.json?.ok === true && afterClose.status === 0,
      afterClose.raw.trim()
    )
    const visible = win32(`[SmokeWin]::IsWindowVisible([IntPtr]${hwnd})`)
    check(
      '点 X 只是把窗口收进托盘',
      sent === 'True' && visible === 'False',
      `PostMessage=${sent} IsWindowVisible=${visible} hwnd=${hwnd}`
    )
  } else {
    console.log('  skip 点 X 收进托盘（只有 Windows 有这条消息）')
  }

  cdp.close()
  finish(failures)
}

function finish(code) {
  child?.kill()
  server?.close()
  llm?.close()
  setTimeout(() => {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      // best effort
    }
    console.log(code === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`)
    process.exit(code)
  }, 500)
  return code
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  finish(1)
})

process.on('uncaughtException', (err) => {
  console.error('uncaught:', err.message)
  finish(1)
})
