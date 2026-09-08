import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * Measured throughput of this machine, learned from runs the app already does
 * — the binary health check and any benchmark — rather than from a separate
 * calibration step. The best figure seen is kept, since a slower sample usually
 * means something else was competing for the device.
 */
const calibrationSchema = z.object({
  gpuBytesPerSecond: z.number().positive().nullable().default(null),
  cpuBytesPerSecond: z.number().positive().nullable().default(null),
  /** Where throughput stops scaling with size and per-token overhead takes over. */
  ceilingTokensPerSecond: z.number().positive().nullable().default(null),
  samples: z.number().int().min(0).default(0),
  updatedAt: z.number().default(0)
})

export type Calibration = z.infer<typeof calibrationSchema>

const settingsSchema = z.object({
  calibration: calibrationSchema.default({
    gpuBytesPerSecond: null, cpuBytesPerSecond: null,
    ceilingTokensPerSecond: null, samples: 0, updatedAt: 0
  }),
  /** Explicit llama.cpp binary chosen by the user, overriding auto-discovery. */
  binaryPath: z.string().optional(),
  /** Extra directories to scan for GGUF files, beyond the defaults. */
  modelDirs: z.array(z.string()).default([])
})

export type Settings = z.infer<typeof settingsSchema>

const DEFAULTS: Settings = {
  modelDirs: [],
  calibration: {
    gpuBytesPerSecond: null, cpuBytesPerSecond: null,
    ceilingTokensPerSecond: null, samples: 0, updatedAt: 0
  }
}

/** Small JSON-backed settings file. Corrupt or missing files fall back to defaults. */
export class SettingsStore {
  private cache: Settings = DEFAULTS

  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    try {
      this.cache = settingsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      this.cache = DEFAULTS
    }
    return this.cache
  }

  get current(): Settings {
    return this.cache
  }

  /**
   * Fold a measurement into the stored profile.
   *
   * Bandwidth is `active bytes per token x tokens per second`. The best figure
   * is kept rather than an average: a low sample means contention, not a slower
   * machine. Very small models are excluded — they are bound by per-token
   * overhead, so they measure the ceiling instead, which is recorded separately.
   */
  async observe(sample: {
    activeBytes: number
    tokensPerSecond: number
    onGpu: boolean
  }): Promise<void> {
    if (sample.tokensPerSecond <= 0 || sample.activeBytes <= 0) return
    const bandwidth = sample.activeBytes * sample.tokensPerSecond
    const current = this.cache.calibration
    const next = { ...current, samples: current.samples + 1, updatedAt: Date.now() }

    // Below roughly 400 MB a token, throughput plateaus and the figure would
    // understate the machine's bandwidth badly.
    const BANDWIDTH_FLOOR_BYTES = 400e6
    if (sample.activeBytes >= BANDWIDTH_FLOOR_BYTES) {
      if (sample.onGpu) {
        next.gpuBytesPerSecond = Math.max(current.gpuBytesPerSecond ?? 0, bandwidth)
      } else {
        next.cpuBytesPerSecond = Math.max(current.cpuBytesPerSecond ?? 0, bandwidth)
      }
    } else if (sample.onGpu) {
      next.ceilingTokensPerSecond = Math.max(
        current.ceilingTokensPerSecond ?? 0,
        sample.tokensPerSecond
      )
    }
    await this.patch({ calibration: next })
  }

  async patch(patch: Partial<Settings>): Promise<Settings> {
    this.cache = settingsSchema.parse({ ...this.cache, ...patch })
    await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf8')
    return this.cache
  }
}
