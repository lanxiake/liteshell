/**
 * Unit check for the agent's Markdown renderer. It builds DOM nodes, so this
 * runs the module against a minimal stub: enough to see the tree shape, which
 * is the part that breaks (a regex swallowing text, a fence eating the rest).
 *
 *   node scripts/test-markdown.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-md-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/* ---------------- minimal DOM ---------------- */

const element = (tag) => ({ tag, className: '', textContent: '', href: '', title: '', children: [], append(...kids) { this.children.push(...kids) } })
globalThis.document = {
  createElement: (tag) => element(tag),
  createTextNode: (text) => ({ tag: '#text', textContent: text, children: [] }),
  createDocumentFragment: () => element('#frag')
}

const bundlePath = join(work, 'markdown.mjs')
await build({
  entryPoints: ['src/renderer/src/markdown.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  logLevel: 'silent'
})
const { renderMarkdown } = await import(`file://${bundlePath.replaceAll('\\', '/')}`)

const tree = (text) => renderMarkdown(text)
const kids = (frag) => frag.children

/* ---------------- checks ---------------- */

{
  const [p] = kids(tree('磁盘用了 **82%**，见 `df -h`'))
  const tags = p.children.map((c) => c.tag)
  check('整段落在一个段落里', p.tag === 'p')
  check('粗体和行内代码被识别', tags.includes('strong') && tags.includes('code'), tags.join(','))
  check('粗体内容正确', p.children.find((c) => c.tag === 'strong')?.textContent === '82%')
  check('行内代码内容正确', p.children.find((c) => c.tag === 'code')?.textContent === 'df -h')
  check('普通文字原样保留', p.children[0].textContent === '磁盘用了 ')
}

{
  const [h] = kids(tree('## 结果'))
  check('二级标题是 h2', h.tag === 'h2' && h.className === 'md-h')
  check('六级标题压到 h3', kids(tree('###### 深'))[0].tag === 'h3')
}

{
  const [pre] = kids(tree('```bash\nls -l\n\necho **x**\n```'))
  const code = pre.children[0]
  check('围栏代码是 pre > code', pre.tag === 'pre' && code.tag === 'code')
  check('语言写进 class', code.className === 'md-lang-bash')
  check('代码块里的空行和星号原样保留', code.textContent === 'ls -l\n\necho **x**', JSON.stringify(code.textContent))
  check('围栏之后的文字不会被吞掉', kids(tree('```\ncode\n```\n后记'))[1]?.children[0].textContent === '后记')
}

{
  const [ul] = kids(tree('- 一\n- 二'))
  check('无序列表两项', ul.tag === 'ul' && ul.children.length === 2)
  check('列表项承载文字', ul.children[0].children[0].textContent === '一')

  const [ol] = kids(tree('1. 一\n2. 二'))
  check('有序列表是 ol', ol.tag === 'ol' && ol.children.length === 2)
}

{
  const [p] = kids(tree('见 [文档](https://example.com/a)'))
  const a = p.children.find((c) => c.tag === 'a')
  check('https 链接可点击', a?.href === 'https://example.com/a' && a.textContent === '文档')
  check('链接带 title 便于悬停确认真实地址', a?.title === 'https://example.com/a')

  const bad = kids(tree('[点我](javascript:alert(1))'))[0]
  check('javascript: 链接不生成 a', !bad.children.some((c) => c.tag === 'a'))
  check('被拒的链接仍保留文字', bad.children[0].textContent === '点我')
}

{
  const [bq] = kids(tree('> 注意\n> 两行'))
  check('引用块合并连续行', bq.tag === 'blockquote' && bq.children[0].textContent === '注意\n两行')
}

{
  const [p] = kids(tree('第一行\r\n第二行'))
  check('CRLF 不留下 \\r', p.children[0].textContent === '第一行\n第二行')
}

{
  const [first, second] = kids(tree('一段\n\n另一段'))
  check('空行分段', first.tag === 'p' && second.tag === 'p')
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
