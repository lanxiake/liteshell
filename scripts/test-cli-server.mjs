/**
 * One CLI call, end to end: the request that arrives over the socket has to
 * show up in the AI panel as a turn — user words, intent, command, answer —
 * and the panel must see the exact output the CLI got back.
 *
 * A fake SshManager stands in for SSH; the socket is real, so this is also the
 * check that tracing did not disturb the wire protocol.
 *
 *   node scripts/test-cli-server.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { build } from 'esbuild'

// The tag makes the server listen on its own pipe and write its own discovery
// file, so a running LiteShell is neither talked to nor overwritten.
process.env.LITESHELL_CLI_TAG = `test-${Date.now().toString(36)}`

const work = mkdtempSync(join(tmpdir(), 'liteshell-cli-server-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// `app` supplies a log path, and `store` the connection list. Both are the only
// things this module reaches outside a socket for.
const stubElectron = join(work, 'electron-stub.mjs')
writeFileSync(stubElectron, `export const app = { getPath: () => ${JSON.stringify(work)} }\n`)
const stubStore = join(work, 'store-stub.mjs')
writeFileSync(
  stubStore,
  `export const store = () => ({ connections: [{ id: 'c1', name: 'web-1', host: '10.0.0.1', port: 22, username: 'root', authType: 'agent' }], folders: [] })\n`
)

const bundle = join(work, 'cli-server.mjs')
await build({
  entryPoints: ['src/main/cli-server.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { electron: stubElectron },
  // A relative path has no alias name in esbuild; a tiny plugin is the whole
  // workaround, and it keeps the real store (keychain, vault) out of the test.
  plugins: [
    {
      name: 'store-stub',
      setup(b) {
        b.onResolve({ filter: /(^|\/)store$/ }, () => ({ path: stubStore }))
      }
    }
  ],
  logLevel: 'silent'
})
const { CliServer } = await import(`file://${bundle.replaceAll('\\', '/')}`)

const traced = []
const execs = []
const manager = {
  status: 'ready',
  has: () => true,
  disconnect: () => undefined,
  interrupt: () => undefined,
  connect: (_id, sessionId) => queueMicrotask(() => srv.onEvent({ type: 'status', sessionId, status: 'ready' })),
  execInShell: (sessionId, cmd) => {
    execs.push({ sessionId, cmd })
    return Promise.resolve({ stdout: 'Filesystem  Size  Used\n/dev/sda1  20G  9G', stderr: '', code: 0, timedOut: false })
  }
}
const srv = new CliServer(
  manager,
  () => undefined,
  (sessionId, event) => traced.push({ sessionId, ...event })
)
srv.listen()

const discovery = join(tmpdir(), `liteshell-cli-${process.env.LITESHELL_CLI_TAG}.json`)
// The pipe is bound asynchronously; the file lands in its callback.
for (let i = 0; i < 100 && !existsSync(discovery); i++) await new Promise((r) => setTimeout(r, 20))
const info = JSON.parse(readFileSync(discovery, 'utf8'))

function request(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const sock = connect(info.pipe)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      sock.destroy()
      resolve(JSON.parse(buf.slice(0, nl)))
    })
    sock.on('error', reject)
  })
}

/* ---------- a turned command ---------- */

const res = await request({
  token: info.token,
  op: 'shell',
  conn: 'web-1',
  cmd: 'df -h',
  intent: '看看服务器磁盘还剩多少',
  say: '先查一下根分区占用'
})

check('CLI 还是拿到原来的回复', res.ok === true && res.stdout.includes('/dev/sda1'), JSON.stringify(res.code))
check('命令跑在它自己新建的那个会话上', execs.length === 1 && execs[0].cmd === 'df -h', JSON.stringify(execs))

const kinds = traced.map((e) => e.kind)
check(
  '面板里的顺序是 用户 → 打算 → 命令 → 结果 → 结束',
  kinds.join(',') === 'user,assistant,tool,result,done',
  kinds.join(',')
)
check('用户那条是 CLI 带过来的原话', traced[0].text === '看看服务器磁盘还剩多少' && traced[0].source === 'cli', traced[0].text)
check('打算那条是 CLI 给的说明', traced[1].text === '先查一下根分区占用', traced[1].text)
check('命令卡片写着真命令', traced[2].name === 'exec' && traced[2].detail === 'df -h', `${traced[2].name} ${traced[2].detail}`)
check('结果卡片是成功，并且带着输出', traced[3].ok === true && traced[3].summary.includes('/dev/sda1'), traced[3].summary)

/* ---------- the same intent does not repeat the user's line ---------- */

traced.length = 0
await request({ token: info.token, op: 'shell', conn: 'web-1', cmd: 'free -m', intent: '看看服务器磁盘还剩多少' })
check('同一次任务里不重复显示用户的话', !traced.some((e) => e.kind === 'user'), traced.map((e) => e.kind).join(','))
check('没有 say 时也给一句预览', traced.some((e) => e.kind === 'assistant' && e.text.length > 0), '')

/* ---------- a failure is a failed card, not an exception ---------- */

traced.length = 0
const bad = await request({ token: info.token, op: 'cat', conn: 'web-1', path: '' })
check('参数错时 CLI 拿到 ok:false', bad.ok === false && bad.error_code === 'bad_args', bad.error_code)

traced.length = 0
const gone = await request({ token: info.token, op: 'shell', conn: 'nope', cmd: 'ls', intent: '看看' })
check('连接名不对时不碰面板', gone.ok === false && traced.length === 0, `${gone.error_code} traced=${traced.length}`)

/* ---------- bookkeeping ---------- */

await request({ token: info.token, op: 'conns' })
check('conns 不进面板', traced.length === 0, traced.map((e) => e.kind).join(','))

srv.close()
check('退出时把发现文件收走了', !existsSync(discovery))

rmSync(work, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
