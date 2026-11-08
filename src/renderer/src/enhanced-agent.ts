/**
 * Enhanced Agent UI - 增强版 AI 对话动效
 * 为录屏演示增加打字机效果、淡入动画和视觉反馈
 */

/**
 * 用户消息打字机效果（15ms/字）
 */
export function typewriterEffect(element: HTMLElement, text: string, speed = 15): Promise<void> {
  return new Promise((resolve) => {
    element.textContent = ''
    element.classList.add('typewriter-active')
    let index = 0
    
    const timer = setInterval(() => {
      if (index < text.length) {
        element.textContent += text[index]
        index++
      } else {
        clearInterval(timer)
        element.classList.remove('typewriter-active')
        resolve()
      }
    }, speed)
  })
}

/**
 * AI 回复消息淡入上浮效果
 */
export function fadeUpAnimation(element: HTMLElement): void {
  element.classList.add('agent-message', 'incoming')
  // 动画由 CSS animations.css 定义
}

/**
 * 命令执行中状态显示
 */
export function showExecutingStatus(container: HTMLElement, command: string): HTMLElement {
  const status = document.createElement('div')
  status.className = 'executing-status'
  status.innerHTML = `
    <span class="loading-spinner"></span>
    <span>执行中：${command}</span>
  `
  container.appendChild(status)
  return status
}

/**
 * 移除执行状态
 */
export function hideExecutingStatus(statusElement: HTMLElement): void {
  statusElement.classList.add('fade-out')
  setTimeout(() => statusElement.remove(), 300)
}

/**
 * 命令结果展示（成功/失败）
 */
export function showCommandResult(
  container: HTMLElement,
  success: boolean,
  output: string
): HTMLElement {
  const result = document.createElement('div')
  result.className = `command-result ${success ? 'success' : 'error'}`
  result.textContent = output
  container.appendChild(result)
  return result
}

/**
 * 表格结果渲染（带淡入效果）
 */
export function renderTableResult(
  container: HTMLElement,
  headers: string[],
  rows: string[][]
): HTMLElement {
  const table = document.createElement('table')
  table.className = 'command-table'
  
  // 表头
  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')
  headers.forEach(h => {
    const th = document.createElement('th')
    th.textContent = h
    headerRow.appendChild(th)
  })
  thead.appendChild(headerRow)
  table.appendChild(thead)
  
  // 表体
  const tbody = document.createElement('tbody')
  rows.forEach(row => {
    const tr = document.createElement('tr')
    row.forEach(cell => {
      const td = document.createElement('td')
      td.textContent = cell
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
  })
  table.appendChild(tbody)
  
  container.appendChild(table)
  return table
}

/**
 * 连接状态视觉反馈
 */
export function updateConnectionStatus(
  nodeElement: HTMLElement,
  status: 'connecting' | 'connected' | 'failed'
): void {
  nodeElement.classList.remove('connecting', 'live', 'failed')
  
  switch (status) {
    case 'connecting':
      nodeElement.classList.add('connecting')
      break
    case 'connected':
      nodeElement.classList.add('live')
      // 成功动画：缩放弹跳
      setTimeout(() => {
        const dot = nodeElement.querySelector('.dot')
        if (dot) {
          dot.classList.add('bounce-once')
          setTimeout(() => dot.classList.remove('bounce-once'), 600)
        }
      }, 50)
      break
    case 'failed':
      nodeElement.classList.add('failed')
      // 失败动画：抖动
      setTimeout(() => {
        nodeElement.classList.add('shake-once')
        setTimeout(() => nodeElement.classList.remove('shake-once'), 300)
      }, 50)
      break
  }
}

/**
 * 终端输出高亮处理（路径、数字、错误关键词）
 */
export function highlightTerminalOutput(text: string): string {
  let result = text
  
  // 高亮文件路径（/path/to/file 或 C:\path\to\file）
  result = result.replace(
    /(\/[\w\-\.\/]+|[A-Z]:\\[\w\-\.\\]+)/g,
    '<span class="term-path">$1</span>'
  )
  
  // 高亮数字
  result = result.replace(
    /\b(\d+(?:\.\d+)?(?:GB|MB|KB|B|%)?)\b/gi,
    '<span class="term-number">$1</span>'
  )
  
  // 高亮错误关键词
  result = result.replace(
    /\b(error|failed|denied|fatal|panic|exception)\b/gi,
    '<span class="term-error">$1</span>'
  )
  
  return result
}

/**
 * 添加背景微粒效果
 */
export function addParticlesBackground(container: HTMLElement): void {
  const particles = document.createElement('div')
  particles.className = 'particles-bg'
  container.prepend(particles)
}

/**
 * 渐变色命令提示符
 */
export function createGradientPrompt(user: string, host: string): string {
  return `<span class="term-prompt">${user}@${host} $</span> `
}
