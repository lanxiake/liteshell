/**
 * 深空指挥台仪式：HUD 文案、工具标签、结果读数。
 * 纯函数，供 main.ts 与 scripts/test-ceremony.mjs 共用。
 */

export type HudStatus = 'connecting' | 'ready' | 'error' | 'closed'

/** 状态栏机械读数行：连接名 + 大写状态码。 */
export function hudLine(name: string, status: HudStatus): string {
  const code =
    status === 'connecting'
      ? 'HANDSHAKE'
      : status === 'ready'
        ? 'LINK UP'
        : status === 'error'
          ? 'LINK FAIL'
          : 'LINK DOWN'
  return `${name} · ${code}`
}

/** 任务卡顶栏等宽标签。 */
export function opTag(name: string): string {
  return (name || 'OP').toUpperCase()
}

/** 从 cli-trace/agent 的 summary 首行解析 exit 与 ms；缺失项为空串。 */
export function parseResultReadout(summary: string): { code: string; ms: string } {
  const head = (summary || '').split('\n', 1)[0] ?? ''
  const code = /exit=([^\s·]+)/.exec(head)?.[1] ?? ''
  const ms = /(\d+)\s*ms/.exec(head)?.[1] ?? ''
  return { code, ms }
}

/**
 * 任务卡读数文案：有真实 exit= 才显示 exit=…；
 * 否则退回 DONE / FAIL（不伪造 exit=—），有耗时则追加 ms。
 */
export function readoutText(summary: string, ok: boolean): string {
  const { code, ms } = parseResultReadout(summary)
  const main = code ? `exit=${code}` : ok ? 'DONE' : 'FAIL'
  return ms ? `${main} · ${ms}ms` : main
}

/** 构建可折叠任务卡：标签 + 明细 + 执行中进度轨。仅限渲染进程调用（依赖 document）。 */
export function buildAgentStep(name: string, detail: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'agent-step folded running'
  box.dataset.op = name

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'agent-step-head'
  head.title = `${name}\n${detail}\n\n点开看完整输出`

  const tag = document.createElement('span')
  tag.className = 'agent-op-tag'
  tag.textContent = opTag(name)

  const label = document.createElement('span')
  label.className = 'agent-op-detail'
  label.textContent = detail

  const readout = document.createElement('span')
  readout.className = 'agent-op-readout'
  readout.hidden = true

  head.append(tag, label, readout)

  const rail = document.createElement('div')
  rail.className = 'agent-step-rail'
  rail.setAttribute('aria-hidden', 'true')

  const body = document.createElement('div')
  body.className = 'agent-step-body'

  head.addEventListener('click', () => box.classList.toggle('folded'))
  box.append(rail, head, body)
  return box
}

/** 结束执行态，填入输出与机械读数；失败时自动展开。 */
export function completeAgentStep(step: HTMLElement, ok: boolean, summary: string): void {
  step.classList.remove('running')
  step.classList.toggle('bad', !ok)
  const body = step.querySelector('.agent-step-body')
  if (body) body.textContent = summary || '（无输出）'
  const readout = step.querySelector('.agent-op-readout') as HTMLElement | null
  if (readout) {
    readout.hidden = false
    readout.textContent = readoutText(summary, ok)
  }
  if (!ok) step.classList.remove('folded')
}

/** 回合结束仍在执行的卡（停止/断线/出错，没有 result 事件）：结算为已取消。 */
export function cancelAgentStep(step: HTMLElement, note = '已取消'): void {
  if (!step.classList.contains('running')) return
  step.classList.remove('running')
  step.classList.add('bad')
  const body = step.querySelector('.agent-step-body')
  if (body && !body.textContent) body.textContent = note
  const readout = step.querySelector('.agent-op-readout') as HTMLElement | null
  if (readout) {
    readout.hidden = false
    readout.textContent = 'CANCELLED'
  }
}
