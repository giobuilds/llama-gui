import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { join, basename } from 'node:path'
import type { BinaryInfo, BinaryKind, GpuDevice } from '@shared/types.js'

const run = promisify(execFile)

/** Where a distro package, a release tarball or the install script put things. */
const SEARCH_DIRS = [
  join(process.env['HOME'] ?? '', '.local/bin'),
  join(process.env['HOME'] ?? '', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/opt/llama.cpp/bin',
  join(process.env['HOME'] ?? '', 'llama.cpp/build/bin')
]

/**
 * Both shapes of llama.cpp, newest-style first.
 *
 * Order matters: `llama serve` is the current distribution, while a stale
 * distro `llama-server` often sits in /usr/bin alongside it. Preferring the
 * unified CLI avoids silently driving a build the user does not actually use —
 * which is how a working GPU can look like a broken one.
 */
const CANDIDATE_NAMES: Array<{ name: string; kind: BinaryKind }> = [
  { name: 'llama', kind: 'unified' },
  { name: 'llama-server', kind: 'llama-server' }
]

export interface Candidate {
  path: string
  kind: BinaryKind
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Every llama.cpp executable we can find, in preference order. */
export function discoverBinaries(explicit?: string): Candidate[] {
  const found: Candidate[] = []
  const seen = new Set<string>()

  if (explicit && isExecutable(explicit)) {
    found.push({ path: explicit, kind: guessKind(explicit) })
    seen.add(explicit)
  }
  for (const { name, kind } of CANDIDATE_NAMES) {
    for (const dir of SEARCH_DIRS) {
      const path = join(dir, name)
      if (!seen.has(path) && isExecutable(path)) {
        found.push({ path, kind })
        seen.add(path)
      }
    }
  }
  return found
}

function guessKind(path: string): BinaryKind {
  return basename(path) === 'llama-server' ? 'llama-server' : 'unified'
}

/**
 * llama.cpp writes --version and --help to stderr, and the ROCm/CUDA backends
 * add device-init noise, so both streams are read and filtered. A non-zero exit
 * is not fatal: --version exits non-zero on some builds.
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
  for (const match of helpText.matchAll(/(--[a-z0-9][a-z0-9-]*)/gi)) flags.add(match[1]!)
  return [...flags].sort()
}

/** "  ROCm0: AMD Radeon RX 6600 (8176 MiB, 8142 MiB free)" */
export function parseDevices(listText: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  const re = /^\s*(\S+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/gm
  for (const m of listText.matchAll(re)) {
    devices.push({ id: m[1]!, name: m[2]!, totalMiB: Number(m[3]), freeMiB: Number(m[4]) })
  }
  return devices
}

export function parseVersion(versionText: string): string {
  const m = versionText.match(/^version:\s*(.+)$/m)
  return m ? m[1]!.trim() : 'unknown'
}

/**
 * Newer builds document `--flash-attn [on|off|auto]`; older ones show the flag
 * with no value. Passing a value to the old form (or omitting it on the new
 * form) makes llama.cpp exit during argument parsing.
 */
export function parseFlashAttnStyle(helpText: string): 'bare' | 'value' {
  return /--flash-attn\s*\[?\s*on\s*\|\s*off/i.test(helpText) ? 'value' : 'bare'
}

/** The unified CLI advertises subcommands; the standalone server does not. */
export function detectKind(bareHelpText: string, fallback: BinaryKind): BinaryKind {
  if (/^\s*Available commands:/im.test(bareHelpText) && /^\s*serve\b/im.test(bareHelpText)) {
    return 'unified'
  }
  return fallback
}

export function argvPrefixFor(kind: BinaryKind): string[] {
  return kind === 'unified' ? ['serve'] : []
}

export async function probeBinary(candidate: Candidate): Promise<BinaryInfo> {
  // Ask the binary what it is rather than trusting its filename.
  const bareHelp = await capture(candidate.path, ['--help'])
  const kind = detectKind(bareHelp, candidate.kind)
  const prefix = argvPrefixFor(kind)

  const [versionText, helpText, listText] = await Promise.all([
    capture(candidate.path, ['--version']),
    // The unified CLI's flags live under the subcommand, not at top level.
    prefix.length ? capture(candidate.path, [...prefix, '--help']) : Promise.resolve(bareHelp),
    capture(candidate.path, [...prefix, '--list-devices'])
  ])

  const version = parseVersion(versionText)
  return {
    path: candidate.path,
    kind,
    argvPrefix: prefix,
    version,
    flags: parseFlags(helpText),
    flashAttnStyle: parseFlashAttnStyle(helpText),
    devices: parseDevices(listText),
    label: `${kind === 'unified' ? 'llama serve' : 'llama-server'} — ${version}`
  }
}

/** Probe every candidate, dropping any that fail to run at all. */
export async function probeAll(explicit?: string): Promise<BinaryInfo[]> {
  const results = await Promise.allSettled(discoverBinaries(explicit).map(probeBinary))
  return results
    .filter((r): r is PromiseFulfilledResult<BinaryInfo> => r.status === 'fulfilled')
    .map((r) => r.value)
}

/**
 * Fedora's llama-cpp reports `version: 0 (unknown)`, so the version string is
 * not a usable cache key. Identity is the binary's size + mtime.
 */
export async function binaryFingerprint(path: string): Promise<string> {
  const s = await stat(path)
  return `${path}:${s.size}:${Math.trunc(s.mtimeMs)}`
}

/**
 * Free VRAM moves as other processes come and go, so the planner re-reads it at
 * launch time rather than trusting the cached probe.
 */
export async function readDevices(binary: BinaryInfo): Promise<GpuDevice[]> {
  return parseDevices(await capture(binary.path, [...binary.argvPrefix, '--list-devices']))
}
