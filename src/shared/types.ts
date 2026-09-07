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

/** Result of probing the installed llama.cpp, cached per binary build string. */
export interface BinaryInfo {
  /** Resolved absolute path to llama-server. */
  path: string
  /** Raw first line(s) of --version, e.g. "version: 6153 (abc1234)". */
  version: string
  /** Long flag names the binary advertises in --help, e.g. "--flash-attn". */
  flags: string[]
  /** Devices from --list-devices. Empty on a CPU-only build. */
  devices: GpuDevice[]
}

export interface GpuDevice {
  /** e.g. "ROCm0" */
  id: string
  name: string
  totalMiB: number
  freeMiB: number
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
