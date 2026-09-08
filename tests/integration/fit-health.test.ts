import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { probeAll } from '../../src/main/probe.js'
import { fitParams, parseFitOutput } from '../../src/main/fit.js'
import { runHealthCheck } from '../../src/main/health.js'
import { buildArgs } from '../../src/main/supervisor.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'

const MODEL = execFileSync('bash',['-c','ls ~/.cache/huggingface/hub/*/snapshots/*/*.gguf | grep -v mmproj | head -1'],{encoding:'utf8'}).trim()
let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}

console.log('parseFitOutput')
const p1 = parseFitOutput('0.00.28 I llama_fit_params: printing fitted CLI arguments to stdout...\n-c 32768 -ngl -1')
assert.deepEqual({c:p1!.contextSize, n:p1!.gpuLayers}, {c:32768, n:-1}); ok('parses ctx and ngl, ignoring log lines')
assert.equal(parseFitOutput('no arguments here'), null); ok('returns null on unparseable output')
const p2 = parseFitOutput('-c 4096 -ngl 12')
assert.equal(p2!.gpuLayers, 12); ok('parses a partial offload suggestion')

console.log('buildArgs: auto-fit must OMIT -ngl/-c or it silently disables --fit')
const bins = await probeAll()
const bin = bins[0]!
console.log(`   using ${bin.label} (${bin.path})`)
const auto = buildArgs({ modelPath: MODEL, ...DEFAULT_LAUNCH_CONFIG, autoFit: true }, 1234, bin)
assert.ok(!auto.includes('--ctx-size'), 'no --ctx-size'); assert.ok(!auto.includes('--gpu-layers'), 'no --gpu-layers')
ok('auto-fit omits both -c and -ngl')
assert.deepEqual(auto.slice(auto.indexOf('--fit'), auto.indexOf('--fit')+2), ['--fit','on'])
ok('auto-fit passes --fit on explicitly')

const manual = buildArgs({ modelPath: MODEL, ...DEFAULT_LAUNCH_CONFIG, autoFit: false, contextSize: 8192, gpuLayers: 7 }, 1234, bin)
assert.ok(manual.includes('--ctx-size') && manual[manual.indexOf('--ctx-size')+1] === '8192')
assert.ok(manual.includes('--gpu-layers') && manual[manual.indexOf('--gpu-layers')+1] === '7')
assert.ok(!manual.includes('--fit')); ok('manual mode sets both explicitly and leaves --fit at the default')

console.log('fit-params against the real binary')
const fit = await fitParams(bin, MODEL)
console.log(`   llama.cpp suggests: ${fit?.raw}`)
assert.ok(fit && fit.raw.length > 0); ok('returns a real suggestion')
assert.ok(fit!.contextSize && fit!.contextSize > 0); ok(`context ${fit!.contextSize}`)

console.log('health check against the real binary (loads model, generates a token)')
const res = await runHealthCheck(bin, MODEL, 999)
res.steps.forEach(s=>console.log(`   ${s.ok?'PASS':'FAIL'} ${s.step.padEnd(10)} ${s.ms}ms  ${s.detail}`))
assert.equal(res.ok, true, res.error ?? ''); ok('reports the working binary as healthy')
assert.ok(res.tokensPerSecond && res.tokensPerSecond > 0); ok(`measured ${res.tokensPerSecond!.toFixed(1)} tok/s`)
assert.deepEqual(res.steps.map(s=>s.step), ['spawn','load','ready','inference','stop'])
ok('all five steps ran in order')

console.log('health check must FAIL a bad binary')
const bad = await runHealthCheck({ ...bin, path: '/bin/true', argvPrefix: [], flags: [] }, MODEL, 0)
assert.equal(bad.ok, false); ok(`rejects a non-llama binary: ${JSON.stringify(bad.error?.slice(0,60))}`)

const badModel = await runHealthCheck(bin, '/nonexistent/nope.gguf', 0)
assert.equal(badModel.ok, false); ok(`rejects a missing model: ${JSON.stringify(badModel.error?.slice(0,60))}`)

console.log(`\n${n} assertions passed`)
process.exit(0)
