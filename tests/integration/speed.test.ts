import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { listRepoFiles } from '../../src/main/downloads.js'
import { parseGgufHeader } from '../../src/main/gguf.js'
import type { GgufMetadata } from '../../src/main/gguf.js'
import { activeParameters, estimateSpeed, comfortOf, type MachineProfile } from '../../src/main/speed.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
// Fixed figures on purpose: this suite tests the arithmetic, not the machine,
// so it must not change its answer because something else is using the GPU.
const MACHINE: MachineProfile = {
  gpuBytesPerSecond: 171e9, cpuBytesPerSecond: 22e9,
  vramBytes: 7.0e9, ramBytes: 20e9, overheadCeilingTokensPerSecond: 630
}

async function header(repo: string, file: string, size: number): Promise<GgufMetadata> {
  const url=`https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`
  const res=await fetch(url,{headers:{Range:'bytes=0-1048575'},signal:AbortSignal.timeout(25000)})
  const { kv, arrayLengths } = parseGgufHeader(Buffer.from(await res.arrayBuffer()), { allowTruncated: true })
  const arch = kv.get('general.architecture') as string
  const num=(v:unknown)=> typeof v==='number' && Number.isFinite(v) ? v : null
  return {
    path:file, fileName:basename(file), fileSize:size, architecture:arch, name:file,
    blockCount:num(kv.get(`${arch}.block_count`)), contextLength:num(kv.get(`${arch}.context_length`)),
    embeddingLength:num(kv.get(`${arch}.embedding_length`)), headCount:num(kv.get(`${arch}.attention.head_count`)),
    headCountKv:num(kv.get(`${arch}.attention.head_count_kv`)), quant:null, parameterCount:null,
    keyLength:num(kv.get(`${arch}.attention.key_length`)), valueLength:num(kv.get(`${arch}.attention.value_length`)),
    hasChatTemplate:false, vocabSize:arrayLengths.get('tokenizer.ggml.tokens') ?? null, isProjector:false,
    feedForwardLength:num(kv.get(`${arch}.feed_forward_length`)),
    expertCount:num(kv.get(`${arch}.expert_count`)),
    expertUsedCount:num(kv.get(`${arch}.expert_used_count`)),
    expertFeedForwardLength:num(kv.get(`${arch}.expert_feed_forward_length`))
  }
}

console.log('active-parameter maths vs the labels the publishers advertise')
const CASES = [
  { repo:'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', match:/Q4_0/i, totalB:30, activeB:3, label:'30B-A3B' },
  { repo:'unsloth/gemma-4-26B-A4B-it-qat-GGUF',       match:/Q4_K_XL/i, totalB:26, activeB:4, label:'26B-A4B' },
  { repo:'ggml-org/gpt-oss-20b-GGUF',                 match:/MXFP4/i,  totalB:21, activeB:3.6, label:'20b (~3.6B active)' }
]
for (const c of CASES) {
  const files=(await listRepoFiles(c.repo)).filter(f=>!f.isProjector)
  const f=files.find(x=>c.match.test(x.path))!
  const meta=await header(c.repo, f.path, f.size)
  const p=activeParameters(meta)!
  const tErr=Math.abs(p.total/1e9-c.totalB)/c.totalB*100
  const aErr=Math.abs(p.active/1e9-c.activeB)/c.activeB*100
  console.log(`   ${c.label.padEnd(20)} computed ${(p.total/1e9).toFixed(1)}B total / ${(p.active/1e9).toFixed(2)}B active   (${tErr.toFixed(0)}% / ${aErr.toFixed(0)}% off)`)
  assert.ok(p.moe, `${c.label} should be detected as MoE`)
  assert.ok(tErr < 25, `total off by ${tErr.toFixed(0)}%`)
  assert.ok(aErr < 30, `active off by ${aErr.toFixed(0)}%`)
  ok(`${c.label}: MoE detected, totals and active params within tolerance`)
}

console.log('\ndense models are unchanged by the MoE path')
const dense: GgufMetadata = { ...(await header('ggml-org/Qwen2.5-VL-3B-Instruct-GGUF','Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',1929901056)) }
const dp=activeParameters(dense)!
assert.equal(dp.moe,false); assert.equal(dp.active,dp.total)
ok('a dense model reads all of itself per token')

console.log('\npredicted vs measured on models actually benchmarked here')
const vl=estimateSpeed(dense, MACHINE)
console.log(`   Qwen2.5-VL-3B Q4_K_M: predicted ${vl.tokensPerSecond!.toFixed(1)} tok/s, measured 94.7`)
assert.ok(Math.abs(vl.tokensPerSecond!-94.7)/94.7 < 0.20, 'dense prediction outside 20%')
ok(`dense prediction within 20% (${((vl.tokensPerSecond!-94.7)/94.7*100).toFixed(0)}%)`)
assert.equal(vl.placement,'gpu'); ok('placed fully on the GPU, which is where it ran')

console.log('\nplacement decisions')
const huge={...dense, fileSize: 40e9}
assert.equal(estimateSpeed(huge,MACHINE).placement,'wont-load'); ok('a model beyond VRAM+RAM is reported as unloadable')
assert.equal(estimateSpeed(huge,MACHINE).tokensPerSecond,null); ok('and offered no speed rather than a fictional one')
const noGpu=estimateSpeed(dense,{...MACHINE,gpuBytesPerSecond:null,vramBytes:0})
assert.equal(noGpu.placement,'cpu'); ok('with no GPU it predicts the CPU path')
assert.ok(noGpu.tokensPerSecond! < vl.tokensPerSecond!); ok('and predicts it slower')

console.log('\ncomfort bands')
assert.equal(comfortOf(80),'fast'); assert.equal(comfortOf(20),'comfortable')
assert.equal(comfortOf(8),'slow'); assert.equal(comfortOf(2),'painful'); assert.equal(comfortOf(null),'unknown')
ok('speeds map to comfort bands around reading pace')

console.log(`\n${n} assertions passed`)
process.exit(0)
