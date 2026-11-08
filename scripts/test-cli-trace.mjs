/**
 * The CLI-to-panel transcript: what an external client's call looks like once
 * it is a conversation, and what its result reads as.
 *
 *   node scripts/test-cli-trace.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-cli-trace-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'cli-trace.mjs')
await build({
  entryPoints: ['src/main/cli-trace.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { describeOp, summarize } = await import(`file://${bundle.replaceAll('\\', '/')}`)

/* ---------- the command card ---------- */

const exec = describeOp({ op: 'shell', cmd: 'df -h' })
check('shell 在面板里叫 exec', exec.name === 'exec', exec.name)
check('执行的标题就是命令本身', exec.detail === 'df -h', exec.detail)
check('没有 say 时也给一句话', exec.say.length > 0, exec.say)

const ls = describeOp({ op: 'ls', path: '/var/log' })
check('ls 的标题带路径', ls.detail === 'ls /var/log', ls.detail)
check('ls 没给路径时用 .', describeOp({ op: 'ls' }).detail === 'ls .', describeOp({ op: 'ls' }).detail)

const put = describeOp({ op: 'put', paths: ['C:/a.log'], dir: '/tmp' })
check('put 叫 upload', put.name === 'upload', put.name)
check('上传的标题说明落在哪', put.detail.includes('/tmp') && put.detail.includes('C:/a.log'), put.detail)
check('get 叫 download', describeOp({ op: 'get', path: '/x', dir: 'D:/y' }).name === 'download')
check('rm 目录带 -r', describeOp({ op: 'rm', path: '/x', isDir: true }).detail === 'rm -r /x')
check('不认识的动作也不炸', describeOp({ op: 'frobnicate' }).name === 'frobnicate')

/* ---------- the result ---------- */

const ran = summarize({ op: 'shell', cmd: 'df -h' }, { ok: true, stdout: 'Filesystem  Size\nsda 20G', stderr: '', code: 0, ms: 12 })
check('执行结果是退出码加输出', ran.ok && ran.text.includes('exit=0') && ran.text.includes('sda 20G'), ran.text)

const failed = summarize({ op: 'shell', cmd: 'false' }, { ok: true, stdout: '', stderr: 'boom', code: 1, ms: 3 })
check('远端失败仍然是"跑完了"', failed.ok, String(failed.ok))
check('远端失败把 stderr 显示出来', failed.text.includes('boom'), failed.text)
check('空输出不显示成空白', summarize({ op: 'shell' }, { ok: true, stdout: '', code: 0 }).text.includes('无输出'))

const refused = summarize({ op: 'shell', cmd: 'df' }, {
  ok: false,
  error_code: 'unknown_connection',
  detail: '没有叫「web-9」的连接',
  suggestion: '先跑 liteshell-cli conns 看有哪些可用连接'
})
check('工具失败标成失败', !refused.ok, String(refused.ok))
check('失败带上建议', refused.text.includes('没有叫') && refused.text.includes('conns'), refused.text)

const partial = summarize({ op: 'shell' }, { ok: false, error_code: 'timeout', detail: '没跑完', partial_stdout: 'half a log' })
check('超时把半截输出也带上', partial.text.includes('half a log'), partial.text)

const mon = summarize({ op: 'monitor' }, {
  ok: true,
  snapshot: {
    cpu: 12.4,
    memUsed: 2 * 1024 ** 3,
    memTotal: 8 * 1024 ** 3,
    disk: [{ mount: '/', size: 100 * 1024 ** 3, used: 50 * 1024 ** 3 }]
  }
})
check('监控压成一行', !mon.text.includes('\n'), mon.text)
check('监控里有 CPU 和内存占比', mon.text.includes('12%') && mon.text.includes('25%'), mon.text)
check('监控里带上根分区', mon.text.includes('磁盘 / 50%'), mon.text)

const listed = summarize({ op: 'ls' }, { ok: true, entries: [{ name: 'a.log', isDir: false }, { name: 'logs', isDir: true }] })
check('列目录显示项数和名字', listed.text.includes('共 2 项') && listed.text.includes('logs'), listed.text)

const long = summarize({ op: 'cat' }, { ok: true, text: 'x'.repeat(9000) })
check('长输出被截断并说明', long.text.length < 5000 && long.text.includes('没显示'), `${long.text.length}`)

rmSync(work, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
