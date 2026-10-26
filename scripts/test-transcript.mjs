/**
 * The AI transcript as a Markdown file — the format the export dialog writes.
 * It is the one artefact a user hands to someone else, so the ordering and the
 * "what was refused" lines matter more than prettiness.
 *
 *   node scripts/test-transcript.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-transcript-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const out = join(work, 'transcript.mjs')
await build({
  entryPoints: ['src/main/transcript.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent'
})
const { transcriptMarkdown } = await import(pathToFileURL(out).href)

const events = [
  { kind: 'user', text: '磁盘满了没' },
  { kind: 'tool', name: 'exec', detail: 'df -h' },
  { kind: 'result', name: 'exec', ok: true, summary: 'Filesystem Size Used' },
  { kind: 'assistant', text: '还有 **12%** 空间。' },
  { kind: 'ask', askId: 'x', name: 'exec', detail: 'rm -rf /tmp/*', risk: 'critical', why: '删文件' },
  { kind: 'error', message: '接口 404' }
]
const convo = {
  id: 'a1',
  connectionId: 'c1',
  title: '磁盘满了没',
  createdAt: Date.UTC(2026, 0, 2, 3, 4),
  updatedAt: Date.UTC(2026, 0, 2, 3, 4),
  events
}

const md = transcriptMarkdown(convo, '生产机')

check('标题就是对话标题', md.startsWith('# 磁盘满了没'))
check('带上连接名', md.includes('- 连接：生产机'))
check('先问后答，顺序不被打乱', md.indexOf('## 我') < md.indexOf('> ▶ df -h'))
check('命令输出进代码块，保留换行和星号', md.includes('```\nFilesystem Size Used\n```'))
check('回复原样保留 Markdown', md.includes('还有 **12%** 空间。'))
check('待确认的命令记下风险和理由', md.includes('待确认 · exec（高危）') && md.includes('_删文件_'))
check('失败的结果看得出是失败的', transcriptMarkdown(
  { ...convo, events: [{ kind: 'result', name: 'exec', ok: false, summary: 'permission denied' }] }
).includes('**失败** exec'))
check('错误行带上了原因', md.includes('**错误**：接口 404'))
check('没有流式增量出现在文件里', !md.includes('delta'))
check('附件路径跟着那句话走', transcriptMarkdown(
  { ...convo, events: [{ kind: 'user', text: '看看这个', files: ['C:\\a\\b.log'] }] }
).includes('附件：C:\\a\\b.log'))
check('连续空行被压掉', !/\n{3,}/.test(md))
check('末尾只有一个换行', md.endsWith('\n') && !md.endsWith('\n\n'))

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
