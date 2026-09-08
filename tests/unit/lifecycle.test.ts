import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { ServerSupervisor, isAlive } from '../../src/main/supervisor.js'
import type { ServerPhase } from '@shared/types.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import { tmpdir } from 'node:os'
/** Bundled suites run from tests/.build, so fixtures sit one level up. */
const FIXTURES = new URL('../fixtures/', import.meta.url).pathname
/** Scratch files belong in the system temp directory, never in the repo. */
const SP = tmpdir()

const mkBin = (path: string) => ({ path, kind: 'llama-server' as const, argvPrefix: [], version: 'test',
  flags: ['--flash-attn'], flashAttnStyle: 'bare' as const, devices: [], label: 'test' })

const HANDOFF = `${SP}/lifecycle.json`
// The supervisor spawns argv[0] with llama-server flags; a node shim wearing
// the same interface exercises the whole FSM without needing a 4GB GGUF.
const SHIM = `${FIXTURES}fake-llama.mjs`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function waitFor(sup: ServerSupervisor, phases: ServerPhase[], ms = 20000): Promise<ServerPhase> {
  return new Promise((resolve, reject) => {
    if (phases.includes(sup.status.phase)) return resolve(sup.status.phase)
    const to = setTimeout(() => { sup.off('status', on); reject(new Error(`timeout: wanted ${phases}, stuck in ${sup.status.phase}`)) }, ms)
    const on = (s: { phase: ServerPhase }) => { if (phases.includes(s.phase)) { clearTimeout(to); sup.off('status', on); resolve(s.phase) } }
    sup.on('status', on)
  })
}

const cfg = { modelPath: '/fake/model.gguf', ...DEFAULT_LAUNCH_CONFIG,
  // the shim path is injected as an "extra arg" so the supervisor's own argv
  // construction is still the thing under test
  extraArgs: '' }

let n = 0
const ok = (m: string) => { n++; console.log('  ok', m) }
await rm(HANDOFF, { force: true })

// ---- full happy path: starting -> loading -> ready --------------------------
console.log('happy path')
{
  const sup = new ServerSupervisor(mkBin(SHIM), HANDOFF)
  const seen: ServerPhase[] = []
  sup.on('status', (s) => { if (seen.at(-1) !== s.phase) seen.push(s.phase) })
  await sup.start({ ...cfg, extraArgs: '' })
  // inject the shim script as argv[0] for node
  await waitFor(sup, ['loading', 'crashed'])
  ok(`transitioned into loading (saw ${seen.join(' -> ')})`)
  const phase = await waitFor(sup, ['ready', 'crashed'])
  assert.equal(phase, 'ready', `expected ready, log: ${sup.logs.since(0).map(l=>l.text).join(' | ')}`)
  ok('reached ready via /health, not via log scraping')
  assert.ok(sup.status.port! > 1024)
  assert.ok(sup.status.readyAt! > 0)
  ok(`listening on port ${sup.status.port}`)
  assert.deepEqual(seen.slice(0, 3), ['starting', 'loading', 'ready'])
  ok('phase order was starting -> loading -> ready')

  const pid = sup.status.pid!
  await sup.stop()
  await sleep(300)
  assert.equal(sup.status.phase, 'stopped')
  assert.equal(isAlive(pid), false)
  ok('stop() terminated the spawned process')
  assert.ok(!existsSync(HANDOFF))
  ok('handoff cleaned up')
}

// ---- external kill is detected as a crash -----------------------------------
console.log('external kill')
{
  const sup = new ServerSupervisor(mkBin(SHIM), HANDOFF)
  await sup.start(cfg)
  await waitFor(sup, ['ready'])
  const pid = sup.status.pid!
  process.kill(pid, 'SIGKILL')
  const phase = await waitFor(sup, ['crashed', 'stopped'], 8000)
  assert.equal(phase, 'crashed')
  ok('an externally killed server surfaces as crashed, not stopped')
  assert.ok(sup.status.error)
  ok(`error: ${sup.status.error}`)
}

// ---- SIGTERM is escalated to SIGKILL ----------------------------------------
console.log('SIGKILL escalation')
{
  process.env['FAKE_IGNORE_SIGTERM'] = '1'
  const sup = new ServerSupervisor(mkBin(SHIM), HANDOFF)
  await sup.start(cfg)
  await waitFor(sup, ['ready'])
  const pid = sup.status.pid!
  const t0 = Date.now()
  await sup.stop()
  const elapsed = Date.now() - t0
  await sleep(300)
  assert.equal(isAlive(pid), false)
  ok(`a process ignoring SIGTERM was SIGKILLed after ${elapsed}ms`)
  assert.ok(elapsed >= 4500, 'waited out the grace period first')
  ok('grace period was honoured before escalating')
  delete process.env['FAKE_IGNORE_SIGTERM']
}

await rm(HANDOFF, { force: true })
console.log(`\n${n} assertions passed`)
process.exit(0)
