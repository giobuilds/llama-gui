/**
 * The contract between the main process and the renderer.
 * Everything crossing IPC is defined here and validated with the zod schemas
 * in ./schema.ts before it is trusted on either side.
 */

/** Lifecycle of the supervised llama-server process. */
export type ServerPhase =
  | 'stopped'
  | 'starting' // spawned, no output parsed yet
  | 'loading' // model is being read into memory / offloaded
  | 'ready' // GET /health returned 200
  | 'degraded' // was ready, health checks now failing
  | 'stopping'
  | 'crashed' // exited without us asking

/** Flags we hand to llama-server. Only the ones the UI actually exposes. */
export interface LaunchConfig {
  /** Absolute path to a .gguf file. */
  modelPath: string
  /**
   * Let llama.cpp size the launch itself.
   *
   * Modern builds default `--fit on`, which adjusts *unset* arguments to fit
   * device memory. Passing an explicit -ngl and -c suppresses that, so auto-fit
   * works by deliberately omitting them and letting llama.cpp decide — it knows
   * its own allocator better than any estimate can.
   */
  autoFit: boolean
  /** -ngl: layers to offload to VRAM. */
  gpuLayers: number
  /** -c: context size in tokens. */
  contextSize: number
  /** -fa: flash attention. */
  flashAttn: boolean
  /** -ctk / -ctv: KV cache quantisation. */
  cacheTypeK: KvCacheType
  cacheTypeV: KvCacheType
  /**
   * --no-warmup: skip the empty warmup run. Normally worth keeping, but the
   * warmup pass segfaults on some ROCm builds (reproduced on gfx1032 / RX 6600
   * with llama-cpp b6153), so it has to be switchable.
   */
  noWarmup: boolean
  /** -np: parallel sequences. */
  parallel: number
  /** -t: generation threads. -1 lets llama.cpp decide. */
  threads: number
  /** --alias: the model name reported over the API. */
  alias?: string
  /** Extra raw flags, split on whitespace. Escape hatch for anything unmodelled. */
  extraArgs: string
}

export const KV_CACHE_TYPES = [
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q5_1',
  'q5_0',
  'iq4_nl',
  'q4_1',
  'q4_0'
] as const
export type KvCacheType = (typeof KV_CACHE_TYPES)[number]

export const DEFAULT_LAUNCH_CONFIG: Omit<LaunchConfig, 'modelPath'> = {
  autoFit: true,
  gpuLayers: 999,
  contextSize: 4096,
  flashAttn: true,
  noWarmup: false,
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
  parallel: 1,
  threads: -1,
  extraArgs: ''
}

/** Everything the UI needs to render the server panel. */
export interface ServerStatus {
  phase: ServerPhase
  /** Present from 'starting' onwards. */
  pid: number | null
  port: number | null
  /** The config the running process was launched with, not the one being edited. */
  config: LaunchConfig | null
  /**
   * Human-readable stage while phase === 'loading', else null.
   * llama-server emits no load percentage (only per-slot prompt progress), so
   * this is a discrete stage from its stderr, never a fabricated 0..100 bar.
   */
  loadStage: string | null
  /** ms since epoch the current launch attempt began, for an elapsed-time display. */
  startedAt: number | null
  /** Populated on 'crashed' / failed start. */
  error: string | null
  /** Exit code of the last run, if it has exited. */
  exitCode: number | null
  /** ms since epoch the process reached 'ready'. */
  readyAt: number | null
  /** True when we adopted a server that was already running rather than spawning it. */
  adopted: boolean
}

export type LogStream = 'stdout' | 'stderr' | 'app'

export interface LogLine {
  /** Monotonic, assigned by the ring buffer. Renderer uses it to de-dup and to ask for deltas. */
  seq: number
  ts: number
  stream: LogStream
  text: string
}

/**
 * llama.cpp ships in two shapes, and they are not interchangeable:
 *  - 'llama-server': the long-standing standalone binary (what distro packages ship)
 *  - 'unified': the newer single `llama` CLI where `llama serve` replaces it
 * Searching only for a file named `llama-server` silently misses the second and
 * can land on a stale distro build the user does not actually use.
 */
export type BinaryKind = 'llama-server' | 'unified'

/** Result of probing an installed llama.cpp. */
export interface BinaryInfo {
  /** Resolved absolute path to the executable. */
  path: string
  kind: BinaryKind
  /** Subcommand to prepend to argv — [] for llama-server, ['serve'] for the unified CLI. */
  argvPrefix: string[]
  /** Raw --version line, e.g. "0.3.0-dev (build 10679, commit 50f068fff)". */
  version: string
  /** Long flag names the binary advertises in --help, e.g. "--flash-attn". */
  flags: string[]
  /**
   * Newer builds take `--flash-attn on|off|auto`; older ones treat it as a bare
   * boolean. Passing the wrong form makes the server exit before it starts.
   */
  flashAttnStyle: 'bare' | 'value'
  /** Devices from --list-devices. Empty on a CPU-only build. */
  devices: GpuDevice[]
  /** Human-readable label for the picker, e.g. "llama serve — 0.3.0-dev". */
  label: string
}

export interface GpuDevice {
  /** e.g. "ROCm0" */
  id: string
  name: string
  totalMiB: number
  freeMiB: number
}

/** Mirrors main/planner.ts VramPlan; duplicated here so the renderer can type it. */
export interface VramPlanView {
  offloadedLayers: number
  totalLayers: number
  weightsMiB: number
  kvCacheMiB: number
  computeMiB: number
  backendOverheadMiB: number
  totalMiB: number
  freeMiB: number | null
  fits: boolean | null
  maxGpuLayers: number | null
  notes: string[]
}

/** Mirrors main/registry.ts ModelEntry. */
export interface ModelEntryView {
  path: string
  fileName: string
  fileSize: number
  architecture: string
  name: string
  blockCount: number | null
  contextLength: number | null
  embeddingLength: number | null
  headCount: number | null
  headCountKv: number | null
  quant: string | null
  parameterCount: number | null
  hasChatTemplate: boolean
  vocabSize: number | null
  mtimeMs: number
  error?: string
}

/** What `llama fit-params` recommends for a model on this machine. */
export interface FitSuggestion {
  contextSize: number | null
  /** -1 means "offload everything". */
  gpuLayers: number | null
  /** Raw argument string as printed, for display. */
  raw: string
}

export type HealthStep = 'spawn' | 'load' | 'ready' | 'inference' | 'stop'

export interface HealthCheckResult {
  binaryPath: string
  ok: boolean
  /** Steps in the order they were attempted. */
  steps: Array<{ step: HealthStep; ok: boolean; detail: string; ms: number }>
  /** Populated when a step failed. */
  error: string | null
  /** Tokens per second from the probe request, when it got that far. */
  tokensPerSecond: number | null
  checkedAt: number
}

export interface ChatSettingsView {
  temperature: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  maxTokens: number
}

export interface ChatMessageView {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  createdAt: number
  model?: string
  tokensPerSecond?: number
  reasoning?: string
  stopped?: boolean
  error?: string
}

export interface ConversationView {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  systemPrompt: string
  messages: ChatMessageView[]
  settings: ChatSettingsView
}

export interface ConversationSummaryView {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
}

export interface IpcResult<T> {
  ok: true
  value: T
}
export interface IpcFailure {
  ok: false
  error: string
}
export type IpcResponse<T> = IpcResult<T> | IpcFailure
