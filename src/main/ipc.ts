import { ipcMain, dialog, BrowserWindow } from 'electron'
import { ZodError } from 'zod'
import type {
  BenchRunView,
  BinaryInfo,
  ConversationSummaryView,
  ConversationView,
  DownloadJob,
  FitSuggestion,
  HfFile,
  HfModel,
  RemoteFit,
  GpuDevice,
  HealthCheckResult,
  LaunchProfileView,
  IpcResponse,
  LogLine,
  ModelEntryView,
  ServerStatus,
  VramPlanView
} from '@shared/types.js'
import { IPC } from '@shared/ipc.js'
import { launchConfigSchema } from '@shared/schema.js'
import type { ServerSupervisor } from './supervisor.js'
import { probeBinary, readDevices } from './probe.js'
import { scanModels, defaultModelDirs, type ModelEntry } from './registry.js'
import { planVram } from './planner.js'
import { fitParams } from './fit.js'
import { runHealthCheck } from './health.js'
import { conversationSchema, type ConversationStore } from './conversations.js'
import type { ProfileStore } from './profiles.js'
import { searchModels, listRepoFiles, type DownloadManager } from './downloads.js'
import { estimateRepoFit } from './remoteFit.js'
import { BenchRunner } from './bench.js'
import { benchRequestSchema } from '@shared/schema.js'
import { downloadRequestSchema } from '@shared/schema.js'
import { planRequestSchema, healthCheckRequestSchema } from '@shared/schema.js'
import type { SettingsStore } from './settings.js'

/** Wrap a handler so a thrown error becomes a typed failure instead of an opaque IPC rejection. */
function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResponse<T>> => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  })
}

/**
 * A raw ZodError serialises to an unreadable JSON blob. The UI shows this string
 * verbatim, so it is flattened into "field: reason" here.
 */
function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
      .join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

export function registerIpc(
  supervisor: ServerSupervisor,
  settings: SettingsStore,
  conversations: ConversationStore,
  profiles: ProfileStore,
  downloads: DownloadManager,
  /** Every llama.cpp install found at startup, best first. */
  discovered: BinaryInfo[]
): void {
  handle<ServerStatus>(IPC.serverStatus, () => supervisor.status)

  handle<ServerStatus>(IPC.serverStart, async (raw) => {
    // Renderer input reaches a process spawn, so it is validated, not trusted.
    const config = launchConfigSchema.parse(raw)
    await supervisor.start(config)
    return supervisor.status
  })

  handle<ServerStatus>(IPC.serverStop, async () => {
    await supervisor.stop()
    return supervisor.status
  })

  handle<LogLine[]>(IPC.logsSince, (afterSeq) => {
    const seq = typeof afterSeq === 'number' && Number.isFinite(afterSeq) ? afterSeq : 0
    return supervisor.logs.since(seq)
  })

  handle<BinaryInfo>(IPC.binaryInfo, () => supervisor.binaryInfo)

  /**
   * Both shapes of llama.cpp are reported, not just the chosen one: a machine
   * can have a current `llama serve` alongside a stale distro `llama-server`,
   * and the user is the one who should decide which to drive.
   */
  handle<BinaryInfo[]>(IPC.binaryList, () => discovered)

  handle<BinaryInfo>(IPC.binarySelect, async (rawPath) => {
    const path = String(rawPath ?? '')
    // Re-probe rather than trusting the cached entry: the binary may have been
    // replaced (an update) since startup.
    const known = discovered.find((b) => b.path === path)
    const info = await probeBinary({ path, kind: known?.kind ?? 'unified' })
    supervisor.setBinary(info)
    await settings.patch({ binaryPath: path })
    const idx = discovered.findIndex((b) => b.path === path)
    if (idx >= 0) discovered[idx] = info
    else discovered.push(info)
    return info
  })

  handle<GpuDevice[]>(IPC.binaryDevices, () => readDevices(supervisor.binaryInfo))

  // The scan touches only file headers, but it walks whole directory trees, so
  // the result is cached and refreshed on demand rather than on every render.
  let modelCache: ModelEntry[] | null = null
  const listModels = async (force: boolean): Promise<ModelEntry[]> => {
    if (!modelCache || force) {
      modelCache = await scanModels([...defaultModelDirs(), ...settings.current.modelDirs])
    }
    return modelCache
  }

  handle<ModelEntryView[]>(IPC.modelsList, () => listModels(false))
  handle<ModelEntryView[]>(IPC.modelsRescan, () => listModels(true))

  handle<VramPlanView>(IPC.modelPlan, async (raw) => {
    const req = planRequestSchema.parse(raw)
    const models = await listModels(false)
    const meta = models.find((m) => m.path === req.modelPath)
    if (!meta) throw new Error('Model not found. Try rescanning.')
    if (meta.error) throw new Error(`Cannot plan for this file: ${meta.error}`)

    // Free VRAM is re-read here rather than reused from the startup probe:
    // other processes take and release VRAM while the app is open.
    let freeMiB: number | null = null
    try {
      const devices = await readDevices(supervisor.binaryInfo)
      freeMiB = devices[0]?.freeMiB ?? null
    } catch {
      freeMiB = null
    }
    const binary = supervisor.binaryInfo
    return planVram(
      {
        meta,
        gpuLayers: req.gpuLayers,
        contextSize: req.contextSize,
        cacheTypeK: req.cacheTypeK,
        cacheTypeV: req.cacheTypeV,
        parallel: req.parallel,
        // The unified CLI is the newer line, which sizes its compute buffer very
        // differently from the classic standalone server.
        computeProfile: binary.kind === 'unified' ? 'modern' : 'classic',
        hasGpuBackend: binary.devices.length > 0
      },
      freeMiB
    )
  })

  /**
   * llama.cpp's own fitting tool. Cached per model+binary: it loads the model
   * to measure, so it is far too slow to call on every slider movement.
   */
  const fitCache = new Map<string, FitSuggestion | null>()
  handle<FitSuggestion | null>(IPC.modelFit, async (rawPath) => {
    const modelPath = String(rawPath ?? '')
    if (!modelPath) return null
    const binary = supervisor.binaryInfo
    const key = `${binary.path}::${modelPath}`
    if (!fitCache.has(key)) fitCache.set(key, await fitParams(binary, modelPath))
    return fitCache.get(key) ?? null
  })

  handle<HealthCheckResult>(IPC.binaryHealthCheck, async (raw) => {
    const req = healthCheckRequestSchema.parse(raw)
    if (supervisor.status.pid !== null) {
      throw new Error('Stop the running server before testing the binary.')
    }
    return runHealthCheck(supervisor.binaryInfo, req.modelPath, req.gpuLayers)
  })

  handle<string | null>(IPC.pickModelDir, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Add a folder to scan for GGUF models',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = r.filePaths[0]
    if (!settings.current.modelDirs.includes(dir)) {
      await settings.patch({ modelDirs: [...settings.current.modelDirs, dir] })
    }
    modelCache = null
    return dir
  })

  handle<HfModel[]>(IPC.hfSearch, (query) => searchModels(String(query ?? ''), 24))
  handle<HfFile[]>(IPC.hfFiles, (repo) => listRepoFiles(String(repo ?? '')))
  /**
   * Fit estimates cost a ranged HTTP fetch of each distinct model's header, so
   * they are cached per repo. The answer only changes if the binary does, which
   * the key accounts for.
   */
  const repoFitCache = new Map<string, RemoteFit[]>()
  handle<RemoteFit[]>(IPC.hfFit, async (rawRepo) => {
    const repo = String(rawRepo ?? '')
    const binary = supervisor.binaryInfo
    const key = `${binary.path}::${repo}`
    const cached = repoFitCache.get(key)
    if (cached) return cached

    const files = await listRepoFiles(repo)
    // Free VRAM is read now rather than reused from startup: what fits depends
    // on what else is currently using the card.
    let freeMiB: number | null = null
    try {
      freeMiB = (await readDevices(binary))[0]?.freeMiB ?? null
    } catch {
      freeMiB = null
    }
    const fits = await estimateRepoFit(repo, files, freeMiB, binary)
    repoFitCache.set(key, fits)
    return fits
  })

  handle<DownloadJob[]>(IPC.downloadList, () => downloads.list())
  handle<DownloadJob>(IPC.downloadStart, async (raw) => {
    const req = downloadRequestSchema.parse(raw)
    const job = await downloads.start(req.repo, req.file, req.expectedBytes)
    return job
  })
  handle<null>(IPC.downloadCancel, (id) => {
    downloads.cancel(String(id ?? ''))
    return null
  })

  /**
   * One benchmark at a time: two sweeps competing for the same GPU would
   * measure each other's contention rather than the settings under test.
   */
  const bench = new BenchRunner()
  let benchRun: BenchRunView | null = null
  const pushBench = (): void => {
    if (benchRun) broadcastBench({ ...benchRun })
  }
  bench.on('progress', (progress) => {
    if (!benchRun) return
    benchRun = { ...benchRun, progress }
    pushBench()
  })
  bench.on('done', (results) => {
    if (!benchRun) return
    benchRun = { ...benchRun, results, state: 'done', progress: null, finishedAt: Date.now() }
    pushBench()
  })
  bench.on('failed', (error) => {
    if (!benchRun) return
    benchRun = { ...benchRun, state: 'failed', error, progress: null, finishedAt: Date.now() }
    pushBench()
  })

  handle<BenchRunView>(IPC.benchStart, (raw) => {
    const request = benchRequestSchema.parse(raw)
    if (supervisor.status.pid !== null) {
      // A loaded server holds VRAM and competes for the GPU, which would make
      // every number in the sweep wrong.
      throw new Error('Stop the running server before benchmarking — it would skew the results.')
    }
    benchRun = {
      id: `${Date.now()}`,
      request,
      results: [],
      progress: null,
      state: 'running',
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    bench.start(supervisor.binaryInfo, request)
    return benchRun
  })

  handle<null>(IPC.benchCancel, () => {
    bench.cancel()
    return null
  })

  handle<BenchRunView | null>(IPC.benchState, () => benchRun)

  handle<LaunchProfileView | null>(IPC.profileGet, (modelPath) =>
    profiles.get(String(modelPath ?? ''))
  )
  handle<LaunchProfileView[]>(IPC.profileList, () => profiles.list())
  handle<null>(IPC.profileForget, async (modelPath) => {
    await profiles.forget(String(modelPath ?? ''))
    return null
  })

  handle<ConversationSummaryView[]>(IPC.chatList, () => conversations.list())
  handle<ConversationView | null>(IPC.chatGet, (id) => conversations.get(String(id ?? '')))
  handle<ConversationView>(IPC.chatCreate, (systemPrompt) =>
    conversations.create(typeof systemPrompt === 'string' ? systemPrompt : '')
  )
  handle<ConversationView>(IPC.chatSave, (raw) =>
    // Conversation content is model output written back through the renderer,
    // so it is validated before it is persisted.
    conversations.save(conversationSchema.parse(raw))
  )
  handle<null>(IPC.chatDelete, async (id) => {
    await conversations.remove(String(id ?? ''))
    return null
  })

  handle<string | null>(IPC.pickModelFile, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}

/** Set by wireEvents so handlers registered earlier can broadcast. */
let broadcastBench: (run: BenchRunView) => void = () => {}

/** Push status and log-availability events to every open window. */
export function wireEvents(supervisor: ServerSupervisor, downloads: DownloadManager): void {
  const broadcast = (channel: string, payload?: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  supervisor.on('status', (status) => broadcast(IPC.serverStatusChanged, status))
  downloads.on('update', (job) => broadcast(IPC.downloadChanged, job))
  broadcastBench = (run) => broadcast(IPC.benchChanged, run)

  // llama-server can emit hundreds of lines per second; coalesce the "there is
  // new output" hint so the renderer polls at most ~10x/sec instead of per line.
  let pending = false
  supervisor.on('log', () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      broadcast(IPC.logsChanged)
    }, 100)
  })
}
