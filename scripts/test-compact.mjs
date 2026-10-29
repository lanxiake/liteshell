/**
 * The compression boundary: when a conversation has to be summarised, and what
 * the summariser is fed. Approximate on purpose — it decides *when*, not what
 * the provider actually charges for.
 *
 *   node scripts/test-compact.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-compact-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'compact.mjs')
await build({
  entryPoints: ['src/main/compact.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { cutIndex, dump, size, limitOf, isSummary, SUMMARY_TAG, SUMMARY_SYSTEM, SUMMARY_PROMPT } =
  await import(`file://${bundle.replaceAll('\\', '/')}`)

const user = (text) => ({ role: 'user', text })
const answer = (text) => ({ role: 'assistant', text, calls: [], echo: null })
const result = (text) => ({ role: 'result', results: [{ id: 'c1', text, isError: false }] })

/* ---------- the trigger ---------- */

check('小对话不压缩', cutIndex([user('你好'), answer('在')], 128) === null)
check('窗口越界才压缩', limitOf(128) === 115200)

const big = 'x'.repeat(400)
const many = []
for (let i = 0; i < 400; i++) many.push(user(`${i}`), result(big))
const cut = cutIndex(many, 8)
check('超了就给一个切点', typeof cut === 'number' && cut > 0, `cut=${cut}`)
check('切点落在 user 上（工具结果不能脱离它的调用）', many[cut].role === 'user', many[cut].role)
check('切完了就回到窗口内', size(many.slice(cut)) < limitOf(8), `${size(many.slice(cut))}`)

/* ---------- the tail ---------- */

const hugeSingle = [user('开始'), result('y'.repeat(400_000))]
check('一条巨大的结果不能被"整个保留"当尾巴',
  (() => {
    const c = cutIndex(hugeSingle, 8)
    // Either the whole thing is summarised (tail empty) or the tail starts on a
    // user turn — never a tool result whose call went into the summary.
    return c === null || c >= hugeSingle.length || hugeSingle[c].role === 'user'
  })())
check('尾巴为空时不返回 0（压了等于没压）',
  (() => {
    const c = cutIndex([result('z'.repeat(400_000))], 8)
    return c === null || c > 0
  })())

/* ---------- what the summariser sees ---------- */

const withSummary = [{ role: 'user', text: `${SUMMARY_TAG}\n之前的摘要` }, ...many.slice(0, 10)]
const feed = dump(withSummary, 8)
check('摘要被带进去，不会被二次压缩丢掉', feed.includes('之前的摘要'))
check('喂给摘要器的内容按窗口截断', feed.length < 8 * 1000 * 0.5 * 2 + 200, `${feed.length}`)
check('截断时说明省略了多少', dump(many, 8).includes('已省略'))

/* ---------- the prompt ---------- */

check('摘要标记可识别', isSummary(user(`${SUMMARY_TAG}\nx`)) && !isSummary(user('普通')))
check('摘要提示词要求照抄命令与路径', SUMMARY_SYSTEM.includes('照抄'))
check('摘要提示词不许它写开场白', SUMMARY_SYSTEM.includes('不要') && SUMMARY_PROMPT.includes('直接写摘要'))

rmSync(work, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
