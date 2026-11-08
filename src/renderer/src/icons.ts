/**
 * 指挥台线框图标：统一 stroke 几何形，替代 emoji。
 * viewBox 固定 24，调用方用 CSS 控制尺寸与颜色（currentColor）。
 */

export type IconName =
  | 'side'
  | 'theme'
  | 'log'
  | 'command'
  | 'key'
  | 'keyboard'
  | 'settings'
  | 'folder'
  | 'plus'
  | 'close'
  | 'files'
  | 'monitor'
  | 'agent'
  | 'history'
  | 'search'
  | 'clear'
  | 'disconnect'
  | 'back'
  | 'refresh'
  | 'upload'
  | 'edit'
  | 'copy'
  | 'more'
  | 'expand'
  | 'popout'
  | 'send'
  | 'stop'
  | 'import'
  | 'dot'

/** 各图标的 path/line 片段（已置于 24×24 坐标系）。 */
const PATHS: Record<IconName, string> = {
  side: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  theme:
    '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16"/>',
  log: '<path d="M6 5h12v14H6z"/><path d="M9 9h6M9 12h6M9 15h4"/>',
  command: '<path d="M8 8l-3 4 3 4M16 8l3 4-3 4M13 6l-2 12"/>',
  key: '<circle cx="8" cy="12" r="3"/><path d="M11 12h9v3M17 12v3"/>',
  keyboard:
    '<rect x="3" y="7" width="18" height="11" rx="1"/><path d="M7 11h.01M10 11h.01M13 11h.01M16 11h.01M8 15h8"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M4.9 6.5l1.4 1.4M17.7 16.1l1.4 1.4M3 12h2M19 12h2M4.9 17.5l1.4-1.4M17.7 7.9l1.4-1.4"/>',
  folder: '<path d="M3 8h6l2 2h10v9H3z"/><path d="M3 8V6h5l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  files: '<path d="M4 5h7l2 2h7v12H4z"/><path d="M8 13h8M8 16h5"/>',
  monitor:
    '<path d="M4 16V8h16v8H4z"/><path d="M7 19h10"/><path d="M8 12l2-3 3 4 2-2 3 3"/>',
  agent:
    '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><circle cx="12" cy="12" r="2.2"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  clear: '<path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12"/>',
  disconnect: '<path d="M8 12h8M7 9v6M17 9v6M5 12H3M21 12h-2"/>',
  back: '<path d="M14 6l-6 6 6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  upload: '<path d="M12 16V6M8 10l4-4 4 4"/><path d="M5 18h14"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
  copy: '<rect x="8" y="8" width="11" height="11"/><path d="M5 16V5h11"/>',
  more: '<circle cx="12" cy="6" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18" r="1.2"/>',
  expand: '<path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4"/>',
  popout: '<path d="M10 5H5v14h14v-5"/><path d="M12 12l7-7M14 5h5v5"/>',
  send: '<path d="M5 19l14-7L5 5v5l8 2-8 2z"/>',
  stop: '<rect x="7" y="7" width="10" height="10"/>',
  import: '<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 18h14"/>',
  dot: '<rect x="10" y="10" width="4" height="4"/>'
}

/**
 * 生成单个 SVG 图标节点。
 */
export function icon(name: IconName, className = 'ui-icon'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (className) svg.setAttribute('class', className)
  svg.innerHTML = PATHS[name]
  return svg
}

/**
 * 清空元素并用图标（可选后缀文字）重建内容。
 */
export function setIcon(el: HTMLElement, name: IconName, label = ''): void {
  el.replaceChildren(icon(name))
  if (label) {
    const span = document.createElement('span')
    span.className = 'ui-icon-label'
    span.textContent = label
    el.append(span)
  }
}

/**
 * 根据 data-icon 给标题栏 / 侧栏静态按钮挂上图标。
 */
export function mountChromeIcons(): void {
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName | undefined
    if (!name || !(name in PATHS)) return
    const keepText = el.dataset.iconLabel === '1'
    const label = keepText ? (el.textContent || '').trim() : ''
    setIcon(el, name, label)
  })
}
