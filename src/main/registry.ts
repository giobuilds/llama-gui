import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readGgufMetadata, type GgufMetadata } from './gguf.js'

/** Where GGUF files usually live: llama.cpp's cache, HF's cache, common manual spots. */
export function defaultModelDirs(): string[] {
  const home = process.env['HOME'] ?? ''
  return [
    join(home, '.cache/llama.cpp'),
    join(home, '.cache/huggingface/hub'),
    join(home, 'models'),
    join(home, 'Models'),
    join(home, '.local/share/models')
  ]
}

export interface ModelEntry extends GgufMetadata {
  /** Set when the header could not be read; the entry is still listed. */
  error?: string
  mtimeMs: number
}

const MAX_DEPTH = 4

/** Recursively collect .gguf paths, skipping the multi-part shards after the first. */
async function collect(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // missing or unreadable directory is not an error worth surfacing
  }
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) {
      await collect(path, depth + 1, out)
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
      // A split model is "-00001-of-00003.gguf"; llama.cpp is handed the first
      // shard and finds the rest itself, so listing the others is just noise.
      const shard = e.name.match(/-(\d{5})-of-\d{5}\.gguf$/i)
      if (shard && shard[1] !== '00001') continue
      out.push(path)
    }
  }
}

/**
 * Scan for models and read each header.
 *
 * Headers are read concurrently but with a small cap: a model directory can hold
 * dozens of files, and opening all of them at once on a spinning disk is slower
 * than a bounded queue.
 */
export async function scanModels(dirs: string[]): Promise<ModelEntry[]> {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    const found: string[] = []
    await collect(dir, 0, found)
    for (const p of found) {
      if (!seen.has(p)) {
        seen.add(p)
        paths.push(p)
      }
    }
  }

  const entries: ModelEntry[] = []
  const CONCURRENCY = 4
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, paths.length) }, async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++]!
        entries.push(await describe(path))
      }
    })
  )

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/** A file that cannot be parsed is still listed, with the reason attached. */
async function describe(path: string): Promise<ModelEntry> {
  const st = await stat(path).catch(() => null)
  const mtimeMs = st?.mtimeMs ?? 0
  try {
    return { ...(await readGgufMetadata(path)), mtimeMs }
  } catch (err) {
    return {
      path,
      fileName: path.split('/').pop() ?? path,
      fileSize: st?.size ?? 0,
      architecture: 'unknown',
      name: path.split('/').pop()?.replace(/\.gguf$/i, '') ?? path,
      blockCount: null,
      contextLength: null,
      embeddingLength: null,
      headCount: null,
      headCountKv: null,
      quant: null,
      parameterCount: null,
      hasChatTemplate: false,
      vocabSize: null,
      mtimeMs,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export { readGgufMetadata }
