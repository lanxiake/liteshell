import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AgentConversation, AgentConversationInfo, AgentEvent } from '../shared/types'

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

function persist(): void {
  const list = load()
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify(list), 'utf8')
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
    .map(({ events: _events, ...rest }) => rest)
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
 */
export function append(
  current: string | null,
  connectionId: string,
  event: AgentEvent
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
