import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type WebContents
} from 'electron'
import type {
  BackupBundle,
  Connection,
  Folder,
  KeyFile,
  QuickCommand,
  SessionEvent,
  Settings
} from '../shared/types'
import { SshManager } from './ssh'
import { CliServer } from './cli-server'
import { AgentRunner, clearSpill } from './agent'
import { listModels } from './agent-providers'
import { importFinalshell } from './finalshell'
import { setupPasswordless } from './passwordless'
import {
  addKey,
  duplicateConnection,
  exportBundle,
  findKey,
  importBundle,
  keyDir,
  llmSettings,
  mergeImport,
  publicKey,
  publicStore,
  removeConnection,
  removeFolder,
  removeKey,
  setHistory,
  setKeySecret,
  setQuickCommands,
  setSettings,
  store,
  updateKey,
  upsertConnection,
  upsertFolder
} from './store'

let win: BrowserWindow | null = null
/** Windows opened around a single tab. They close for real, unlike the main one. */
const extras = new Set<BrowserWindow>()
/** Which window is currently showing a session. A session has one viewer; the
 *  tab moves between windows, it is not mirrored. */
const owners = new Map<string, WebContents>()
/** Events for a session are held here between `popOutSession` and the new
 *  window's `attachSession`, so no terminal output falls into the gap. */
const pending = new Map<string, SessionEvent[]>()
/** Sessions each window is responsible for, so closing it hangs up cleanly. */
const windowSessions = new Map<number, Set<string>>()
/** Popped-out windows that have not attached yet, by webContents id. */
const popped = new Map<number, string>()
let tray: Tray | null = null
let manager: SshManager
let cli: CliServer | null = null
let agent: AgentRunner | null = null
/** Only true once the app is really leaving. Closing the window parks it in the
 *  tray instead, so the close handler has to tell the two apart. */
let quitting = false

function emit(ev: SessionEvent): void {
  // A conversation dies with its tab. Its transcript describes a machine that is
  // no longer connected, and its output handles point at nothing re-readable.
  if (ev.type === 'status' && (ev.status === 'closed' || ev.status === 'error')) {
    agent?.forget(ev.sessionId)
  }

  const sid = 'sessionId' in ev ? ev.sessionId : ''
  const held = sid ? pending.get(sid) : undefined
  if (held) {
    // The window that will show this is still loading; replay it then.
    held.push(ev)
    // ponytail: 5000-event cap; a slow pop-out could drop the oldest output.
    if (held.length > 5000) held.shift()
  } else {
    const owner = sid ? owners.get(sid) : undefined
    if (owner && !owner.isDestroyed()) owner.send('session:event', ev)
    // Sessions nobody popped out (the CLI's, or early events) belong to the main window.
    else win?.webContents.send('session:event', ev)
  }
  cli?.onEvent(ev)
}

/** A window is gone: hang up the sessions only it was showing. */
function forgetWindow(wcId: number): void {
  const ids = windowSessions.get(wcId)
  windowSessions.delete(wcId)
  for (const sid of ids ?? []) {
    owners.delete(sid)
    pending.delete(sid)
    manager?.disconnect(sid)
  }
  const lone = popped.get(wcId)
  if (lone) {
    popped.delete(wcId)
    pending.delete(lone)
    owners.delete(lone)
    manager?.disconnect(lone)
  }
}

function showWindow(): void {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** The window's X means "get out of my way", not "quit" — the tray is both the
 *  way back and the only way out. Sessions keep running while it is parked
 *  there, which is what lets the CLI keep working with no window on screen. */
function createTray(): void {
  // Same png as the window: one icon to keep in sync. A dedicated 16px .ico
  // would be sharper in the Windows tray, but this is the size that matters.
  tray = new Tray(nativeImage.createFromPath(join(__dirname, '../../build/icon.png')))
  tray.setToolTip('LiteShell')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      { label: '退出 LiteShell', click: () => app.quit() }
    ])
  )
  // Left click is the reflex on Windows; the menu is on the right one.
  tray.on('click', showWindow)
}

/**
 * @param query renderer-side parameters — `attach`/`conn` make a dedicated
 *              window around one live session.
 * @param extra false for the main window, which parks in the tray instead of
 *              closing; true for the one-tab windows, which really close.
 */
function createWindow(query: Record<string, string> = {}, extra = false): BrowserWindow {
  const w = new BrowserWindow({
    width: extra ? 1000 : 1280,
    height: extra ? 700 : 820,
    minWidth: 900,
    minHeight: 560,
    // Windows takes the icon from the exe; Linux reads it off the window, and
    // in dev this is the only icon there is.
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    backgroundColor: '#0f1116',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? {}
      : {
          titleBarOverlay: { color: '#0f1116', symbolColor: '#8b95a5', height: 40 }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const wcId = w.webContents.id
  if (extra) extras.add(w)
  else win = w

  w.once('ready-to-show', () => w.show())
  w.on('close', (e) => {
    if (extra || quitting) return
    e.preventDefault()
    w.hide()
  })
  w.on('closed', () => {
    if (extra) {
      extras.delete(w)
      forgetWindow(wcId)
    } else {
      win = null
    }
  })

  // Anything that wants a new window opens in the user's browser instead.
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const qs = new URLSearchParams(query).toString()
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(process.env.ELECTRON_RENDERER_URL + (qs ? `?${qs}` : ''))
  } else {
    void w.loadFile(
      join(__dirname, '../renderer/index.html'),
      qs ? { query } : undefined
    )
  }
  return w
}

function registerIpc(): void {
  ipcMain.handle('store:get', () => publicStore())
  ipcMain.handle('conn:save', (_e, conn: Connection, secret: string | null) => upsertConnection(conn, secret))
  ipcMain.handle('conn:delete', (_e, id: string) => removeConnection(id))
  ipcMain.handle('conn:duplicate', (_e, id: string) => duplicateConnection(id))
  ipcMain.handle('folder:save', (_e, folder: Folder) => upsertFolder(folder))
  ipcMain.handle('folder:delete', (_e, id: string) => removeFolder(id))
  ipcMain.handle('quick:save', (_e, cmds: QuickCommand[]) => setQuickCommands(cmds))
  ipcMain.handle('settings:save', (_e, s: Settings) => setSettings(s))
  ipcMain.handle('store:history', (_e, connectionId: string, commands: string[]) =>
    setHistory(connectionId, commands)
  )

  // Every dialog is parented to the window that asked for it — a popped-out
  // tab files things where it is, not over the hidden main window.
  const ownerOf = (sender: WebContents): BrowserWindow => BrowserWindow.fromWebContents(sender)!

  // No extension filter on purpose: private keys frequently have no suffix
  // (`id_ed25519` is the common case), and a filter would hide exactly those.
  ipcMain.handle('key:import', async (e) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '导入私钥',
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled) return null
    return picked.filePaths.map((path) => publicKey(addKey(path)))
  })
  ipcMain.handle('key:save', (_e, key: KeyFile) => updateKey(key))
  ipcMain.handle('key:secret', (_e, id: string, passphrase: string) =>
    setKeySecret(id, String(passphrase ?? ''))
  )
  ipcMain.handle('key:delete', (_e, id: string) => removeKey(id))
  ipcMain.handle('key:export', async (e, id: string) => {
    const key = findKey(id)
    if (!key) return null
    const picked = await dialog.showSaveDialog(ownerOf(e.sender), {
      title: '导出私钥',
      defaultPath: `${key.name}.pem`,
      filters: [{ name: '私钥', extensions: ['pem'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    // Copies the copy, not a move: the library entry keeps working.
    copyFileSync(key.path, picked.filePath)
    return picked.filePath
  })

  ipcMain.handle(
    'session:connect',
    (_e, id: string, sessionId: string, cols: number, rows: number, secret?: string) =>
      manager.connect(id, sessionId, cols, rows, secret)
  )
  ipcMain.handle('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.handle('session:resize', (_e, id: string, cols: number, rows: number) => manager.resize(id, cols, rows))
  ipcMain.handle('session:disconnect', (_e, id: string) => manager.disconnect(id))
  ipcMain.handle('session:disconnectAll', () => manager.disconnectAll())

  // A renderer claims a session when it puts a terminal around it. Events are
  // routed to exactly one window, so moving a tab between windows is a move.
  ipcMain.handle('session:attach', (e, sessionId: string) => {
    owners.set(sessionId, e.sender)
    let mine = windowSessions.get(e.sender.id)
    if (!mine) {
      mine = new Set()
      windowSessions.set(e.sender.id, mine)
    }
    mine.add(sessionId)
    popped.delete(e.sender.id)
    const held = pending.get(sessionId)
    if (held) {
      pending.delete(sessionId)
      for (const ev of held) e.sender.send('session:event', ev)
    }
    return manager.info(sessionId)
  })
  ipcMain.handle('session:release', (e, sessionId: string) => {
    if (owners.get(sessionId) === e.sender) owners.delete(sessionId)
    windowSessions.get(e.sender.id)?.delete(sessionId)
  })
  ipcMain.handle('session:popOut', (e, sessionId: string, connectionId: string) => {
    if (!manager.has(sessionId)) return false
    // Held, not routed anywhere, until the new window attaches.
    pending.set(sessionId, [])
    if (owners.get(sessionId) === e.sender) owners.delete(sessionId)
    const conn = store().connections.find((c) => c.id === connectionId)
    const child = createWindow({ attach: sessionId, conn: connectionId }, true)
    child.setTitle(conn?.name ?? 'LiteShell')
    popped.set(child.webContents.id, sessionId)
    return true
  })

  ipcMain.handle('sftp:home', (_e, id: string) => manager.home(id))
  ipcMain.handle('sftp:list', (_e, id: string, path: string) => manager.list(id, path))
  ipcMain.handle('sftp:mkdir', (_e, id: string, path: string) => manager.mkdir(id, path))
  ipcMain.handle('sftp:rename', (_e, id: string, from: string, to: string) => manager.rename(id, from, to))
  ipcMain.handle('sftp:remove', (_e, id: string, path: string, isDir: boolean, recursive?: boolean) =>
    manager.remove(id, path, isDir, recursive)
  )
  ipcMain.handle('sftp:touch', (_e, id: string, path: string) => manager.touch(id, path))
  ipcMain.handle('sftp:chmod', (_e, id: string, path: string, mode: number) =>
    manager.chmod(id, path, mode)
  )
  ipcMain.handle('sftp:download', async (e, id: string, path: string, isDir: boolean) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '选择下载到',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return manager.download(id, path, picked.filePaths[0], isDir)
  })
  ipcMain.handle('sftp:downloadArchive', async (e, id: string, path: string) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '选择打包下载到',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return manager.downloadArchive(id, path, picked.filePaths[0])
  })
  ipcMain.handle('sftp:readText', (_e, id: string, path: string) => manager.readText(id, path))
  ipcMain.handle(
    'sftp:writeText',
    (_e, id: string, path: string, text: string, mtime: number, force: boolean) =>
      manager.writeText(id, path, text, mtime, force)
  )

  // "Open" means: fetch it somewhere local, then let the OS decide what that means.
  ipcMain.handle('sftp:open', async (_e, id: string, path: string) => {
    const dir = join(app.getPath('temp'), 'liteshell-open')
    const local = await manager.download(id, path, dir, false)
    const err = await shell.openPath(local)
    return err ? `无法打开：${err}` : `已打开 ${local}`
  })
  ipcMain.handle('sftp:upload', async (e, id: string, remoteDir: string) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled) return []
    return manager.upload(id, picked.filePaths, remoteDir)
  })

  // The OS-drawn window buttons sit in the title bar strip, so they need the theme
  // background too — CSS can't reach them.
  ipcMain.handle('window:chrome', (e, bg: string, fg: string) => {
    if (process.platform === 'darwin') return
    BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 })
  })

  ipcMain.handle('sftp:uploadPaths', (_e, id: string, localPaths: string[], remoteDir: string) =>
    manager.upload(id, localPaths, remoteDir)
  )
  ipcMain.handle('sftp:transfers', (_e, id: string) => manager.listTransfers(id))
  ipcMain.handle('sftp:clearTransfers', (_e, id: string) => manager.clearTransfers(id))
  ipcMain.handle('monitor:snapshot', (_e, id: string) => manager.monitor(id))

  ipcMain.handle('agent:send', (_e, sessionId: string, connectionId: string, text: string, files?: string[]) =>
    agent?.send(sessionId, connectionId, text, files)
  )
  ipcMain.handle('agent:approve', (_e, askId: string, allowed: boolean, command?: string) =>
    agent?.approve(askId, allowed, command)
  )
  ipcMain.handle('agent:abort', (_e, sessionId: string) => agent?.abort(sessionId))
  // The dialog may not be saved yet, so what is typed there wins; the stored key
  // is only a fallback for "I changed the model, not the key".
  ipcMain.handle(
    'llm:models',
    (_e, cfg: { provider: Settings['llm']['provider']; baseUrl: string; apiKey?: string }) =>
      listModels({ ...cfg, apiKey: cfg.apiKey || llmSettings().apiKey })
  )
  ipcMain.handle('agent:reset', (_e, sessionId: string) => agent?.reset(sessionId))

  /** One save dialog + one file, shared by "export everything" and "export this one". */
  const exportToFile = async (
    sender: WebContents,
    passphrase: string,
    defaultName: string,
    onlyIds?: string[],
    folderId?: string
  ) => {
    const picked = await dialog.showSaveDialog(ownerOf(sender), {
      title: folderId ? '导出这个文件夹' : onlyIds ? '导出这条连接' : '导出连接',
      defaultPath: defaultName,
      filters: [{ name: 'LiteShell 备份', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePath) return null

    const { bundle, missing, passwords } = exportBundle(passphrase, onlyIds, folderId)
    // Written 0600: it carries private keys in the clear, same as FinalShell's own config.
    writeFileSync(picked.filePath, JSON.stringify(bundle, null, 2), { mode: 0o600 })
    try {
      chmodSync(picked.filePath, 0o600)
    } catch {
      // Windows ACLs under the user profile are already restrictive enough.
    }
    return {
      path: picked.filePath,
      connections: bundle.connections.length,
      keys: bundle.keys.length,
      passwords,
      hostKeys: bundle.knownHosts?.length ?? 0,
      missing
    }
  }

  // One-click `ssh <host>`: the stored secret (or the one just typed) authorises
  // installing the local public key, and the ssh config block is written after
  // a key-only login is proven.
  ipcMain.handle('conn:passwordless', (_e, id: string, secret?: string) => {
    const conn = store().connections.find((c) => c.id === id)
    if (!conn) throw new Error(`未知连接: ${id}`)
    return setupPasswordless(conn, secret)
  })

  ipcMain.handle('conn:export', (e, passphrase = '') =>
    exportToFile(
      e.sender,
      String(passphrase ?? ''),
      `liteshell-${new Date().toISOString().slice(0, 10)}.json`
    )
  )
  // The single-connection variant also carries its password/API key when a
  // passphrase is given, like the full export does.
  ipcMain.handle('conn:exportOne', (e, id: string, passphrase = '') => {
    const conn = store().connections.find((c) => c.id === id)
    if (!conn) return null
    const name = conn.name.replace(/[\\/:*?"<>|]/g, '_')
    return exportToFile(e.sender, String(passphrase ?? ''), `${name}.json`, [id])
  })
  ipcMain.handle('conn:exportFolder', (e, id: string, passphrase = '') => {
    const folder = store().folders.find((f) => f.id === id)
    if (!folder) return null
    const name = folder.name.replace(/[\\/:*?"<>|]/g, '_')
    return exportToFile(e.sender, String(passphrase ?? ''), `${name}.json`, undefined, id)
  })

  // Two calls when the file is sealed: the first one answers `needsPassphrase`
  // (main cannot prompt), the second carries the passphrase and the same path.
  ipcMain.handle('conn:import', async (e, passphrase = '', path = '') => {
    let file = String(path ?? '')
    if (!file) {
      const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
        title: '选择 LiteShell 备份文件',
        properties: ['openFile'],
        filters: [{ name: 'LiteShell 备份', extensions: ['json'] }]
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      file = picked.filePaths[0]
    }
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as BackupBundle
    if (bundle.secrets && !passphrase) return { needsPassphrase: true, path: file }
    return importBundle(bundle, keyDir(), String(passphrase ?? ''))
  })

  const runFinalshellImport = (source: string, folderId: string | null) => {
    const result = importFinalshell(source, keyDir(), folderId)
    // Decrypted FinalShell passwords are sealed into this machine's keychain by
    // mergeImport; an existing saved password still wins on re-import.
    mergeImport(result.folders_new, result.connections_new, result.passwords_new)
    // The importer unpacks keys straight into the key directory; index them so
    // they show up in the library and can be reused by other connections.
    for (const conn of result.connections_new) {
      if (conn.privateKeyPath) addKey(conn.privateKeyPath, conn.name)
    }
    const { folders, connections, keys, passwords, needsPassword, skipped, warnings } = result
    return { folders, connections, keys, passwords, needsPassword, skipped, warnings }
  }

  ipcMain.handle('import:finalshell', async (e) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '选择 FinalShell 安装目录（包含 conn 子目录）',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return runFinalshellImport(picked.filePaths[0], null)
  })

  // One `*_connect_config.json`, as produced by FinalShell's per-connection export.
  ipcMain.handle('import:finalshellFile', async (e, folderId: string | null = null) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '选择 FinalShell 连接配置',
      properties: ['openFile'],
      filters: [{ name: 'FinalShell 连接配置', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return runFinalshellImport(picked.filePaths[0], folderId || null)
  })

  ipcMain.handle('dialog:pickFile', async (e, filters?: { name: string; extensions: string[] }[]) => {
    const picked = await dialog.showOpenDialog(ownerOf(e.sender), {
      title: '选择文件',
      properties: ['openFile'],
      filters
    })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })
}

app.setAppUserModelId('dev.lanxk.liteshell')

// One window, one tray icon, one CLI pipe. A second launch surfaces the first
// instead of racing it for the socket and the store file.
const single = app.requestSingleInstanceLock()
if (!single) app.quit()
app.on('second-instance', showWindow)

void app.whenReady().then(() => {
  if (!single) return
  manager = new SshManager(emit)
  // Sessions the CLI opens get a tab too, so the user can watch the agent work —
  // and take over the moment it gets something wrong.
  cli = new CliServer(manager, (connectionId, sessionId) =>
    emit({ type: 'cli-session', sessionId, connectionId })
  )
  cli.listen()
  agent = new AgentRunner(cli, emit)
  // Outputs spilled by the last run are scratch, and nothing outside this
  // process is expected to still hold a handle to them.
  clearSpill()
  registerIpc()
  createWindow()
  createTray()

  app.on('activate', showWindow)
})

// Registered on purpose, to override Electron's default of quitting once the
// last window is gone — the tray is what keeps the app alive now. The window is
// hidden rather than destroyed, so in practice this only runs on the way out.
app.on('window-all-closed', () => undefined)

app.on('before-quit', () => {
  quitting = true
  cli?.close()
  manager?.disconnectAll()
})
