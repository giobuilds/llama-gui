import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BinaryInfo, FitSuggestion } from '@shared/types.js'

const run = promisify(execFile)

/**
 * Ask llama.cpp what it would pick for this model on this machine.
 *
 * `llama fit-params` prints fitted CLI arguments to stdout, e.g. `-c 32768 -ngl -1`.
 * It knows the real allocator, so it is authoritative in a way an external
 * estimate cannot be — the planner's job is to explain the trade-off, not to
 * out-guess this.
 */
export async function fitParams(
  binary: BinaryInfo,
  modelPath: string
): Promise<FitSuggestion | null> {
  if (binary.kind !== 'unified') return null
  let out: string
  try {
    const { stdout, stderr } = await run(binary.path, ['fit-params', '--model', modelPath], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000
    })
    // The fitted arguments go to stdout; progress logging goes to stderr.
    out = stdout.trim() || stderr.trim()
  } catch {
    return null
  }
  return parseFitOutput(out)
}

export function parseFitOutput(text: string): FitSuggestion | null {
  // Take the last non-empty line: earlier lines are log output.
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .pop()
  if (!line) return null

  const ctx = line.match(/-c\s+(\d+)/)
  const ngl = line.match(/-ngl\s+(-?\d+)/)
  return {
    contextSize: ctx ? Number(ctx[1]) : null,
    gpuLayers: ngl ? Number(ngl[1]) : null,
    raw: line
  }
}
