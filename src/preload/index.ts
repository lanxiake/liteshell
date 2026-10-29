import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, SessionEvent } from '../shared/types'

const api: Api = {
  getStore: () => ipcRenderer.invoke('store:get'),
  saveConnection: (conn, secret) => ipcRenderer.invoke('conn:save', conn, secret),
  deleteConnection: (id) => ipcRenderer.invoke('conn:delete', id),
  duplicateConnection: (id) => ipcRenderer.invoke('conn:duplicate', id),
  saveFolder: (folder) => ipcRenderer.invoke('folder:save', folder),
  deleteFolder: (id) => ipcRenderer.invoke('folder:delete', id),
  saveQuickCommands: (cmds) => ipcRenderer.invoke('quick:save', cmds),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  saveHistory: (connectionId, commands) => ipcRenderer.invoke('store:history', connectionId, commands),

  importKeys: () => ipcRenderer.invoke('key:import'),
  saveKey: (key) => ipcRenderer.invoke('key:save', key),
  deleteKey: (id) => ipcRenderer.invoke('key:delete', id),
  setKeySecret: (id, passphrase) => ipcRenderer.invoke('key:secret', id, passphrase),
  exportKey: (id) => ipcRenderer.invoke('key:export', id),

  connect: (id, sessionId, cols, rows, secret) =>
    ipcRenderer.invoke('session:connect', id, sessionId, cols, rows, secret),
  write: (id, data) => ipcRenderer.invoke('session:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke('session:resize', id, cols, rows),
  disconnect: (id) => ipcRenderer.invoke('session:disconnect', id),
  disconnectAll: () => ipcRenderer.invoke('session:disconnectAll'),
  desktopOpen: (id, opts) => ipcRenderer.invoke('desktop:open', id, opts),
  desktopClose: (tunnelId) => ipcRenderer.invoke('desktop:close', tunnelId),
  desktopEmbedded: (id, opts) => ipcRenderer.invoke('desktop:openEmbedded', id, opts),
  desktopAttach: (id) => ipcRenderer.invoke('desktop:attach', id),
  desktopCloseEmbedded: (id) => ipcRenderer.invoke('desktop:closeEmbedded', id),
  attachSession: (id) => ipcRenderer.invoke('session:attach', id),
  releaseSession: (id) => ipcRenderer.invoke('session:release', id),
  popOutSession: (id, connectionId) => ipcRenderer.invoke('session:popOut', id, connectionId),
  popOutAgent: (sessionId, connectionId) => ipcRenderer.invoke('agent:popOut', sessionId, connectionId),
  attachAgentWindow: (sessionId) => ipcRenderer.invoke('agent:attachWindow', sessionId),
  agentTranscript: (sessionId) => ipcRenderer.invoke('agent:transcript', sessionId),

  sftpList: (id, path) => ipcRenderer.invoke('sftp:list', id, path),
  sftpHome: (id) => ipcRenderer.invoke('sftp:home', id),
  sftpMkdir: (id, path) => ipcRenderer.invoke('sftp:mkdir', id, path),
  sftpRename: (id, from, to) => ipcRenderer.invoke('sftp:rename', id, from, to),
  sftpRemove: (id, path, isDir, recursive) =>
    ipcRenderer.invoke('sftp:remove', id, path, isDir, recursive),
  sftpTouch: (id, path) => ipcRenderer.invoke('sftp:touch', id, path),
  sftpChmod: (id, path, mode) => ipcRenderer.invoke('sftp:chmod', id, path, mode),
  sftpDownload: (id, path, isDir) => ipcRenderer.invoke('sftp:download', id, path, isDir),
  sftpDownloadArchive: (id, path) => ipcRenderer.invoke('sftp:downloadArchive', id, path),
  sftpOpen: (id, path) => ipcRenderer.invoke('sftp:open', id, path),
  sftpReadText: (id, path) => ipcRenderer.invoke('sftp:readText', id, path),
  sftpWriteText: (id, path, text, mtime, force) =>
    ipcRenderer.invoke('sftp:writeText', id, path, text, mtime, force),
  sftpUpload: (id, dir) => ipcRenderer.invoke('sftp:upload', id, dir),
  sftpUploadPaths: (id, paths, dir) => ipcRenderer.invoke('sftp:uploadPaths', id, paths, dir),
  sftpTransfers: (id) => ipcRenderer.invoke('sftp:transfers', id),
  sftpClearTransfers: (id) => ipcRenderer.invoke('sftp:clearTransfers', id),

  monitor: (id) => ipcRenderer.invoke('monitor:snapshot', id),

  agentSend: (sessionId, connectionId, text, files) =>
    ipcRenderer.invoke('agent:send', sessionId, connectionId, text, files),
  agentApprove: (askId, allowed, command) => ipcRenderer.invoke('agent:approve', askId, allowed, command),
  agentAbort: (sessionId) => ipcRenderer.invoke('agent:abort', sessionId),
  listModels: (cfg) => ipcRenderer.invoke('llm:models', cfg),
  agentReset: (sessionId) => ipcRenderer.invoke('agent:reset', sessionId),
  agentResume: (sessionId, connectionId, id) => ipcRenderer.invoke('agent:resume', sessionId, connectionId, id),
  agentHistory: (connectionId) => ipcRenderer.invoke('agent:history', connectionId),
  agentHistoryGet: (id) => ipcRenderer.invoke('agent:historyGet', id),
  agentHistoryDelete: (id) => ipcRenderer.invoke('agent:historyDelete', id),
  agentHistoryExport: (id) => ipcRenderer.invoke('agent:historyExport', id),

  setWindowChrome: (bg, fg) => ipcRenderer.invoke('window:chrome', bg, fg),

  // Dropped File objects carry no path in the renderer; only the main process can see it.
  pathForFile: (file) => webUtils.getPathForFile(file),

  pickBackgroundImage: () => ipcRenderer.invoke('theme:pickBackground'),
  backgroundImage: () => ipcRenderer.invoke('theme:background'),
  exportSkill: () => ipcRenderer.invoke('skill:export'),

  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
  importFinalshell: () => ipcRenderer.invoke('import:finalshell'),
  importFinalshellFile: (folderId) => ipcRenderer.invoke('import:finalshellFile', folderId),
  setupPasswordless: (id, secret) => ipcRenderer.invoke('conn:passwordless', id, secret),
  netInterfaces: () => ipcRenderer.invoke('net:interfaces'),
  exportConnections: (passphrase) => ipcRenderer.invoke('conn:export', passphrase),
  exportConnection: (id, passphrase) => ipcRenderer.invoke('conn:exportOne', id, passphrase),
  exportFolder: (id, passphrase) => ipcRenderer.invoke('conn:exportFolder', id, passphrase),
  importConnections: (passphrase, path) => ipcRenderer.invoke('conn:import', passphrase, path),

  onAgentCleared: (cb) => {
    const handler = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('agent:cleared', handler)
    return () => ipcRenderer.removeListener('agent:cleared', handler)
  },

  onStoreChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('store:changed', handler)
    return () => ipcRenderer.removeListener('store:changed', handler)
  },

  closeWindow: () => ipcRenderer.invoke('window:close'),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: (path) => ipcRenderer.invoke('update:install', path),
  updateReleasesUrl: () => ipcRenderer.invoke('update:releasesUrl'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateProgress: (cb) => {
    const handler = (_e: unknown, received: number, total: number): void => cb(received, total)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },

  onSessionEvent: (cb) => {
    const handler = (_e: unknown, ev: SessionEvent): void => cb(ev)
    ipcRenderer.on('session:event', handler)
    return () => ipcRenderer.removeListener('session:event', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
