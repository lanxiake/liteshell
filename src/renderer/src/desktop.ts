import type { DesktopEmbeddedInfo } from '../../shared/types'

declare const api: import('../../shared/types').Api

/** PS/2 set 1 scancodes for `KeyboardEvent.code`. Extended keys carry 0xE0,
 *  which the WASM client understands. Same table as the IronRDP example. */
const SCANCODE: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04,
  Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17,
  KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b,
  Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21,
  KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25,
  KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f,
  KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33,
  Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e,
  F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42,
  F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, F11: 0x57, F12: 0x58,
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035,
  PrintScreen: 0xe037, AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048,
  PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f,
  ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053,
  MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d, Pause: 0xe11d45
}

function el(tag: string, cls = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text) node.textContent = text
  return node
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object' && '__wbg_ptr' in err) {
    try {
      const kinds = [
        'General', 'WrongPassword', 'LogonFailure', 'AccessDenied',
        'RDCleanPath', 'ProxyConnect', 'NegotiationFailure'
      ]
      const kind = (err as unknown as { kind(): number }).kind()
      const trace = (err as unknown as { backtrace(): string }).backtrace() ?? ''
      return `[${kinds[kind] ?? kind}] ${trace.split('\n').slice(0, 3).join(' ')}`
    } catch {
      // not an IronError after all
    }
  }
  return err instanceof Error ? err.message : String(err)
}

/** The whole page of a `?desktop=` window: a canvas, a status strip, and the
 *  WASM RDP client. The main process has already opened the tunnel and proxy. */
export async function bootDesktopWindow(id: string): Promise<void> {
  document.body.classList.add('desktop-popout')

  const info = await api.desktopAttach(id)
  if (!info) {
    document.body.append(el('div', 'desktop-error', '远程桌面会话不存在或已关闭'))
    return
  }

  const head = el('header', 'desktop-head')
  const title = el('span', 'desktop-title', `远程桌面 — ${info.name}`)
  const status = el('span', 'desktop-status', '准备中…')
  const fullscreen = el('button', 'desktop-btn', '⛶')
  const close = el('button', 'desktop-btn', '×')
  fullscreen.title = '全屏'
  close.title = '关闭'
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => undefined)
  })
  close.addEventListener('click', () => void api.closeWindow())
  head.append(title, status, el('span', 'desktop-spacer'), fullscreen, close)

  const stage = el('div', 'desktop-stage')
  const canvas = document.createElement('canvas')
  canvas.tabIndex = 0
  canvas.className = 'desktop-canvas'
  stage.append(canvas)

  const error = el('div', 'desktop-error')
  error.hidden = true
  stage.append(error)

  const retry = el('button', 'desktop-retry', '重新连接')
  retry.hidden = true
  retry.addEventListener('click', () => location.reload())
  stage.append(retry)

  document.body.append(head, stage)

  let session: import('ironrdp-wasm').Session | null = null
  let ended = false

  const setStatus = (text: string): void => {
    status.textContent = text
  }
  const fail = (message: string): void => {
    setStatus('连接失败')
    error.textContent = message
    error.hidden = false
    retry.hidden = false
  }

  window.addEventListener('beforeunload', () => {
    ended = true
    try {
      session?.shutdown()
    } catch {
      // already gone
    }
  })

  try {
    setStatus('加载 RDP 组件…')
    const wasm = await import('ironrdp-wasm')
    await wasm.default()
    wasm.setup('warn')

    const dpr = window.devicePixelRatio || 1
    const width = Math.max(640, Math.round(stage.clientWidth * dpr))
    const height = Math.max(480, Math.round(stage.clientHeight * dpr))

    const builder = new wasm.SessionBuilder()
    builder.username(info.username)
    builder.password(info.password)
    // The proxy ignores this host and forwards to the remote's loopback; the
    // shape is what RDCleanPath expects.
    builder.destination(`127.0.0.1:${info.port}`)
    builder.proxyAddress(info.url)
    // The token is both the URL path and the request's proxy_auth.
    builder.authToken(new URL(info.url).pathname.slice(1))
    builder.desktopSize(new wasm.DesktopSize(width, height))
    builder.renderCanvas(canvas)
    builder.extension(new wasm.Extension('enable_credssp', true))
    builder.setCursorStyleCallbackContext(canvas)
    builder.setCursorStyleCallback((style: string) => {
      canvas.style.cursor = style || 'default'
    })

    setupClipboard(builder, wasm.ClipboardData, () => session)

    setStatus('正在连接…')
    session = await builder.connect()
    const size = session.desktopSize()
    canvas.width = size.width
    canvas.height = size.height
    setStatus(`已连接 ${size.width}×${size.height}`)
    canvas.focus()

    setupInput(canvas, session, wasm.DeviceEvent, wasm.InputTransaction, wasm.RotationUnit)

    void session
      .run()
      .then((end) => {
        if (ended) return
        setStatus('已断开')
        fail(`会话结束：${end.reason()}`)
      })
      .catch((err: unknown) => {
        if (ended) return
        setStatus('已断开')
        fail(formatError(err))
      })
  } catch (err) {
    fail(formatError(err))
  }
}

function setupInput(
  canvas: HTMLCanvasElement,
  session: import('ironrdp-wasm').Session,
  DeviceEvent: typeof import('ironrdp-wasm').DeviceEvent,
  InputTransaction: typeof import('ironrdp-wasm').InputTransaction,
  RotationUnit: typeof import('ironrdp-wasm').RotationUnit
): void {
  const apply = (event: import('ironrdp-wasm').DeviceEvent): void => {
    try {
      const tx = new InputTransaction()
      tx.addEvent(event)
      session.applyInputs(tx)
    } catch {
      // a closed session rejects input; nothing useful to do
    }
  }

  canvas.addEventListener('keydown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const code = SCANCODE[e.code]
    if (code !== undefined) apply(DeviceEvent.keyPressed(code))
  })
  canvas.addEventListener('keyup', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const code = SCANCODE[e.code]
    if (code !== undefined) apply(DeviceEvent.keyReleased(code))
  })

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = Math.round(((e.clientX - rect.left) * canvas.width) / rect.width)
    const y = Math.round(((e.clientY - rect.top) * canvas.height) / rect.height)
    apply(DeviceEvent.mouseMove(x, y))
  })
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault()
    canvas.focus()
    apply(DeviceEvent.mouseButtonPressed(e.button))
  })
  canvas.addEventListener('mouseup', (e) => {
    e.preventDefault()
    apply(DeviceEvent.mouseButtonReleased(e.button))
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      if (e.deltaY !== 0) {
        apply(DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, RotationUnit.Line))
      }
      if (e.deltaX !== 0) {
        apply(DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, RotationUnit.Line))
      }
    },
    { passive: false }
  )
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('blur', () => {
    try {
      session.releaseAllInputs()
    } catch {
      // session already closed
    }
  })
}

/** Text-only clipboard sync. Reading the local clipboard can be refused by the
 *  browser; the failure is harmless, so it is swallowed. */
function setupClipboard(
  builder: import('ironrdp-wasm').SessionBuilder,
  ClipboardData: typeof import('ironrdp-wasm').ClipboardData,
  session: () => { onClipboardPaste(data: unknown): Promise<void> } | null
): void {
  builder.remoteClipboardChangedCallback(async (data: import('ironrdp-wasm').ClipboardData) => {
    try {
      if (!data || data.isEmpty()) return
      for (const item of data.items()) {
        if (!item.mimeType().startsWith('text/')) continue
        const value = item.value()
        const text =
          typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array)
        await navigator.clipboard.writeText(text)
        return
      }
    } catch {
      // clipboard permission or a closed channel
    }
  })

  builder.forceClipboardUpdateCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      const data = new ClipboardData()
      if (text) data.addText('text/plain', text)
      await session()?.onClipboardPaste(data)
    } catch {
      // clipboard permission or a closed channel
    }
  })
}
