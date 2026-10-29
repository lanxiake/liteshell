# 第三方代码与许可

LiteShell 自身以 MIT 许可发布（见 [LICENSE](LICENSE)）。下面是随程序分发、或改写后纳入源码的第三方代码。
其余 npm 依赖的许可见各自包内的 `LICENSE`。

## 内嵌远程桌面

### IronRDP / ironrdp-wasm 1.2.0

- 用途：渲染进程里的 RDP 客户端（WebAssembly），把远程桌面画到 `<canvas>`
- 来源：<https://github.com/electerm/ironrdp-wasm>
- 许可：MIT，Copyright (c) 2026 Marc-André Moreau
- 分发形式：`node_modules/ironrdp-wasm`；构建时内联进渲染进程 bundle

### tabby-rdp 0.5.7

- 用途：RDCleanPath WebSocket 代理，改写后放在 `src/main/rdp/`
- 来源：<https://github.com/meanaverage/tabby-rdp>
- 许可：MIT，Copyright (c) 2026 meanaverage
- 改写：`dist/rdcleanpath.js` → `src/main/rdp/rdcleanpath.ts`，`dist/byteQueue.js` →
  `src/main/rdp/byte-queue.ts`。传输层改为 SSH `direct-tcpip` 通道，移除来源白名单和证书名称校验，
  其余协议与背压逻辑保持上游实现

### ws 8.21.3

- 用途：内嵌 RDP 代理的本地 WebSocket 服务
- 来源：<https://github.com/websockets/ws>
- 许可：MIT，Copyright (c) 2011 Einar Otto Stangvik、2013 Arnout Kazemier and contributors、
  2016 Luigi Pinca and contributors

## MIT 许可全文

以下许可适用于上面列出的第三方代码。

```text
MIT License

Copyright (c) 2026 Marc-André Moreau
Copyright (c) 2026 meanaverage
Copyright (c) 2011 Einar Otto Stangvik
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
