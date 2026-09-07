import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { BenchProgress, BenchRequest, BenchResult, BinaryInfo } from '@shared/types.js'

/**
 * Runs `llama bench` and turns its output into comparable numbers.
 *
 * Only settings that actually change throughput are swept — offload, KV cache
 * type, flash attention, threads, batch size. Sampler settings (temperature,
 * top-p and friends) are deliberately absent: they do not measurably affect
 * speed, so benchmarking them would be measuring noise. Sampler choice is a
 * quality question and belongs in the chat view.
 */

interface RawEntry {
  model_filename?: string
  model_type?: string
  model_size?: number
  backends?: string
  build_commit?: string
  n_gpu_layers?: number
  n_threads?: number
  n_batch?: number
  n_ubatch?: number
  type_k?: string
  type_v?: string
  flash_attn?: number
  n_prompt?: number
  n_gen?: number
  avg_ts?: number
  stddev_ts?: number
}

export interface BenchEvents {
  progress: [BenchProgress]
  done: [BenchResult[]]
  failed: [string]
}

/** `llama-bench: benchmark 3/8: prompt run 1/1` */
const PROGRESS_RE = /benchmark\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.+)$/

export class BenchRunner extends EventEmitter<BenchEvents> {
  private child: ChildProcess | null = null
  private cancelled = false

  get running(): boolean {
    return this.child !== null
  }

  cancel(): void {
    const child = this.child
    if (!child?.pid) return
    this.cancelled = true
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        process.kill(child.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }

  start(binary: BinaryInfo, request: BenchRequest): void {
    if (this.child) throw new Error('A benchmark is already running.')
    if (!binary.path) throw new Error('No llama.cpp binary selected.')
    this.cancelled = false
    void this.runBatches(binary, planBatches(request))
  }

  /**
   * Batches run one after another, never in parallel: two sweeps on one GPU
   * would measure each other's contention instead of the settings under test.
   */
  private async runBatches(binary: BinaryInfo, batches: BenchRequest[]): Promise<void> {
    const collected: BenchResult[] = []
    let completed = 0

    for (const batch of batches) {
      if (this.cancelled) break
      try {
        const { results, total } = await this.runOne(binary, batch, completed)
        collected.push(...results)
        completed += total
      } catch (err) {
        // A batch that fails takes only itself down; anything already measured
        // is still worth reporting.
        const message = (err as Error).message
        if (this.cancelled) break
        if (collected.length === 0) {
          this.emit('failed', message)
          return
        }
        this.emit('progress', { current: completed, total: completed, stage: `skipped: ${message}` })
      }
    }

    if (this.cancelled) {
      this.emit('failed', 'Benchmark cancelled.')
      return
    }
    this.emit('done', collected)
  }

  private runOne(
    binary: BinaryInfo,
    request: BenchRequest,
    offset: number
  ): Promise<{ results: BenchResult[]; total: number }> {
    return new Promise((resolve, reject) => {
      const args = buildBenchArgs(binary, request)
      const child = spawn(binary.path, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      this.child = child

      let stdout = ''
      let stderr = ''
      let total = 0
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (c: string) => (stdout += c))
      child.stderr.on('data', (c: string) => {
        stderr += c
        for (const line of c.split('\n')) {
          const m = line.match(PROGRESS_RE)
          if (!m) continue
          total = Number(m[2])
          // Progress is reported across the whole sweep, not per batch, so the
          // bar does not restart partway through.
          this.emit('progress', {
            current: offset + Number(m[1]),
            total: offset + total,
            stage: m[3]!.trim()
          })
        }
      })

      child.on('error', (err) => {
        this.child = null
        reject(err)
      })

      child.on('exit', (code) => {
        this.child = null
        if (this.cancelled) {
          resolve({ results: [], total })
          return
        }
        if (code !== 0) {
          reject(new Error(lastLine(stderr) || `llama bench exited with code ${code}.`))
          return
        }
        try {
          resolve({ results: parseBenchJson(stdout), total: total || 1 })
        } catch (err) {
          reject(new Error(`Could not read benchmark output: ${(err as Error).message}`))
        }
      })
    })
  }
}

/** KV cache types that are stored unquantised and work without flash attention. */
const UNQUANTISED_KV = new Set(['f32', 'f16', 'bf16'])

/**
 * Split a sweep into runs llama.cpp will actually accept.
 *
 * A quantised KV cache requires flash attention — with `-ctk q8_0 -fa off`
 * llama.cpp cannot create a context at all. Since `llama bench` expands its own
 * cross product, one invalid pairing aborts the entire sweep, taking every valid
 * combination with it. Splitting keeps the f16-with-flash-attention-off
 * comparison while still measuring the quantised types.
 */
export function planBatches(request: BenchRequest): BenchRequest[] {
  if (request.cacheTypes.length <= 1) return [request]

  // One run per cache type, so K and V always match. Passing several types as
  // one list makes llama-bench cross -ctk with -ctv, producing mismatched pairs
  // like K=q8_0/V=q4_0 that nobody asked for and that look like duplicate rows.
  return request.cacheTypes.map((type) => ({
    ...request,
    cacheTypes: [type],
    // A quantised KV cache requires flash attention — llama.cpp cannot create a
    // context without it, and one invalid pairing would abort that whole run.
    flashAttn: UNQUANTISED_KV.has(type) ? request.flashAttn : ['on']
  }))
}

export function buildBenchArgs(binary: BinaryInfo, request: BenchRequest): string[] {
  const args: string[] = []
  // The unified CLI puts bench behind a subcommand; the standalone build ships
  // it as a separate llama-bench binary, which callers point at directly.
  if (binary.kind === 'unified') args.push('bench')

  args.push('--model', request.modelPath)
  args.push('-p', String(request.nPrompt))
  args.push('-n', String(request.nGen))
  args.push('-r', String(request.repetitions))
  args.push('--progress')
  args.push('-o', 'json')

  // Each sweep is passed as a comma-separated list, which llama-bench expands
  // into the cross product of every combination.
  if (request.gpuLayers.length) args.push('-ngl', request.gpuLayers.join(','))
  if (request.threads.length) args.push('-t', request.threads.join(','))
  if (request.cacheTypes.length) {
    args.push('-ctk', request.cacheTypes.join(','))
    args.push('-ctv', request.cacheTypes.join(','))
  }
  if (request.flashAttn.length) args.push('-fa', request.flashAttn.join(','))
  if (request.ubatch.length) args.push('-ub', request.ubatch.join(','))
  return args
}

export function parseBenchJson(stdout: string): BenchResult[] {
  // Backend banners can precede the JSON on stdout, so the array is located
  // rather than assumed to start at byte zero.
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('no JSON array in output')
  const raw = JSON.parse(stdout.slice(start, end + 1)) as RawEntry[]

  return raw.map((e) => ({
    // n_gen of 0 marks a prompt-processing row; n_prompt of 0 marks generation.
    kind: (e.n_gen ?? 0) > 0 ? 'generation' : 'prompt',
    tokensPerSecond: e.avg_ts ?? 0,
    stddev: e.stddev_ts ?? 0,
    gpuLayers: e.n_gpu_layers ?? -1,
    threads: e.n_threads ?? 0,
    cacheTypeK: e.type_k ?? 'f16',
    cacheTypeV: e.type_v ?? 'f16',
    // -1 means llama.cpp chose for itself.
    flashAttn: e.flash_attn === 1 ? 'on' : e.flash_attn === 0 ? 'off' : 'auto',
    ubatch: e.n_ubatch ?? 0,
    nPrompt: e.n_prompt ?? 0,
    nGen: e.n_gen ?? 0,
    backend: e.backends ?? 'unknown',
    modelType: e.model_type ?? '',
    buildCommit: e.build_commit ?? ''
  }))
}

function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^ggml_/.test(l))
      .pop() ?? ''
  ).replace(/^[\d.]+\s+[EWID]\s+/, '')
}
