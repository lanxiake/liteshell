/**
 * The vendor preset table: every entry must be usable as typed, and the row
 * that opens the settings dialog must be the one the saved configuration
 * names. Getting either wrong sends the user looking for an address bug that
 * does not exist.
 *
 *   node scripts/test-presets.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-presets-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const out = join(work, 'presets.mjs')
await build({
  entryPoints: ['src/shared/presets.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent'
})
const { PRESETS, presetFor } = await import(pathToFileURL(out).href)

check('预设表非空', PRESETS.length >= 8, `${PRESETS.length} 条`)
check('id 不重复', new Set(PRESETS.map((p) => p.id)).size === PRESETS.length)
check('每条都有中文说明', PRESETS.every((p) => p.note.trim().length > 0))
check(
  '地址要么留空（官方默认），要么以 /v1 结尾或本身就是接口根',
  PRESETS.every((p) => !p.baseUrl || /\/v1$|\/v4$/.test(p.baseUrl)),
  PRESETS.filter((p) => p.baseUrl && !/\/v1$|\/v4$/.test(p.baseUrl)).map((p) => `${p.id}=${p.baseUrl}`).join(' ')
)
check(
  '上下文窗口是 8 的倍数且不低于 8K',
  PRESETS.every((p) => p.models.every((m) => m.contextK >= 8 && m.contextK % 8 === 0))
)
check(
  '有模型列表的预设，模型 id 都不为空',
  PRESETS.every((p) => p.models.every((m) => m.id.trim().length > 0))
)

// The dialog opens on the vendor the saved URL belongs to, or on the first row
// of the same dialect when the URL is a custom gateway.
check('按保存的地址认出厂商', presetFor('openai', 'https://api.deepseek.com/v1')?.id === 'deepseek')
check('地址末尾的斜杠不影响识别', presetFor('openai', 'https://api.deepseek.com/v1/')?.id === 'deepseek')
check('自建网关不算任何预设', presetFor('openai', 'https://gw.example.com/v1') === undefined)
check('协议不同不串台', presetFor('anthropic', 'https://api.deepseek.com/v1') === undefined)
check('地址留空时落到该协议的第一条', presetFor('anthropic', '')?.id === 'anthropic')
check('Anthropic 预设走原生协议', PRESETS.find((p) => p.id === 'anthropic')?.kind === 'anthropic')
check('智谱的地址是它自己的 paas 根', PRESETS.find((p) => p.id === 'zhipu')?.baseUrl === 'https://open.bigmodel.cn/api/paas/v4')

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n预设表检查通过')
process.exit(failures ? 1 : 0)
