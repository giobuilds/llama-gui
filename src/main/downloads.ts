import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { BinaryInfo, DownloadJob, HfFile, HfModel } from '@shared/types.js'

/**
 * Model downloads, delegated to `llama download`.
 *
 * Upstream already resolves Hugging Face repos, picks a quant, fetches the
 * matching mmproj and writes the HF cache layout — reimplementing that against
 * the HF API would be a lot of work to end up with something less correct.
 *
 * What it does not do is report progress: with no TTY attached it writes
 * nothing at all until it prints the final path on stdout. So progress is
 * observed rather than parsed — the HF cache writes the incoming file as
 * `blobs/<sha>.downloadInProgress`, and its size against the size the HF API
 * reports for the chosen file gives an accurate percentage.
 */

const HF_API = 'https://huggingface.co/api'

function hubRoot(): string {
  const home = process.env['HOME'] ?? ''
  const hfHome = process.env['HF_HOME']
  if (process.env['HF_HUB_CACHE']) return process.env['HF_HUB_CACHE']
  if (hfHome) return join(hfHome, 'hub')
  return join(home, '.cache/huggingface/hub')
}

/** "unsloth/SmolLM2-135M-Instruct-GGUF" -> "models--unsloth--SmolLM2-135M-Instruct-GGUF" */
export function repoCacheDir(repo: string): string {
  return join(hubRoot(), `models--${repo.replace(/\//g, '--')}`)
}

/** llama.cpp's own convention: projectors are published as `mmproj-*.gguf`. */
export function isProjectorName(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return /^mmproj[-_.]/i.test(name)
}

/**
 * The projector to fetch alongside a model.
 *
 * Prefers one sharing the model's quantisation. Failing that it takes the
 * smallest: VRAM is the binding constraint on a single consumer card, and a
 * quantised projector is close to lossless, whereas an f16 one can cost several
 * hundred MiB more than the alternative for no visible gain. Pairing a Q4 model
 * with an f16 projector is also a precision mismatch nobody asked for. The
 * launch panel names the projector it chose, so the decision stays visible.
 */
export function projectorFor(modelFile: string, files: HfFile[]): HfFile | null {
  const projectors = files.filter((f) => f.isProjector)
  if (projectors.length === 0) return null
  const quant = modelFile.match(/(?:^|[.\-_])((?:IQ|Q)\d[A-Z0-9_]*|F16|BF16|F32)/i)?.[1]
  const matching = quant
    ? projectors.find((p) => p.path.toLowerCase().includes(quant.toLowerCase()))
    : undefined
  return matching ?? [...projectors].sort((a, b) => a.size - b.size)[0]!
}

export async function searchModels(query: string, limit = 20): Promise<HfModel[]> {
  const url =
    `${HF_API}/models?filter=gguf&sort=downloads&direction=-1&limit=${limit}` +
    (query.trim() ? `&search=${encodeURIComponent(query.trim())}` : '')
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Hugging Face search failed (HTTP ${res.status})`)
  const raw = (await res.json()) as Array<{
    id: string
    downloads?: number
    likes?: number
    gated?: boolean | string
    lastModified?: string
  }>
  return raw.map((m) => ({
    id: m.id,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    // A gated repo needs an accepted licence and a token; downloads fail
    // confusingly otherwise, so it is worth flagging in the list.
    gated: Boolean(m.gated),
    lastModified: m.lastModified ?? null
  }))
}

/** The GGUF files in a repo, so a quant can be chosen by name and size. */
export async function listRepoFiles(repo: string): Promise<HfFile[]> {
  const res = await fetch(`${HF_API}/models/${repo}/tree/main`, {
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`Could not list files for ${repo} (HTTP ${res.status})`)
  const raw = (await res.json()) as Array<{ path: string; size?: number; type?: string }>
  return raw
    .filter((f) => f.path.toLowerCase().endsWith('.gguf'))
    .map((f) => ({
      path: f.path,
      size: f.size ?? 0,
      isProjector: isProjectorName(f.path),
      // A split model is handed to llama.cpp as its first shard; the rest are
      // found automatically, so offering them individually would mislead.
      shard: /-(\d{5})-of-(\d{5})\.gguf$/i.test(f.path)
    }))
    .filter((f) => !f.shard || /-00001-of-\d{5}\.gguf$/i.test(f.path))
    .sort((a, b) => a.size - b.size)
}

interface RunningJob {
  job: DownloadJob
  child: ChildProcess
  timer: NodeJS.Timeout
  stdout: string
  stderr: string
  /**
   * The `.downloadInProgress` blob this job is writing.
   *
   * Two downloads from one repo write into the same blobs directory, so summing
   * every partial file there credits each job with the other's bytes — which is
   * how a projector came to report 198% complete. Once a job claims a blob it
   * keeps it, and reads only that one.
   */
  blob: string | null
}

export interface DownloadEvents {
  update: [DownloadJob]
}

export class DownloadManager extends EventEmitter<DownloadEvents> {
  private jobs = new Map<string, RunningJob>()
  private finished: DownloadJob[] = []
  /**
   * Jobs waiting for another download from the same repo to finish.
   *
   * Two `llama download` processes on one repository race to write the cache's
   * `refs/main`, and one of them loses with "failed to write file". It is
   * intermittent, which makes it worse than a reliable failure — a vision model
   * and its projector come from the same repo, so this is exactly the pairing
   * the app queues automatically.
   */
  private queued: Array<{ job: DownloadJob; expectedBytes: number }> = []

  constructor(private binary: () => BinaryInfo) {
    super()
  }

  setBinary(binary: () => BinaryInfo): void {
    this.binary = binary
  }

  list(): DownloadJob[] {
    return [
      ...[...this.jobs.values()].map((j) => j.job),
      ...this.queued.map((q) => q.job),
      ...this.finished
    ].sort((a, b) => b.startedAt - a.startedAt)
  }

  private isRepoBusy(repo: string): boolean {
    return [...this.jobs.values()].some((r) => r.job.repo === repo)
  }

  async start(repo: string, file: string, expectedBytes: number): Promise<DownloadJob> {
    const binary = this.binary()
    if (!binary.path) throw new Error('No llama.cpp binary selected.')
    if (binary.kind !== 'unified') {
      throw new Error('Downloads need the unified `llama` CLI; the standalone server has no download command.')
    }
    for (const running of this.jobs.values()) {
      if (running.job.repo === repo && running.job.file === file) {
        throw new Error('That file is already downloading.')
      }
    }

    for (const pending of this.queued) {
      if (pending.job.repo === repo && pending.job.file === file) {
        throw new Error('That file is already queued.')
      }
    }

    const job: DownloadJob = {
      id: randomUUID(),
      repo,
      file,
      expectedBytes,
      receivedBytes: 0,
      state: 'queued',
      error: null,
      modelPath: null,
      startedAt: Date.now(),
      finishedAt: null
    }

    if (this.isRepoBusy(repo)) {
      this.queued.push({ job, expectedBytes })
      this.emit('update', job)
      return job
    }
    return this.spawnJob(job)
  }

  /** Start the next queued job for a repo, if the repo is now free. */
  private startNext(repo: string): void {
    if (this.isRepoBusy(repo)) return
    const index = this.queued.findIndex((q) => q.job.repo === repo)
    if (index < 0) return
    const [next] = this.queued.splice(index, 1)
    if (next) this.spawnJob(next.job)
  }

  private spawnJob(job: DownloadJob): DownloadJob {
    const binary = this.binary()
    const { repo, file } = job
    job.state = 'running'
    job.startedAt = Date.now()

    // -hff names the exact file, which avoids llama.cpp's quant guessing
    // picking something other than what was chosen in the UI.
    const args = ['download', '--hf-repo', repo, '--hf-file', file]
    const child = spawn(binary.path, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })

    const record: RunningJob = {
      job,
      child,
      stdout: '',
      stderr: '',
      blob: null,
      timer: setInterval(() => void this.poll(job.id), 700)
    }
    this.jobs.set(job.id, record)

    child.stdout.on('data', (c: Buffer) => (record.stdout += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (record.stderr += c.toString('utf8')))
    child.on('error', (err) => this.finish(job.id, { state: 'failed', error: err.message }))
    child.on('exit', (code, signal) => {
      if (job.state === 'cancelled') {
        this.finish(job.id, { state: 'cancelled' })
        return
      }
      if (code === 0) {
        const path = record.stdout.trim().split('\n').filter(Boolean).pop() ?? null
        this.finish(job.id, {
          state: 'done',
          modelPath: path,
          receivedBytes: job.expectedBytes
        })
      } else {
        this.finish(job.id, {
          state: 'failed',
          error: lastMeaningfulLine(record.stderr + record.stdout, code, signal)
        })
      }
    })

    this.emit('update', job)
    return job
  }

  cancel(id: string): void {
    const waiting = this.queued.findIndex((q) => q.job.id === id)
    if (waiting >= 0) {
      const [removed] = this.queued.splice(waiting, 1)
      if (removed) {
        removed.job.state = 'cancelled'
        removed.job.finishedAt = Date.now()
        this.finished = [removed.job, ...this.finished].slice(0, 20)
        this.emit('update', removed.job)
      }
      return
    }
    const record = this.jobs.get(id)
    if (!record) return
    record.job.state = 'cancelled'
    const pid = record.child.pid
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
    }
    // The partial blob is deliberately left in place: llama.cpp resumes it on
    // the next attempt rather than starting over.
    this.emit('update', record.job)
  }

  /** How far this job's own blob has got. */
  private async poll(id: string): Promise<void> {
    const record = this.jobs.get(id)
    if (!record || record.job.state !== 'running') return

    const partials = await inFlightBlobs(record.job.repo)
    if (partials.length === 0) return

    if (record.blob === null || !partials.some((b) => b.name === record.blob)) {
      // Claim a blob no other running job in this repo has taken, and only one
      // that could plausibly be this file — a blob already larger than what we
      // expect belongs to something else.
      const claimed = new Set(
        [...this.jobs.values()]
          .filter((r) => r !== record && r.job.repo === record.job.repo && r.blob)
          .map((r) => r.blob!)
      )
      const candidate = partials
        .filter((b) => !claimed.has(b.name))
        .filter((b) => record.job.expectedBytes === 0 || b.size <= record.job.expectedBytes * 1.02)
        .sort((a, b) => b.size - a.size)[0]
      if (!candidate) return
      record.blob = candidate.name
    }

    const bytes = partials.find((b) => b.name === record.blob)?.size
    if (bytes !== undefined && bytes !== record.job.receivedBytes) {
      record.job.receivedBytes = bytes
      this.emit('update', record.job)
    }
  }

  private finish(id: string, patch: Partial<DownloadJob>): void {
    const record = this.jobs.get(id)
    if (!record) return
    clearInterval(record.timer)
    this.jobs.delete(id)
    const job = { ...record.job, ...patch, finishedAt: Date.now() }
    // Keep a short history so the UI can show what just completed or failed.
    this.finished = [job, ...this.finished].slice(0, 20)
    this.emit('update', job)
    this.startNext(job.repo)
  }

  /** Stop everything on quit so no orphaned downloader survives the app. */
  shutdown(): void {
    this.queued = []
    for (const id of [...this.jobs.keys()]) this.cancel(id)
  }
}

/** Every partially-written blob in a repo's cache, with its current size. */
export async function inFlightBlobs(
  repo: string
): Promise<Array<{ name: string; size: number }>> {
  const blobs = join(repoCacheDir(repo), 'blobs')
  let names: string[]
  try {
    names = await readdir(blobs)
  } catch {
    return []
  }
  const out: Array<{ name: string; size: number }> = []
  for (const name of names.filter((n) => n.endsWith('.downloadInProgress'))) {
    try {
      out.push({ name, size: (await stat(join(blobs, name))).size })
    } catch {
      // A blob can be renamed out from under us the moment it completes.
    }
  }
  return out
}

/** Total bytes in flight for a repo, across every file being fetched. */
export async function inFlightBytes(repo: string): Promise<number | null> {
  const blobs = await inFlightBlobs(repo)
  if (blobs.length === 0) return null
  return blobs.reduce((total, b) => total + b.size, 0)
}

function lastMeaningfulLine(
  output: string,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  // llama.cpp prefixes log lines with a timestamp and severity, e.g.
  // "0.01.014.076 E common_download_get_hf_plan: no GGUF files found ..."
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  if (line) return line.replace(/^[\d.]+\s+[EWID]\s+/, '')
  return signal ? `Download was killed by ${signal}.` : `Download failed with exit code ${code}.`
}
