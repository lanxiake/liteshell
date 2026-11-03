/**
 * Two thin adapters, one shape. Anthropic speaks its own dialect; everything
 * else in the world speaks OpenAI's.
 *
 * Deliberately not Vercel's AI SDK: it force-injects `eager_input_streaming`
 * into every Anthropic tool, which 400s against any gateway that validates
 * strictly, and the fix upstream was scoped to one provider and closed as
 * out-of-scope. Two adapters we can read beat one we cannot.
 *
 * Anthropic also has to go through its own SDK. Its OpenAI-compatible endpoint
 * silently drops thinking output and ignores `strict`, so routing Claude
 * through the "compatible" path loses capability for no gain.
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Call, LlmSettings, Msg, ToolResult } from '../shared/types'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Turn {
  text: string
  calls: Call[]
  echo: unknown
  /** Normalised to 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'other'. */
  stop: string
  /** The model said something in its reasoning channel. An empty answer with
   *  reasoning in it is a different problem from an empty answer with nothing
   *  at all, and the message the user gets has to tell them apart. */
  thought: boolean
}

export interface Provider {
  turn(
    messages: Msg[],
    tools: ToolSpec[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
    /** Replaces the system prompt for this one request. Used by the summariser,
     *  which runs on the same endpoint with its own instructions. */
    system?: string
  ): Promise<Turn>
}

/** A cut-off stream yields JSON that either fails to parse or parses to
 *  something plausible but short. Both come back as null so the caller refuses
 *  the call instead of running it with defaults. */
function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Anthropic
 * ------------------------------------------------------------------ */

function anthropicProvider(s: LlmSettings, system: string): Provider {
  // Two minutes and one retry, instead of the SDK's ten and two: a typo'd host
  // that black-holes the request should surface as a message, not as a panel
  // that sits there looking like it did nothing.
  const client = new Anthropic({
    apiKey: s.apiKey || undefined,
    baseURL: s.baseUrl || undefined,
    timeout: 120_000,
    maxRetries: 1
  })

  const toParam = (m: Msg): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.text }
    if (m.role === 'assistant') {
      return { role: 'assistant', content: m.echo as Anthropic.ContentBlockParam[] }
    }
    // One user message carrying every result. Splitting them does not error —
    // it quietly teaches the model to stop calling tools in parallel.
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.text,
        is_error: r.isError
      }))
    }
  }

  return {
    async turn(messages, tools, onDelta, signal, sys) {
      const stream = client.messages.stream(
        {
          model: s.model,
          max_tokens: 8192,
          system: sys ?? system,
          ...(tools.length
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters as Anthropic.Tool['input_schema']
                }))
              }
            : {}),
          messages: messages.map(toParam)
        },
        { signal }
      )

      stream.on('text', (delta) => onDelta(delta))
      const message = await stream.finalMessage()

      let text = ''
      const calls: Call[] = []
      for (const block of message.content) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'tool_use') {
          const input = block.input
          calls.push({
            id: block.id,
            name: block.name,
            args:
              input && typeof input === 'object' && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : null
          })
        }
      }

      const raw = message.stop_reason ?? 'end_turn'
      const stop = raw === 'tool_use' || raw === 'end_turn' || raw === 'max_tokens' || raw === 'refusal' ? raw : 'other'
      return { text, calls, echo: message.content, stop, thought: message.content.some((b) => b.type === 'thinking') }
    }
  }
}

/* ------------------------------------------------------------------ *
 * OpenAI and everything that copies it
 * ------------------------------------------------------------------ */

/** Arguments arrive as a JSON string in fragments, so they are accumulated here
 *  and parsed once at the end. */
interface Frag {
  index: number
  id: string
  name: string
  args: string
}

interface Delta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

function openaiProvider(s: LlmSettings, system: string): Provider {
  // A local gateway may not check the key, but the SDK refuses to construct one
  // without something in the field.
  const client = new OpenAI({
    apiKey: s.apiKey || 'unused',
    baseURL: s.baseUrl || undefined,
    timeout: 120_000,
    maxRetries: 1
  })

  const flatten = (messages: Msg[], sys: string): OpenAI.Chat.ChatCompletionMessageParam[] =>
    // The system prompt rides in the message list — this dialect has no separate
    // field for it, so forgetting it here means the model never hears the rules.
    [
      { role: 'system' as const, content: sys },
      ...messages.flatMap((m): OpenAI.Chat.ChatCompletionMessageParam[] => {
        if (m.role === 'user') return [{ role: 'user', content: m.text }]
        if (m.role === 'assistant') {
          return [m.echo as OpenAI.Chat.ChatCompletionAssistantMessageParam]
        }
        // One message per call here, unlike Anthropic — the dialect requires it,
        // and the id is what ties each result back to its call.
        return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text }))
      })
    ]

  return {
    async turn(messages, tools, onDelta, signal, sys) {
      // Asked for the response alongside the stream so a body that never became
      // SSE can be read and quoted. A gateway answering 200 with an error in
      // JSON — or a 200 with a web page — makes the SDK hand back a stream with
      // zero chunks and no exception, so "0 chunks" is the only signal that
      // something went wrong; without the raw text all the user gets is "the
      // interface returned nothing", and the reason it says is anybody's guess.
      const { data: stream, response } = await client.chat.completions
        .create(
          {
            model: s.model,
            messages: flatten(messages, sys ?? system),
            ...(tools.length
              ? {
                  tools: tools.map((t) => ({
                    type: 'function' as const,
                    function: { name: t.name, description: t.description, parameters: t.parameters }
                  }))
                }
              : {}),
            stream: true
          },
          { signal }
        )
        .withResponse()

      // A body that is not SSE never becomes frames — the SDK's reader finds no
      // `data:` lines and yields nothing. Read it *before* iterating (the body
      // is locked once the iterator takes it over) so the reason the gateway
      // gave can be quoted instead of guessing at the address.
      const type = response.headers.get('content-type') ?? ''
      if (!/text\/event-stream/i.test(type)) {
        const body = await response.text().catch(() => '')
        throw await silentStream(response, s.model, type, body)
      }

      let text = ''
      let reasoning = ''
      let finish: string | null = null
      let chunks = 0
      const frags: Frag[] = []

      for await (const chunk of stream) {
        chunks++
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta as Delta | undefined
        if (delta) {
          if (delta.content) {
            text += delta.content
            onDelta(delta.content)
          }
          // Field name varies by vendor; keep whichever one showed up so the
          // next call can hand it back.
          const extra = delta.reasoning_content ?? delta.reasoning
          if (extra) reasoning += extra

          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? frags.length
            // Matching on the id when there is one survives gateways that send
            // index 0 for every parallel call; matching on the index when there
            // is not covers the normal case where only the first fragment
            // carries an id.
            let frag = frags.find((f) => f.index === index && (!tc.id || f.id === tc.id))
            if (!frag) {
              frag = { index, id: '', name: '', args: '' }
              frags.push(frag)
            }
            if (tc.id) frag.id = tc.id
            if (tc.function?.name) frag.name = tc.function.name
            if (tc.function?.arguments) frag.args += tc.function.arguments
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }

      const used = frags.filter((f) => f.name)
      const calls: Call[] = used.map((f, i) => ({
        id: f.id || `call_${i}`,
        name: f.name,
        args: parseArgs(f.args)
      }))

      const echo: Record<string, unknown> = { role: 'assistant', content: text || null }
      // Echo the raw strings, not the re-serialised parse: if the argument JSON
      // was cut off, the model has to see what it actually said.
      if (used.length) {
        echo.tool_calls = used.map((f, i) => ({
          id: f.id || `call_${i}`,
          type: 'function',
          function: { name: f.name, arguments: f.args || '{}' }
        }))
      }
      if (reasoning) echo.reasoning_content = reasoning

      const stop =
        finish === 'tool_calls'
          ? 'tool_use'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'content_filter'
              ? 'refusal'
              : finish === 'stop'
                ? 'end_turn'
                : 'other'
      if (chunks === 0) throw silentStream(response, s.model, type, '')
      return { text, calls, echo, stop, thought: !!reasoning }
    }
  }
}

/**
 * What to say about a stream that produced no frames at all.
 *
 * This is the failure mode that made the gateway look like a wrong address: a
 * request the vendor accepted (`HTTP 200`) whose body is a JSON error object, an
 * HTML page, or bare `data: [DONE]`. The OpenAI SDK reads it as an empty stream
 * and says nothing, so the only evidence left is the raw body — read it and
 * quote it, because the reason ("no channel for this model in this group",
 * "upstream saturated") is the one thing that tells the user what to fix.
 */
async function silentStream(response: Response, model: string, type: string, body: string): Promise<Error> {
  const snippet = body.trim().slice(0, 400).replace(/\s+/g, ' ')
  const err = new Error(
    [
      `接口返回了 HTTP ${response.status}，但没有吐出任何流式内容（0 帧）。`,
      `模型：${model}`,
      type ? `返回类型：${type}` : '',
      snippet ? `返回正文：${snippet}` : '返回正文是空的。',
      '常见原因：网关给这个模型/分组没有可用渠道、额度或并发耗尽、地址指到了网站首页而不是 /v1 接口。'
    ]
      .filter(Boolean)
      .join('\n')
  )
  // describe() switches on this; 200 is truthful and would fall through to the
  // generic branch, so the message above is what gets shown.
  ;(err as Error & { status?: number }).status = response.status
  return err
}

export function makeProvider(s: LlmSettings, system: string): Provider {
  return s.provider === 'anthropic' ? anthropicProvider(s, system) : openaiProvider(s, system)
}

/**
 * One real request to see whether the settings work at all: same provider,
 * same tool list, one short question. Errors come back in the same shape the
 * panel would show, because "works in the test, fails in the panel" is the
 * difference between a bad setting and a bad conversation.
 */
export async function testModel(s: LlmSettings): Promise<string> {
  const tool: ToolSpec = {
    name: 'ping',
    description: '确认工具调用通道可用。',
    parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  }
  const turn = await makeProvider(s, SYSTEM_FOR_TEST).turn(
    [{ role: 'user', text: '回复「连接正常」四个字即可。' }],
    [tool],
    () => undefined,
    AbortSignal.timeout(45_000)
  )
  const said = turn.text.trim() || (turn.calls.length ? `（模型调用了工具 ${turn.calls.map((c) => c.name).join('、')}）` : '')
  if (!said) {
    throw new Error(
      `模型没有回答：既没有文字也没有工具调用${turn.thought ? '（只有思考内容）' : ''}。` +
        '这个模型可能不支持工具调用，或者网关对它没有可用渠道。'
    )
  }
  return said
}

export const SYSTEM_FOR_TEST = '你是连通性测试。只回一句话。'

/**
 * The model list, straight from the endpoint the settings point at. Both
 * dialects answer `GET /models` with `{ data: [{ id }] }`; the difference is
 * where it hangs and what the key is called.
 *
 * Deliberately does not "fix up" a base URL that is missing `/v1` — the
 * gateway is the user's to know, and silently rewriting an address they typed
 * fails somewhere else instead. The error carries the URL it tried so the
 * mistake is visible where it was made.
 */
export async function listModels(s: {
  provider: LlmSettings['provider']
  baseUrl: string
  apiKey?: string
}): Promise<string[]> {
  const base = s.baseUrl.trim().replace(/\/+$/, '')
  const anthropic = s.provider === 'anthropic'
  const root = base || (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  const url = `${root}${anthropic && !/\/v1$/.test(root) ? '/v1' : ''}/models`
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': s.apiKey ?? '', 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${s.apiKey || 'unused'}` }

  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  } catch (err) {
    throw new Error(`连不上 ${url}：${(err as Error).message}`)
  }
  if (!res.ok) throw new Error(`${url} 返回 ${res.status} ${res.statusText}`)

  const body = (await res.json()) as { data?: { id?: unknown }[] }
  const ids = (body.data ?? []).map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
  // An empty list is a failed lookup, not an endpoint with no models: saying
  // "0 个模型" and leaving the box empty reads as "this gateway is broken".
  if (!ids.length) throw new Error(`${url} 没有返回模型列表（data[].id）`)
  return ids
}
