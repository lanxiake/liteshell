# 深空指挥台 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重做信息架构的前提下，为 LiteShell 默认深色壳层与连接/AI·CLI 反馈加上「深空指挥台」机械仪式感，并验收 CLI 操作在 AI 面板实时同步。

**Architecture:** 主题 token 仍由 `THEMES` → `applySettings` 写入 CSS 变量；仪式动效以 CSS 类名驱动。抽出可测纯函数 `src/renderer/src/ceremony.ts`（HUD 文案、工具标签、结果读数解析、步骤卡 DOM 工厂），`main.ts` 的 `setStatus` / `agentStep` / `fillAgentStep` / `renderTree` 只挂类名与调用工厂。不改 CLI socket 与 `cli-trace` 协议，除非验收缺字段。

**Tech Stack:** Electron + TypeScript 渲染进程、现有 `style.css` / `animations.css`、`scripts/test-*.mjs`（esbuild 打纯模块）模式。

## Global Constraints

- 范围：焦点面优先（连接 / AI·CLI / 壳层轻量对齐），不做全壳信息架构重排。
- 气质：深空指挥台 — 近黑、冷青电蓝 accent、细线仪表；禁止厚霓虹与紫色默认脸。
- 主题：保留多主题；只增强默认 `liteshell`；其它主题跟变量，禁止写死色值。
- 动效档位 2：连接 300–600ms；控件按下 1–2px；`prefers-reduced-motion: reduce` 降为瞬时。
- 每个操作要有机械咬合感：短、准、有状态；不挡终端输入、无全屏过场。
- Git：本仓库用户规则要求**仅在用户明确要求时才 commit**；计划中的 Commit 步骤默认跳过，除非用户说「提交」。
- Spec：`docs/superpowers/specs/2026-11-08-command-console-ui-design.md`

---

## File map

| File | Responsibility |
| --- | --- |
| `src/renderer/src/ceremony.ts` | 纯函数：HUD 文案、op 标签、读数解析、步骤卡 DOM |
| `scripts/test-ceremony.mjs` | ceremony 单元测试 |
| `src/renderer/src/main.ts` | 接入 setStatus / tree / agentStep；默认主题 token |
| `src/renderer/src/style.css` | 指挥台壳层、任务卡结构、HUD、舱门 modal |
| `src/renderer/src/animations.css` | 握手序列、进度条、闸门闪、reduced-motion 汇总 |
| `package.json` | 增加 `test:ceremony` script |

---

### Task 1: ceremony 纯模块 + 测试

**Files:**
- Create: `src/renderer/src/ceremony.ts`
- Create: `scripts/test-ceremony.mjs`
- Modify: `package.json`（scripts 增加 `"test:ceremony": "node scripts/test-ceremony.mjs"`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `hudLine(name: string, status: 'connecting' | 'ready' | 'error' | 'closed'): string`
  - `opTag(name: string): string`（如 `exec` → `EXEC`）
  - `parseResultReadout(summary: string): { code: string; ms: string }`
  - `buildAgentStep(name: string, detail: string): HTMLElement`（仅在浏览器/jsdom 环境测结构时可选；本任务先测三个纯函数）

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-ceremony.mjs`（仿 `scripts/test-cli-trace.mjs`：esbuild 打包 `ceremony.ts` 后 import）：

```js
/**
 * 指挥台仪式纯函数。
 *   node scripts/test-ceremony.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-ceremony-'))
let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'ceremony.mjs')
await build({
  entryPoints: ['src/renderer/src/ceremony.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundle,
  logLevel: 'silent'
})
const { hudLine, opTag, parseResultReadout } = await import(`file://${bundle.replaceAll('\\', '/')}`)

check('connecting → HANDSHAKE', hudLine('web-1', 'connecting').includes('HANDSHAKE'))
check('ready → LINK UP', hudLine('web-1', 'ready').includes('LINK UP'))
check('error → LINK FAIL', hudLine('web-1', 'error').includes('LINK FAIL'))
check('closed → LINK DOWN', hudLine('web-1', 'closed').includes('LINK DOWN'))
check('hud 带连接名', hudLine('web-1', 'ready').includes('web-1'))
check('exec → EXEC', opTag('exec') === 'EXEC')
check('upload → UPLOAD', opTag('upload') === 'UPLOAD')
check('读数解析 exit+ms', (() => {
  const r = parseResultReadout('exit=0 · 12 ms\nok')
  return r.code === '0' && r.ms === '12'
})())
check('读数缺 ms 不炸', parseResultReadout('exit=1\nboom').code === '1')

rmSync(work, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node scripts/test-ceremony.mjs
```

Expected: FAIL（找不到 `ceremony.ts` 或 export）

- [ ] **Step 3: 实现 `ceremony.ts`**

```ts
/**
 * 深空指挥台仪式：HUD 文案、工具标签、结果读数。
 * 纯函数，供 main.ts 与 scripts/test-ceremony.mjs 共用。
 */

export type HudStatus = 'connecting' | 'ready' | 'error' | 'closed'

/** 状态栏机械读数行：连接名 + 大写状态码。 */
export function hudLine(name: string, status: HudStatus): string {
  const code =
    status === 'connecting'
      ? 'HANDSHAKE'
      : status === 'ready'
        ? 'LINK UP'
        : status === 'error'
          ? 'LINK FAIL'
          : 'LINK DOWN'
  return `${name} · ${code}`
}

/** 任务卡顶栏等宽标签。 */
export function opTag(name: string): string {
  return (name || 'OP').toUpperCase()
}

/** 从 cli-trace/agent 的 summary 首行解析 exit 与 ms。 */
export function parseResultReadout(summary: string): { code: string; ms: string } {
  const head = (summary || '').split('\n', 1)[0] ?? ''
  const code = /exit=([^\s·]+)/.exec(head)?.[1] ?? '—'
  const ms = /(\d+)\s*ms/.exec(head)?.[1] ?? ''
  return { code, ms }
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node scripts/test-ceremony.mjs
npm pkg set scripts.test:ceremony="node scripts/test-ceremony.mjs"
# 或手工在 package.json scripts 增加 test:ceremony
npm run test:ceremony
```

Expected: 全部 `ok`，exit 0

- [ ] **Step 5: Commit（仅用户要求时）**

```powershell
git add src/renderer/src/ceremony.ts scripts/test-ceremony.mjs package.json
git commit -m "feat: add ceremony helpers for command-console HUD"
```

---

### Task 2: 默认主题 token + 壳层咬合 CSS

**Files:**
- Modify: `src/renderer/src/main.ts`（`THEMES.liteshell.ui` / `term` accent 改为电青）
- Modify: `src/renderer/src/style.css`（`:root` 默认变量、圆角、等宽 HUD、按钮/标签/侧栏按下态）
- Modify: `src/renderer/src/animations.css`（去掉 `.term-prompt` 紫渐变；补 reduced-motion 总闸）

**Interfaces:**
- Consumes: 无新 TS API
- Produces: CSS 变量 `--radius: 5px`、`--font-mono`；默认 accent `#4CC9F0` / accent-dim `#1A6B7A`

- [ ] **Step 1: 更新 `THEMES.liteshell` 色值**

在 `main.ts` 的 `liteshell` 主题中改为（其余键保留）：

```ts
accent: '#4CC9F0',
'accent-dim': '#1A6B7A',
```

同步 `term.cursor`、`term.blue`、`term.selectionBackground` 到同一冷青体系（cursor/blue → `#4CC9F0`，selection → `#1A6B7A`）。**不要改** midnight/nord/其它主题的硬编码表。

- [ ] **Step 2: 更新 `:root` 与壳层交互**

在 `style.css` `:root` 增加/调整：

```css
--radius: 5px;
--font-mono: "Cascadia Mono", "JetBrains Mono", Consolas, "Sarasa Mono SC", monospace;
--accent: #4cc9f0;
--accent-dim: #1a6b7a;
```

为 `.icon-btn`、`.tab`、`.node`、`.tbtn`、button 基类增加：

```css
.icon-btn:active,
.tab:active,
.node:active,
.tbtn:active {
  transform: translateY(1px);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.icon-btn:hover,
.tab:hover,
.node:hover {
  outline: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: -1px;
}
```

`#status-text` / `#status-host` 使用 `font-family: var(--font-mono); letter-spacing: 0.04em; font-size: 12px;`

`.modal` 边框改为 `1px solid color-mix(in srgb, var(--accent) 25%, var(--border))`，圆角用 `var(--radius)`。

- [ ] **Step 3: 收敛 animations.css**

删除或改写 `.term-prompt` 的紫粉渐变（改为单色 `var(--accent)` 或直接删除未使用规则）。

文件末尾增加：

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 4: 手动目视**

```powershell
npm run dev
```

Expected: 默认主题偏冷青；按钮按下有 1px 下沉；主题切换到 Nord 等仍可用。

- [ ] **Step 5: Commit（仅用户要求时）**

---

### Task 3: 连接握手仪式（setStatus + tree + HUD）

**Files:**
- Modify: `src/renderer/src/main.ts`（`setStatus`、`onSessionEvent` 状态文案、`renderTree` / search 命中 connecting）
- Modify: `src/renderer/src/animations.css`（握手扫线、闸门闪、失败微抖；削弱过重 glow）
- Modify: `src/renderer/src/style.css`（`.tab.gate-lock` / `.node.gate-lock` 边框闪）

**Interfaces:**
- Consumes: `hudLine` from `./ceremony`
- Produces: `session.tab` / tree node 类名：`connecting` | `live` | `failed`；就绪时短暂 `gate-lock`

- [ ] **Step 1: 扩展 `setStatus`**

```ts
import { hudLine } from './ceremony'

function setStatus(session: Session, status: SessionStatus): void {
  session.status = status
  session.tab.classList.toggle('connecting', status === 'connecting')
  session.tab.classList.toggle('live', status === 'ready')
  session.tab.classList.toggle('failed', status === 'closed' || status === 'error')
  if (status === 'ready') {
    session.tab.classList.remove('gate-lock')
    // reflow so re-adding restarts the flash animation
    void session.tab.offsetWidth
    session.tab.classList.add('gate-lock')
    window.setTimeout(() => session.tab.classList.remove('gate-lock'), 600)
  }
  if (activeId === session.id) {
    $('#status-text').textContent = hudLine(session.name, status === 'closed' || status === 'error' ? status : status)
  }
}
```

注意：`SessionStatus` 若含其它值，只对四态调用 `hudLine`；`closed`/`error` 映射已在类型内。

同时把 `onSessionEvent` 里现有的：

```ts
$('#status-text').textContent = `${session.name} 已连接`
$('#status-text').textContent = `${session.name} 连接失败`
```

改为依赖 `setStatus` 已写 HUD（删除重复赋值，避免覆盖）。

- [ ] **Step 2: tree 标记 connecting**

在 `renderTree` / `renderTreeSearch` 中，除 `live`/`failed` 外：

```ts
const connecting = !isFolder && [...sessions.values()].some(
  (s) => s.connectionId === item.id && s.status === 'connecting'
)
if (connecting) node.classList.add('connecting')
```

search 命中列表同样处理。

- [ ] **Step 3: CSS 仪式**

`animations.css` — 连接点用细扫而非厚 glow：

```css
@keyframes handshake-scan {
  0% { box-shadow: inset 0 0 0 0 var(--accent); opacity: 0.55; }
  50% { box-shadow: inset 0 0 0 1px var(--accent); opacity: 1; }
  100% { box-shadow: inset 0 0 0 0 var(--accent); opacity: 0.55; }
}

@keyframes gate-lock {
  0% { box-shadow: inset 0 0 0 1px transparent; }
  30% { box-shadow: inset 0 0 0 1px var(--accent); }
  100% { box-shadow: inset 0 0 0 1px transparent; }
}

.tab.connecting .tdot,
.node.connecting .dot {
  animation: handshake-scan 0.45s ease-in-out infinite;
  background: color-mix(in srgb, var(--accent) 70%, var(--text-faint));
}

.tab.gate-lock,
.node.live.gate-lock {
  animation: gate-lock 0.55s ease-out;
}
```

把现有 `.node.live .dot` / `.tab.live .tdot` 的厚 `box-shadow: 0 0 6px` 改为细 `0 0 0 1px` 或去掉外发光。失败保留短 `shake`（已被 reduced-motion 总闸覆盖）。

- [ ] **Step 4: 手动验收**

`npm run dev` → 双击连接：状态栏见 `HANDSHAKE` → `LINK UP`；标签点脉冲后点亮；失败见 `LINK FAIL` + 红点。

- [ ] **Step 5: Commit（仅用户要求时）**

---

### Task 4: AI / CLI 任务卡机械语言

**Files:**
- Modify: `src/renderer/src/ceremony.ts`（增加 `buildAgentStep` / `completeAgentStep`）
- Modify: `scripts/test-ceremony.mjs`（用 linkedom 或最小手写 DOM mock — **若引入依赖过重则跳过 DOM 测试，只在注释说明改由手动验收**；本仓库无 jsdom，采用 **字符串/结构约定 + 手动**）
- Modify: `src/renderer/src/main.ts`（`agentStep` / `fillAgentStep` 委托 ceremony）
- Modify: `src/renderer/src/style.css` / `animations.css`（标签、左侧进度条、读数）

**Interfaces:**
- Consumes: `opTag`, `parseResultReadout`
- Produces:
  - `buildAgentStep(name: string, detail: string): HTMLElement`
  - `completeAgentStep(step: HTMLElement, ok: boolean, summary: string): void`

- [ ] **Step 1: 扩展 ceremony DOM 工厂**

```ts
/** 构建可折叠任务卡：标签 + 明细 + 执行中进度轨。 */
export function buildAgentStep(name: string, detail: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'agent-step folded running'
  box.dataset.op = name

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'agent-step-head'
  head.title = `${name}\n${detail}\n\n点开看完整输出`

  const tag = document.createElement('span')
  tag.className = 'agent-op-tag'
  tag.textContent = opTag(name)

  const label = document.createElement('span')
  label.className = 'agent-op-detail'
  label.textContent = detail.startsWith(name) ? detail : detail

  const readout = document.createElement('span')
  readout.className = 'agent-op-readout'
  readout.hidden = true

  head.append(tag, label, readout)

  const rail = document.createElement('div')
  rail.className = 'agent-step-rail'
  rail.setAttribute('aria-hidden', 'true')

  const body = document.createElement('div')
  body.className = 'agent-step-body'

  head.addEventListener('click', () => box.classList.toggle('folded'))
  box.append(rail, head, body)
  return box
}

/** 结束执行态，填入输出与机械读数。 */
export function completeAgentStep(step: HTMLElement, ok: boolean, summary: string): void {
  step.classList.remove('running')
  step.classList.toggle('bad', !ok)
  const body = step.querySelector('.agent-step-body')
  if (body) body.textContent = summary || '（无输出）'
  const readout = step.querySelector('.agent-op-readout') as HTMLElement | null
  if (readout) {
    const { code, ms } = parseResultReadout(summary)
    readout.hidden = false
    readout.textContent = ms ? `exit=${code} · ${ms}ms` : `exit=${code}`
  }
  if (!ok) step.classList.remove('folded')
}
```

扩展测试（纯函数部分）：

```js
check('opTag monitor', opTag('monitor') === 'MONITOR')
check('读数无 exit 给破折号', parseResultReadout('完成').code === '—')
```

- [ ] **Step 2: 替换 main.ts 中的 agentStep / fillAgentStep**

```ts
import { buildAgentStep, completeAgentStep } from './ceremony'

function agentStep(name: string, detail: string): HTMLElement {
  return buildAgentStep(name, detail)
}

function fillAgentStep(step: HTMLElement, ok: boolean, text: string): void {
  completeAgentStep(step, ok, text)
}
```

`case 'compact'` 的摘要卡可保持手写，或加 `agent-op-tag` 文案 `COMPACT`（可选，非必须）。

- [ ] **Step 3: 任务卡 CSS**

```css
.agent-step {
  position: relative;
  border-left: 2px solid var(--border);
  border-radius: 0 var(--radius) var(--radius) 0;
  padding-left: 4px;
}

.agent-step-rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--border);
  overflow: hidden;
}

.agent-step.running .agent-step-rail::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 40%;
  background: var(--accent);
  animation: rail-travel 0.9s linear infinite;
}

@keyframes rail-travel {
  from { transform: translateY(-100%); }
  to { transform: translateY(250%); }
}

.agent-step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 保留原等宽字体与 ellipsis：.agent-op-detail 承担省略 */
}

.agent-op-tag {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  padding: 0 5px;
  border-radius: 2px;
}

.agent-op-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-op-readout {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
}

.agent-step.bad .agent-op-tag {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
}
```

调整原 `.agent-step-head::before` 折叠三角，避免与 flex 冲突（可改到 `.agent-op-detail::before` 或保留在 head 最前）。

- [ ] **Step 4: 跑测试 + 手动**

```powershell
npm run test:ceremony
npm run typecheck
```

UI：内置 AI 跑一条只读命令，见 `EXEC` 标签 + 左侧轨动画 + 完成后读数。

- [ ] **Step 5: Commit（仅用户要求时）**

---

### Task 5: 弹层舱门 + CLI 同步验收

**Files:**
- Modify: `src/renderer/src/style.css` / `animations.css`（`#overlay` / `.modal` 入场）
- Verify: `skills/liteshell/bin/liteshell-cli.mjs`、运行中的 LiteShell
- Run: `npm run test:cli-trace`、`npm run test:skill`、手动 CLI

**Interfaces:**
- Consumes: 既有 CLI 轨迹；Task 4 卡片
- Produces: 验收记录（可写在 PR/聊天回复，不必改协议）

- [ ] **Step 1: Modal 舱门动效**

```css
@keyframes hatch-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

#overlay:not([hidden]) {
  background: color-mix(in srgb, #000 55%, transparent);
}

#overlay:not([hidden]) .modal {
  animation: hatch-in 0.22s ease-out;
}
```

- [ ] **Step 2: 回归纯测**

```powershell
npm run test:ceremony
npm run test:cli-trace
npm run test:skill
npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 3: CLI 实时同步（LiteShell 必须已开）**

```powershell
$CLI = "e:\my-project\liteshell\skills\liteshell\bin\liteshell-cli.mjs"
node $CLI conns
# 从 JSON 取一条连接名，例如 "开发环境"
node $CLI exec "开发环境" "uname -a" --intent "看看这台机器是什么系统" --say "读取内核与主机信息"
```

Expected（对照打开的 LiteShell AI 面板）：

1. 出现 CLI 来源的用户 intent 抬头（同 intent 不重复刷）。
2. `assistant interim cli` 显示 say 文案。
3. `EXEC` 任务卡 running → 完成后 readout + 可折叠输出。
4. 对应连接标签变为 live（若原先未连则会握手）。

若 `app_not_running`：先启动 `npm run dev` 或已安装的 LiteShell，再重试，不改协议。

- [ ] **Step 4: 把验收结果写回对话（成功/失败与截图要点）**

- [ ] **Step 5: Commit（仅用户要求时）** — 可含 spec/plan 文档一并提交

---

## Spec coverage self-check

| Spec 项 | Task |
| --- | --- |
| 深空 token / 默认主题增强 | Task 2 |
| 多主题保留、变量跟随 | Task 2（只改 liteshell） |
| 连接握手 HUD + 闸门 | Task 3 |
| AI/CLI 任务卡标签/进度/读数 | Task 4 |
| 壳层咬合 + modal 舱门 | Task 2 + Task 5 |
| reduced-motion | Task 2 |
| 不做全屏过场 / 不改 SSH·CLI 协议 | 全局约束 |
| CLI `--intent/--say` 同步验收 | Task 5 |
| ceremony 可测 | Task 1 |

## Placeholder / 一致性自检

- 无 TBD；`hudLine` / `opTag` / `buildAgentStep` / `completeAgentStep` 命名前后一致。
- Commit 步骤默认跳过（用户 git 规则）。
- DOM 任务卡不强制 jsdom 依赖，验收以 typecheck + 手动 + CLI 为准。
