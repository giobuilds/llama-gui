import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { probeSandbox, runInSandbox } from '../../src/main/coding/sandbox.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

// This suite needs bubblewrap. Where it is absent the probe says so and that
// is the whole result: Coding would launch read-only there, and this suite
// reports nothing rather than pretending.
const probe = await probeSandbox()
if (!probe.ok) {
  console.log(`  skipped: ${probe.reason}`)
  console.log('\n0 assertions passed')
  process.exit(0)
}

const base = await mkdtemp(join(tmpdir(), 'sandbox-'))
const project = join(base, 'project')
const workspace = join(base, 'workspace')
await mkdir(join(project, 'node_modules', 'dep'), { recursive: true })
await writeFile(join(project, 'node_modules', 'dep', 'index.js'), 'module.exports = "dep"\n')
await mkdir(workspace)
await writeFile(join(workspace, 'hello.js'), 'console.log("hello from", process.cwd() === process.env.PWD ? "cwd" : process.cwd())\n')
const opts = { workspace, projectRoot: project, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 }

console.log('a command runs in the workspace')
{
  const r = await runInSandbox({ ...opts, command: 'node hello.js && echo done' })
  assert.equal(r.exitCode, 0); ok('and exits with its own code')
  assert.match(r.stdout, /hello from/); assert.match(r.stdout, /done/); ok('its output comes back')
  const r2 = await runInSandbox({ ...opts, command: 'exit 3' })
  assert.equal(r2.exitCode, 3); ok('a failing command reports its exit code')
}

console.log('\nthe box is the whole world')
{
  const r = await runInSandbox({ ...opts, command: `ls ${homedir()} ${homedir()}/.ssh 2>&1; echo "code $?"` })
  assert.match(r.stdout, /No such file|cannot access/); ok('the home directory does not exist inside')
  const net = await runInSandbox({ ...opts, command: `node -e 'fetch("http://127.0.0.1:1/").then(()=>console.log("reached")).catch(e=>console.log("blocked", e.cause?.code))'` })
  assert.match(net.stdout, /blocked/); ok('there is no network, loopback included')
  const w = await runInSandbox({ ...opts, command: 'echo x > inside.txt; echo x > node_modules/evil.js 2>&1; echo x > /usr/evil 2>&1; echo end' })
  assert.equal(await readFile(join(workspace, 'inside.txt'), 'utf8'), 'x\n'); ok('a write to the workspace lands and is visible outside')
  assert.equal(await stat(join(project, 'node_modules', 'evil.js')).then(() => true, () => false), false); ok('the lent dependency tree is read only')
  assert.match(w.stdout + w.stderr, /Read-only|read-only|Permission/); ok('and the system is')
  const dep = await runInSandbox({ ...opts, command: `node -e 'console.log(require("dep"))'` })
  assert.match(dep.stdout, /dep/); ok('but the dependency tree is there to require from')
}

console.log('\nlimits hold')
{
  const t0 = Date.now()
  const r = await runInSandbox({ ...opts, command: 'sleep 30; echo never', timeoutMs: 1500 })
  assert.equal(r.timedOut, true); ok('a command past its time is killed and reported as timed out')
  assert.ok(Date.now() - t0 < 10_000); ok('promptly')
  assert.ok(!r.stdout.includes('never')); ok('with no output from after the kill')

  const big = await runInSandbox({ ...opts, command: 'node -e \'process.stdout.write("y".repeat(200000))\'', maxOutputBytes: 1000 })
  assert.equal(big.stdout.length, 1000); assert.equal(big.stdoutTruncated, true); ok('output past the cap is dropped and the drop is reported')

  const abort = new AbortController()
  setTimeout(() => abort.abort(), 500)
  const c = await runInSandbox({ ...opts, command: 'sleep 30', signal: abort.signal })
  assert.equal(c.cancelled, true); ok('a stop from outside ends it, reported as cancelled')
}

console.log('\nnothing outlives the run')
{
  const r = await runInSandbox({ ...opts, command: 'sleep 47 & sleep 47 & echo started; sleep 0.3', timeoutMs: 2000 })
  assert.match(r.stdout, /started/)
  const { execFileSync } = await import('node:child_process')
  // The pid namespace tears down when the box exits, but not to the
  // microsecond; give the kernel a moment before counting.
  const count = (): string => execFileSync('sh', ['-c', "ps -eo args | grep -c '^[s]leep 47' || true"]).toString().trim()
  let alive = count()
  for (let i = 0; i < 20 && alive !== '0'; i++) { await new Promise((r) => setTimeout(r, 100)); alive = count() }
  assert.equal(alive, '0'); ok('background children started by the command are gone once it ends')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
