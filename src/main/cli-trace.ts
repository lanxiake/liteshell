/**
 * What the AI panel shows while the CLI drives this app.
 *
 * A CLI call is a whole turn on its own: the external agent was told something,
 * decided on a command, ran it and read the answer. Everything but the command
 * itself has to be reconstructed here — the panel is the user's window into a
 * conversation that is happening in another process.
 *
 * Pure on purpose: no Electron, no socket, so the wording is testable
 * (scripts/test-cli-trace.mjs).
 */

export interface TraceReq {
  op?: string
  cmd?: string
  path?: string
  to?: string
  dir?: string
  paths?: string[]
  isDir?: boolean
  /** The external agent's own one-line description of what it is doing. */
  say?: string
  /** What the user actually asked for, in their own words. */
  intent?: string
}

export interface TraceOp {
  /** The tool name the panel shows; the built-in agent's tools use the same. */
  name: string
  /** The card's title: the command, or the paths involved. */
  detail: string
  /** One line in the agent's voice, before the command runs. */
  say: string
}

/** The CLI's wire names differ from the panel's tool names on purpose: the CLI
 *  speaks file-transfer, the panel speaks what the user sees it doing. */
const opName = (op = ''): string =>
  op === 'shell' ? 'exec' : op === 'put' ? 'upload' : op === 'get' ? 'download' : op

export function describeOp(req: TraceReq): TraceOp {
  const path = req.path ?? ''
  const op = req.op ?? ''
  switch (opName(req.op)) {
    case 'exec':
      return { name: 'exec', detail: req.cmd ?? '', say: '执行这条命令看看结果。' }
    case 'ls':
      return { name: 'ls', detail: `ls ${path || '.'}`, say: '先看看这个目录里有什么。' }
    case 'cat':
      return { name: 'cat', detail: `cat ${path}`, say: '读一下这个文件的内容。' }
    case 'monitor':
      return { name: 'monitor', detail: '读取资源监控', say: '先确认这台机器的资源状况。' }
    case 'upload':
      return {
        name: 'upload',
        detail: `上传到 ${req.dir ?? ''}\n${(req.paths ?? []).join('\n')}`,
        say: '把文件传到服务器上。'
      }
    case 'download':
      return { name: 'download', detail: `下载 ${path} → ${req.dir ?? ''}`, say: '从服务器下载下来。' }
    case 'rm':
      return { name: 'rm', detail: `rm ${req.isDir ? '-r ' : ''}${path}`, say: '删除这个远端路径。' }
    case 'mv':
      return { name: 'mv', detail: `mv ${path} → ${req.to ?? ''}`, say: '在服务器上移动它。' }
    case 'mkdir':
      return { name: 'mkdir', detail: `mkdir ${path}`, say: '在服务器上建这个目录。' }
    default:
      return { name: op, detail: op, say: '继续在服务器上操作。' }
  }
}

/** The card's body is the only place some of these outputs exist — an `exec`
 *  over the CLI's own channel never lands in the terminal — but it is still a
 *  transcript, not a file viewer. */
const CLIP = 4000

const clip = (s: string): string =>
  s.length <= CLIP ? s : `${s.slice(0, CLIP)}\n…（还有 ${s.length - CLIP} 字没显示）`

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`

export function summarize(req: TraceReq, res: unknown): { ok: boolean; text: string } {
  const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>
  if (r.ok === false) {
    const detail = typeof r.detail === 'string' ? r.detail : '没跑成'
    const hint = typeof r.suggestion === 'string' ? `\n${r.suggestion}` : ''
    const partial = typeof r.partial_stdout === 'string' && r.partial_stdout ? `\n${clip(r.partial_stdout)}` : ''
    return { ok: false, text: `${detail}${hint}${partial}` }
  }

  switch (opName(req.op)) {
    case 'exec': {
      const code = r.code === undefined ? '?' : String(r.code)
      const ms = typeof r.ms === 'number' ? ` · ${r.ms} ms` : ''
      const out = typeof r.stdout === 'string' ? r.stdout : ''
      const err = typeof r.stderr === 'string' ? r.stderr : ''
      const body = `${out}${out && err ? '\n' : ''}${err}`.trim()
      return { ok: true, text: `exit=${code}${ms}\n${clip(body || '（无输出）')}` }
    }
    case 'monitor':
      return { ok: true, text: monitorLine(r.snapshot) }
    case 'ls': {
      const entries = Array.isArray(r.entries) ? r.entries : []
      const names = entries.map((e) => {
        const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
        return `${o.isDir === true ? '📁' : '📄'} ${String(o.name ?? '')}`
      })
      return { ok: true, text: names.length ? clip(`共 ${names.length} 项\n${names.join('\n')}`) : '目录是空的' }
    }
    case 'cat': {
      const text = typeof r.text === 'string' ? r.text : ''
      return { ok: true, text: clip(text || '（空文件）') }
    }
    case 'upload':
    case 'download': {
      const w = r.written
      const paths = Array.isArray(w) ? w.map(String) : typeof w === 'string' ? [w] : []
      return { ok: true, text: `落地路径：\n${paths.join('\n') || '（远端没回路径）'}` }
    }
    default:
      return { ok: true, text: '完成' }
  }
}

/** One line instead of the whole snapshot: the panel is a conversation, and the
 *  monitor tab is already the place that draws all of it. */
function monitorLine(snap: unknown): string {
  const s = (snap && typeof snap === 'object' ? snap : {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const used = num(s.memUsed)
  const total = num(s.memTotal)
  const pct = total ? Math.round((used / total) * 100) : 0
  const disk = Array.isArray(s.disk) ? (s.disk as Record<string, unknown>[]) : []
  const root = disk.find((d) => d.mount === '/') ?? disk[0]
  const size = root ? num(root.size) : 0
  const diskLine = root
    ? ` · 磁盘 ${String(root.mount ?? '/')} ${size ? Math.round((num(root.used) / size) * 100) : 0}%`
    : ''
  return `CPU ${Math.round(num(s.cpu))}% · 内存 ${gb(used)}/${gb(total)}（${pct}%）${diskLine}`
}
