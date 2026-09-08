import assert from 'node:assert/strict'
import { probeAll, readDevices } from '../../src/main/probe.js'
import { listRepoFiles } from '../../src/main/downloads.js'
import { estimateRepoFit, baseModelName } from '../../src/main/remoteFit.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const bin=(await probeAll())[0]!
const free=(await readDevices(bin))[0]?.freeMiB ?? null
console.log(`GPU free: ${free} MiB | binary: ${bin.label}\n`)

console.log('grouping quants of one model')
assert.equal(baseModelName('SmolLM2-135M-Instruct-Q4_K_M.gguf'), baseModelName('SmolLM2-135M-Instruct-Q2_K.gguf'))
ok('quants of the same model group together')
assert.equal(baseModelName('Model-F16.gguf'), baseModelName('Model-Q8_0.gguf')); ok('F16 groups with the quants')
assert.notEqual(baseModelName('Llama-3-8B-Q4_K_M.gguf'), baseModelName('Llama-3-70B-Q4_K_M.gguf'))
ok('different models in one repo stay separate')
assert.equal(baseModelName('big-Q4_K_M-00001-of-00003.gguf'), baseModelName('big-Q4_K_M.gguf'))
ok('split shards group with their base name')

for (const repo of ['unsloth/SmolLM2-135M-Instruct-GGUF','Qwen/Qwen2.5-0.5B-Instruct-GGUF','bartowski/Qwen2.5-14B-Instruct-GGUF']) {
  console.log(`\n${repo}`)
  const files = await listRepoFiles(repo)
  const fits = await estimateRepoFit(repo, files, free, bin)
  const byName = new Map(files.map(f=>[f.path,f]))
  for (const f of fits.sort((a,b)=>(byName.get(a.file)!.size)-(byName.get(b.file)!.size)).slice(0,6)) {
    const size = byName.get(f.file)!.size
    console.log(`   ${f.verdict.padEnd(8)} ${String(f.totalMiB ?? '?').padStart(6)} MiB VRAM  ${(size/1e9).toFixed(2)} GB  ${f.file}`)
  }
  assert.equal(fits.length, files.length); ok(`estimated all ${files.length} files`)
  assert.ok(fits.every(f=>f.verdict!=='unknown'), 'some headers unreadable')
  ok('read every header over HTTP Range')
  // Bigger file, never less VRAM.
  const sorted=[...fits].sort((a,b)=>byName.get(a.file)!.size-byName.get(b.file)!.size)
  for(let i=1;i<sorted.length;i++) assert.ok(sorted[i]!.totalMiB! >= sorted[i-1]!.totalMiB!, 'VRAM not monotonic with size')
  ok('estimated VRAM rises with file size')
}

/**
 * Absolute verdicts depend on how much VRAM is free at this moment, and
 * something else may be using the card — including this app, with a model
 * loaded. Those checks are skipped rather than failed when the GPU is busy; the
 * relative checks above hold regardless.
 */
const IDLE_VRAM_FLOOR_MIB = 3000
if (free !== null && free < IDLE_VRAM_FLOOR_MIB) {
  console.log(`\nskipping absolute fit checks: only ${free} MiB free, something else is using the GPU`)
  console.log(`\n${n} assertions passed`)
  process.exit(0)
}

console.log('\nsanity against the 8 GB card')
const small = await estimateRepoFit('unsloth/SmolLM2-135M-Instruct-GGUF', await listRepoFiles('unsloth/SmolLM2-135M-Instruct-GGUF'), free, bin)
assert.ok(small.every(f=>f.verdict==='full'), 'a 135M model should fit entirely')
ok('every quant of a 135M model fits fully')

const bigFiles = await listRepoFiles('bartowski/Qwen2.5-14B-Instruct-GGUF')
const big = await estimateRepoFit('bartowski/Qwen2.5-14B-Instruct-GGUF', bigFiles, free, bin)
const bigMap = new Map(bigFiles.map(f=>[f.path,f]))
const q8 = big.find(f=>/Q8_0/i.test(f.file) && !bigMap.get(f.file)!.shard)
assert.ok(q8 && q8.verdict !== 'full', `a 14B Q8_0 should not fully fit 8 GB (got ${q8?.verdict})`)
ok(`a 14B Q8_0 is correctly not "full" (${q8!.verdict}, needs ~${q8!.totalMiB} MiB)`)
const anyFull = big.some(f=>f.verdict==='full')
console.log(`   largest 14B quant that fits fully: ${big.filter(f=>f.verdict==='full').sort((a,b)=>bigMap.get(b.file)!.size-bigMap.get(a.file)!.size)[0]?.file ?? 'none'}`)
assert.ok(anyFull, 'expected at least one small 14B quant to fit'); ok('still finds the quants that do fit')

console.log(`\n${n} assertions passed`)
process.exit(0)
