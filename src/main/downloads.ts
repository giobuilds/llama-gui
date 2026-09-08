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
 * Prefers one sharing the model's quantisation, then the largest — a
 * higher-precision projector is the safer default, and they are small relative
 * to the model.
 */
export function projectorFor(modelFile: string, files: HfFile[]): HfFile | null {
  const projectors = files.filter((f) => f.isProjector)
  if (projectors.length === 0) return null
  const quant = modelFile.match(/(?:^|[.\-_])((?:IQ|Q)\d[A-Z0-9_]*|F16|BF16|F32)/i)?.[1]
  const matching = quant
    ? projectors.find((p) => p.path.toLowerCase().includes(quant.toLowerCase()))
    : undefined
  return matching ?? [...projectors].sort((a, b) => b.size - a.size)[0]!
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
}

export interface DownloadEvents {
  update: [DownloadJob]
}

export class DownloadManager extends EventEmitter<DownloadEvents> {
  private jobs = new Map<string, RunningJob>()
  private finished: DownloadJob[] = []

  constructor(private binary: () => BinaryInfo) {
    super()
  }

  setBinary(binary: () => BinaryInfo): void {
    this.binary = binary
  }

  list(): DownloadJob[] {
    return [...[...this.jobs.values()].map((j) => j.job), ...this.finished].sort(
      (a, b) => b.startedAt - a.startedAt
    )
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

    const job: DownloadJob = {
      id: randomUUID(),
      repo,
      file,
      expectedBytes,
      receivedBytes: 0,
      state: 'running',
      error: null,
      modelPath: null,
      startedAt: Date.now(),
      finishedAt: null
    }

    // -hff names the exact file, which avoids llama.cpp's quant guessing
    // picking something other than what was chosen in the UI.
    const args = ['download', '--hf-repo', repo, '--hf-file', file]
    const child = spawn(binary.path, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })

    const record: RunningJob = {
      job,
      child,
      stdout: '',
      stderr: '',
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

  /** Size of whatever the HF cache is currently writing for this repo. */
  private async poll(id: string): Promise<void> {
    const record = this.jobs.get(id)
    if (!record || record.job.state !== 'running') return
    const bytes = await inFlightBytes(record.job.repo)
    if (bytes !== null && bytes !== record.job.receivedBytes) {
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
  }

  /** Stop everything on quit so no orphaned downloader survives the app. */
  shutdown(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id)
  }
}

/**
 * Bytes written so far. The in-progress blob is the authoritative source while
 * a download runs; once it completes the blob is renamed, so a finished file is
 * counted from the completed blobs instead.
 */
export async function inFlightBytes(repo: string): Promise<number | null> {
  const blobs = join(repoCacheDir(repo), 'blobs')
  let names: string[]
  try {
    names = await readdir(blobs)
  } catch {
    return null
  }
  const partial = names.filter((n) => n.endsWith('.downloadInProgress'))
  if (partial.length === 0) return null
  let total = 0
  for (const name of partial) {
    try {
      total += (await stat(join(blobs, name))).size
    } catch {
      // The file can be renamed out from under us the moment it completes.
    }
  }
  return total
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
