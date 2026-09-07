import { spawn } from 'node:child_process'
import type { BinaryInfo, HealthCheckResult, HealthStep } from '@shared/types.js'
import { pickFreePort, probeHealth, isAlive } from './supervisor.js'

/**
 * End-to-end verification that a llama.cpp build actually works.
 *
 * A binary that runs, prints its version and lists devices can still segfault
 * the moment it launches a compute kernel — that is exactly what a broken ROCm
 * build does, and every cheaper check passes it. So this loads a real model and
 * generates a real token, which is the only step that catches it.
 *
 * Deliberately small: 256 context, a handful of predicted tokens. The point is
 * "does this stack work at all" — but a single token yields no usable rate, so
 * it generates enough to report a throughput figure worth showing.
 */

const READY_TIMEOUT_MS = 120_000
/** Enough tokens for a meaningful tok/s, few enough to stay a quick check. */
const PROBE_TOKENS = 8
const INFERENCE_TIMEOUT_MS = 120_000

export async function runHealthCheck(
  binary: BinaryInfo,
  modelPath: string,
  /** Offload as configured, since GPU offload is what tends to be broken. */
  gpuLayers: number
): Promise<HealthCheckResult> {
  const steps: HealthCheckResult['steps'] = []
  const started = Date.now()
  let mark = started
  const record = (step: HealthStep, ok: boolean, detail: string): void => {
    const now = Date.now()
    steps.push({ step, ok, detail, ms: now - mark })
    mark = now
  }

  const fail = (error: string): HealthCheckResult => ({
    binaryPath: binary.path,
    ok: false,
    steps,
    error,
    tokensPerSecond: null,
    checkedAt: Date.now()
  })

  const port = await pickFreePort()
  const args = [
    ...binary.argvPrefix,
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', '256',
    '--gpu-layers', String(gpuLayers),
    '--jinja'
  ]
  // --fit would override the offload we are specifically trying to exercise.
  if (binary.flags.includes('--fit')) args.push('--fit', 'off')

  const child = spawn(binary.path, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const tail: string[] = []
  const keep = (chunk: Buffer): void => {
    tail.push(chunk.toString('utf8'))
    if (tail.length > 80) tail.splice(0, tail.length - 80)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)

  const lastOutput = (): string => tail.join('').split('\n').filter(Boolean).slice(-4).join(' | ')

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })

  if (!child.pid) return fail('Could not spawn the binary.')
  record('spawn', true, `pid ${child.pid} on port ${port}`)

  const stop = (): void => {
    if (child.pid && isAlive(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }

  // --- wait for /health, watching for an early exit ---
  const deadline = Date.now() + READY_TIMEOUT_MS
  let ready = false
  while (Date.now() < deadline) {
    if (exited) {
      const e = exited as { code: number | null; signal: NodeJS.Signals | null }
      record('load', false, lastOutput())
      const how = e.signal ? `killed by ${e.signal}` : `exit code ${e.code}`
      return fail(
        e.signal === 'SIGSEGV'
          ? `The binary crashed (${how}) while loading the model. This build cannot run this model on the current backend.`
          : `The binary exited during load (${how}).`
      )
    }
    if (await probeHealth(`http://127.0.0.1:${port}`)) {
      ready = true
      break
    }
    await delay(400)
  }
  if (!ready) {
    stop()
    record('ready', false, lastOutput())
    return fail('The server never became healthy within the timeout.')
  }
  record('load', true, 'model loaded')
  record('ready', true, `/health OK on port ${port}`)

  // --- the step that actually catches a broken compute backend ---
  let tokensPerSecond: number | null = null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: PROBE_TOKENS,
        temperature: 0
      }),
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS)
    })
    if (!res.ok) {
      stop()
      record('inference', false, `HTTP ${res.status}`)
      return fail(`Inference request failed with HTTP ${res.status}.`)
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { completion_tokens?: number }
      timings?: { predicted_per_second?: number }
    }
    const produced = body.usage?.completion_tokens ?? null
    tokensPerSecond = body.timings?.predicted_per_second ?? null
    if (!produced) {
      stop()
      record('inference', false, 'the server returned no tokens')
      return fail('The server accepted the request but generated no tokens.')
    }
    record(
      'inference',
      true,
      `generated ${produced} token${produced === 1 ? '' : 's'}` +
        (tokensPerSecond ? ` at ${tokensPerSecond.toFixed(1)} tok/s` : '')
    )
  } catch (err) {
    stop()
    // A crash mid-request shows up here as a dropped connection, which is
    // exactly how a compute-kernel segfault presents.
    const crashed = exited as { signal: NodeJS.Signals | null } | null
    record('inference', false, lastOutput())
    return fail(
      crashed?.signal === 'SIGSEGV'
        ? 'The binary crashed while generating. The model loads, but this backend cannot run inference — a GPU build mismatch usually causes this.'
        : `Inference failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  stop()
  record('stop', true, 'stopped cleanly')

  return {
    binaryPath: binary.path,
    ok: true,
    steps,
    error: null,
    tokensPerSecond,
    checkedAt: Date.now()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
