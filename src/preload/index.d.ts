import type { LlamaGuiApi } from './index.js'

declare global {
  interface Window {
    llama: LlamaGuiApi
  }
}

export {}
