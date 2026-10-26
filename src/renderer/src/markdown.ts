/**
 * Markdown for agent answers. Deliberately small — headings, lists, quotes,
 * fenced code, inline code, bold/italic and http(s) links — because that is what
 * a shell assistant writes. A full parser would be a dependency and an
 * injection surface for the parts it never writes; every node here is built
 * with DOM calls and nothing is ever parsed as HTML.
 */

const make = (tag: string, cls = '', text = ''): HTMLElement => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text) node.textContent = text
  return node
}

/** Inline spans: `code`, **bold**, *italic*, [text](url). */
function inline(text: string): Node[] {
  const out: Node[] = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(make('code', 'md-code', tok.slice(1, -1)))
    } else if (tok.startsWith('**')) {
      out.push(make('strong', '', tok.slice(2, -2)))
    } else if (tok.startsWith('*')) {
      out.push(make('em', '', tok.slice(1, -1)))
    } else {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      // Only what a click can safely open. Anything else keeps its text and
      // loses the link: the model does not get to hand out file:// or
      // javascript: targets.
      const href = /^(https?:\/\/|mailto:)/i.test(link[2]) ? link[2] : ''
      if (href) {
        const a = make('a', 'md-link', link[1]) as HTMLAnchorElement
        a.href = href
        a.title = href
        out.push(a)
      } else {
        out.push(document.createTextNode(link[1]))
      }
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)))
  return out
}

const blockStart = (line: string): boolean =>
  /^\s*```/.test(line) ||
  /^#{1,6}\s/.test(line) ||
  /^>\s?/.test(line) ||
  /^\s*[-*+]\s/.test(line) ||
  /^\s*\d+[.)]\s/.test(line)

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^\s*```([\w+#-]*)\s*$/)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      const pre = make('pre', 'md-pre')
      const block = make('code', fence[1] ? `md-lang-${fence[1]}` : '', code.join('\n'))
      pre.append(block)
      frag.append(pre)
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3
      const h = make(`h${level}`, 'md-h')
      h.append(...inline(heading[2]))
      frag.append(h)
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''))
      const bq = make('blockquote', 'md-quote')
      bq.append(...inline(quote.join('\n')))
      frag.append(bq)
      continue
    }

    const uItem = line.match(/^\s*[-*+]\s+(.*)$/)
    const oItem = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (uItem || oItem) {
      const ordered = !uItem
      const list = make(ordered ? 'ol' : 'ul', 'md-list')
      const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
      while (i < lines.length) {
        const item = lines[i].match(re)
        if (!item) break
        const li = make('li')
        li.append(...inline(item[1]))
        list.append(li)
        i++
      }
      frag.append(list)
      continue
    }

    // Paragraph: consecutive plain lines. Blank lines and block markers end it.
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) para.push(lines[i++])
    if (!para.length) para.push(lines[i++])
    const p = make('p', 'md-p')
    p.append(...inline(para.join('\n')))
    frag.append(p)
  }

  return frag
}
