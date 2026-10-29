import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    build: {
      // IronRDP ships a 4 MB .wasm served as an asset; under `file://` the
      // client's fetch() cannot read an ordinary asset URL, so inline it as a
      // data: URL (allowed by the page's CSP) instead of emitting a file.
      assetsInlineLimit: (file) => (file.endsWith('.wasm') ? true : undefined)
    }
  }
})
