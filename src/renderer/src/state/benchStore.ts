import { create } from 'zustand'
import type { BenchRequest, BenchResult, BenchRunView, KvCacheType } from '@shared/types.js'
import { useServerStore } from './serverStore.js'

/**
 * Sweep presets.
 *
 * Only settings that measurably change throughput are offered. Sampler settings
 * are deliberately absent: temperature and top-p do not affect speed, so
 * benchmarking them would be measuring noise. Sampler choice is a quality
 * question, and it lives in the chat view.
 */
export interface SweepPreset {
  id: string
  label: string
  description: string
  build: (ctx: { layers: number | null; cpuThreads: number }) => Partial<BenchRequest>
}

export const PRESETS: SweepPreset[] = [
  {
    id: 'flash-attn',
    label: 'Flash attention',
    description: 'On versus off. Usually a clear win, but not on every backend.',
    build: () => ({ flashAttn: ['on', 'off'] })
  },
  {
    id: 'kv-cache',
    label: 'KV cache type',
    description:
      'Quantising the cache frees VRAM for more context — this shows what it costs in speed. ' +
      'Quantised caches require flash attention, so they are measured with it on.',
    build: () => ({ cacheTypes: ['f16', 'q8_0', 'q4_0'] })
  },
  {
    id: 'gpu-layers',
    label: 'GPU offload',
    description: 'How throughput falls as layers move to the CPU.',
    build: ({ layers }) => {
      const total = layers ?? 32
      const steps = [0, Math.round(total * 0.5), Math.round(total * 0.75), total]
      return { gpuLayers: [...new Set(steps)].filter((n) => n >= 0) }
    }
  },
  {
    id: 'threads',
    label: 'CPU threads',
    description: 'Only matters when part of the model runs on the CPU.',
    build: ({ cpuThreads }) => ({
      threads: [...new Set([2, Math.max(2, cpuThreads >> 1), cpuThreads])].sort((a, b) => a - b)
    })
  },
  {
    id: 'ubatch',
    label: 'Batch size',
    description: 'Physical batch size, which mostly affects prompt processing.',
    build: () => ({ ubatch: [128, 256, 512] })
  }
]

interface BenchState {
  run: BenchRunView | null
  selectedPresets: string[]
  nPrompt: number
  nGen: number
  repetitions: number
  error: string | null

  init: () => Promise<void>
  togglePreset: (id: string) => void
  setSizes: (patch: { nPrompt?: number; nGen?: number; repetitions?: number }) => void
  start: () => Promise<void>
  cancel: () => Promise<void>
  applyBest: (result: BenchResult) => void
  clearError: () => void
}

export const useBenchStore = create<BenchState>((set, get) => ({
  run: null,
  selectedPresets: ['flash-attn'],
  nPrompt: 512,
  nGen: 128,
  repetitions: 2,
  error: null,

  async init() {
    try {
      set({ run: await window.llama.bench.state() })
    } catch {
      // No prior run is the normal case.
    }
  },

  togglePreset(id) {
    const current = get().selectedPresets
    set({
      selectedPresets: current.includes(id)
        ? current.filter((p) => p !== id)
        : [...current, id]
    })
  },

  setSizes(patch) {
    set(patch)
  },

  async start() {
    const server = useServerStore.getState()
    const modelPath = server.draft.modelPath
    if (!modelPath) {
      set({ error: 'Choose a model on the Server tab first.' })
      return
    }
    const model = server.models.find((m) => m.path === modelPath)
    const ctx = {
      layers: model?.blockCount ?? null,
      cpuThreads: navigator.hardwareConcurrency || 8
    }

    const request: BenchRequest = {
      modelPath,
      nPrompt: get().nPrompt,
      nGen: get().nGen,
      repetitions: get().repetitions,
      gpuLayers: [],
      threads: [],
      cacheTypes: [],
      flashAttn: [],
      ubatch: []
    }
    for (const id of get().selectedPresets) {
      const preset = PRESETS.find((p) => p.id === id)
      if (preset) Object.assign(request, preset.build(ctx))
    }

    set({ error: null })
    try {
      set({ run: await window.llama.bench.start(request) })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async cancel() {
    try {
      await window.llama.bench.cancel()
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  /**
   * Push a measured configuration into the launch settings. Only the fields the
   * benchmark actually varied are applied — copying an unswept default would
   * silently overwrite a deliberate choice with llama.cpp's fallback.
   */
  applyBest(result) {
    const request = get().run?.request
    if (!request) return
    const server = useServerStore.getState()
    const patch: Record<string, unknown> = {}
    if (request.flashAttn.length) patch['flashAttn'] = result.flashAttn === 'on'
    if (request.cacheTypes.length) {
      patch['cacheTypeK'] = result.cacheTypeK as KvCacheType
      patch['cacheTypeV'] = result.cacheTypeV as KvCacheType
    }
    if (request.gpuLayers.length) {
      patch['gpuLayers'] = result.gpuLayers
      // An explicit offload is a manual decision, so auto-fit has to step aside
      // or llama.cpp would ignore it.
      patch['autoFit'] = false
    }
    if (request.threads.length) patch['threads'] = result.threads
    server.setDraft(patch as never)
  },

  clearError() {
    set({ error: null })
  }
}))

export function subscribeToBench(): () => void {
  return window.llama.bench.onChanged((run) => useBenchStore.setState({ run }))
}

/** The fastest row for a workload, which is what "best" means here. */
export function fastest(results: BenchResult[], kind: BenchResult['kind']): BenchResult | null {
  const rows = results.filter((r) => r.kind === kind)
  if (rows.length === 0) return null
  return rows.reduce((best, r) => (r.tokensPerSecond > best.tokensPerSecond ? r : best))
}
