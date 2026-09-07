import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

const settingsSchema = z.object({
  /** Explicit llama.cpp binary chosen by the user, overriding auto-discovery. */
  binaryPath: z.string().optional(),
  /** Extra directories to scan for GGUF files, beyond the defaults. */
  modelDirs: z.array(z.string()).default([])
})

export type Settings = z.infer<typeof settingsSchema>

const DEFAULTS: Settings = { modelDirs: [] }

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

  async patch(patch: Partial<Settings>): Promise<Settings> {
    this.cache = settingsSchema.parse({ ...this.cache, ...patch })
    await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf8')
    return this.cache
  }
}
