import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { ServerSupervisor, pickFreePort } from '../../src/main/supervisor.js'
import type { ServerPhase } from '@shared/types.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import { tmpdir } from 'node:os'
/** Bundled suites run from tests/.build, so fixtures sit one level up. */
const FIXTURES = new URL('../fixtures/', import.meta.url).pathname
/** Scratch files belong in the system temp directory, never in the repo. */
const SP = tmpdir()

const mkBin = (path: string) => ({ path, kind: 'llama-server' as const, argvPrefix: [], version: 'test',
  flags: ['--flash-attn'], flashAttnStyle: 'bare' as const, devices: [], label: 'test' })

const HANDOFF = `${SP}/handoff.json`
import { probeAll } from '../../src/main/probe.js'
const DISCOVERED = (await probeAll())[0]
if (!DISCOVERED) throw new Error('no llama.cpp binary found on this system')
const BIN = DISCOVERED.path
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function waitFor(sup: ServerSupervisor, phases: ServerPhase[], ms = 25000): Promise<ServerPhase> {
  return new Promise((resolve, reject) => {
    if (phases.includes(sup.status.phase)) return resolve(sup.status.phase)
    const to = setTimeout(() => { sup.off('status', on); reject(new Error(`timeout waiting for ${phases} (stuck in ${sup.status.phase})`)) }, ms)
    const on = (s: { phase: ServerPhase }) => {
      if (phases.includes(s.phase)) { clearTimeout(to); sup.off('status', on); resolve(s.phase) }
    }
    sup.on('status', on)
  })
}

let n = 0
const ok = (m: string) => { n++; console.log('  ok', m) }

// ---- 1. crash path: a model that does not exist ----------------------------
console.log('crash path (missing model file)')
await rm(HANDOFF, { force: true })
{
  const sup = new ServerSupervisor(DISCOVERED, HANDOFF)
  await sup.start({ modelPath: '/nonexistent/definitely-not-a-model.gguf', ...DEFAULT_LAUNCH_CONFIG })
  const pid = sup.status.pid
  assert.ok(pid && pid > 0, 'got a pid')
  ok('spawned and recorded a pid')
  assert.ok(existsSync(HANDOFF), 'handoff written')
  ok('handoff file written on start')

  const phase = await waitFor(sup, ['crashed', 'ready'])
  assert.equal(phase, 'crashed')
  ok('reaches phase=crashed, not ready')
  assert.ok(sup.status.error, 'error is populated')
  ok(`error captured: ${JSON.stringify(sup.status.error!.slice(0, 60))}`)
  assert.ok(sup.logs.since(0).some((l) => /failed to load model/i.test(l.text)))
  ok('stderr failure line landed in the log buffer')
  await sleep(200)
  assert.ok(!existsSync(HANDOFF), 'handoff removed after exit')
  ok('handoff cleaned up on exit')
  assert.equal(sup.status.pid, null)
  ok('pid cleared after exit')
}

// ---- 2. adoptOrReap: stale handoff, dead pid --------------------------------
console.log('adoptOrReap with a dead pid')
{
  await writeFile(HANDOFF, JSON.stringify({
    pid: 0x7ffffffe, port: 9, startedAt: Date.now(),
    config: { modelPath: '/x.gguf', ...DEFAULT_LAUNCH_CONFIG }
  }))
  const sup = new ServerSupervisor(DISCOVERED, HANDOFF)
  await sup.adoptOrReap()
  assert.equal(sup.status.phase, 'stopped')
  assert.equal(sup.status.adopted, false)
  ok('stays stopped, does not adopt a dead pid')
  assert.ok(!existsSync(HANDOFF))
  ok('stale handoff reaped')
}

// ---- 3. adoptOrReap: live + healthy -> adopt --------------------------------
console.log('adoptOrReap with a live healthy server')
{
  const port = await pickFreePort()
  const fake = spawn(process.execPath, [`${FIXTURES}fake-server.mjs`, String(port)], { stdio: 'ignore', detached: true })
  await sleep(600)
  await writeFile(HANDOFF, JSON.stringify({
    pid: fake.pid, port, startedAt: Date.now(),
    config: { modelPath: '/adopted.gguf', ...DEFAULT_LAUNCH_CONFIG }
  }))
  const sup = new ServerSupervisor(DISCOVERED, HANDOFF)
  await sup.adoptOrReap()
  assert.equal(sup.status.phase, 'ready')
  ok('adopts a healthy running server')
  assert.equal(sup.status.adopted, true)
  assert.equal(sup.status.port, port)
  assert.equal(sup.status.config?.modelPath, '/adopted.gguf')
  ok('restores port and launch config from the handoff')
  await sup.shutdown()
  await sleep(300)
  try { process.kill(fake.pid!, 0); assert.fail('fake still alive') } catch { ok('shutdown terminated the adopted process') }
}

// ---- 4. adoptOrReap: live but unhealthy -> leave alone -----------------------
console.log('adoptOrReap with a live but unhealthy process')
{
  const port = await pickFreePort()
  const fake = spawn(process.execPath, [`${FIXTURES}fake-server.mjs`, String(port), 'sick'], { stdio: 'ignore', detached: true })
  await sleep(600)
  await writeFile(HANDOFF, JSON.stringify({
    pid: fake.pid, port, startedAt: Date.now(),
    config: { modelPath: '/x.gguf', ...DEFAULT_LAUNCH_CONFIG }
  }))
  const sup = new ServerSupervisor(DISCOVERED, HANDOFF)
  await sup.adoptOrReap()
  assert.equal(sup.status.phase, 'stopped')
  ok('does not adopt an unhealthy process')
  assert.ok(!existsSync(HANDOFF))
  ok('drops the handoff rather than claiming the process')
  process.kill(-fake.pid!, 'SIGKILL')
}

// ---- 5. double start is refused ---------------------------------------------
console.log('guard rails')
{
  const sup = new ServerSupervisor(DISCOVERED, HANDOFF)
  await sup.start({ modelPath: '/nope.gguf', ...DEFAULT_LAUNCH_CONFIG })
  await assert.rejects(() => sup.start({ modelPath: '/nope2.gguf', ...DEFAULT_LAUNCH_CONFIG }), /already running/)
  ok('refuses a second concurrent launch')
  await sup.shutdown()
}

await rm(HANDOFF, { force: true })
console.log(`\n${n} assertions passed`)
process.exit(0)
