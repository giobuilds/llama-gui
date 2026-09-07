import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { BinaryInfo, GpuDevice } from '@shared/types.js'

const run = promisify(execFile)

/** Where a distro package or a hand-built llama.cpp usually lands. */
const CANDIDATE_DIRS = [
  '/usr/bin',
  '/usr/local/bin',
  '/opt/llama.cpp/bin',
  join(process.env.HOME ?? '', '.local/bin'),
  join(process.env.HOME ?? '', 'llama.cpp/build/bin')
]

export function findLlamaServer(explicit?: string): string | null {
  const candidates = explicit
    ? [explicit]
    : CANDIDATE_DIRS.map((d) => join(d, 'llama-server'))
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // not there, or not executable — try the next one
    }
  }
  return null
}

/**
 * llama-server writes --version and --help to stderr, and the ROCm/CUDA backends
 * print device-init noise there too, so we read both streams and filter.
 * A failed exit code is not fatal: --version exits non-zero on some builds.
 */
async function capture(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(bin, args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000
    })
    return stdout + stderr
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const out = (e.stdout ?? '') + (e.stderr ?? '')
    if (out) return out
    throw new Error(e.message ?? String(err))
  }
}

/** Every long flag the binary advertises, so the UI can hide unsupported controls. */
export function parseFlags(helpText: string): string[] {
  const flags = new Set<string>()
  for (const match of helpText.matchAll(/(--[a-z0-9][a-z0-9-]*)/gi)) {
    flags.add(match[1]!)
  }
  return [...flags].sort()
}

/** "  ROCm0: AMD Radeon RX 6600 (8176 MiB, 8142 MiB free)" */
export function parseDevices(listText: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  const re = /^\s*(\S+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/gm
  for (const m of listText.matchAll(re)) {
    devices.push({
      id: m[1]!,
      name: m[2]!,
      totalMiB: Number(m[3]),
      freeMiB: Number(m[4])
    })
  }
  return devices
}

export function parseVersion(versionText: string): string {
  const m = versionText.match(/^version:\s*(.+)$/m)
  return m ? m[1]!.trim() : 'unknown'
}

/**
 * Fedora's llama-cpp package reports `version: 0 (unknown)`, so the version
 * string is not a usable cache key. Identity is the binary's size + mtime.
 */
export async function binaryFingerprint(path: string): Promise<string> {
  const s = await stat(path)
  return `${path}:${s.size}:${Math.trunc(s.mtimeMs)}`
}

export async function probeBinary(path: string): Promise<BinaryInfo> {
  const [versionText, helpText, listText] = await Promise.all([
    capture(path, ['--version']),
    capture(path, ['--help']),
    capture(path, ['--list-devices'])
  ])
  return {
    path,
    version: parseVersion(versionText),
    flags: parseFlags(helpText),
    devices: parseDevices(listText)
  }
}

/**
 * Free VRAM changes as other processes come and go, so the planner re-reads it
 * at launch time rather than trusting the cached probe.
 */
export async function readDevices(path: string): Promise<GpuDevice[]> {
  return parseDevices(await capture(path, ['--list-devices']))
}
