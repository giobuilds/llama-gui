import assert from 'node:assert/strict'
import { buildArgs, pickFreePort, isAlive, probeHealth } from '../../src/main/supervisor.js'
import { LogBuffer, LineSplitter } from '../../src/main/logBuffer.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import { launchConfigSchema } from '@shared/schema.js'

let pass = 0
const t = (name: string, fn: () => void) => { fn(); pass++; console.log('  ok', name) }

console.log('buildArgs')
const cfg = { modelPath: '/models/m.gguf', ...DEFAULT_LAUNCH_CONFIG, alias: 'test', extraArgs: '--mlock --no-mmap' }
const SERVER_BIN = { path:'/usr/bin/llama-server', kind:'llama-server' as const, argvPrefix:[], version:'b6153',
  flags:['--flash-attn'], flashAttnStyle:'bare' as const, devices:[], label:'llama-server' }
const UNIFIED_BIN = { ...SERVER_BIN, path:'/home/x/.local/bin/llama', kind:'unified' as const,
  argvPrefix:['serve'], flashAttnStyle:'value' as const, label:'llama serve' }
const args = buildArgs(cfg, 12345, SERVER_BIN)
t('includes model and port', () => {
  assert.deepEqual(args.slice(0, 6), ['--model', '/models/m.gguf', '--host', '127.0.0.1', '--port', '12345'])
})
t('bare flash-attn style emits no value', () => {
  const i = args.indexOf('--flash-attn')
  assert.ok(i >= 0)
  assert.ok(args[i+1] === undefined || args[i+1]!.startsWith('--'), 'no on/off after it')
})

// The unified CLI needs a subcommand and a valued --flash-attn; getting either
// wrong makes llama.cpp exit during argument parsing rather than start.
const uArgs = buildArgs(cfg, 12345, UNIFIED_BIN)
t('unified CLI gets the serve subcommand first', () => assert.equal(uArgs[0], 'serve'))
t('unified CLI gets --flash-attn on', () => {
  assert.deepEqual(uArgs.slice(uArgs.indexOf('--flash-attn'), uArgs.indexOf('--flash-attn')+2), ['--flash-attn','on'])
})
t('unified CLI gets --flash-attn off when disabled', () => {
  const off = buildArgs({...cfg, flashAttn:false}, 1, UNIFIED_BIN)
  assert.deepEqual(off.slice(off.indexOf('--flash-attn'), off.indexOf('--flash-attn')+2), ['--flash-attn','off'])
})
t('llama-server omits flash-attn entirely when disabled', () => {
  assert.ok(!buildArgs({...cfg, flashAttn:false}, 1, SERVER_BIN).includes('--flash-attn'))
})
t('enables telemetry endpoints', () => {
  for (const f of ['--slots', '--metrics', '--props', '--jinja']) assert.ok(args.includes(f), f)
})
t('does NOT pass --no-webui', () => assert.ok(!args.includes('--no-webui')))
t('flash-attn respected', () => assert.ok(args.includes('--flash-attn')))
t('threads omitted when -1', () => assert.ok(!args.includes('--threads')))
t('extra args split on whitespace', () => {
  assert.ok(args.includes('--mlock') && args.includes('--no-mmap'))
})
t('every arg is a string', () => args.forEach(a => assert.equal(typeof a, 'string')))

console.log('schema rejects hostile input')
t('rejects path traversal-free but empty model', () => {
  assert.throws(() => launchConfigSchema.parse({ ...cfg, modelPath: '' }))
})
t('rejects non-integer gpuLayers', () => {
  assert.throws(() => launchConfigSchema.parse({ ...cfg, gpuLayers: 1.5 }))
})
t('rejects unknown cache type', () => {
  assert.throws(() => launchConfigSchema.parse({ ...cfg, cacheTypeK: 'q3_k' }))
})

console.log('LineSplitter')
t('holds partial line', () => {
  const s = new LineSplitter()
  assert.deepEqual(s.push('abc'), [])
  assert.deepEqual(s.push('def\nghi'), ['abcdef'])
  assert.deepEqual(s.flush(), ['ghi'])
})
t('treats \\r as a break', () => {
  const s = new LineSplitter()
  assert.deepEqual(s.push('a\rb\r\nc\n'), ['a', 'b', 'c'])
})

console.log('LogBuffer')
t('respects capacity', () => {
  const b = new LogBuffer(10)
  for (let i = 0; i < 50; i++) b.append('stderr', `line ${i}`)
  assert.equal(b.since(0).length, 10)
  assert.equal(b.latestSeq, 50)
})
t('since() returns only newer lines', () => {
  const b = new LogBuffer(100)
  for (let i = 0; i < 20; i++) b.append('stderr', `l${i}`)
  const d = b.since(15)
  assert.equal(d.length, 5)
  assert.equal(d[0]!.seq, 16)
})
t('since() past the evicted window returns what remains', () => {
  const b = new LogBuffer(5)
  for (let i = 0; i < 20; i++) b.append('stderr', `l${i}`)
  assert.equal(b.since(0).length, 5)
  assert.equal(b.since(100).length, 0)
})

console.log('process helpers')
t('isAlive true for self', () => assert.equal(isAlive(process.pid), true))
t('isAlive false for impossible pid', () => assert.equal(isAlive(0x7ffffffe), false))

const p1 = await pickFreePort(), p2 = await pickFreePort()
t('pickFreePort returns usable ports', () => {
  assert.ok(p1 > 1024 && p1 < 65536, String(p1))
  assert.ok(p2 > 1024)
})
t('probeHealth false on a closed port', async () => {})
assert.equal(await probeHealth(`http://127.0.0.1:${p1}`), false)
console.log('  ok probeHealth false on closed port')
pass++

console.log(`\n${pass} assertions passed`)
