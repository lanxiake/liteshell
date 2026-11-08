/**
 * 指挥台仪式纯函数。
 *   node scripts/test-ceremony.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-ceremony-'))
let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'ceremony.mjs')
await build({
  entryPoints: ['src/renderer/src/ceremony.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundle,
  logLevel: 'silent'
})
const { hudLine, opTag, parseResultReadout, readoutText } = await import(`file://${bundle.replaceAll('\\', '/')}`)

check('connecting → HANDSHAKE', hudLine('web-1', 'connecting').includes('HANDSHAKE'))
check('ready → LINK UP', hudLine('web-1', 'ready').includes('LINK UP'))
check('error → LINK FAIL', hudLine('web-1', 'error').includes('LINK FAIL'))
check('closed → LINK DOWN', hudLine('web-1', 'closed').includes('LINK DOWN'))
check('hud 带连接名', hudLine('web-1', 'ready').includes('web-1'))
check('exec → EXEC', opTag('exec') === 'EXEC')
check('upload → UPLOAD', opTag('upload') === 'UPLOAD')
check('读数解析 exit+ms', (() => {
  const r = parseResultReadout('exit=0 · 12 ms\nok')
  return r.code === '0' && r.ms === '12'
})())
check('读数缺 ms 不炸', parseResultReadout('exit=1\nboom').code === '1')
check('opTag monitor', opTag('monitor') === 'MONITOR')
check('读数无 exit 返回空串', parseResultReadout('完成').code === '')
check('readout 有 exit 显示 exit=', readoutText('exit=0 · 12 ms\nok', true) === 'exit=0 · 12ms')
check('readout 无 exit 成功显示 DONE', readoutText('{"a":1}', true) === 'DONE')
check('readout 无 exit 失败显示 FAIL', readoutText('boom', false) === 'FAIL')
check('readout 不伪造 exit=—', !readoutText('完成', true).includes('—'))

rmSync(work, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
