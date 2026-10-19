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
import type { LlmSettings } from '../shared/types'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Call {
  id: string
  name: string
  /** null when the streamed JSON did not parse — the caller must not run it. */
  args: Record<string, unknown> | null
}

export interface ToolResult {
  id: string
  text: string
  isError: boolean
}

/**
 * The conversation in a shape both dialects can read. `echo` is what goes back
 * verbatim as the assistant turn: Anthropic's content blocks (a thinking block
 * that comes back modified is a 400) and OpenAI's tool_calls plus whatever
 * reasoning channel the endpoint uses — DeepSeek rejects a tool-using history
 * that drops `reasoning_content`.
 */
export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: Call[]; echo: unknown }
  | { role: 'result'; results: ToolResult[] }

export interface Turn {
  text: string
  calls: Call[]
  echo: unknown
  /** Normalised to 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'other'. */
  stop: string
}

export interface Provider {
  turn(
    messages: Msg[],
    tools: ToolSpec[],
    onDelta: (text: string) => void,
    signal: AbortSignal
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
    async turn(messages, tools, onDelta, signal) {
      const stream = client.messages.stream(
        {
          model: s.model,
          max_tokens: 8192,
          system,
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
      return { text, calls, echo: message.content, stop }
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

  const flatten = (messages: Msg[]): OpenAI.Chat.ChatCompletionMessageParam[] =>
    // The system prompt rides in the message list — this dialect has no separate
    // field for it, so forgetting it here means the model never hears the rules.
    [
      { role: 'system' as const, content: system },
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
    async turn(messages, tools, onDelta, signal) {
      const stream = await client.chat.completions.create(
        {
          model: s.model,
          messages: flatten(messages),
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

      let text = ''
      let reasoning = ''
      let finish: string | null = null
      const frags: Frag[] = []

      for await (const chunk of stream) {
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
      return { text, calls, echo, stop }
    }
  }
}

export function makeProvider(s: LlmSettings, system: string): Provider {
  return s.provider === 'anthropic' ? anthropicProvider(s, system) : openaiProvider(s, system)
}

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
