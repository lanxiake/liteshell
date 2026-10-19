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
  attachSession: (id) => ipcRenderer.invoke('session:attach', id),
  releaseSession: (id) => ipcRenderer.invoke('session:release', id),
  popOutSession: (id, connectionId) => ipcRenderer.invoke('session:popOut', id, connectionId),

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

  setWindowChrome: (bg, fg) => ipcRenderer.invoke('window:chrome', bg, fg),

  // Dropped File objects carry no path in the renderer; only the main process can see it.
  pathForFile: (file) => webUtils.getPathForFile(file),

  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
  importFinalshell: () => ipcRenderer.invoke('import:finalshell'),
  importFinalshellFile: (folderId) => ipcRenderer.invoke('import:finalshellFile', folderId),
  exportConnections: (passphrase) => ipcRenderer.invoke('conn:export', passphrase),
  exportConnection: (id, passphrase) => ipcRenderer.invoke('conn:exportOne', id, passphrase),
  exportFolder: (id, passphrase) => ipcRenderer.invoke('conn:exportFolder', id, passphrase),
  importConnections: (passphrase, path) => ipcRenderer.invoke('conn:import', passphrase, path),

  onSessionEvent: (cb) => {
    const handler = (_e: unknown, ev: SessionEvent): void => cb(ev)
    ipcRenderer.on('session:event', handler)
    return () => ipcRenderer.removeListener('session:event', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
