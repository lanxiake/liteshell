import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AgentConversation, AgentConversationInfo, AgentEvent, Msg } from '../shared/types'

/**
 * Saved AI conversations, one file beside the store rather than inside it: a
 * transcript is the biggest thing this app writes, and the store is rewritten
 * on every settings save and every command typed.
 *
 * Deltas are never stored — each answer also arrives once, whole, so the saved
 * form is the settled events only.
 */
const MAX_CONVERSATIONS = 200
/** A turn's tool output can be a build log; the history list is for reading
 *  back what was asked, not for re-running it. */
const MAX_EVENTS = 400

const file = (): string => join(app.getPath('userData'), 'agent-history.json')

let cache: AgentConversation[] | null = null
let timer: NodeJS.Timeout | null = null

function load(): AgentConversation[] {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as AgentConversation[]) : []
  } catch {
    // A broken history must not cost anyone their connections.
    try {
      renameSync(file(), `${file()}.corrupt`)
    } catch {
      // Nothing else to do; start empty.
    }
    cache = []
  }
  return cache
}

/** Debounced: a turn writes an event per tool call, and each one would otherwise
 *  be a full rewrite of the file. */
function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    persist()
  }, 800)
}

/** A saved conversation keeps its tool results, but only this much of each: a
 *  build log is 32 KB a line in the live transcript, and 200 conversations of
 *  that is a file nobody wants parsed on every save. The live copy is intact —
 *  this only bounds what survives a restart. */
const MAX_STORED_TEXT = 4000

function slim(m: Msg): Msg {
  if (m.role !== 'result') return m
  return {
    ...m,
    results: m.results.map((r) =>
      r.text.length > MAX_STORED_TEXT
        ? { ...r, text: `${r.text.slice(0, MAX_STORED_TEXT)}\n…（存档只留了前 ${MAX_STORED_TEXT} 字）` }
        : r
    )
  }
}

function persist(): void {
  const list = load()
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const tmp = `${file()}.tmp`
    const stored = list.map((c) => (c.messages ? { ...c, messages: c.messages.map(slim) } : c))
    writeFileSync(tmp, JSON.stringify(stored), 'utf8')
    renameSync(tmp, file())
  } catch {
    // A full disk must not take the conversation down with it.
  }
}

export function flush(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
    persist()
  }
}

export function list(connectionId: string): AgentConversationInfo[] {
  return load()
    .filter((c) => c.connectionId === connectionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ events: _events, messages: _messages, endpoint: _endpoint, ...rest }) => rest)
}

export function get(id: string): AgentConversation | null {
  return load().find((c) => c.id === id) ?? null
}

export function remove(id: string): void {
  const list = load()
  const i = list.findIndex((c) => c.id === id)
  if (i < 0) return
  list.splice(i, 1)
  persist()
}

const titleOf = (events: AgentEvent[]): string => {
  const said = events.find((e) => e.kind === 'user')
  const text = said && 'text' in said ? said.text.trim().replace(/\s+/g, ' ') : ''
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '未命名对话'
}

/**
 * Appends one event to the open conversation for a session, creating it on the
 * first user turn. Returns the conversation it went into.
 *
 * `messages` is the model-side history saved alongside, so reopening the
 * conversation continues it instead of starting over. It is written on every
 * event because it is a plain assignment; the file itself is debounced.
 */
export function append(
  current: string | null,
  connectionId: string,
  event: AgentEvent,
  messages?: Msg[],
  endpoint?: string
): string {
  const list = load()
  let convo = current ? list.find((c) => c.id === current) : undefined
  if (!convo) {
    // A reply with no question before it (a reload, a restored panel) starts
    // its own thread rather than being dropped.
    convo = {
      id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      connectionId,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: []
    }
    list.push(convo)
  }
  if (event.kind !== 'delta') convo.events.push(event)
  if (convo.events.length > MAX_EVENTS) convo.events.splice(0, convo.events.length - MAX_EVENTS)
  // A reopened conversation replays these events, and a card that still has
  // buttons would approve a command whose turn ended long ago.
  if (event.kind === 'done') {
    for (const ev of convo.events) if (ev.kind === 'ask') ev.settled = true
  }
  // It is the writer's responsibility to hand over a list already inside the
  // window: truncating here would cut a tool result away from its call and
  // leave a history no endpoint will accept.
  if (messages?.length) convo.messages = messages
  if (endpoint) convo.endpoint = endpoint
  convo.updatedAt = Date.now()
  convo.title = convo.title || titleOf(convo.events)

  // Oldest first: the list is sorted on read, so trimming here keeps the newest.
  if (list.length > MAX_CONVERSATIONS) {
    const drop = list
      .slice()
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, list.length - MAX_CONVERSATIONS)
    for (const d of drop) list.splice(list.indexOf(d), 1)
  }
  schedule()
  return convo.id
}

/** Conversations belonging to the connections in an export. */
export function forConnections(connectionIds: Iterable<string>): AgentConversation[] {
  const keep = new Set(connectionIds)
  return load().filter((c) => keep.has(c.connectionId))
}

/** Merge on import: same id wins only when the incoming copy is newer. */
export function merge(incoming: AgentConversation[]): void {
  const list = load()
  for (const convo of incoming) {
    if (!convo?.id || !Array.isArray(convo.events)) continue
    const i = list.findIndex((c) => c.id === convo.id)
    if (i < 0) list.push(convo)
    else if ((convo.updatedAt ?? 0) > (list[i].updatedAt ?? 0)) list[i] = convo
  }
  persist()
}
