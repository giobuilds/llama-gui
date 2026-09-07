import { create } from 'zustand'
import type {
  BinaryInfo,
  GpuDevice,
  LaunchConfig,
  LogLine,
  ModelEntryView,
  ServerStatus,
  VramPlanView
} from '@shared/types.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'

const MAX_RENDERED_LOGS = 2000

interface ServerState {
  status: ServerStatus | null
  binary: BinaryInfo | null
  binaries: BinaryInfo[]
  devices: GpuDevice[]
  models: ModelEntryView[]
  modelsLoading: boolean
  plan: VramPlanView | null
  logs: LogLine[]
  lastSeq: number
  draft: LaunchConfig
  busy: boolean
  error: string | null

  init: () => Promise<void>
  selectBinary: (path: string) => Promise<void>
  loadModels: (force?: boolean) => Promise<void>
  addModelDir: () => Promise<void>
  refreshPlan: () => Promise<void>
  pullLogs: () => Promise<void>
  setDraft: (patch: Partial<LaunchConfig>) => void
  start: () => Promise<void>
  stop: () => Promise<void>
  refreshDevices: () => Promise<void>
  clearError: () => void
}

export const useServerStore = create<ServerState>((set, get) => ({
  status: null,
  binary: null,
  binaries: [],
  devices: [],
  models: [],
  modelsLoading: false,
  plan: null,
  logs: [],
  lastSeq: 0,
  draft: { modelPath: '', ...DEFAULT_LAUNCH_CONFIG },
  busy: false,
  error: null,

  async init() {
    const [status, binary, binaries] = await Promise.all([
      window.llama.server.status(),
      window.llama.binary.info(),
      window.llama.binary.list()
    ])
    set({ status, binary, binaries, devices: binary.devices })
    // Adopting a running server means its config is the truth, not our defaults.
    if (status.config) set({ draft: status.config })
    await Promise.all([get().pullLogs(), get().loadModels()])
  },

  async loadModels(force = false) {
    set({ modelsLoading: true })
    try {
      const models = force ? await window.llama.models.rescan() : await window.llama.models.list()
      set({ models })
      // A model may already be selected (adopted server, restored draft), so the
      // plan is refreshed as soon as the library is known.
      if (get().draft.modelPath) await get().refreshPlan()
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ modelsLoading: false })
    }
  },

  async addModelDir() {
    try {
      const dir = await window.llama.dialog.pickModelDir()
      if (dir) await get().loadModels(true)
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async refreshPlan() {
    const { draft } = get()
    if (!draft.modelPath) {
      set({ plan: null })
      return
    }
    try {
      set({
        plan: await window.llama.models.plan({
          modelPath: draft.modelPath,
          gpuLayers: draft.gpuLayers,
          contextSize: draft.contextSize || 4096,
          cacheTypeK: draft.cacheTypeK,
          cacheTypeV: draft.cacheTypeV,
          parallel: draft.parallel
        })
      })
    } catch {
      // A file outside the scanned library cannot be planned for; the UI just
      // hides the estimate rather than showing an error for it.
      set({ plan: null })
    }
  },

  async pullLogs() {
    const fresh = await window.llama.logs.since(get().lastSeq)
    if (fresh.length === 0) return
    set((s) => {
      const logs = [...s.logs, ...fresh]
      return {
        logs: logs.length > MAX_RENDERED_LOGS ? logs.slice(-MAX_RENDERED_LOGS) : logs,
        lastSeq: fresh[fresh.length - 1]!.seq
      }
    })
  },

  async selectBinary(path) {
    set({ busy: true, error: null })
    try {
      const binary = await window.llama.binary.select(path)
      set({ binary, devices: binary.devices })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  setDraft(patch) {
    set((s) => ({ draft: { ...s.draft, ...patch } }))
    // Every knob in the panel changes the VRAM estimate, so it is recomputed
    // rather than only on launch.
    void get().refreshPlan()
  },

  async start() {
    const { draft } = get()
    if (!draft.modelPath) {
      set({ error: 'Choose a .gguf model first.' })
      return
    }
    set({ busy: true, error: null })
    try {
      set({ status: await window.llama.server.start(draft) })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  async stop() {
    set({ busy: true, error: null })
    try {
      set({ status: await window.llama.server.stop() })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  async refreshDevices() {
    try {
      set({ devices: await window.llama.binary.devices() })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  clearError() {
    set({ error: null })
  }
}))

/** Wire the push events from main into the store. Called once at mount. */
export function subscribeToMain(): () => void {
  const store = useServerStore
  const offStatus = window.llama.server.onStatus((status) => {
    store.setState({ status })
  })
  const offLogs = window.llama.logs.onChanged(() => {
    void store.getState().pullLogs()
  })
  return () => {
    offStatus()
    offLogs()
  }
}
