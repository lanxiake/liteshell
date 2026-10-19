import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import {
  hintFor,
  searchCommands,
  suggest as suggestCommands,
  type CommandEntry,
  type Suggestion
} from './commands'
import { alertsFor, toneOf, usePct, type Tone } from './alerts'
import type {
  AgentEvent,
  Connection,
  Folder,
  KeyFile,
  MonitorSnapshot,
  QuickCommand,
  RemoteText,
  SessionEvent,
  SessionStatus,
  Settings,
  SftpEntry,
  Store,
  Transfer
} from '../../shared/types'

declare const api: import('../../shared/types').Api

/* ------------------------------------------------------------------ *
 * themes
 * ------------------------------------------------------------------ */

interface Theme {
  label: string
  chrome: 'dark' | 'light'
  /** Written straight onto :root as CSS custom properties, so the chrome follows too. */
  ui: Record<string, string>
  term: ITheme
}

const THEMES: Record<string, Theme> = {
  liteshell: {
    label: 'LiteShell 暗色',
    chrome: 'dark',
    ui: {
      bg: '#0f1116',
      'bg-panel': '#141821',
      'bg-side': '#12151d',
      'bg-hover': '#1c2130',
      'bg-active': '#232a3d',
      border: '#232936',
      text: '#c9d1dd',
      'text-dim': '#8b95a5',
      'text-faint': '#5d6675',
      accent: '#5b8cff',
      'accent-dim': '#2f4a8a',
      danger: '#e5534b',
      ok: '#3fb950',
      warn: '#d29922'
    },
    term: {
      background: '#141821',
      foreground: '#c9d1dd',
      cursor: '#5b8cff',
      cursorAccent: '#141821',
      selectionBackground: '#2f4a8a',
      black: '#1c2130',
      red: '#e5534b',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#5b8cff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ff7b72',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc'
    }
  },
  midnight: {
    label: '午夜黑',
    chrome: 'dark',
    ui: {
      bg: '#000000',
      'bg-panel': '#0a0c10',
      'bg-side': '#050608',
      'bg-hover': '#161a21',
      'bg-active': '#1f2530',
      border: '#1b2029',
      text: '#d7dde5',
      'text-dim': '#79828f',
      'text-faint': '#4c545f',
      accent: '#00d4aa',
      'accent-dim': '#0d5a4c',
      danger: '#ff5f56',
      ok: '#3ddc84',
      warn: '#e8b339'
    },
    term: {
      background: '#0a0c10',
      foreground: '#d7dde5',
      cursor: '#00d4aa',
      cursorAccent: '#0a0c10',
      selectionBackground: '#0d5a4c',
      black: '#0a0c10',
      red: '#ff5f56',
      green: '#3ddc84',
      yellow: '#e8b339',
      blue: '#5aa9ff',
      magenta: '#c792ea',
      cyan: '#00d4aa',
      white: '#d7dde5',
      brightBlack: '#5c6572',
      brightRed: '#ff8a80',
      brightGreen: '#6ee7a8',
      brightYellow: '#f5cf6b',
      brightBlue: '#8ec5ff',
      brightMagenta: '#dcb1f0',
      brightCyan: '#5cf0d4',
      brightWhite: '#ffffff'
    }
  },
  nord: {
    label: 'Nord',
    chrome: 'dark',
    ui: {
      bg: '#2e3440',
      'bg-panel': '#3b4252',
      'bg-side': '#292e39',
      'bg-hover': '#434c5e',
      'bg-active': '#4c566a',
      border: '#434c5e',
      text: '#eceff4',
      'text-dim': '#aebacd',
      'text-faint': '#7b88a1',
      accent: '#88c0d0',
      'accent-dim': '#3b6b78',
      danger: '#bf616a',
      ok: '#a3be8c',
      warn: '#ebcb8b'
    },
    term: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d08770',
      brightGreen: '#b8d69f',
      brightYellow: '#f0d9a3',
      brightBlue: '#8fbcbb',
      brightMagenta: '#c9a3c4',
      brightCyan: '#9ed8e0',
      brightWhite: '#eceff4'
    }
  },
  dracula: {
    label: 'Dracula',
    chrome: 'dark',
    ui: {
      bg: '#21222c',
      'bg-panel': '#282a36',
      'bg-side': '#1e1f29',
      'bg-hover': '#343746',
      'bg-active': '#44475a',
      border: '#343746',
      text: '#f8f8f2',
      'text-dim': '#b0b3c4',
      'text-faint': '#7c81a0',
      accent: '#bd93f9',
      'accent-dim': '#5b4a86',
      danger: '#ff5555',
      ok: '#50fa7b',
      warn: '#f1fa8c'
    },
    term: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  paper: {
    label: '纸张白',
    chrome: 'light',
    ui: {
      bg: '#f4f5f8',
      'bg-panel': '#ffffff',
      'bg-side': '#eceef3',
      'bg-hover': '#e3e6ee',
      'bg-active': '#d8dde9',
      border: '#d6dae3',
      text: '#1f2430',
      'text-dim': '#5b6474',
      'text-faint': '#8a93a5',
      accent: '#3b6fd4',
      'accent-dim': '#b9cdfa',
      danger: '#c0392b',
      ok: '#1a7f37',
      warn: '#9a6700'
    },
    term: {
      background: '#ffffff',
      foreground: '#24292f',
      cursor: '#0969da',
      selectionBackground: '#b6d7ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f'
    }
  },
  solarized: {
    label: 'Solarized 亮',
    chrome: 'light',
    ui: {
      bg: '#fdf6e3',
      'bg-panel': '#fffbf0',
      'bg-side': '#eee8d5',
      'bg-hover': '#e4ddc8',
      'bg-active': '#d9d2bb',
      border: '#ddd6c1',
      text: '#073642',
      'text-dim': '#586e75',
      'text-faint': '#93a1a1',
      accent: '#268bd2',
      'accent-dim': '#a8cbe6',
      danger: '#dc322f',
      ok: '#859900',
      warn: '#b58900'
    },
    term: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#268bd2',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#93a1a1',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3'
    }
  },
  github: {
    label: 'GitHub 亮',
    chrome: 'light',
    ui: {
      bg: '#ffffff',
      'bg-panel': '#ffffff',
      'bg-side': '#f6f8fa',
      'bg-hover': '#eaeef2',
      'bg-active': '#dfe3e8',
      border: '#d0d7de',
      text: '#1f2328',
      'text-dim': '#59636e',
      'text-faint': '#8c959f',
      accent: '#0969da',
      'accent-dim': '#b6d7ff',
      danger: '#cf222e',
      ok: '#1a7f37',
      warn: '#9a6700'
    },
    term: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#0969da',
      selectionBackground: '#b6d7ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f'
    }
  }
}

/* ------------------------------------------------------------------ *
 * tiny dom helpers
 * ------------------------------------------------------------------ */

function $(sel: string): HTMLElement {
  return document.querySelector(sel) as HTMLElement
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text) node.textContent = text
  return node
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

/** Colour buckets for the SFTP list — the css classes carry the actual colours. */
const FILE_KINDS: [string, string][] = [
  ['exec', 'sh bash zsh fish csh ksh py pyw pl rb lua exe msi com bat cmd run app'],
  ['archive', 'zip rar 7z gz tgz bz2 xz zst lz4 tar cab jar war ear apk ipa deb rpm dmg iso img'],
  ['media', 'png jpg jpeg gif bmp webp svg ico tif tiff psd mp3 mp4 avi mkv mov wav flac ogg webm m4a aac pdf ttf otf woff woff2'],
  ['code', 'js mjs cjs ts jsx tsx vue svelte go rs c h cc cpp cxx hpp java kt kts scala php swift sql json yaml yml toml xml html htm css scss sass less md rst ini cfg conf env properties gradle cmake dockerfile makefile'],
  ['log', 'log out err trace']
]

function fileKind(name: string): string {
  const dot = name.lastIndexOf('.')
  // `foo.tar.gz` keys off `gz`, `.bashrc` off `bashrc`, `Makefile` off the name.
  const ext = name.slice(dot + 1).toLowerCase()
  for (const [kind, list] of FILE_KINDS) {
    if (list.split(' ').includes(ext)) return `kind-${kind}`
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

interface Session {
  id: string
  connectionId: string
  name: string
  status: SessionStatus
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  pane: HTMLElement
  tab: HTMLElement
  notice: HTMLElement
  toolbar: HTMLElement
  files: HTMLElement
  filePath: string
  selected: SftpEntry | null
  searchBar: HTMLElement
  monitor: MonitorView | null
  /** The AI panel, built up-front and hidden like the monitor one. */
  agent: AgentView | null
  /** Upload progress rows, keyed by transfer id so events can update them in place. */
  transfers: Map<string, { row: HTMLElement; fill: HTMLElement; pct: HTMLElement }>
  transferList: HTMLElement
  /** Commands typed in this session, oldest first. */
  history: string[]
  /** Best-effort echo of the line being typed, for history matching. */
  line: string
  suggest: HTMLElement
  suggestItems: Suggestion[]
  suggestIndex: number
  /** What was on the line before the first candidate got previewed into it. */
  suggestTyped?: string
  historyTimer?: number
}

let store: Store
let activeId: string | null = null
let broadcast = false
const sessions = new Map<string, Session>()
const collapsed = new Set<string>()

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  document.body.dataset.platform = /Mac/.test(navigator.userAgent)
    ? 'mac'
    : /Linux/.test(navigator.userAgent)
      ? 'linux'
      : 'win'

  store = await api.getStore()
  applySettings(store.settings)
  renderTree()
  wireChrome()
  // Registered before attaching: main starts replaying buffered events the
  // moment the attach call lands.
  api.onSessionEvent(handleEvent)

  // ?attach=<session>&conn=<connection>: this window was opened around a tab
  // that is already connected somewhere else.
  const params = new URLSearchParams(location.search)
  const attach = params.get('attach')
  const conn = store.connections.find((c) => c.id === params.get('conn'))
  if (attach && conn) await openSession(conn, attach)
}

function applySettings(settings: Settings): void {
  const theme = THEMES[settings.theme] ?? THEMES.liteshell
  document.body.dataset.chrome = theme.chrome
  // Theme colors live in the theme table, not the stylesheet: the stylesheet only
  // declares the variable names, so adding a theme is a data change.
  for (const [name, value] of Object.entries(theme.ui)) {
    document.documentElement.style.setProperty(`--${name}`, value)
  }
  // File-type colors in the SFTP list, borrowed from the terminal palette so a
  // new theme inherits them instead of having to declare two more variables.
  document.documentElement.style.setProperty('--type-media', theme.term.magenta ?? '#bc8cff')
  document.documentElement.style.setProperty('--type-code', theme.term.cyan ?? '#39c5cf')
  document.body.dataset.theme = settings.theme
  void api.setWindowChrome(theme.ui.bg, theme.ui['text-dim'])
  for (const session of sessions.values()) {
    session.term.options.fontFamily = settings.fontFamily
    session.term.options.fontSize = settings.fontSize
    session.term.options.cursorStyle = settings.cursorStyle
    session.term.options.cursorBlink = settings.cursorBlink
    session.term.options.scrollback = settings.scrollback
    session.term.options.theme = theme.term
    session.fit.fit()
  }
}

/* ------------------------------------------------------------------ *
 * connection tree
 * ------------------------------------------------------------------ */

function renderTree(): void {
  const tree = $('#tree')
  tree.replaceChildren()

  const children = (parentId: string | null): (Folder | Connection)[] => [
    ...store.folders.filter((f) => f.parentId === parentId),
    ...store.connections.filter((c) => c.folderId === parentId)
  ]

  const draw = (parentId: string | null, depth: number): void => {
    for (const item of children(parentId)) {
      const isFolder = 'host' in item === false
      const live = isFolder
        ? false
        : [...sessions.values()].some((s) => s.connectionId === item.id && s.status === 'ready')
      const failed = isFolder
        ? false
        : [...sessions.values()].some((s) => s.connectionId === item.id && s.status === 'error')

      const node = el('div', 'node')
      if (live) node.classList.add('live')
      if (failed) node.classList.add('failed')
      node.style.paddingLeft = `${8 + depth * 14}px`
      node.dataset.id = item.id
      node.dataset.kind = isFolder ? 'folder' : 'connection'

      if (isFolder && !collapsed.has(item.id)) {
        const chev = el('span', 'chev open', '▶')
        node.appendChild(chev)
      } else if (isFolder) {
        node.appendChild(el('span', 'chev', '▶'))
      } else {
        node.appendChild(el('span', 'dot'))
      }

      node.appendChild(el('span', 'label', item.name))
      if (!isFolder) {
        node.appendChild(el('span', 'sub', `${(item as Connection).username}@${(item as Connection).host}`))
      }

      node.addEventListener('click', () => {
        if (isFolder) {
          collapsed.has(item.id) ? collapsed.delete(item.id) : collapsed.add(item.id)
          renderTree()
        } else {
          void openSession(item as Connection)
        }
      })
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        treeMenu(ev, item, isFolder, item.id)
      })

      tree.appendChild(node)
      if (isFolder && !collapsed.has(item.id)) draw(item.id, depth + 1)
    }
  }

  draw(null, 0)

  if (!store.folders.length && !store.connections.length) {
    const hint = el('div', 'empty-hint')
    hint.innerHTML = '还没有连接<br />点右上角 <b>＋</b> 新建'
    tree.appendChild(hint)
  }
}

function treeMenu(ev: MouseEvent, item: Folder | Connection, isFolder: boolean, id: string): void {
  const parentId = isFolder ? (item as Folder).parentId : (item as Connection).folderId
  const items: MenuItem[] = isFolder
    ? [
        { label: '新建连接', run: () => connDialog(null, id) },
        { label: '新建子文件夹', run: () => folderDialog(null, id) },
        { sep: true },
        { label: '重命名', run: () => folderDialog(item as Folder, parentId) },
        { label: '删除', danger: true, run: () => confirmDelete('文件夹', `删除文件夹「${item.name}」及其中所有连接？`, () => api.deleteFolder(id)) }
      ]
    : [
        { label: '连接', run: () => void openSession(item as Connection) },
        { label: '编辑', run: () => connDialog(item as Connection, null) },
        { label: '重命名', run: () => renameConnection(item as Connection) },
        { label: '复制 IP', run: () => copyText((item as Connection).host, 'IP') },
        { label: '导出…', run: () => void exportOneDialog(item as Connection) },
        { label: '复制', run: () => void api.duplicateConnection(id).then(refreshStore) },
        { sep: true },
        { label: '删除', danger: true, run: () => confirmDelete('连接', `删除连接「${item.name}」？`, () => api.deleteConnection(id)) }
      ]
  showMenu(ev.clientX, ev.clientY, items)
}

function renameConnection(conn: Connection): void {
  promptDialog('重命名连接', '名称', conn.name, async (value) => {
    const name = value.trim()
    if (!name || name === conn.name) return
    // `hasSecret`/`secret` are renderer-side views; passing them back would
    // write them into the store. `null` keeps the saved password as it is.
    const { hasSecret: _hasSecret, secret: _secret, ...rest } = conn
    await api.saveConnection({ ...rest, name }, null)
    await refreshStore()
  })
}

async function exportOneDialog(conn: Connection): Promise<void> {
  try {
    const passphrase = await askPassphrase({
      title: `导出「${conn.name}」`,
      note:
        '设一个口令：这条连接的密码会用它在文件里加密，导入时输同一个口令就不用再输密码。' +
        '留空则不带走密码。',
      confirm: '导出',
      twice: true
    })
    if (passphrase === null) return
    const report = await api.exportConnection(conn.id, passphrase)
    if (!report) return
    log('info', `已导出连接「${conn.name}」 → ${report.path}`)
    showModal('导出完成', el('div', 'mon-sub', report.path), [
      { label: '好', primary: true, onClick: closeModal }
    ])
  } catch (err) {
    log('error', `导出失败：${(err as Error).message}`)
  }
}

function confirmDelete(_kind: string, message: string, run: () => Promise<void>): void {
  if (!window.confirm(message)) return
  void run().then(refreshStore)
}

/* ------------------------------------------------------------------ *
 * menus / modals
 * ------------------------------------------------------------------ */

interface MenuItem {
  label?: string
  sep?: boolean
  danger?: boolean
  run?: () => void
}

let menuEl: HTMLElement | null = null

function closeMenu(): void {
  menuEl?.remove()
  menuEl = null
}

function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu()
  const menu = el('div')
  menu.id = 'menu'
  for (const item of items) {
    if (item.sep) {
      menu.appendChild(el('hr'))
      continue
    }
    const row = el('div', item.danger ? 'danger' : '', item.label ?? '')
    row.addEventListener('click', () => {
      closeMenu()
      item.run?.()
    })
    menu.appendChild(row)
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
  menuEl = menu
}

function showModal(
  title: string,
  content: HTMLElement,
  actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }[]
): void {
  const overlay = $('#overlay')
  overlay.hidden = false
  overlay.replaceChildren()

  const modal = el('div', 'modal')
  modal.appendChild(el('h2', '', title))
  const body = el('div', 'content')
  body.appendChild(content)
  modal.appendChild(body)

  const footer = el('footer')
  for (const action of actions) {
    const btn = el('button', `btn${action.primary ? ' primary' : ''}${action.danger ? ' danger' : ''}`, action.label)
    btn.addEventListener('click', () => void action.onClick())
    footer.appendChild(btn)
  }
  modal.appendChild(footer)
  overlay.appendChild(modal)

  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) closeModal()
  })
}

function closeModal(): void {
  $('#overlay').hidden = true
  $('#overlay').replaceChildren()
}

/** Electron has no window.prompt, so ask with a real modal. */
function promptDialog(
  title: string,
  label: string,
  initial: string,
  onOk: (value: string) => void | Promise<void>
): void {
  const value = input(initial)
  const body = el('div')
  body.appendChild(field(label, value))
  showModal(title, body, [
    { label: '取消', onClick: closeModal },
    {
      label: '确定',
      primary: true,
      onClick: async () => {
        const text = value.value.trim()
        if (!text) return
        closeModal()
        await onOk(text)
      }
    }
  ])
  setTimeout(() => value.select(), 0)
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('div', 'field')
  wrap.appendChild(el('label', '', label))
  wrap.appendChild(control)
  return wrap
}

function input(value = '', type = 'text'): HTMLInputElement {
  const node = el('input')
  node.type = type
  node.value = value
  return node
}

function select(options: [string, string][], value: string): HTMLSelectElement {
  const node = el('select')
  for (const [val, label] of options) {
    const opt = el('option', '', label)
    opt.value = val
    node.appendChild(opt)
  }
  node.value = value
  return node
}

async function refreshStore(): Promise<void> {
  store = await api.getStore()
  renderTree()
  // Whether the AI panel exists is derived from the store, so every place that
  // reloads it has to resync — otherwise configuring a key would need a restart.
  for (const session of sessions.values()) syncAgentEntry(session)
}

/* ------------------------------------------------------------------ *
 * connection editor
 * ------------------------------------------------------------------ */

/** Folder picker options, excluding `skip` and its descendants so a folder cannot become its own parent. */
function folderOptions(skip: string | null): [string, string][] {
  const out: [string, string][] = [['', '（根目录）']]
  const walk = (parentId: string | null, depth: number): void => {
    for (const f of store.folders.filter((x) => x.parentId === parentId)) {
      if (f.id === skip) continue
      out.push([f.id, '　'.repeat(depth) + f.name])
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function connDialog(existing: Connection | null, folderId: string | null): void {
  const draft: Connection = existing
    ? { ...existing }
    : {
        id: uid(),
        name: '',
        folderId,
        host: '',
        port: 22,
        username: 'root',
        authType: 'password',
        termType: 'xterm-256color',
        keepalive: 30
      }

  const name = input(draft.name)
  const host = input(draft.host)
  const port = input(String(draft.port), 'number')
  const username = input(draft.username)
  const auth = select(
    [
      ['password', '密码'],
      ['key', '私钥'],
      ['agent', 'SSH Agent']
    ],
    draft.authType
  )
  const secret = input('', 'password')
  secret.placeholder = existing ? '留空则不修改' : ''
  const agentSocket = input(draft.agentSocket ?? '')
  const keepalive = input(String(draft.keepalive), 'number')
  const termType = input(draft.termType)
  const folder = select(folderOptions(null), draft.folderId ?? '')

  // The key list is the point of the picker; a path this connection already
  // carries is kept as an option even when nobody filed it in the library.
  let keyValue = draft.privateKeyPath ?? ''
  const keySelect = select([], '')
  keySelect.style.flex = '1'
  keySelect.style.minWidth = '0'
  const keyNote = el('div', 'key-path')
  const fillKeys = (): void => {
    keySelect.replaceChildren()
    const options: [string, string][] = [['', '（未选择）']]
    for (const k of store.keys) options.push([k.path, keyLabel(k)])
    if (keyValue && !store.keys.some((k) => k.path === keyValue)) {
      options.push([keyValue, `${keyValue.replace(/.*[\\/]/, '')}（不在私钥库）`])
    }
    for (const [val, label] of options) {
      const opt = el('option', '', label)
      opt.value = val
      keySelect.appendChild(opt)
    }
    keySelect.value = keyValue
    keyNote.textContent = keyValue || '未选择私钥文件'
  }
  fillKeys()
  keySelect.addEventListener('change', () => {
    keyValue = keySelect.value
    fillKeys()
  })

  const keyImport = el('button', 'btn', '导入')
  keyImport.title = '导入一个新的私钥文件（可带口令），并选用它'
  keyImport.addEventListener('click', async () => {
    const added = await importKeyFiles()
    if (!added?.length) return
    // The one just imported is almost certainly the one you meant.
    keyValue = added[added.length - 1].path
    fillKeys()
  })
  const keyBrowse = el('button', 'btn', '浏览')
  keyBrowse.title = '选一个不在私钥库里的文件'
  keyBrowse.addEventListener('click', async () => {
    const picked = await api.pickFile()
    if (!picked) return
    keyValue = picked
    fillKeys()
  })

  const keyRow = el('div', 'row-inline')
  keyRow.append(keySelect, keyImport, keyBrowse)
  const secretField = field('密码 / 私钥口令', secret)
  const keyField = field('私钥文件', keyRow)
  keyField.append(keyNote)
  const agentField = field('Agent Socket（留空则用 SSH_AUTH_SOCK）', agentSocket)

  const syncAuth = (): void => {
    const mode = auth.value
    secretField.hidden = mode === 'agent'
    secretField.querySelector('label')!.textContent = mode === 'key' ? '私钥口令（可选）' : '密码'
    keyField.hidden = mode !== 'key'
    agentField.hidden = mode !== 'agent'
  }
  auth.addEventListener('change', syncAuth)

  const body = el('div')
  body.style.display = 'grid'
  body.style.gap = '12px'
  body.append(
    field('名称', name),
    (() => {
      const grid = el('div', 'grid2')
      grid.append(field('主机', host), field('端口', port))
      return grid
    })(),
    (() => {
      const grid = el('div', 'grid2')
      grid.append(field('用户名', username), field('保活(秒)', keepalive))
      return grid
    })(),
    field('认证方式', auth),
    secretField,
    keyField,
    agentField,
    field('所在文件夹', folder),
    field('终端类型', termType)
  )

  syncAuth()

  showModal(existing ? '编辑连接' : '新建连接', body, [
    { label: '取消', onClick: closeModal },
    {
      label: '保存',
      primary: true,
      onClick: async () => {
        if (!host.value.trim()) return
        const next: Connection = {
          ...draft,
          name: name.value.trim() || `${username.value}@${host.value}`,
          host: host.value.trim(),
          port: Number(port.value) || 22,
          username: username.value.trim(),
          authType: auth.value as Connection['authType'],
          privateKeyPath: keyValue.trim() || undefined,
          agentSocket: agentSocket.value.trim() || undefined,
          termType: termType.value.trim() || 'xterm-256color',
          keepalive: Number(keepalive.value) || 0,
          folderId: folder.value || null
        }
        await api.saveConnection(next, existing && secret.value === '' ? null : secret.value)
        closeModal()
        await refreshStore()
      }
    }
  ])
}

function folderDialog(existing: Folder | null, parentId: string | null): void {
  const name = input(existing?.name ?? '')
  const parent = select(
    folderOptions(existing?.id ?? null),
    existing?.parentId ?? parentId ?? ''
  )
  const body = el('div')
  body.style.display = 'grid'
  body.style.gap = '12px'
  body.append(field('名称', name), field('上级文件夹', parent))

  showModal(existing ? '重命名文件夹' : '新建文件夹', body, [
    { label: '取消', onClick: closeModal },
    {
      label: '保存',
      primary: true,
      onClick: async () => {
        const label = name.value.trim()
        if (!label) return
        await api.saveFolder({ id: existing?.id ?? uid(), name: label, parentId: parent.value || null })
        closeModal()
        await refreshStore()
      }
    }
  ])
}

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

function settingsDialog(): void {
  const s = store.settings
  const theme = select(Object.keys(THEMES).map((k) => [k, k]), s.theme)
  const font = input(s.fontFamily)
  const size = input(String(s.fontSize), 'number')
  const cursor = select(
    [
      ['block', '方块'],
      ['underline', '下划线'],
      ['bar', '竖线']
    ],
    s.cursorStyle
  )
  const blink = select(
    [
      ['1', '开'],
      ['0', '关']
    ],
    s.cursorBlink ? '1' : '0'
  )
  const scrollback = input(String(s.scrollback), 'number')
  const copyOnSelect = select([['1', '开'], ['0', '关']], s.copyOnSelect ? '1' : '0')
  const rightClick = select([['1', '开'], ['0', '关']], s.rightClickPaste ? '1' : '0')

  const llm = s.llm ?? { provider: 'anthropic' as const, baseUrl: '', model: '', hasKey: false }
  const provider = select(
    [
      ['anthropic', 'Anthropic（官方 SDK）'],
      ['openai', 'OpenAI 兼容（OpenAI / DeepSeek / 自建网关）']
    ],
    llm.provider
  )
  const model = input(llm.model)
  const baseUrl = input(llm.baseUrl)
  const MODEL: Record<string, string> = { anthropic: 'claude-opus-5', openai: 'deepseek-chat' }

  // Names come from the endpoint itself; typing one from memory is how people
  // end up with a 404 that looks like a broken key. The list is a datalist, so
  // picking is optional and typing still works when the lookup fails.
  const modelList = document.createElement('datalist')
  modelList.id = 'llm-models'
  model.setAttribute('list', modelList.id)
  model.autocomplete = 'off'
  const pull = el('button', 'agent-mini', '拉取模型')
  pull.title = '从接口地址读取模型列表；读不到就直接手填'
  const note = el('div', 'llm-note')
  const urlRow = el('div', 'key-row')
  urlRow.append(baseUrl, pull)
  const modelRow = el('div', 'key-row')
  modelRow.append(model, modelList)

  const short = (err: unknown): string =>
    String((err as Error)?.message ?? err)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '')

  pull.addEventListener('click', () => {
    const ids = (base: string): Promise<string[]> =>
      api.listModels({
        provider: provider.value as Settings['llm']['provider'],
        baseUrl: base,
        apiKey: apiKey.value.trim() || undefined
      })
    const fill = (list: string[]): void => {
      modelList.replaceChildren(
        ...list.map((id) => {
          const opt = document.createElement('option')
          opt.value = id
          return opt
        })
      )
      if (!model.value.trim()) model.value = list[0]
    }

    pull.disabled = true
    note.textContent = '正在拉取…'
    const typed = baseUrl.value.trim().replace(/\/+$/, '')
    ids(typed)
      .catch((err) => {
        // `/v1` is the single most common thing people leave off, and the
        // gateway answers a request to the bare host with its web page rather
        // than an error — so try the fixed-up address once before giving up,
        // and say out loud that the box was changed.
        if (provider.value !== 'openai' || /\/v1$/.test(typed) || !typed) throw err
        return ids(`${typed}/v1`).then((list) => {
          baseUrl.value = `${typed}/v1`
          note.textContent = `地址少了 /v1，已经补上再拉一次 —— `
          return list
        })
      })
      .then((list) => {
        fill(list)
        note.textContent += `拉到 ${list.length} 个模型，点模型框可以选`
      })
      .catch((err) => {
        note.textContent = `没拉到：${short(err)} —— 可以自己填模型名`
      })
      .finally(() => {
        pull.disabled = false
      })
  })
  let shown: string = llm.provider
  const syncProvider = (from: string, to: string): void => {
    model.placeholder = MODEL[to]
    baseUrl.placeholder = to === 'anthropic' ? '留空用官方地址' : '留空用官方地址，自建网关填 https://…/v1'
    // The default belongs in the placeholder, never in the value: writing it
    // into the box shows a model the endpoint may not even have as though the
    // user had chosen it, which is exactly how "拉取模型" ends up looking like
    // it worked while the field still holds yesterday's guess.
    if (model.value.trim() === MODEL[from]) model.value = ''
  }
  syncProvider(shown, shown)
  provider.addEventListener('change', () => {
    syncProvider(shown, provider.value)
    shown = provider.value
  })
  const apiKey = input('', 'password')
  apiKey.placeholder = llm.hasKey ? '已保存，留空则不修改' : '本地网关通常不用填'
  let forgetKey = false
  const forget = el('button', 'agent-mini', '清除')
  forget.title = '保存后删掉已存的密钥'
  forget.addEventListener('click', () => {
    forgetKey = true
    apiKey.value = ''
    apiKey.placeholder = '保存后清除'
  })
  const keyRow = el('div', 'key-row')
  keyRow.append(apiKey, forget)

  const body = el('div')
  body.style.display = 'grid'
  body.style.gap = '12px'
  body.append(
    field('配色', theme),
    field('字体', font),
    (() => {
      const grid = el('div', 'grid2')
      grid.append(field('字号', size), field('光标', cursor))
      return grid
    })(),
    (() => {
      const grid = el('div', 'grid2')
      grid.append(field('光标闪烁', blink), field('回滚行数', scrollback))
      return grid
    })(),
    (() => {
      const grid = el('div', 'grid2')
      grid.append(field('选中即复制', copyOnSelect), field('右键粘贴', rightClick))
      return grid
    })(),
    el('div', 'field-sep', 'AI 助手'),
    field('接口', provider),
    field('接口地址', urlRow),
    field('模型', modelRow),
    note,
    field('API Key', keyRow)
  )

  showModal('设置', body, [
    { label: '取消', onClick: closeModal },
    {
      label: '保存',
      primary: true,
      onClick: async () => {
        // No silent default: a model name this app picked for you is a 404 on
        // the endpoint you actually use, reported as "the model does not exist"
        // with no hint that you never chose it. Pull it, or type it.
        if (!model.value.trim()) {
          note.textContent = '模型不能空 —— 点「拉取模型」从接口读一份，或者自己填。'
          model.focus()
          return
        }
        const next: Settings = {
          theme: theme.value,
          fontFamily: font.value.trim() || s.fontFamily,
          fontSize: Number(size.value) || 14,
          cursorStyle: cursor.value as Settings['cursorStyle'],
          cursorBlink: blink.value === '1',
          scrollback: Number(scrollback.value) || 5000,
          copyOnSelect: copyOnSelect.value === '1',
          rightClickPaste: rightClick.value === '1',
          // Not in this dialog; carried through so saving does not undo a drag.
          agentWidth: s.agentWidth,
          llm: {
            provider: provider.value as Settings['llm']['provider'],
            baseUrl: baseUrl.value.trim(),
            model: model.value.trim(),
            // Absent means "leave the stored one alone"; empty means "forget it".
            apiKey: forgetKey ? '' : apiKey.value.trim() || undefined
          }
        }
        applySettings(await api.saveSettings(next))
        // The saved copy is the authority: it knows whether a key is on file
        // now, which is what decides whether the AI button exists at all —
        // refreshStore resyncs that on every session.
        await refreshStore()
        closeModal()
      }
    }
  ])
}

/* ------------------------------------------------------------------ *
 * FinalShell import
 * ------------------------------------------------------------------ */

/** One entry point for both directions, since they only differ by which dialog opens. */
function transferMenu(ev: MouseEvent): void {
  showMenu(ev.clientX, ev.clientY, [
    { label: '从 FinalShell 导入…', run: () => void importFinalshellDialog() },
    { sep: true },
    { label: '导入 LiteShell 备份…', run: () => void importBundleDialog() },
    { label: '导出全部连接…', run: () => void exportBundleDialog() }
  ])
}

/**
 * Promise-wrapped passphrase modal. An empty answer is allowed in both
 * directions (on export it means "do not seal"); null means the user backed out.
 * `twice` asks a second time — a typo there is only discovered on the machine
 * that cannot open the file.
 */
function askPassphrase(opts: {
  title: string
  note: string
  confirm: string
  twice?: boolean
}): Promise<string | null> {
  return new Promise((resolve) => {
    const box = input('', 'password')
    const again = opts.twice ? input('', 'password') : null
    const hint = el('div', 'mon-sub')
    let settled = false

    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      closeModal()
      resolve(value)
    }
    const submit = (): void => {
      if (again && again.value !== box.value) {
        hint.textContent = '两次输入的口令不一样'
        return
      }
      done(box.value)
    }

    const body = el('div')
    body.style.display = 'grid'
    body.style.gap = '8px'
    body.append(el('div', 'mon-sub', opts.note), field('口令', box))
    if (again) body.append(field('再输一次', again))
    body.append(hint)

    showModal(opts.title, body, [
      { label: '取消', onClick: () => done(null) },
      { label: opts.confirm, primary: true, onClick: submit }
    ])
    box.focus()
    for (const node of [box, again]) {
      node?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submit()
      })
    }
  })
}

async function exportBundleDialog(): Promise<void> {
  try {
    const passphrase = await askPassphrase({
      title: '导出全部连接',
      note:
        '设一个口令：这台机器上存着的密码和模型 API Key 会用它加密写进备份，另一台机器导入时输同一个口令，就一条都不用再输。' +
        '留空则不加密，那些密码留在这台机器上。',
      confirm: '导出',
      twice: true
    })
    if (passphrase === null) return

    const report = await api.exportConnections(passphrase)
    if (!report) return
    log(
      'info',
      `已导出 ${report.connections} 条连接和 ${report.keys} 个私钥` +
        (report.passwords ? `，以及 ${report.passwords} 个密码` : '') +
        ` → ${report.path}`
    )
    const body = el('div')
    body.style.display = 'grid'
    body.style.gap = '6px'
    body.append(
      el('div', '', `连接 ${report.connections} 条，私钥 ${report.keys} 个`),
      el('div', 'mon-sub', report.path),
      el(
        'div',
        'mon-sub',
        report.passwords
          ? `密码和 API Key 已加密写进文件（${report.passwords} 项），另一台机器导入时输这个口令就能用。`
          : '文件里不含密码——密码由本机钥匙串封装，换台机器要重新输入。'
      ),
      el(
        'div',
        'mon-sub',
        `另外还带了：界面设置（主题 / 字体 / 面板宽度）、模型接口、${report.hostKeys} 个已信任的主机指纹。`
      )
    )
    for (const name of report.missing) {
      body.append(el('div', 'mon-sub', `⚠ ${name} 的私钥文件已丢失，没有导出`))
      log('warn', `${name} 的私钥文件已丢失，导出时跳过`)
    }
    showModal('导出完成', body, [{ label: '好', primary: true, onClick: closeModal }])
  } catch (err) {
    log('error', `导出失败：${(err as Error).message}`)
    showModal('导出失败', el('div', '', (err as Error).message), [
      { label: '好', primary: true, onClick: closeModal }
    ])
  }
}

async function importBundleDialog(): Promise<void> {
  try {
    let report = await api.importConnections()
    if (!report) return
    if ('needsPassphrase' in report) {
      const passphrase = await askPassphrase({
        title: '这个备份加密了',
        note: '输入导出时设的那个口令。',
        confirm: '解锁'
      })
      if (passphrase === null) return
      report = await api.importConnections(passphrase, report.path)
      if (!report || 'needsPassphrase' in report) return
    }
    await refreshStore()
    log(
      'info',
      `导入备份：${report.folders} 个文件夹 / ${report.connections} 条连接 / ${report.keys} 个私钥` +
        (report.passwords ? ` / ${report.passwords} 个密码` : '')
    )
    const body = el('div')
    body.style.display = 'grid'
    body.style.gap = '6px'
    body.append(
      el('div', '', `文件夹 ${report.folders} 个，连接 ${report.connections} 条，私钥 ${report.keys} 个`),
      el(
        'div',
        'mon-sub',
        report.passwords
          ? `${report.passwords} 个密码已经存进这台机器的钥匙串，连的时候不用再输。`
          : '密码没有随备份过来，首次连接时会让你输入。'
      )
    )
    if (report.llm) {
      body.append(
        el(
          'div',
          'mon-sub',
          `模型接口也跟着换成了 ${store.settings.llm.provider} / ${store.settings.llm.model}，可以在设置里核对。`
        )
      )
    }
    if (report.settings || report.hostKeys) {
      body.append(
        el(
          'div',
          'mon-sub',
          '主题、字体、面板宽度' +
            (report.hostKeys ? `，以及 ${report.hostKeys} 个主机指纹` : '') +
            '也跟着过来了。'
        )
      )
    }
    if (report.missingKeys) {
      body.append(el('div', 'mon-sub', `⚠ ${report.missingKeys} 条连接引用的私钥不在备份里`))
    }
    showModal('导入完成', body, [{ label: '好', primary: true, onClick: closeModal }])
  } catch (err) {
    log('error', `导入失败：${(err as Error).message}`)
    showModal('导入失败', el('div', '', (err as Error).message), [
      { label: '好', primary: true, onClick: closeModal }
    ])
  }
}

async function importFinalshellDialog(): Promise<void> {
  const summary = await api.importFinalshell()
  if (!summary) return
  await refreshStore()
  log(
    'info',
    `导入 FinalShell：${summary.folders} 个文件夹 / ${summary.connections} 条连接 / ${summary.keys} 个私钥` +
      (summary.needsPassword ? `，${summary.needsPassword} 条需要补录密码` : '')
  )
  for (const warning of summary.warnings) log('warn', `导入提示：${warning}`)

  const rows: [string, string][] = [
    ['文件夹', String(summary.folders)],
    ['连接', String(summary.connections)],
    ['导出的私钥', `${summary.keys} 个`]
  ]
  if (summary.needsPassword) {
    rows.push([
      '需要补录密码',
      `${summary.needsPassword} 个连接（FinalShell 的密码是加密存储的，导不出来）`
    ])
  }
  if (summary.skipped) rows.push(['已跳过（非 SSH）', String(summary.skipped)])
  for (const warning of summary.warnings) rows.push(['提示', warning])

  const body = el('div')
  body.style.display = 'grid'
  body.style.gap = '6px'
  for (const [label, value] of rows) {
    const row = el('div')
    const key = el('span', '', `${label}：`)
    key.style.color = 'var(--text-dim)'
    row.append(key, document.createTextNode(value))
    body.appendChild(row)
  }

  showModal('导入完成', body, [{ label: '好', primary: true, onClick: closeModal }])
}

/* ------------------------------------------------------------------ *
 * private key library
 * ------------------------------------------------------------------ */

/** `label` is what a connection's key picker shows; the path is for confirming. */
function keyLabel(key: KeyFile): string {
  return key.comment ? `${key.name} — ${key.comment}` : key.name
}

function keyItem(key: KeyFile): HTMLElement {
  const row = el('div', 'key-item')
  row.append(el('span', 'key-icon', '🔑'))
  const text = el('div', 'key-text')
  text.append(
    el('div', 'key-name', key.name),
    el(
      'div',
      'key-path',
      `${key.hasSecret ? '🔒 ' : ''}${key.comment ? `${key.comment} · ${key.path}` : key.path}`
    )
  )
  row.append(text)
  row.title = '点击编辑 / 设置口令 / 导出 / 删除'
  row.addEventListener('click', () => keyEditDialog(key))
  return row
}

/**
 * Import files, then ask once for the passphrase. It is stored on the key
 * itself, so every connection that reuses the file connects without asking.
 */
async function importKeyFiles(): Promise<KeyFile[] | null> {
  const added = await api.importKeys()
  if (!added?.length) return null
  const passphrase = await askPassphrase({
    title: '私钥口令',
    note: '私钥有口令就在这里输一次，以后复用它的连接都不用再输；没有口令直接留空。',
    confirm: '保存'
  })
  if (passphrase) {
    for (const key of added) await api.setKeySecret(key.id, passphrase)
  }
  await refreshStore()
  return added
}

async function keysDialog(): Promise<void> {
  const body = el('div', 'key-list')
  if (!store.keys.length) {
    body.append(
      el('div', 'key-empty', '还没有私钥。导入后所有连接都能直接选用，也会跟着连接备份一起导出。')
    )
  }
  for (const key of store.keys) body.append(keyItem(key))

  showModal('私钥管理', body, [
    {
      label: '导入私钥',
      onClick: async () => {
        const added = await importKeyFiles()
        if (!added?.length) return
        log('info', `导入私钥：${added.map((k) => k.name).join('、')}`)
        await keysDialog()
      }
    },
    { label: '关闭', primary: true, onClick: closeModal }
  ])
}

function keyEditDialog(key: KeyFile): void {
  const name = input(key.name)
  const comment = input(key.comment ?? '')
  comment.placeholder = '给密钥起个能认出来的说明，比如「生产跳板机」'

  const body = el('div')
  body.append(
    field('名称', name),
    field('备注', comment),
    field('文件路径', el('div', 'key-path', key.path))
  )

  showModal('私钥', body, [
    {
      label: key.hasSecret ? '修改口令' : '设置口令',
      onClick: async () => {
        const passphrase = await askPassphrase({
          title: `${key.name} — 私钥口令`,
          note: '输一次就存起来，复用这把私钥的连接不用再输。留空表示清除已保存的口令。',
          confirm: '保存'
        })
        if (passphrase === null) return
        await api.setKeySecret(key.id, passphrase)
        await refreshStore()
        await keysDialog()
      }
    },
    {
      label: '导出到文件',
      onClick: async () => {
        const saved = await api.exportKey(key.id)
        if (saved) log('info', `已导出私钥到 ${saved}`)
      }
    },
    {
      label: '删除',
      danger: true,
      onClick: async () => {
        const used = store.connections.some((c) => c.privateKeyPath === key.path)
        const note = used ? `\n仍有连接在用它，文件会保留，只从列表里移除。` : ''
        if (!window.confirm(`从私钥库移除「${key.name}」？${note}`)) return
        await api.deleteKey(key.id)
        await refreshStore()
        await keysDialog()
      }
    },
    { label: '取消', onClick: () => void keysDialog() },
    {
      label: '保存',
      primary: true,
      onClick: async () => {
        await api.saveKey({
          ...key,
          name: name.value.trim() || key.name,
          comment: comment.value.trim() || undefined
        })
        await refreshStore()
        await keysDialog()
      }
    }
  ])
}

/* ------------------------------------------------------------------ *
 * quick commands
 * ------------------------------------------------------------------ */

function quickDialog(): void {
  const draft = store.quickCommands.map((c) => ({ ...c }))
  const list = el('div')
  list.style.display = 'grid'
  list.style.gap = '8px'

  const draw = (): void => {
    list.replaceChildren()
    draft.forEach((cmd, i) => {
      const row = el('div', 'row-inline')
      const name = input(cmd.name)
      name.placeholder = '名称'
      name.style.flex = '0 0 110px'
      const text = input(cmd.command)
      text.placeholder = '命令'
      name.addEventListener('input', () => (draft[i].name = name.value))
      text.addEventListener('input', () => (draft[i].command = text.value))
      const del = el('button', 'btn danger', '×')
      del.addEventListener('click', () => {
        draft.splice(i, 1)
        draw()
      })
      row.append(name, text, del)
      list.appendChild(row)
    })
  }
  draw()

  const add = el('button', 'btn', '＋ 添加一条')
  add.addEventListener('click', () => {
    draft.push({ id: uid(), name: '', command: '' })
    draw()
  })

  const body = el('div')
  body.style.display = 'grid'
  body.style.gap = '12px'
  body.append(list, add)

  showModal('快捷命令', body, [
    { label: '取消', onClick: closeModal },
    {
      label: '保存',
      primary: true,
      onClick: async () => {
        store.quickCommands = draft.filter((c) => c.command.trim())
        await api.saveQuickCommands(store.quickCommands)
        for (const s of sessions.values()) renderQuickBar(s)
        closeModal()
      }
    }
  ])
}

function renderQuickBar(session: Session): void {
  const bar = session.pane.querySelector('.quickbar') as HTMLElement
  bar.replaceChildren()

  const all = el('button', `chip${broadcast ? ' on' : ''}`, broadcast ? '广播：开' : '广播')
  all.title = '开启后命令发往所有已连接的会话'
  all.addEventListener('click', () => {
    broadcast = !broadcast
    for (const s of sessions.values()) renderQuickBar(s)
    $('#status-text').textContent = broadcast ? '广播模式：命令将发送到所有会话' : '就绪'
  })
  bar.appendChild(all)

  for (const cmd of store.quickCommands) {
    const chip = el('button', 'chip', cmd.name || cmd.command)
    // A command kept from the palette already has a description; a hand-written
    // one is usually explained by its own name, so the command alone is fine.
    const hint = hintFor(cmd.command)
    chip.title = hint ? `${cmd.command}\n${hint}` : cmd.command
    chip.addEventListener('click', () => sendCommand(session, cmd.command))
    bar.appendChild(chip)
  }

  const add = el('button', 'chip add', '＋')
  add.addEventListener('click', quickDialog)
  bar.appendChild(add)
}

function sendCommand(session: Session, command: string): void {
  const targets = broadcast ? [...sessions.values()].filter((s) => s.status === 'ready') : [session]
  for (const target of targets) send(target, command + '\r')
}

/* ------------------------------------------------------------------ *
 * command palette
 * ------------------------------------------------------------------ */

/** Fills the prompt rather than running it — plenty of these deserve a look first. */
function useCommand(cmd: string): void {
  const session = sessions.get(activeId ?? '')
  closeModal()
  if (session && session.status === 'ready') {
    applySuggest(session, { cmd }, false)
    session.term.focus()
    return
  }
  void navigator.clipboard.writeText(cmd)
  $('#status-text').textContent = '没有已连接的会话，命令已复制到剪贴板'
}

function commandPalette(): void {
  const search = input('')
  search.placeholder = '搜索命令、说明或分组；空格分隔多个词'
  const list = el('div', 'palette')
  let shown: CommandEntry[] = []

  const draw = (): void => {
    shown = searchCommands(search.value)
    list.replaceChildren()
    if (!shown.length) {
      list.append(el('div', 'key-empty', '没有匹配的命令'))
      return
    }
    let group = ''
    for (const entry of shown) {
      if (entry.group !== group) {
        group = entry.group
        list.append(el('div', 'keys-title', group))
      }
      const row = el('div', 'pal-item')
      row.append(el('code', '', entry.cmd), el('span', 'pal-hint', entry.hint))
      // Long commands get ellipsized in the row; hover is where the whole thing
      // and its explanation are readable.
      row.title = `${entry.cmd}\n${entry.hint}\n\n点击填入命令行，不执行`
      row.addEventListener('click', () => useCommand(entry.cmd))
      list.append(row)
    }
  }
  draw()
  search.addEventListener('input', draw)
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && search.value.trim() && shown[0]) useCommand(shown[0].cmd)
  })

  const body = el('div', 'palette-body')
  body.append(search, list)

  showModal('命令面板', body, [
    { label: '编辑快捷条', onClick: quickDialog },
    { label: '关闭', primary: true, onClick: closeModal }
  ])
  setTimeout(() => search.focus(), 0)
}

/* ------------------------------------------------------------------ *
 * sessions
 * ------------------------------------------------------------------ */

/**
 * Everything imported from FinalShell lands here: its passwords are not recoverable,
 * so a password-auth connection with no stored secret would otherwise connect with an
 * empty password and fail with ssh2's opaque "All configured authentication methods
 * failed". Ask before opening the tab instead. Returns a connection to use, or null
 * if the user backed out.
 */
async function withSecret(
  conn: Connection
): Promise<{ conn: Connection; secret?: string; remember?: boolean } | null> {
  log('info', `[${conn.name}] 连接 ${conn.username}@${conn.host}:${conn.port}（${conn.authType}）`)

  if (conn.authType === 'agent') return { conn }

  if (conn.authType === 'key') {
    if (conn.privateKeyPath) return { conn }
    log('error', `[${conn.name}] 没有指定私钥文件`)
    showModal(
      '无法连接',
      el('div', '', `${conn.name} 是密钥认证，但没有指定私钥文件。请先右键 → 编辑，选一个私钥。`),
      [{ label: '好', primary: true, onClick: closeModal }]
    )
    return null
  }

  if (conn.hasSecret) return { conn }

  // Already typed once in this run and declined to save it — reuse that.
  const cached = sessionSecrets.get(conn.id)
  if (cached) return { conn, secret: cached }

  return new Promise((resolve) => {
    const secret = input('', 'password')
    const remember = el('input')
    remember.type = 'checkbox'
    remember.checked = true
    const rememberRow = el('label', 'check-row')
    rememberRow.append(remember, document.createTextNode('保存到系统钥匙串'))

    const body = el('div')
    body.append(field(`${conn.username}@${conn.host} 的密码`, secret), rememberRow)

    let settled = false
    const done = (value: { conn: Connection; secret?: string; remember?: boolean } | null): void => {
      if (settled) return
      settled = true
      closeModal()
      resolve(value)
    }
    const submit = (): void => {
      if (!secret.value) return
      // Not saved here: a typo would otherwise be written to the keychain before
      // we know whether it works. openSession saves it once the session comes up.
      done({ conn, secret: secret.value, remember: remember.checked })
    }

    showModal(`${conn.name} — 需要密码`, body, [
      { label: '取消', onClick: () => done(null) },
      { label: '连接', primary: true, onClick: submit }
    ])
    secret.focus()
    secret.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit()
    })
  })
}

/** Passwords typed at the connect prompt, held until the session proves them out. */
const pendingSecrets = new Map<string, { conn: Connection; secret: string; remember: boolean }>()

/** In-memory cache so a re-connect in this run doesn't re-ask for an unsaved password. */
const sessionSecrets = new Map<string, string>()

/** Connections the user already said "don't ask again" about, for this run. */
const declinedSave = new Set<string>()

async function persistSecret(conn: Connection, secret: string): Promise<void> {
  // `hasSecret` is a renderer-side hint; don't let it reach the store.
  const { hasSecret: _drop, ...plain } = conn
  await api.saveConnection(plain, secret)
  const i = store.connections.findIndex((c) => c.id === conn.id)
  if (i >= 0) store.connections[i] = { ...store.connections[i], hasSecret: true }
}

/**
 * Called once the session is actually up: either save the password the user typed,
 * or — if they only want it for this run — offer to remember it so they stop
 * retyping it. Either way a typo never reaches the keychain.
 */
function settleSecret(sessionId: string, sessionName: string): void {
  const pending = pendingSecrets.get(sessionId)
  if (!pending) return
  pendingSecrets.delete(sessionId)

  if (pending.remember) {
    void persistSecret(pending.conn, pending.secret)
      .then(() => log('info', `[${pending.conn.name}] 密码已验证并保存`))
      .catch((err: Error) => log('warn', `[${pending.conn.name}] 密码保存失败：${err.message}`))
    return
  }

  if (declinedSave.has(pending.conn.id)) return

  const body = el('div')
  body.append(
    el(
      'div',
      '',
      `${sessionName} 的密码这次连接有效。保存到系统钥匙串的话，下次就不用再输一遍。`
    )
  )
  showModal('保存密码？', body, [
    {
      label: '不用了',
      onClick: () => {
        declinedSave.add(pending.conn.id)
        closeModal()
      }
    },
    {
      label: '保存',
      primary: true,
      onClick: () => {
        void persistSecret(pending.conn, pending.secret)
          .then(() => log('info', `[${pending.conn.name}] 密码已保存`))
          .catch((err: Error) => log('warn', `[${pending.conn.name}] 密码保存失败：${err.message}`))
        closeModal()
      }
    }
  ])
}

/**
 * @param externalId a session main already opened on its own — the CLI's. No secret
 *   prompt and no connect call then: this only puts a tab and a terminal around a
 *   session that is already up, so the user can watch or take it over.
 */
async function openSession(rawConn: Connection, externalId?: string): Promise<void> {
  const picked = externalId ? { conn: rawConn, secret: '' } : await withSecret(rawConn)
  if (!picked) return
  const conn = picked.conn

  const sessionId = externalId ?? uid()
  const pane = el('div', 'pane')
  pane.dataset.session = sessionId
  const termRow = el('div', 'term-row')
  const termBox = el('div', 'term-box')
  const notice = el('div', 'notice')
  notice.hidden = true

  const files = el('div', 'files')
  const quickbar = el('div', 'quickbar')

  // Built up-front but hidden, so both panels keep their state across toggles.
  const monitor = buildMonitor()
  monitor.root.style.display = 'none'
  // Always built, always in the toolbar. A panel that opens onto a dead box is
  // the mistake iTerm2 shipped, but a feature hidden behind a key nobody knows
  // to set is worse: nobody ever finds it. What it opens onto is a next step
  // when there is no key (see syncAgentEntry).
  const agent = buildAgent()
  agent.root.style.display = 'none'
  const transferList = el('div', 'transfers')
  transferList.style.display = 'none'
  files.append(transferList)
  files.dataset.drop = ''

  const searchBar = el('div', 'files-head')
  searchBar.hidden = true

  const toolbar = el('div', 'toolbar')
  const tbtn = (label: string, act: string, title: string, run: () => void): HTMLElement => {
    const b = el('button', 'tbtn', label)
    b.dataset.act = act
    b.title = title
    b.addEventListener('click', run)
    return b
  }

  const term = new Terminal({
    fontFamily: store.settings.fontFamily,
    fontSize: store.settings.fontSize,
    cursorStyle: store.settings.cursorStyle,
    cursorBlink: store.settings.cursorBlink,
    scrollback: store.settings.scrollback,
    allowProposedApi: true,
    theme: (THEMES[store.settings.theme] ?? THEMES.liteshell).term
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())

  const suggest = buildSuggest()

  termRow.append(termBox, files, monitor.root)
  if (agent) termRow.append(agent.root)
  // The suggestion list is the last row of the pane on purpose: it opens *under*
  // the prompt line like an IME candidate bar, and because it takes part in the
  // flex layout it shrinks the terminal instead of covering what you were reading.
  pane.append(toolbar, notice, searchBar, termRow, quickbar, suggest)
  $('#panes').appendChild(pane)
  term.open(termBox)

  const session: Session = {
    id: sessionId,
    connectionId: conn.id,
    name: conn.name,
    status: 'connecting',
    term,
    fit,
    search,
    pane,
    tab: el('div'),
    notice,
    toolbar,
    files,
    filePath: '/',
    selected: null,
    searchBar,
    monitor,
    agent,
    transfers: new Map(),
    transferList,
    history: [...(store.history[conn.id] ?? [])],
    line: '',
    suggest,
    suggestItems: [],
    suggestIndex: -1
  }

  // Registered before the socket exists so no early output is dropped.
  sessions.set(sessionId, session)
  // Claim it for this window. Main routes a session's events to exactly one
  // window, so this is what makes the tab move rather than mirror.
  void api.attachSession(sessionId).then((info) => {
    if (info) setStatus(session, info.status)
  })
  term.onData((data) => send(session, data))
  term.onResize(({ cols, rows }) => void api.resize(sessionId, cols, rows))
  // Returning false only tells xterm to stand down — the browser's own default
  // still fires. Without the preventDefault, Tab moves focus out of the terminal
  // (and Enter types a newline into the hidden textarea) exactly when the
  // suggestion list is up and consuming those keys.
  term.attachCustomKeyEventHandler((ev) => {
    const handled = handleTermKey(session, ev)
    if (!handled && ev.type === 'keydown') ev.preventDefault()
    return handled
  })
  term.onSelectionChange(() => {
    if (store.settings.copyOnSelect && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
    }
  })
  new ResizeObserver(() => {
    if (activeId === sessionId) fit.fit()
  }).observe(termBox)

  const agentBtn = tbtn('AI', 'agent', '用自然语言操作这台机器；只读的自己跑，改动服务器前都会问你', () =>
    toggleAgent(session)
  )

  toolbar.append(
    tbtn('文件', 'files', 'SFTP 文件面板 (Ctrl+Shift+B)，文件可直接拖入上传', () => void toggleFiles(session)),
    tbtn('监控', 'monitor', '服务器资源监控 (Ctrl+Shift+M)', () => toggleMonitor(session)),
    agentBtn,
    tbtn('历史', 'history', '历史命令 (Ctrl+Shift+H)，输入时也有候选', () => historyDialog(session)),
    tbtn('查找', 'find', '终端内查找 (Ctrl+Shift+F)', () => focusSearch(session)),
    tbtn('清屏', 'clear', '清空屏幕 (Ctrl+Shift+K)', () => term.clear()),
    tbtn('断开', 'close', '断开会话', () => void closeSession(sessionId))
  )

  buildTab(session, pane)
  buildFilePanel(session)
  buildSearchBar(session)
  buildQuickBarWire(session)
  wireAgent(session)
  syncAgentEntry(session)
  activate(sessionId)
  fit.fit()

  renderTree()
  // A password typed at the prompt is only worth keeping once it actually works,
  // and only for this run until the user says otherwise — see settleSecret().
  if (picked.secret) {
    sessionSecrets.set(conn.id, picked.secret)
    pendingSecrets.set(sessionId, { conn, secret: picked.secret, remember: !!picked.remember })
  }

  if (!externalId) await api.connect(conn.id, sessionId, term.cols, term.rows, picked.secret)
}

function buildQuickBarWire(session: Session): void {
  const bar = session.pane.querySelector('.quickbar') as HTMLElement
  bar.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    showMenu(ev.clientX, ev.clientY, [{ label: '编辑快捷命令', run: quickDialog }])
  })
  renderQuickBar(session)
}

function buildTab(session: Session, pane: HTMLElement): void {
  pane.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.files-list')) return
    ev.preventDefault()
    // Whatever the user dragged over — a log line, a monitor figure — is one
    // click away from the clipboard instead of a Ctrl+C that the terminal eats.
    const picked = window.getSelection()?.toString().trim() ?? ''
    showMenu(ev.clientX, ev.clientY, [
      ...(picked
        ? [
            { label: '复制选中内容', run: () => void navigator.clipboard.writeText(picked) },
            { sep: true }
          ]
        : []),
      { label: '打开/关闭文件面板', run: () => void toggleFiles(session) },
      { label: '查找 (Ctrl+Shift+F)', run: () => focusSearch(session) },
      { sep: true },
      { label: '清屏', run: () => session.term.clear() },
      { label: '断开', danger: true, run: () => void closeSession(session.id) }
    ])
  })

  const tab = el('div', 'tab')
  tab.appendChild(el('span', 'tdot'))
  tab.appendChild(el('span', 'label', session.name))
  const close = el('button', 'close', '×')
  close.addEventListener('click', (ev) => {
    ev.stopPropagation()
    void closeSession(session.id)
  })
  tab.appendChild(close)
  tab.addEventListener('click', () => activate(session.id))
  tab.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    tabMenu(ev, session)
  })
  session.tab = tab
  setStatus(session, session.status)
  $('#tabs').appendChild(tab)
}

/** The tab's dot: grey while connecting, green when up, red once it is not. */
function setStatus(session: Session, status: SessionStatus): void {
  session.status = status
  session.tab.classList.toggle('live', status === 'ready')
  session.tab.classList.toggle('failed', status === 'closed' || status === 'error')
}

function tabMenu(ev: MouseEvent, session: Session): void {
  const conn = store.connections.find((c) => c.id === session.connectionId)
  const ids = [...sessions.keys()]
  showMenu(ev.clientX, ev.clientY, [
    { label: '复制标签', run: () => conn && void openSession(conn) },
    { label: '连接', run: () => conn && void reconnectTab(session, conn) },
    { label: '连接全部', run: () => void reconnectAllTabs() },
    { label: '断开', run: () => void api.disconnect(session.id) },
    { sep: true },
    ...(session.status === 'ready'
      ? [{ label: '在新窗口中打开', run: () => void popOutSession(session) }]
      : []),
    { sep: true },
    { label: '关闭', run: () => void closeSession(session.id) },
    { label: '关闭其他', run: () => void closeMany(ids.filter((id) => id !== session.id)) },
    { label: '关闭全部', run: () => void closeMany(ids) }
  ])
}

/** "连接" on a tab whose session dropped: a fresh session, same connection. */
async function reconnectTab(session: Session, conn: Connection): Promise<void> {
  if (session.status === 'ready' || session.status === 'connecting') return
  await closeSession(session.id)
  await openSession(conn)
}

async function reconnectAllTabs(): Promise<void> {
  for (const session of [...sessions.values()]) {
    const conn = store.connections.find((c) => c.id === session.connectionId)
    if (conn) await reconnectTab(session, conn)
  }
}

async function closeMany(ids: string[]): Promise<void> {
  for (const id of ids) await closeSession(id)
}

function buildSearchBar(session: Session): void {
  const bar = session.searchBar
  const find = input()
  find.className = 'find-input'
  find.placeholder = '查找'
  find.addEventListener('input', () => session.search.findNext(find.value))
  find.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.shiftKey ? session.search.findPrevious(find.value) : session.search.findNext(find.value)
    }
    if (ev.key === 'Escape') bar.hidden = true
  })
  const close = el('button', 'btn', '×')
  close.addEventListener('click', () => (bar.hidden = true))
  bar.append(find, close)
}

function focusSearch(session: Session): void {
  session.searchBar.hidden = false
  ;(session.searchBar.querySelector('input') as HTMLInputElement).focus()
}

function handleTermKey(session: Session, ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown') return true

  // While the suggestion list is up it owns Tab and ↓ — that is the whole point
  // of showing it. ↑ is only ours once something is highlighted; Esc always
  // puts the keys back in the shell's hands.
  if (session.suggestItems.length) {
    if (ev.code === 'ArrowDown') {
      moveSuggest(session, 1)
      return false
    }
    if (ev.code === 'ArrowUp') {
      // ↓ walks in from the top, so ↑ walks back out — and once nothing is
      // highlighted the key belongs to the shell again (that's its history,
      // and it's what fingers expect when the panel is just sitting there).
      if (session.suggestIndex < 0) return true
      moveSuggest(session, -1)
      return false
    }
    if (ev.code === 'Tab' || (ev.code === 'Enter' && session.suggestIndex >= 0)) {
      applySuggest(session, session.suggestItems[Math.max(0, session.suggestIndex)], ev.code === 'Enter')
      return false
    }
    if (ev.key === 'Escape') {
      hideSuggest(session)
      return false
    }
  }

  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
    if (session.term.hasSelection()) void navigator.clipboard.writeText(session.term.getSelection())
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
    void navigator.clipboard.readText().then((text) => text && send(session, text))
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyF') {
    focusSearch(session)
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyW') {
    void closeSession(session.id)
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyH') {
    historyDialog(session)
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyM') {
    toggleMonitor(session)
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyB') {
    void toggleFiles(session)
    return false
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyK') {
    session.term.clear()
    return false
  }
  // Alt+↑/↓ only when the file panel is actually on screen.
  if (ev.altKey && session.files.classList.contains('open')) {
    if (ev.code === 'ArrowUp') {
      void navigate(session, parentOf(session.filePath))
      return false
    }
    if (ev.code === 'ArrowDown' && session.selected?.isDir) {
      void navigate(session, session.selected.path)
      return false
    }
  }
  // Last: the keys xterm would otherwise turn into control characters.
  if (appKey(ev)) return false
  return true
}

function cycleTab(delta: number): void {
  const ids = [...sessions.keys()]
  if (ids.length < 2) return
  const i = ids.indexOf(activeId ?? ids[0])
  activate(ids[(i + delta + ids.length) % ids.length])
}

function activate(sessionId: string): void {
  activeId = sessionId
  for (const session of sessions.values()) {
    const on = session.id === sessionId
    session.pane.classList.toggle('active', on)
    session.tab.classList.toggle('active', on)
  }
  const session = sessions.get(sessionId)
  if (!session) return
  requestAnimationFrame(() => {
    session.fit.fit()
    session.term.focus()
  })
  const conn = store.connections.find((c) => c.id === session.connectionId)
  $('#status-host').textContent = conn ? `${conn.username}@${conn.host}:${conn.port}` : ''
}

/** Takes the tab out of this window. The connection stays up unless the caller
 *  hangs up too — that is what makes `popOutSession` a move, not a reconnect. */
function dropSession(session: Session): void {
  const sessionId = session.id
  stopMonitor(session)
  flushHistory(session)
  sessions.delete(sessionId)
  session.term.dispose()
  session.pane.remove()
  session.tab.remove()
  if (activeId === sessionId) {
    const next = [...sessions.keys()].pop()
    if (next) activate(next)
    else activeId = null
  }
  renderTree()
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  dropSession(session)
  await api.releaseSession(sessionId)
  await api.disconnect(sessionId)
}

async function popOutSession(session: Session): Promise<void> {
  if (!(await api.popOutSession(session.id, session.connectionId))) return
  // Main already stopped routing this session here and is holding its events
  // for the new window; dropping the local tab does not hang up.
  dropSession(session)
  void api.releaseSession(session.id)
}

function handleEvent(ev: SessionEvent): void {
  // The CLI's tab is announced before it exists, so this branch has to come first.
  if (ev.type === 'cli-session') {
    const conn = store.connections.find((c) => c.id === ev.connectionId)
    if (conn) void openSession(conn, ev.sessionId)
    return
  }

  const session = sessions.get(ev.sessionId)
  if (!session) return

  if (ev.type === 'data') {
    session.term.write(ev.data)
    return
  }

  if (ev.type === 'log') {
    log(ev.level, `[${session.name}] ${ev.text}`)
    return
  }

  if (ev.type === 'transfer') {
    renderTransfer(session, ev.transfer)
    if (ev.transfer.state === 'failed') {
      log('error', `[${session.name}] 上传失败 ${ev.transfer.name}：${ev.transfer.error ?? ''}`)
    }
    return
  }

  if (ev.type === 'agent') {
    renderAgent(session, ev.event)
    return
  }

  if (ev.type === 'hostkey') {
    log('info', `[${session.name}] 主机密钥 ${ev.changed ? '已改变' : '已记录'} ${ev.fingerprint}`)
    if (ev.changed) {
      session.notice.hidden = false
      session.notice.classList.add('error')
      session.notice.textContent = `⚠ 主机密钥已改变！可能存在中间人攻击。新指纹 ${ev.fingerprint}`
    } else {
      session.notice.hidden = false
      session.notice.classList.remove('error')
      session.notice.dataset.hostkey = ev.fingerprint
      session.notice.textContent = `首次连接，已记录主机密钥 ${ev.fingerprint}`
    }
    return
  }

  // ssh2 reports a failed connection as error *then* close; remember which we came
  // from so the tidy-up close doesn't wipe the reason off the screen.
  const prevStatus = session.status
  setStatus(session, ev.status)
  if (ev.status === 'ready') {
    log('info', `[${session.name}] 已连接`)
    settleSecret(ev.sessionId, session.name)
    // Keep a first-connection host key notice up so the fingerprint is actually readable.
    if (!session.notice.dataset.hostkey) session.notice.hidden = true
    $('#status-text').textContent = `${session.name} 已连接`
  } else if (ev.status === 'error') {
    log('error', `[${session.name}] 连接失败：${ev.error ?? '未知错误'}`)
    session.notice.hidden = false
    session.notice.classList.add('error')
    session.notice.textContent = `连接失败：${ev.error ?? '未知错误'}`
    $('#status-text').textContent = `${session.name} 连接失败`
  } else if (ev.status === 'closed') {
    if (prevStatus === 'error') return
    log('info', `[${session.name}] 会话已断开`)
    session.notice.hidden = false
    session.notice.classList.remove('error')
    session.notice.textContent = '会话已断开'
  }
  renderTree()
}

/* ------------------------------------------------------------------ *
 * command history
 * ------------------------------------------------------------------ */

const HISTORY_LIMIT = 500
/**
 * Five is what fits in the strip the popup occupies without the terminal having
 * to give up more than a few lines — see the .suggest rules in style.css, which
 * reserve exactly this many rows.
 */
const SUGGEST_LIMIT = 5

/** Everything the user types goes through here, so the history recorder sees it too. */
function send(session: Session, data: string): void {
  trackInput(session, data)
  void api.write(session.id, data)
}

/**
 * Rebuilds the current input line from the byte stream. xterm hands us raw keys —
 * the remote shell is the one doing the line editing — so this is a small readline
 * in reverse. Anything that moves the cursor (arrows, Tab completion, escape
 * sequences) desyncs it, and the honest answer there is to drop the line: a lost
 * history entry beats a recorded `ls\x1b[C`.
 */
function trackInput(session: Session, data: string): void {
  // A full-screen app owns the keyboard; Enter there is not a command.
  if (session.term.buffer.active.type !== 'normal') {
    session.line = ''
    renderSuggest(session)
    return
  }
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      rememberCommand(session, session.line)
      session.line = ''
    } else if (ch === '\x1b' || ch === '\t') {
      session.line = ''
      break
    } else if (ch === '\x7f' || ch === '\b') {
      session.line = session.line.slice(0, -1)
    } else if (ch === '\x15' || ch === '\x03') {
      session.line = '' // Ctrl-U / Ctrl-C
    } else if (ch === '\x17') {
      session.line = session.line.replace(/\S*\s*$/, '') // Ctrl-W
    } else if (ch >= ' ') {
      session.line += ch
    }
  }
  renderSuggest(session)
}

function rememberCommand(session: Session, raw: string): void {
  const cmd = raw.trim()
  // Leading whitespace is the shell convention for "don't record this".
  if (!cmd || raw.startsWith(' ')) return
  const last = session.history[session.history.length - 1]
  if (last !== cmd) session.history.push(cmd)
  if (session.history.length > HISTORY_LIMIT) session.history.splice(0, session.history.length - HISTORY_LIMIT)
  scheduleHistorySave(session)
}

function flushHistory(session: Session): void {
  if (!session.historyTimer) return
  clearTimeout(session.historyTimer)
  session.historyTimer = undefined
  void api.saveHistory(session.connectionId, session.history)
}

/** One disk write per burst of typing, not one per command. */
function scheduleHistorySave(session: Session): void {
  if (session.historyTimer) return
  session.historyTimer = window.setTimeout(() => {
    session.historyTimer = undefined
    void api.saveHistory(session.connectionId, session.history)
  }, 1000)
}

function buildSuggest(): HTMLElement {
  const box = el('div', 'suggest')
  box.hidden = true
  return box
}

function renderSuggest(session: Session): void {
  // The reverse-readline is the most fragile thing here, so keep the line it
  // currently believes in on the DOM where a debugger (or the smoke test) can
  // see it without a breakpoint.
  session.pane.dataset.line = session.line
  const items = suggestCommands(session.line, session.history, SUGGEST_LIMIT)

  session.suggestItems = items
  if (session.suggestIndex >= items.length) session.suggestIndex = -1
  session.suggest.hidden = !items.length
  if (!items.length) return

  session.suggest.replaceChildren(
    ...items.map((item, i) => {
      const row = el('div', `suggest-row${i === session.suggestIndex ? ' sel' : ''}`)
      row.title = item.hint ? `${item.cmd}\n${item.hint}` : item.cmd
      row.append(el('span', 'suggest-cmd', item.cmd))
      row.append(el('span', 'suggest-desc', item.hint ?? ''))
      row.append(el('span', 'suggest-hint', i === session.suggestIndex ? 'Tab 补全 · Enter 执行' : ''))
      return row
    })
  )
}

function hideSuggest(session: Session): void {
  session.suggest.hidden = true
  session.suggestItems = []
  session.suggestIndex = -1
}

/** Ctrl-A then Ctrl-K: whatever is on the line goes, cursor position aside. */
function writeLine(session: Session, cmd: string): void {
  void api.write(session.id, `\x01\x0b${cmd}`)
}

function applySuggest(session: Session, item: Suggestion, submit: boolean): void {
  const cmd = item?.cmd
  if (!cmd) return
  hideSuggest(session)
  writeLine(session, cmd)
  // Handled here rather than through trackInput, so the recorded line is the one
  // we actually sent rather than the prefix that was typed.
  session.line = submit ? '' : cmd
  if (submit) {
    void api.write(session.id, '\r')
    rememberCommand(session, cmd)
  }
}

/** ↓ enters at the top and walks down; ↑ walks back out to the typed line. */
function moveSuggest(session: Session, delta: number): void {
  const max = session.suggestItems.length - 1
  const next = Math.max(-1, Math.min(max, session.suggestIndex + delta))
  // Entering the list is the moment the typed line stops existing, so that is
  // where its last value is worth keeping — walking back out restores it.
  if (next >= 0 && session.suggestIndex < 0) session.suggestTyped = session.line
  session.suggestIndex = next
  const cmd = next >= 0 ? session.suggestItems[next].cmd : (session.suggestTyped ?? session.line)
  renderSuggest(session)
  writeLine(session, cmd)
}

function historyDialog(session: Session): void {
  const body = el('div', 'hist-body')
  const filter = input()
  filter.className = 'hist-filter'
  filter.placeholder = '过滤'
  const list = el('div', 'hist-list scroll')

  const draw = (): void => {
    const q = filter.value.trim()
    const items = session.history.filter((h) => !q || h.includes(q)).reverse()
    if (!items.length) {
      list.replaceChildren(el('div', 'empty-hint', session.history.length ? '没有匹配的命令' : '本连接还没有历史命令'))
      return
    }
    list.replaceChildren(
      ...items.map((cmd) => {
        const row = el('div', 'hist-row', cmd)
        row.title = '点击填到终端'
        row.addEventListener('click', () => {
          applySuggest(session, { cmd }, false)
          session.term.focus()
          closeModal()
        })
        return row
      })
    )
  }

  filter.addEventListener('input', draw)
  body.append(filter, list)
  draw()
  showModal(`${session.name} — 历史命令（${session.history.length} 条）`, body, [
    {
      label: '清空',
      danger: true,
      onClick: () => {
        session.history = []
        void api.saveHistory(session.connectionId, [])
        closeModal()
      }
    },
    { label: '关闭', primary: true, onClick: closeModal }
  ])
  filter.focus()
}

/* ------------------------------------------------------------------ *
 * file panel
 * ------------------------------------------------------------------ */

function buildFilePanel(session: Session): void {
  const head = el('div', 'files-head')
  const btn = (label: string, title: string, run: () => void): HTMLElement => {
    const b = el('button', 'icon-btn txt', label)
    b.title = title
    b.addEventListener('click', run)
    return b
  }
  const more = btn('⋯', '更多操作', () => {
    const r = head.getBoundingClientRect()
    showMenu(r.right - 150, r.bottom + 2, [
      { label: '复制当前路径', run: () => copyPath(session.filePath) },
      { label: '新建目录', run: () => void mkdirHere(session) },
      { label: '刷新', run: () => void navigate(session, session.filePath) },
      { sep: true },
      { label: '关闭文件面板', run: () => session.files.classList.remove('open') }
    ])
  })
  head.append(
    btn('⬅', '上一级 (Alt+↑)', () => void navigate(session, parentOf(session.filePath))),
    btn('⟳', '刷新', () => void navigate(session, session.filePath)),
    btn('🗀 新建', '新建目录', () => void mkdirHere(session)),
    btn('⬆ 上传', '上传文件到当前目录（也可以直接把文件拖进来）', () => void uploadHere(session)),
    more
  )

  const pathbar = el('div', 'pathbar')
  const crumbs = el('div', 'crumbs')
  crumbs.title = '点击路径片段跳转；双击空白处可直接输入路径'
  const editPath = (): void => startPathEdit(session, pathbar, crumbs)
  crumbs.addEventListener('dblclick', editPath)
  const pencil = el('button', 'icon-btn', '✎')
  pencil.title = '输入路径跳转'
  pencil.addEventListener('click', editPath)
  const copy = el('button', 'icon-btn', '⧉')
  copy.title = '复制当前路径'
  copy.addEventListener('click', () => copyPath(session.filePath))
  pathbar.append(crumbs, pencil, copy)

  const list = el('div', 'files-list scroll')
  // Right-click on empty space: actions about the directory itself.
  list.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.row')) return
    ev.preventDefault()
    showMenu(ev.clientX, ev.clientY, [
      { label: '上传到此处', run: () => void uploadHere(session) },
      { label: '新建文件夹', run: () => void mkdirHere(session) },
      { label: '新建文件', run: () => newFileHere(session) },
      { sep: true },
      { label: '复制当前路径', run: () => copyPath(session.filePath) },
      { label: '刷新', run: () => void navigate(session, session.filePath) }
    ])
  })
  // Drop target: the whole list, so a file can be dropped anywhere over it.
  // dragenter/leave fire for every child element crossed, hence the depth counter.
  let dragDepth = 0
  let stash: ChildNode[] = []

  const endDrag = (): void => {
    dragDepth = 0
    list.classList.remove('drop')
    list.replaceChildren(...stash)
    stash = []
  }

  list.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return
    ev.preventDefault()
    if (dragDepth === 0) {
      stash = [...list.childNodes]
      list.replaceChildren(el('div', 'drop-hint', `松开即上传到 ${session.filePath}`))
    }
    dragDepth++
    list.classList.add('drop')
  })
  list.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'copy'
  })
  list.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) endDrag()
  })
  list.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.files.length) return
    ev.preventDefault()
    const files = ev.dataTransfer.files
    endDrag()
    void uploadDropped(session, files, session.filePath)
  })

  // The header belongs with the rows, not at the bottom of the panel.
  session.transferList.append(buildTransferHeader(session))
  session.files.append(head, pathbar, list)
}

function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return '/' + parts.join('/')
}

async function toggleFiles(session: Session): Promise<void> {
  const open = session.files.classList.toggle('open')
  session.pane.querySelector('[data-act="files"]')?.classList.toggle('on', open)
  if (!open) return
  if (session.filePath === '/') session.filePath = await api.sftpHome(session.id)
  await navigate(session, session.filePath)
}

async function navigate(session: Session, path: string): Promise<void> {
  session.filePath = path
  session.selected = null
  const list = session.files.querySelector('.files-list') as HTMLElement
  try {
    const entries = await api.sftpList(session.id, path)
    list.replaceChildren()
    for (const entry of entries) {
      // Same idea as `ls --color`: the kind is readable at a glance, so you stop
      // opening things to find out what they are.
      const row = el('div', `row${entry.isDir ? ' dir' : ''} ${fileKind(entry.name)}`)
      row.title = `${entry.path}\n${entry.isDir ? '双击进入' : '双击打开'}`
      row.appendChild(el('span', 'nm', `${entry.isDir ? '🗀' : '·'} ${entry.name}`))
      row.appendChild(el('span', 'sz', entry.isDir ? '' : human(entry.size)))
      const pick = (): void => {
        list.querySelector('.sel')?.classList.remove('sel')
        row.classList.add('sel')
        session.selected = entry
      }
      row.addEventListener('click', pick)
      row.addEventListener('dblclick', () => void openEntry(session, entry))
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        pick()
        // For a directory, "here" means inside it; for a file, the folder we
        // are looking at.
        const here = entry.isDir ? entry.path : session.filePath
        showMenu(ev.clientX, ev.clientY, [
          { label: entry.isDir ? '打开' : '编辑', run: () => void openEntry(session, entry) },
          { label: '上传到此处', run: () => void uploadTo(session, here) },
          { label: '下载', run: () => void downloadEntry(session, entry) },
          ...(entry.isDir
            ? [{ label: '打包下载…', run: () => void downloadArchive(session, entry) }]
            : [{ label: '用本机程序打开', run: () => void openWithSystem(session, entry) }]),
          { sep: true },
          { label: '新建文件夹', run: () => void mkdirHere(session) },
          { label: '新建文件', run: () => newFileHere(session) },
          { label: '文件权限…', run: () => chmodEntry(session, entry) },
          { label: '重命名', run: () => renameEntry(session, entry) },
          { label: '复制路径', run: () => copyPath(entry.path) },
          { sep: true },
          { label: '删除', danger: true, run: () => void deleteEntry(session, entry, false) },
          ...(entry.isDir
            ? [
                {
                  label: '递归删除',
                  danger: true,
                  run: () => void deleteEntry(session, entry, true)
                }
              ]
            : []),
          { label: '刷新', run: () => void navigate(session, session.filePath) }
        ])
      })
      list.appendChild(row)
    }
    if (!entries.length) list.replaceChildren(el('div', 'empty-hint', '空目录 —— 把文件拖进来即可上传'))
  } catch (err) {
    list.replaceChildren(el('div', 'empty-hint', `读取失败：${(err as Error).message}`))
  }
  // After the listing, so the path bar never describes a directory that failed to load.
  renderCrumbs(session)
}

/** Path split into clickable pieces, so any ancestor is one click away. */
function renderCrumbs(session: Session): void {
  const crumbs = session.files.querySelector('.crumbs') as HTMLElement
  const parts = session.filePath.split('/').filter(Boolean)
  const nodes: HTMLElement[] = []
  const jump = (to: string): HTMLElement => {
    const seg = el('span', 'crumb')
    seg.dataset.path = to
    seg.title = `进入 ${to}`
    seg.addEventListener('click', () => void navigate(session, to))
    return seg
  }

  const root = jump('/')
  root.append(el('span', 'crumb-icon', '🗀'), el('span', 'crumb-text', '/'))
  nodes.push(root)
  let so = ''
  parts.forEach((part, i) => {
    so += `/${part}`
    const seg = jump(so)
    seg.append(el('span', 'crumb-text', part))
    if (i === parts.length - 1) seg.classList.add('cur')
    nodes.push(seg)
  })

  crumbs.replaceChildren(
    ...nodes.flatMap((node, i) => (i ? [el('span', 'crumb-sep', '›'), node] : [node]))
  )
  crumbs.scrollLeft = crumbs.scrollWidth
}

/** Type or paste a path instead of clicking down to it. */
function startPathEdit(session: Session, pathbar: HTMLElement, crumbs: HTMLElement): void {
  if (pathbar.querySelector('.path-input')) return
  const edit = input(session.filePath)
  edit.className = 'path-input'
  edit.spellcheck = false
  const field = el('div', 'path-edit')
  field.append(edit)
  crumbs.replaceWith(field)
  edit.focus()
  edit.select()

  let closed = false
  const done = (go: boolean): void => {
    if (closed) return
    closed = true
    field.replaceWith(crumbs)
    const path = edit.value.trim()
    if (!go) return
    void navigate(session, path && path !== session.filePath ? path : session.filePath)
  }
  edit.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') done(true)
    if (ev.key === 'Escape') done(false)
  })
  edit.addEventListener('blur', () => done(false))
}

function copyText(text: string, what: string): void {
  void navigator.clipboard.writeText(text)
  $('#status-text').textContent = `已复制${what} ${text}`
}

function copyPath(path: string): void {
  copyText(path, '路径')
}

async function openEntry(session: Session, entry: SftpEntry): Promise<void> {
  if (entry.isDir) {
    await navigate(session, entry.path)
    return
  }
  await openEntryInEditor(session, entry)
}

/** Explicit "hand it to whatever this machine uses" — images, archives, PDFs. */
async function openWithSystem(session: Session, entry: SftpEntry): Promise<void> {
  $('#status-text').textContent = `正在取回 ${entry.name}…`
  try {
    $('#status-text').textContent = await api.sftpOpen(session.id, entry.path)
  } catch (err) {
    $('#status-text').textContent = `打开失败：${(err as Error).message}`
  }
}

async function uploadHere(session: Session): Promise<void> {
  await uploadTo(session, session.filePath)
}

async function uploadTo(session: Session, remoteDir: string): Promise<void> {
  await api.sftpUpload(session.id, remoteDir)
  await navigate(session, session.filePath)
}

/** One path segment, never a path: typing `a/b` would silently make folders. */
function segment(value: string): string | null {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    log('warn', '名称不能为空，也不能包含 /')
    return null
  }
  return name
}

async function mkdirHere(session: Session): Promise<void> {
  promptDialog('新建文件夹', '文件夹名称', '', async (value) => {
    const name = segment(value)
    if (!name) return
    await api.sftpMkdir(session.id, `${session.filePath.replace(/\/$/, '')}/${name}`)
    await navigate(session, session.filePath)
  })
}

async function newFileHere(session: Session): Promise<void> {
  promptDialog('新建文件', '文件名称', '', async (value) => {
    const name = segment(value)
    if (!name) return
    await api.sftpTouch(session.id, `${session.filePath.replace(/\/$/, '')}/${name}`)
    await navigate(session, session.filePath)
  })
}

function chmodEntry(session: Session, entry: SftpEntry): void {
  const current = (entry.mode & 0o7777).toString(8).padStart(3, '0')
  promptDialog(`权限 — ${entry.name}`, '八进制权限（如 644、755、4755）', current, async (value) => {
    const text = value.trim()
    if (!/^[0-7]{3,4}$/.test(text)) {
      log('warn', `权限要写成 644 这样的八进制，收到的是「${text}」`)
      return
    }
    await api.sftpChmod(session.id, entry.path, parseInt(text, 8))
    await navigate(session, session.filePath)
  })
}

async function downloadEntry(session: Session, entry: SftpEntry): Promise<void> {
  const saved = await api.sftpDownload(session.id, entry.path, entry.isDir)
  if (saved) $('#status-text').textContent = `已下载到 ${saved}`
}

async function downloadArchive(session: Session, entry: SftpEntry): Promise<void> {
  $('#status-text').textContent = `正在服务器上打包 ${entry.name}…`
  try {
    const saved = await api.sftpDownloadArchive(session.id, entry.path)
    if (saved) $('#status-text').textContent = `已打包下载到 ${saved}`
  } catch (err) {
    $('#status-text').textContent = `打包下载失败：${(err as Error).message}`
    log('error', `[${session.name}] 打包下载 ${entry.path} 失败：${(err as Error).message}`)
  }
}

async function renameEntry(session: Session, entry: SftpEntry): Promise<void> {
  promptDialog('重命名', '新名称', entry.name, async (value) => {
    const name = segment(value)
    if (!name || name === entry.name) return
    await api.sftpRename(session.id, entry.path, `${session.filePath.replace(/\/$/, '')}/${name}`)
    await navigate(session, session.filePath)
  })
}

async function deleteEntry(
  session: Session,
  entry: SftpEntry,
  recursive: boolean
): Promise<void> {
  const note = entry.isDir && !recursive ? '\n（目录非空时会被拒绝；清空目录请用「递归删除」）' : ''
  if (!window.confirm(`删除 ${entry.name}？${note}`)) return
  try {
    await api.sftpRemove(session.id, entry.path, entry.isDir, recursive)
    await navigate(session, session.filePath)
  } catch (err) {
    log('error', `[${session.name}] 删除 ${entry.path} 失败：${(err as Error).message}`)
  }
}

/* ------------------------------------------------------------------ *
 * remote file editor
 * ------------------------------------------------------------------ */

/**
 * One floating editor at a time. Saving writes straight back over SFTP, so the
 * file on the server is the source of truth — no local copy to drift.
 */
interface Editor {
  session: Session
  path: string
  name: string
  /** What the file looked like when we read it (or last saved it). */
  saved: string
  mtime: number
  root: HTMLElement
  area: HTMLTextAreaElement
  state: HTMLElement
  saveBtn: HTMLButtonElement
}

let editor: Editor | null = null

async function openEntryInEditor(session: Session, entry: SftpEntry): Promise<void> {
  if (editor && !editorClose()) return
  $('#status-text').textContent = `正在读取 ${entry.name}…`
  let file: RemoteText
  try {
    file = await api.sftpReadText(session.id, entry.path)
  } catch (err) {
    $('#status-text').textContent = `读取失败：${(err as Error).message}`
    log('error', `[${session.name}] 读取 ${entry.path} 失败：${(err as Error).message}`)
    return
  }

  if (file.kind === 'binary') {
    log('warn', `[${session.name}] ${entry.path} 不能编辑：${file.reason}`)
    if (!window.confirm(`${entry.name}\n\n${file.reason}\n\n改用本机程序打开？`)) {
      $('#status-text').textContent = `已跳过 ${entry.name}（${file.reason}）`
      return
    }
    $('#status-text').textContent = await api.sftpOpen(session.id, entry.path)
    return
  }

  buildEditor(session, entry, file)
  $('#status-text').textContent = `已打开 ${entry.path}`
}

function buildEditor(
  session: Session,
  entry: SftpEntry,
  file: Extract<RemoteText, { kind: 'text' }>
): void {
  const scrim = el('div', 'editor-scrim')
  const win = el('div', 'editor-win')
  const head = el('div', 'editor-head')
  const path = el('span', 'editor-path', entry.path)
  path.title = entry.path
  const state = el('span', 'editor-state', '')
  const area = el('textarea', 'editor-area')
  area.value = file.text
  area.spellcheck = false
  area.wrap = 'off'

  const saveBtn = el('button', 'btn primary', '保存')
  const closeBtn = el('button', 'btn', '关闭')
  const hint = el('span', 'editor-meta', 'Ctrl+S 保存 · Esc 关闭')
  head.append(path, state, el('span', 'spacer'), hint, saveBtn, closeBtn)
  win.append(head, area)
  scrim.append(win)
  document.body.append(scrim)

  editor = {
    session,
    path: entry.path,
    name: entry.name,
    saved: file.text,
    mtime: file.mtime,
    root: scrim,
    area,
    state,
    saveBtn
  }
  refreshEditorState()
  area.focus()

  saveBtn.addEventListener('click', () => void saveEditor())
  closeBtn.addEventListener('click', () => editorClose())
  area.addEventListener('input', refreshEditorState)
  area.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') {
      // A tab stop in a textarea is a trap door out of the editor.
      ev.preventDefault()
      const { selectionStart: s, selectionEnd: e, value } = area
      area.value = `${value.slice(0, s)}  ${value.slice(e)}`
      area.selectionStart = area.selectionEnd = s + 2
      refreshEditorState()
      return
    }
    const mod = ev.ctrlKey || ev.metaKey
    if (mod && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void saveEditor()
    }
    if (ev.key === 'Escape') {
      ev.preventDefault()
      editorClose()
    }
  })
}

function editorDirty(): boolean {
  return !!editor && editor.area.value !== editor.saved
}

function refreshEditorState(): void {
  if (!editor) return
  const dirty = editorDirty()
  editor.state.textContent = dirty ? '● 未保存' : '已同步'
  editor.state.classList.toggle('dirty', dirty)
  editor.saveBtn.classList.toggle('primary', dirty)
  editor.root.classList.toggle('dirty', dirty)
}

/** @returns true when the editor is gone, so the caller may open another file. */
function editorClose(): boolean {
  if (!editor) return true
  if (editorDirty() && !window.confirm(`${editor.name} 有未保存的修改，放弃并关闭？`)) return false
  editor.root.remove()
  editor = null
  return true
}

async function saveEditor(): Promise<void> {
  const doc = editor
  if (!doc) return
  const text = doc.area.value
  doc.state.textContent = '保存中…'
  doc.state.classList.remove('dirty')

  try {
    let res = await api.sftpWriteText(doc.session.id, doc.path, text, doc.mtime, false)
    if (!res.ok) {
      const go = window.confirm(`${doc.name} 在服务器上已被改动（可能是别人改的，也可能是日志在写）。\n\n用本地这份覆盖它？`)
      if (!go) {
        refreshEditorState()
        return
      }
      res = await api.sftpWriteText(doc.session.id, doc.path, text, doc.mtime, true)
    }
    if (!res.ok) {
      refreshEditorState()
      return
    }
    doc.mtime = res.mtime
    doc.saved = text
    log('info', `[${doc.session.name}] 已保存 ${doc.path}`)
    refreshEditorState()
    doc.state.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    // The listing shows size and mtime, so put it back in sync.
    void navigate(doc.session, doc.session.filePath)
  } catch (err) {
    const message = (err as Error).message
    doc.state.textContent = `保存失败：${message}`
    doc.state.classList.add('dirty')
    log('error', `[${doc.session.name}] 保存 ${doc.path} 失败：${message}`)
  }
}

/* ------------------------------------------------------------------ *
 * uploads
 * ------------------------------------------------------------------ */

/** Upsert a row for one transfer, and keep the header's aggregate count honest. */
function renderTransfer(session: Session, t: Transfer): void {
  let entry = session.transfers.get(t.id)
  if (!entry) {
    const row = el('div', 'xfer')
    const head = el('div', 'xfer-head')
    head.append(el('span', 'xfer-name', t.name))
    const pct = el('span', 'xfer-pct', '0%')
    head.append(pct)
    const track = el('div', 'pbar')
    const fill = el('div', 'pbar-fill')
    track.append(fill)
    row.append(head, track)
    session.transferList.append(row)
    entry = { row, fill, pct }
    session.transfers.set(t.id, entry)
  }

  const pct = t.size ? Math.min(100, (t.transferred / t.size) * 100) : 0
  entry.fill.style.width = `${pct}%`
  entry.fill.style.background =
    t.state === 'failed' ? 'var(--danger)' : t.state === 'done' ? 'var(--ok)' : 'var(--accent)'
  entry.pct.textContent =
    t.state === 'failed' ? '失败' : t.state === 'done' ? '完成' : `${pct.toFixed(0)}%`
  entry.row.title = t.state === 'failed' ? `${t.local} → ${t.remote}\n${t.error ?? ''}` : `${t.local} → ${t.remote}`

  session.transferList.style.display = 'flex'
  const header = session.transferList.querySelector('.xfer-head-bar')
  if (header) {
    const active = [...session.transfers.keys()].length
    header.querySelector('.xfer-count')!.textContent = `${active} 项`
  }
}

function buildTransferHeader(session: Session): HTMLElement {
  const bar = el('div', 'xfer-head-bar')
  bar.append(el('span', 'mon-title', '上传'), el('span', 'xfer-count', '0 项'))
  const clear = el('button', 'tbtn', '清除已完成')
  clear.addEventListener('click', async () => {
    await api.sftpClearTransfers(session.id)
    session.transfers.clear()
    session.transferList.querySelectorAll('.xfer').forEach((n) => n.remove())
    bar.querySelector('.xfer-count')!.textContent = '0 项'
    session.transferList.style.display = 'none'
  })
  bar.append(clear)
  return bar
}

/** Dropped files reach us as File objects with no path; Electron resolves them. */
async function uploadDropped(session: Session, files: FileList, remoteDir: string): Promise<void> {
  const paths = [...files].map((f) => api.pathForFile(f)).filter(Boolean)
  if (!paths.length) return
  log('info', `[${session.name}] 上传 ${paths.length} 个文件到 ${remoteDir}`)
  try {
    await api.sftpUploadPaths(session.id, paths, remoteDir)
    await navigate(session, session.filePath)
  } catch (err) {
    log('error', `[${session.name}] 上传失败：${(err as Error).message}`)
  }
}

/* ------------------------------------------------------------------ *
 * resource monitor
 * ------------------------------------------------------------------ */

const HISTORY = 60

function humanRate(bytesPerSecond: number): string {
  return `${human(bytesPerSecond)}/s`
}

function humanUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${m} 分`
}

/**
 * A sparkline drawn straight onto a canvas. Charting libs are ~100KB for what is
 * a 3px line and an area fill here.
 */
function drawSpark(canvas: HTMLCanvasElement, values: number[], max: number): void {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 160
  const h = canvas.clientHeight || 34
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const style = getComputedStyle(document.documentElement)
  const accent = style.getPropertyValue('--accent').trim() || '#5b8cff'
  const span = Math.max(1, max)

  // Until the buffer is full the samples stretch over the whole width, so the
  // chart is legible from the first poll instead of crawling in from the left.
  // One sample doubles up: a level line says "this is where it is now", a lone
  // dot in the corner just looks like a chart that failed to draw.
  const series = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0]
  const xAt = (i: number): number => (i / (series.length < HISTORY ? series.length - 1 : HISTORY - 1)) * w
  const yAt = (v: number): number => h - Math.min(1, v / span) * (h - 2) - 1

  ctx.beginPath()
  ctx.moveTo(0, h)
  series.forEach((v, i) => ctx.lineTo(xAt(i), yAt(v)))
  ctx.lineTo(xAt(series.length - 1), h)
  ctx.closePath()
  ctx.globalAlpha = 0.16
  ctx.fillStyle = accent
  ctx.fill()

  ctx.globalAlpha = 1
  ctx.beginPath()
  series.forEach((v, i) => {
    i === 0 ? ctx.moveTo(xAt(i), yAt(v)) : ctx.lineTo(xAt(i), yAt(v))
  })
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  ctx.stroke()
}

interface MonitorView {
  root: HTMLElement
  alerts: HTMLElement
  cpu: { value: HTMLElement; detail: HTMLElement; spark: HTMLCanvasElement; fill: HTMLElement; hist: number[] }
  mem: { value: HTMLElement; detail: HTMLElement; spark: HTMLCanvasElement; fill: HTMLElement; hist: number[] }
  swap: { value: HTMLElement; detail: HTMLElement; fill: HTMLElement }
  net: { down: HTMLElement; up: HTMLElement; spark: HTMLCanvasElement; hist: number[] }
  gpu: HTMLElement
  disk: HTMLElement
  info: HTMLElement
  timer?: number
  busy: boolean
}

/** A level bar whose fill node is kept, so a poll makes it slide instead of jump. */
function meter(): { track: HTMLElement; fill: HTMLElement } {
  const track = el('div', 'pbar')
  const fill = el('div', 'pbar-fill')
  track.append(fill)
  return { track, fill }
}

function setMeter(fill: HTMLElement, pct: number, tone: Tone): void {
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`
  fill.style.background = `var(--${tone})`
}

function buildMonitor(): MonitorView {
  const root = el('div', 'monitor')

  // "Is anything wrong?" is the first question, so its answer goes on top.
  const alerts = el('div', 'mon-alerts')
  root.append(alerts)

  const info = el('div', 'mon-info')
  root.append(info)

  // Two columns keep the four numbers on one screen — a single column needed a
  // scroll just to reach the disks.
  const grid = el('div', 'mon-grid')
  root.append(grid)

  /**
   * A card = label + big number, then a trend line and/or a level bar. The bar
   * reads the level at a glance, the sparkline reads where it has been.
   */
  const gauge = (label: string, kind: 'spark' | 'meter' | 'both'): {
    value: HTMLElement
    detail: HTMLElement
    spark: HTMLCanvasElement
    fill: HTMLElement
  } => {
    const box = el('div', 'gauge')
    const head = el('div', 'gauge-head')
    head.append(el('span', 'gauge-label', label))
    const detail = el('span', 'gauge-detail')
    head.append(detail)
    const value = el('div', 'gauge-value', '—')
    box.append(head, value)
    const spark = el('canvas', 'spark')
    if (kind !== 'meter') box.append(spark)
    const m = meter()
    if (kind !== 'spark') box.append(m.track)
    grid.append(box)
    return { value, detail, spark, fill: m.fill }
  }

  const cpuG = gauge('CPU', 'both')
  const memG = gauge('内存', 'both')
  const swapG = gauge('Swap', 'meter')
  const netG = gauge('网络', 'spark')
  // Rates are longer strings than a percentage, so that one card sets its own size.
  netG.value.classList.add('gauge-rate')

  const gpuBox = el('div', 'mon-section')
  gpuBox.append(el('div', 'mon-title', 'GPU'))
  const gpu = el('div', 'mon-body')
  gpuBox.append(gpu)
  root.append(gpuBox)

  const diskBox = el('div', 'mon-section')
  diskBox.append(el('div', 'mon-title', '磁盘'))
  const disk = el('div', 'mon-body')
  diskBox.append(disk)
  root.append(diskBox)

  return {
    root,
    alerts,
    cpu: { value: cpuG.value, detail: cpuG.detail, spark: cpuG.spark, fill: cpuG.fill, hist: [] },
    mem: { value: memG.value, detail: memG.detail, spark: memG.spark, fill: memG.fill, hist: [] },
    swap: { value: swapG.value, detail: swapG.detail, fill: swapG.fill },
    net: { down: netG.value, up: netG.detail, spark: netG.spark, hist: [] },
    gpu,
    disk,
    info,
    busy: false
  }
}

function renderMonitor(view: MonitorView, m: MonitorSnapshot): void {
  const push = (hist: number[], v: number): void => {
    hist.push(v)
    if (hist.length > HISTORY) hist.shift()
  }
  const memPct = usePct(m.memUsed, m.memTotal)
  push(view.cpu.hist, m.cpu)
  push(view.mem.hist, memPct)
  push(view.net.hist, m.netDown + m.netUp)

  // Colours come from the same thresholds the alert strip uses, so a yellow
  // number and a yellow chip can never disagree.
  const cpuTone = toneOf(m.cpu, 'cpu')
  const memTone = toneOf(memPct, 'mem')

  view.cpu.value.textContent = `${m.cpu.toFixed(0)}%`
  view.cpu.value.style.color = `var(--${cpuTone})`
  view.cpu.detail.textContent = `${m.cpuCores} 核`
  drawSpark(view.cpu.spark, view.cpu.hist, 100)
  setMeter(view.cpu.fill, m.cpu, cpuTone)

  view.mem.value.textContent = `${memPct.toFixed(0)}%`
  view.mem.value.style.color = `var(--${memTone})`
  view.mem.detail.textContent = `${human(m.memUsed)} / ${human(m.memTotal)}`
  drawSpark(view.mem.spark, view.mem.hist, 100)
  setMeter(view.mem.fill, memPct, memTone)

  if (m.swapTotal) {
    const swapPct = usePct(m.swapUsed, m.swapTotal)
    const swapTone = toneOf(swapPct, 'swap')
    view.swap.value.textContent = `${swapPct.toFixed(0)}%`
    view.swap.value.style.color = `var(--${swapTone})`
    view.swap.detail.textContent = `${human(m.swapUsed)} / ${human(m.swapTotal)}`
    setMeter(view.swap.fill, swapPct, swapTone)
  } else {
    view.swap.value.textContent = '未启用'
    view.swap.value.style.color = 'var(--text-faint)'
    view.swap.detail.textContent = ''
    setMeter(view.swap.fill, 0, 'ok')
  }

  view.net.down.textContent = `↓ ${humanRate(m.netDown)}`
  view.net.up.textContent = `↑ ${humanRate(m.netUp)}`
  drawSpark(view.net.spark, view.net.hist, Math.max(1024, ...view.net.hist))

  const alerts = alertsFor(m)
  view.alerts.dataset.tone = alerts[0]?.tone ?? 'ok'
  view.alerts.replaceChildren(
    ...(alerts.length
      ? alerts.map((a) => el('div', `alert tone-${a.tone}`, a.text))
      : [el('div', 'alert-none', '✓ CPU / 内存 / 磁盘 都在正常范围')])
  )

  view.gpu.replaceChildren()
  if (!m.gpu.length) {
    view.gpu.append(el('div', 'mon-empty', '没有检测到 NVIDIA 显卡（需要 nvidia-smi）'))
  }

  for (const [i, g] of m.gpu.entries()) {
    const card = el('div', 'gpu-card')
    const head = el('div', 'mon-row-head')
    // Both cards usually carry the same model string, so without the number there
    // is no way to tell which row is the busy one — or to line it up with the
    // `0` / `1` rows in nvidia-smi's own table. nvidia-smi enumerates by index.
    head.append(el('span', 'gpu-idx', `#${i}`))
    const name = el('span', 'mon-name', g.name)
    // 侧栏放不下整串型号，截断的地方鼠标划过能看到全名。
    name.title = g.name
    head.append(name)
    head.append(el('span', `badge tone-${toneOf(g.temp, 'gpuTemp')}`, `${g.temp}°C`))
    card.append(head)

    // The bar sits beside the number it describes, and there is only one number.
    const memPct = usePct(g.memUsed, g.memTotal)
    const tone = toneOf(memPct, 'gpuMem')
    const row = el('div', 'gpu-row')
    row.append(el('span', 'gpu-label', '显存'))
    row.append(bar(memPct, tone))
    row.append(el('span', `mon-val tone-${tone}`, `${memPct.toFixed(0)}%  ${human(g.memUsed)} / ${human(g.memTotal)}`))
    card.append(row)
    view.gpu.append(card)
  }

  view.disk.replaceChildren()
  if (!m.disk.length) view.disk.append(el('div', 'mon-empty', '没有可显示的挂载点'))
  for (const d of m.disk) {
    const pct = usePct(d.used, d.size)
    const tone = toneOf(pct, 'disk')
    // One line per mount: with a handful of them the list still fits on screen.
    const row = el('div', 'mon-disk')
    row.title = `${d.mount}\n${d.fs} · ${human(d.used)} / ${human(d.size)}`
    row.append(el('span', 'mon-name', d.mount))
    row.append(bar(pct, tone))
    row.append(el('span', `mon-val tone-${tone}`, `${pct.toFixed(0)}%`))
    row.append(el('span', 'mon-sub', `${human(d.used)} / ${human(d.size)}`))
    view.disk.append(row)
  }

  const n = m.info
  view.info.replaceChildren(
    el('div', 'mon-host', n.hostname || '—'),
    el('div', 'mon-line', `${n.os} · ${n.kernel} · ${n.arch}`),
    el('div', 'mon-line', `${n.cpuModel} · ${m.cpuCores} 核`),
    el('div', 'mon-line', `负载 ${m.load.map((l) => l.toFixed(2)).join('  ')} · 运行 ${humanUptime(m.uptime)}`)
  )
}

function bar(pct: number, tone: Tone): HTMLElement {
  const m = meter()
  setMeter(m.fill, pct, tone)
  return m.track
}

/** Polls over the existing session; stops the moment the panel is hidden. */
function startMonitor(session: Session): void {
  const view = session.monitor
  if (!view || view.timer) return

  const tick = async (): Promise<void> => {
    if (view.busy || document.hidden) return
    view.busy = true
    try {
      renderMonitor(view, await api.monitor(session.id))
    } catch (err) {
      log('warn', `[${session.name}] 资源采样失败：${(err as Error).message}`)
    } finally {
      view.busy = false
    }
  }

  void tick()
  // The sampling script itself sleeps a second, so poll on a slower beat than that.
  view.timer = window.setInterval(() => void tick(), 2000)
}

function stopMonitor(session: Session): void {
  if (session.monitor?.timer) clearInterval(session.monitor.timer)
  if (session.monitor) session.monitor.timer = undefined
}

function toggleMonitor(session: Session): void {
  const view = session.monitor
  if (!view) return
  const open = view.root.style.display !== 'none'
  view.root.style.display = open ? 'none' : 'flex'
  session.toolbar.querySelector<HTMLElement>('[data-act="monitor"]')?.classList.toggle('on', !open)
  if (open) {
    stopMonitor(session)
  } else {
    session.fit.fit()
    startMonitor(session)
  }
}

/* ------------------------------------------------------------------ *
 * ai panel
 * ------------------------------------------------------------------ */

/**
 * One conversation per tab, in a side panel built the same way the monitor is:
 * created once, hidden, woken by a toolbar button.
 *
 * The transcript is deliberately not a chat log with avatars — it is an
 * execution record. Every command that ran, and every command that was refused,
 * stays on screen, because that record is what the next prompt is built on.
 */
interface AgentView {
  root: HTMLElement
  log: HTMLElement
  input: HTMLTextAreaElement
  /** The one button that sends, or stops what is running. */
  go: HTMLButtonElement
  /** Local paths waiting to go up with the next message. */
  files: string[]
  filesRow: HTMLElement
  attach: HTMLElement
  /** Takes the pane for the wide view, and the divider that resizes it. */
  wide: HTMLElement
  grip: HTMLElement
  /** The "no key yet" panel, swapped in for the conversation. */
  setup: HTMLElement
  compose: HTMLElement
  /** The bubble currently being streamed into, if any. */
  live: HTMLElement | null
  /** A card waiting for an answer. Whoever answers it clears this. */
  open: { askId: string; card: HTMLElement } | null
  busy: boolean
  /** The "requesting…" row, while the turn has said nothing yet. */
  working: HTMLElement | null
}

function buildAgent(): AgentView {
  const root = el('div', 'agent')
  // Remembered, not fixed: the same panel holds a one-line answer and a 40-line
  // diff, and only the person reading it knows which one is coming.
  root.style.setProperty('--agent-w', `${store.settings.agentWidth}px`)

  // Straddles the panel's own left edge: as a sibling in the flex row it would
  // sit there as a dead 5px stripe every time the panel is closed.
  const grip = el('div', 'agent-grip')
  grip.title = '拖动调整 AI 面板的宽度'
  root.append(grip)

  const head = el('div', 'agent-head')
  head.append(el('span', 'agent-title', 'AI 助手'))
  const wide = el('button', 'agent-mini agent-wide', '⤢')
  wide.title = '占满整行，专看这边的命令和回复（再点一次还原）'
  const clear = el('button', 'agent-mini', '清空')
  head.append(wide, clear)
  root.append(head)

  const log = el('div', 'agent-log')
  log.append(agentHint())
  root.append(log)

  // The panel is reachable before anything is configured — the whole feature
  // hiding behind a key nobody knows to set is how you ship an AI nobody finds.
  // What it opens onto has to be a next step, not an empty box.
  const setup = el('div', 'agent-setup')
  setup.hidden = true
  const setupBtn = el('button', 'agent-btn primary', '去设置')
  setupBtn.addEventListener('click', settingsDialog)
  setup.append(
    el('div', 'agent-setup-title', '还没配置模型接口'),
    el(
      'div',
      'agent-setup-note',
      '设置里填「接口地址」和「模型」就行 —— 模型名可以从接口拉取，本地网关不用 API Key。配好之后：只读的自己跑，改动服务器的会先问过你。'
    ),
    setupBtn
  )
  root.append(setup)

  const compose = el('div', 'agent-compose')
  const box = el('div', 'agent-box')
  const input = document.createElement('textarea')
  input.className = 'agent-input'
  input.rows = 3
  input.placeholder = '让它在这台机器上做事…（Enter 发送，Shift+Enter 换行）'
  // Grows with the text up to a point, then scrolls: a two-line box is where
  // people stop writing the thing they actually wanted to ask.
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`
  })

  const filesRow = el('div', 'agent-files')
  filesRow.hidden = true

  const foot = el('div', 'agent-foot')
  const attach = el('button', 'agent-clip', '＋')
  attach.title = '添加附件：先传到服务器的 /tmp，再让它去读'
  const go = el('button', 'agent-go', '↑')
  go.title = '发送 (Enter)'
  foot.append(attach, go)
  box.append(filesRow, input, foot)
  compose.append(box)
  root.append(compose)

  const view: AgentView = {
    root,
    log,
    input,
    go,
    files: [],
    filesRow,
    attach,
    wide,
    grip,
    setup,
    compose,
    live: null,
    open: null,
    busy: false,
    working: null
  }
  clear.addEventListener('click', () => {
    const session = [...sessions.values()].find((s) => s.agent === view)
    if (session) void api.agentReset(session.id)
    log.replaceChildren(agentHint())
    view.live = null
    view.open = null
    setAgentBusy(view, false)
  })
  setAgentBusy(view, false)
  return view
}

function wireAgent(session: Session): void {
  const view = session.agent
  if (!view) return

  // One click when the terminal is in the way — an approval card and a 40-line
  // reply are read on this side, and dragging the divider every time is the
  // thing people stop doing.
  view.wide.addEventListener('click', () => {
    const row = view.root.parentElement
    if (!row) return
    view.wide.classList.toggle('on', row.classList.toggle('ai-only'))
    session.fit.fit()
  })

  // Dragging left widens the AI side — the handle belongs to it, not to the
  // terminal it is stealing from.
  view.grip.addEventListener('mousedown', (down: MouseEvent) => {
    down.preventDefault()
    const startX = down.clientX
    const startW = view.root.getBoundingClientRect().width
    const move = (ev: MouseEvent): void => {
      const width = Math.min(window.innerWidth - 320, Math.max(340, startW + startX - ev.clientX))
      view.root.style.setProperty('--agent-w', `${Math.round(width)}px`)
      session.fit.fit()
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void api.saveSettings({ ...store.settings, agentWidth: Math.round(view.root.getBoundingClientRect().width) })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  const submit = (): void => {
    if (view.busy) return
    const text = view.input.value.trim()
    const files = view.files
    // Something has to be said. A bare attachment gets a placeholder sentence,
    // written here rather than in the main process so the row on screen is
    // literally what was sent.
    if (!text && !files.length) return
    const said = text || '看看我刚传上去的这个文件'

    view.input.value = ''
    view.input.style.height = ''
    view.files = []
    renderAgentFiles(view)
    // Shown straight away rather than echoed back from the main process — the
    // round trip is long enough to feel broken otherwise.
    addAgentRow(view, 'user', files.length ? `${said}\n📎 ${files.map(baseName).join('、')}` : said)
    setAgentBusy(view, true)
    // A rejected invoke is the one failure with no event behind it — without
    // this the panel would sit on "正在请求…" forever with no way to tell.
    api.agentSend(session.id, session.connectionId, said, files).catch((err) => {
      addAgentRow(view, 'error', `没发出去：${String((err as Error)?.message ?? err)}`)
      setAgentBusy(view, false)
    })
  }

  // One button, two jobs: while a turn is running there is nothing to send, and
  // stopping is the only thing worth pressing.
  view.go.addEventListener('click', () => {
    if (view.busy) void api.agentAbort(session.id)
    else submit()
  })
  view.attach.addEventListener('click', () => {
    void api.pickFile().then((path) => {
      if (path) addAgentFile(view, path)
    })
  })

  const box = view.compose.querySelector('.agent-box') as HTMLElement
  box.addEventListener('dragover', (ev) => {
    ev.preventDefault()
    box.classList.add('over')
  })
  box.addEventListener('dragleave', () => box.classList.remove('over'))
  box.addEventListener('drop', (ev) => {
    ev.preventDefault()
    box.classList.remove('over')
    for (const file of ev.dataTransfer?.files ?? []) addAgentFile(view, api.pathForFile(file))
  })

  view.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      submit()
    }
  })
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Attachments are local paths, never contents: the file is read where it is,
 *  and the renderer has no business holding a 200 MB log to show a chip. */
function addAgentFile(view: AgentView, path: string): void {
  if (!path || view.files.includes(path)) return
  view.files.push(path)
  renderAgentFiles(view)
}

function renderAgentFiles(view: AgentView): void {
  view.filesRow.replaceChildren(
    ...view.files.map((path) => {
      const chip = el('div', 'agent-file')
      chip.title = path
      chip.append(el('span', 'agent-file-name', baseName(path)))
      const drop = el('button', 'agent-file-x', '×')
      drop.title = '这次不传它'
      drop.addEventListener('click', () => {
        view.files = view.files.filter((f) => f !== path)
        renderAgentFiles(view)
      })
      chip.append(drop)
      return chip
    })
  )
  view.filesRow.hidden = view.files.length === 0
}

function setAgentBusy(view: AgentView, busy: boolean): void {
  view.busy = busy
  view.go.classList.toggle('stop', busy)
  view.go.textContent = busy ? '■' : '↑'
  view.go.title = busy ? '停止' : '发送 (Enter)'
  view.input.placeholder = busy
    ? '正在处理…'
    : '让它在这台机器上做事…（Enter 发送，Shift+Enter 换行）'
  // Between sending and the first frame there is nothing on screen at all —
  // a slow endpoint, or one that never answers, looks identical to a dead
  // button. This is the row that says which of the two it is.
  view.working?.remove()
  view.working = null
  if (busy) {
    view.working = addAgentRow(view, 'pending', `正在请求 ${store.settings.llm?.model || '模型'}…`)
  }
}

/** Shown until there is a transcript. Deliberately underneath the toolbar button
 *  that opens the panel, so a first-time user is not staring at an empty box. */
function agentHint(): HTMLElement {
  return el(
    'div',
    'agent-hint',
    '让它在这台机器上做点什么，比如「磁盘还剩多少」。只读的自己跑；要改动服务器的会先问你，确认后就打在左边那个终端里执行。'
  )
}

function addAgentRow(view: AgentView, cls: string, text: string): HTMLElement {
  view.log.querySelector('.agent-hint')?.remove()
  const row = el('div', `agent-msg ${cls}`, text)
  view.log.append(row)
  view.log.scrollTop = view.log.scrollHeight
  return row
}

function renderAgent(session: Session, ev: AgentEvent): void {
  const view = session.agent
  if (!view) return
  const stick = view.log.scrollHeight - view.log.scrollTop - view.log.clientHeight < 40

  // The first thing that actually happens retires the "requesting" row: the
  // turn is no longer silent, whatever it turned out to say.
  if (view.working && ev.kind !== 'done') {
    view.working.remove()
    view.working = null
  }

  switch (ev.kind) {
    case 'delta': {
      if (!view.live) view.live = addAgentRow(view, 'assistant', '')
      view.live.textContent += ev.text
      break
    }
    case 'assistant': {
      // Everything already arrived as deltas; this is the settled value, and
      // setting it is idempotent for the normal case.
      if (!view.live) view.live = addAgentRow(view, 'assistant', '')
      view.live.textContent = ev.text
      view.live = null
      break
    }
    case 'tool':
      // The detail already reads as a command for most tools ("ls /", "mkdir /x"),
      // and repeating the tool name in front of it is just noise.
      addAgentRow(view, 'tool', `▶ ${ev.detail.startsWith(ev.name) ? ev.detail : `${ev.name}  ${ev.detail}`}`)
      break
    case 'result':
      addAgentRow(view, ev.ok ? 'result' : 'result bad', ev.summary || '（无输出）')
      break
    case 'ask':
      addAgentAsk(view, ev)
      break
    case 'error':
      addAgentRow(view, 'error', ev.message)
      break
    case 'done':
      // Anything still open when the turn ends was cancelled — by the stop
      // button, a dropped connection, or an error.
      if (view.open) closeAgentAsk(view.open.card, '已取消')
      view.open = null
      view.live = null
      setAgentBusy(view, false)
      break
  }

  if (stick) view.log.scrollTop = view.log.scrollHeight
}

/** The one moment a command can be stopped. Everything on it is there to make
 *  the decision possible in the two seconds a person will actually spend. */
function addAgentAsk(view: AgentView, ev: Extract<AgentEvent, { kind: 'ask' }>): void {
  const card = el('div', `agent-ask risk-${ev.risk}`)
  card.append(el('div', 'agent-ask-why', `${ev.name} 需要你确认 — ${ev.why}`))

  // Editable only for shell commands: that is the only place a person knows
  // better than the model. Editing it re-runs the risk check.
  const box = document.createElement('textarea')
  box.className = 'agent-ask-cmd'
  box.value = ev.detail
  box.rows = Math.min(14, Math.max(2, ev.detail.split('\n').length))
  box.readOnly = ev.name !== 'exec'
  card.append(box)

  const row = el('div', 'agent-ask-btns')
  const deny = el('button', 'agent-btn', '拒绝')
  const allow = el('button', 'agent-btn primary', '执行')
  row.append(deny, allow)
  card.append(row)
  view.log.append(card)
  view.open = { askId: ev.askId, card }

  const answer = (allowed: boolean): void => {
    if (view.open?.askId !== ev.askId) return
    view.open = null
    closeAgentAsk(card, allowed ? '已允许' : '已拒绝')
    void api.agentApprove(ev.askId, allowed, ev.name === 'exec' ? box.value : undefined)
  }
  deny.addEventListener('click', () => answer(false))
  allow.addEventListener('click', () => answer(true))
  view.log.scrollTop = view.log.scrollHeight
}

function closeAgentAsk(card: HTMLElement, label: string): void {
  card.classList.add('answered')
  card.querySelector('.agent-ask-btns')?.replaceWith(el('div', 'agent-ask-state', label))
  card.querySelector<HTMLTextAreaElement>('.agent-ask-cmd')?.setAttribute('readonly', '')
}

/** The entry is always there — a feature nobody can see is a feature nobody
 *  uses. What changes with the setting is what the panel opens onto: a next
 *  step while nothing is configured, the conversation once something is.
 *
 *  A model name is the whole test. Keys are optional — a gateway on the LAN, a
 *  local ollama, or a proxy that injects its own all work without one, and
 *  demanding a key anyway locks those users out of a feature that would have
 *  worked. */
function syncAgentEntry(session: Session): void {
  if (!session.agent) return
  const ready = !!store.settings.llm?.model?.trim()
  session.agent.setup.hidden = ready
  session.agent.compose.hidden = !ready
  // The transcript stays in the DOM either way: the conversation in the main
  // process outlives the key being edited.
  session.agent.log.hidden = !ready
}

function toggleAgent(session: Session): void {
  const view = session.agent
  if (!view) return
  const open = view.root.style.display !== 'none'
  view.root.style.display = open ? 'none' : 'flex'
  session.toolbar.querySelector<HTMLElement>('[data-act="agent"]')?.classList.toggle('on', !open)
  if (open) {
    // Nothing to stop: the conversation outlives the panel, and a running turn
    // keeps running so its commands stay visible when you come back.
  } else {
    session.fit.fit()
    view.input.focus()
  }
}

/* ------------------------------------------------------------------ *
 * theme picker
 * ------------------------------------------------------------------ */

function themeDialog(): void {
  const grid = el('div', 'theme-grid')
  const swatches: [string, HTMLElement][] = []

  for (const [key, theme] of Object.entries(THEMES)) {
    const card = el('button', 'theme-card')
    card.dataset.themeKey = key
    card.title = theme.label

    const preview = el('div', 'theme-preview')
    preview.style.background = theme.ui['bg-side']
    const bar = el('div', 'theme-bar')
    bar.style.background = theme.ui.bg
    const term = el('div', 'theme-term')
    term.style.background = theme.term.background ?? ''
    const dot = el('div', 'theme-dot')
    dot.style.background = theme.ui.accent
    preview.append(bar, term, dot)
    card.append(preview, el('span', 'theme-name', theme.label))
    card.addEventListener('click', () => void pickTheme(key))
    grid.appendChild(card)
    swatches.push([key, card])
  }

  const mark = (active: string): void => {
    for (const [key, card] of swatches) card.classList.toggle('on', key === active)
  }
  mark(store.settings.theme)

  // Live preview: the whole app recolors as you hover, and reverts on mouse-out.
  for (const [key, card] of swatches) {
    card.addEventListener('mouseenter', () => applySettings({ ...store.settings, theme: key }))
  }
  grid.addEventListener('mouseleave', () => applySettings(store.settings))

  showModal('主题', grid, [{ label: '完成', primary: true, onClick: closeModal }])

  async function pickTheme(key: string): Promise<void> {
    store.settings = await api.saveSettings({ ...store.settings, theme: key })
    applySettings(store.settings)
    mark(key)
    log('info', `主题切换为 ${THEMES[key].label}`)
  }
}

/* ------------------------------------------------------------------ *
 * log
 * ------------------------------------------------------------------ */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogLine {
  t: number
  level: LogLevel
  text: string
}

/** Ring buffer, not a file: this panel exists to explain the last failure. */
const LOG_LIMIT = 2000
const logLines: LogLine[] = []

function log(level: LogLevel, text: string): void {
  logLines.push({ t: Date.now(), level, text })
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT)
}

function stamp(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function logText(): string {
  return logLines.map((l) => `${stamp(l.t)} ${l.level.toUpperCase().padEnd(5)} ${l.text}`).join('\n')
}

function logDialog(): void {
  const box = el('div', 'log-box')
  const view = el('pre', 'log-view', logLines.length ? logText() : '（暂无日志）')
  box.appendChild(view)

  showModal('日志', box, [
    {
      label: '复制',
      onClick: () => void navigator.clipboard.writeText(logText())
    },
    {
      label: '清空',
      danger: true,
      onClick: () => {
        logLines.length = 0
        view.textContent = '（暂无日志）'
      }
    },
    { label: '关闭', primary: true, onClick: closeModal }
  ])
  view.scrollTop = view.scrollHeight
}

/* ------------------------------------------------------------------ *
 * chrome wiring
 * ------------------------------------------------------------------ */

/**
 * Window-level shortcuts. The terminal has its own handler and must run first —
 * xterm would otherwise hand things like Ctrl+T to the remote shell as raw
 * control characters — so anything inside `.term-box` is left to it.
 */
function globalKeys(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement
  if (ev.key === 'Escape' && !$('#overlay').hidden) {
    closeModal()
    return
  }
  if (target.closest?.('.term-box')) return
  if (!$('#overlay').hidden) return
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  ev.preventDefault()
  appKey(ev)
}

/** App-wide shortcuts; true when the key was ours. */
function appKey(ev: KeyboardEvent): boolean {
  if (!ev.ctrlKey || ev.altKey) return false
  if (!ev.shiftKey && /^Digit[1-9]$/.test(ev.code)) {
    const id = [...sessions.keys()][Number(ev.code.slice(5)) - 1]
    if (id) activate(id)
    return true
  }
  switch (ev.code) {
    case 'KeyT':
      if (ev.shiftKey) return false
      connDialog(null, null)
      return true
    case 'Comma':
      settingsDialog()
      return true
    case 'Slash':
      shortcutsDialog()
      return true
    case 'Tab':
      cycleTab(ev.shiftKey ? -1 : 1)
      return true
    default:
      return false
  }
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl + T', '新建连接'],
  ['⌘ / 🔑', '命令面板 / 私钥管理'],
  ['Ctrl + ,', '设置'],
  ['Ctrl + /', '快捷键一览'],
  ['Ctrl + Tab / Ctrl + Shift + Tab', '切换标签'],
  ['Ctrl + 1 … 9', '跳到第 N 个标签'],
  ['Ctrl + Shift + W', '关闭当前标签'],
  ['Ctrl + Shift + C / V', '复制 / 粘贴'],
  ['Ctrl + Shift + F', '终端内查找'],
  ['Ctrl + Shift + B', '文件面板'],
  ['Ctrl + Shift + M', '资源监控'],
  ['Ctrl + Shift + H', '历史命令'],
  ['Ctrl + Shift + K', '清屏'],
  ['Ctrl + S', '编辑器：存回服务器'],
  ['Esc', '编辑器 / 弹窗：关闭'],
  ['Alt + ↑ / ↓', '文件面板：上一级 / 进入选中目录'],
  ['↓', '命令候选：进入面板，依次往下选'],
  ['↑', '命令候选：往回退到已输入的内容'],
  ['右键', '会话内菜单；终端内粘贴']
]

/** Handled by the remote shell, not by us — here because nobody remembers them. */
const SHELL_KEYS: [string, string][] = [
  ['Tab', '补全命令或路径'],
  ['Ctrl + R', '搜索 shell 历史'],
  ['Ctrl + C', '中断当前命令'],
  ['Ctrl + D', '结束输入 / 退出登录'],
  ['Ctrl + L', '清屏（保留历史）'],
  ['Ctrl + A / Ctrl + E', '光标到行首 / 行尾'],
  ['Ctrl + U / Ctrl + K', '删到行首 / 行尾'],
  ['Ctrl + W', '删掉前一个词'],
  ['↑ / ↓', 'shell 自己的历史（候选没被选中时）']
]

function shortcutsDialog(): void {
  const fill = (rows: [string, string][]): HTMLElement => {
    const table = el('div', 'keys')
    for (const [keys, what] of rows) {
      const row = el('div', 'key-row')
      keys.split(' / ').forEach((one, i) => {
        if (i) row.append(el('span', 'key-slash', '/'))
        row.append(el('kbd', '', one))
      })
      row.append(el('span', 'key-what', what))
      table.append(row)
    }
    return table
  }
  const body = el('div', 'keys-body')
  body.append(
    el('div', 'keys-title', '应用快捷键'),
    fill(SHORTCUTS),
    el('div', 'keys-title', '终端里交给远端 shell（LiteShell 不拦）'),
    fill(SHELL_KEYS)
  )
  showModal('快捷键', body, [{ label: '关闭', primary: true, onClick: closeModal }])
}

function wireChrome(): void {
  $('#btn-new-conn').addEventListener('click', () => connDialog(null, null))
  $('#btn-new-folder').addEventListener('click', () => folderDialog(null, null))
  $('#btn-import').addEventListener('click', (ev) => transferMenu(ev))
  $('#btn-theme').addEventListener('click', themeDialog)
  $('#btn-log').addEventListener('click', logDialog)
  $('#btn-settings').addEventListener('click', settingsDialog)
  $('#btn-quick').addEventListener('click', commandPalette)
  $('#btn-keyring').addEventListener('click', () => void keysDialog())
  $('#btn-keys').addEventListener('click', shortcutsDialog)

  window.addEventListener('mousedown', (ev) => {
    if (menuEl && !menuEl.contains(ev.target as Node)) closeMenu()
  })
  window.addEventListener('blur', closeMenu)
  window.addEventListener('keydown', globalKeys)

  const sidebar = $('#sidebar')
  const resizer = $('#resizer')
  resizer.addEventListener('mousedown', (down: MouseEvent) => {
    down.preventDefault()
    const startX = down.clientX
    const startW = sidebar.getBoundingClientRect().width
    const move = (ev: MouseEvent): void => {
      const width = Math.min(460, Math.max(160, startW + ev.clientX - startX))
      sidebar.style.width = `${width}px`
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      sessions.get(activeId ?? '')?.fit.fit()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  window.addEventListener('resize', () => sessions.get(activeId ?? '')?.fit.fit())
  window.addEventListener('beforeunload', () => {
    // Only this window's sessions: a popped-out window going away must not
    // hang up the tabs the main window is still showing.
    for (const session of sessions.values()) {
      flushHistory(session)
      void api.disconnect(session.id)
    }
  })

  // Right-click paste, matching the muscle memory of most terminal clients.
  document.addEventListener('contextmenu', (ev) => {
    const inTerm = (ev.target as HTMLElement).closest('.term-box')
    if (!inTerm || !store.settings.rightClickPaste) return
    ev.preventDefault()
    void navigator.clipboard.readText().then((text) => {
      const session = activeId ? sessions.get(activeId) : undefined
      if (text && session) send(session, text)
    })
  })
}

void boot()
