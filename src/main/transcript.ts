import type { AgentConversation, AgentEvent } from '../shared/types'

/** A conversation as Markdown, for the export dialog. Pure, so it is testable
 *  and the format does not depend on which window asked. */
export function transcriptMarkdown(convo: AgentConversation, connectionName?: string): string {
  const when = new Date(convo.createdAt).toLocaleString('zh-CN')
  const lines: string[] = [
    `# ${convo.title || '未命名对话'}`,
    '',
    ...(connectionName ? [`- 连接：${connectionName}`] : []),
    `- 时间：${when}`,
    '',
    '---',
    ''
  ]

  for (const ev of convo.events) lines.push(...block(ev))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function block(ev: AgentEvent): string[] {
  switch (ev.kind) {
    case 'user':
      return ['## 我', '', ev.text, ...(ev.files?.length ? ['', `附件：${ev.files.join('、')}`] : []), '']
    case 'assistant':
      return ['## 助手', '', ev.text, '']
    case 'tool':
      return [`> ▶ ${ev.detail}`, '']
    case 'result': {
      // Fenced so a command's output keeps its line breaks and its asterisks.
      return [`${ev.ok ? '' : '**失败** '}${ev.name}`, '', '```', ev.summary, '```', '']
    }
    case 'ask':
      return [`**待确认 · ${ev.name}（${{ safe: '只读', risky: '有改动', critical: '高危' }[ev.risk] ?? ev.risk}）**`, '', '```', ev.detail, '```', '', `_${ev.why}_`, '']
    case 'error':
      return [`**错误**：${ev.message}`, '']
    case 'delta':
      return []
    case 'done':
      return ['---', '']
  }
}
