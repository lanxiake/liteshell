/**
 * When a conversation has to be compressed, and what the summariser is shown.
 *
 * Deliberately pure and approximate: nothing here counts tokens the way a
 * provider does, it only decides *when* to compress and which stretch to send.
 * Getting that boundary slightly wrong costs one summary, not correctness.
 */
import type { Msg } from '../shared/types'

/** Past this share of the window the history is summarised. */
const COMPACT_AT = 0.9
/** What stays verbatim after a compression, as a share of the window. The
 *  recent commands are what the next one continues from. */
const KEEP = 0.2
/** …and never more than this many messages, however small they are: a turn of
 *  tiny tool calls can cross the message lid without moving the token count. */
const KEEP_MESSAGES = 12
/** How much of the old stretch the summariser is fed, as a share of the window. */
const FEED = 0.5

/** Fronts the message that replaces an earlier stretch. Recognised so a second
 *  compression carries the first summary forward instead of losing it. */
export const SUMMARY_TAG = '【此前对话摘要】'

export const isSummary = (m: Msg): boolean => m.role === 'user' && m.text.startsWith(SUMMARY_TAG)

/** CJK is roughly one token per character, the rest roughly one per four.
 *  Rounded up on purpose: this only decides when to compress. */
export function tokens(text: string): number {
  let wide = 0
  for (const ch of text) if (ch.codePointAt(0)! >= 0x2e80) wide++
  return wide + Math.ceil((text.length - wide) / 4)
}

function plain(m: Msg): string {
  if (m.role === 'user') return m.text
  if (m.role === 'assistant') {
    return m.text + m.calls.map((c) => `${c.name} ${JSON.stringify(c.args ?? {})}`).join(' ')
  }
  return m.results.map((r) => r.text).join('\n')
}

export function size(messages: Msg[]): number {
  let n = 0
  for (const m of messages) n += tokens(plain(m))
  return n
}

export const limitOf = (contextK: number): number => Math.round(contextK * 1000 * COMPACT_AT)

/**
 * Where the verbatim tail starts, or null when nothing has to be compressed.
 *
 * `force` is the message lid: the caller hit it even though the token count
 * says there is room, and the tail then has to be counted in messages.
 *
 * The tail always starts on a user turn: a tool result whose call was
 * summarised away references an id the endpoint no longer knows, which is a
 * 400 in both dialects.
 */
export function cutIndex(messages: Msg[], contextK: number, force = false): number | null {
  if (!force && size(messages) <= limitOf(contextK)) return null
  const budget = contextK * 1000 * KEEP
  let acc = 0
  let cut = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = tokens(plain(messages[i]))
    const over = acc + t > budget || messages.length - i > KEEP_MESSAGES
    if (over && cut < messages.length) break
    acc += t
    cut = i
  }
  while (cut < messages.length && messages[cut].role !== 'user') cut++
  // No user turn in the budget-sized tail: everything before the current
  // question goes into the summary, so the model still has what it was asked.
  // A `cut` of 0 means the whole history is that tail — compressing it would
  // summarise nothing, so say so instead of splitting at the wrong place.
  if (cut >= messages.length) {
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i].role === 'user') return i
    }
    return null
  }
  return cut > 0 ? cut : null
}

function one(m: Msg): string {
  if (m.role === 'user') return `【用户】${m.text}`
  if (m.role === 'assistant') {
    const calls = m.calls.map((c) => `〔调用 ${c.name}：${JSON.stringify(c.args ?? {})}〕`).join('\n')
    return [`【助手】${m.text}`.trim(), calls].filter(Boolean).join('\n')
  }
  return m.results
    .map((r) => `【结果·${r.isError ? '失败' : '成功'}】${clip(r.text, 1500)}`)
    .join('\n')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（截断）` : text
}

/**
 * The stretch being compressed, as text for the summariser. When it does not
 * fit it is cut from the oldest end — the recent part is what the next command
 * depends on. A summary already at the front is always carried in.
 */
export function dump(messages: Msg[], contextK: number): string {
  const budget = contextK * 1000 * FEED
  const head = messages.length && isSummary(messages[0]) ? plain(messages[0]) : ''
  const rest = head ? messages.slice(1) : messages
  const body: string[] = []
  let used = head ? tokens(head) : 0
  let dropped = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const text = one(rest[i])
    const t = tokens(text)
    if (used + t > budget) {
      dropped = i + 1
      break
    }
    used += t
    body.unshift(text)
  }
  return [
    ...(head ? [head] : []),
    ...(dropped ? [`（更早的 ${dropped} 条记录已省略）`] : []),
    ...body
  ].join('\n\n')
}

export const SUMMARY_SYSTEM = [
  '你是 LiteShell 运维助手的会话压缩器。把一段服务器操作对话压成一份交接摘要，交给同一个助手，让它能接着干活。',
  '',
  '要保留：',
  '- 用户到底想做什么，做到哪一步了；',
  '- 已经执行过的命令及关键结果（路径、服务名、端口、数值、版本、报错原文）；',
  '- 发现的机器状况和已经确认的事实；',
  '- 被拒绝、被跳过或失败的尝试，以及原因；',
  '- 还没解决的问题、下一步打算做什么；',
  '- 仍然有效的输出 handle（read_output 用的那个文件名）。',
  '',
  '不要保留：完整命令输出、重复内容、客套话、对过程的评论。',
  '数字、路径、命令原文照抄，不要改写成描述。',
  '只输出摘要正文，不要标题，不要「以下是摘要」之类的开场白。'
].join('\n')

export const SUMMARY_PROMPT =
  '把下面这段对话压缩成交接摘要，现在就开始（直接写摘要）：\n\n---\n\n'
