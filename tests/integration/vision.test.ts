import assert from 'node:assert/strict'
import { listRepoFiles, projectorFor, isProjectorName } from '../../src/main/downloads.js'
import { pairProjectors } from '../../src/main/registry.js'
import { isProjectorHeader } from '../../src/main/gguf.js'
import { buildBenchArgs } from '../../src/main/bench.js'
import { buildArgs } from '../../src/main/supervisor.js'
import { probeAll } from '../../src/main/probe.js'
import { DEFAULT_LAUNCH_CONFIG } from '@shared/types.js'
import type { ModelEntry } from '../../src/main/registry.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const bin=(await probeAll())[0]!

console.log('identifying projectors')
assert.equal(isProjectorHeader('clip', undefined, 'x.gguf'), true); ok('architecture clip is a projector')
assert.equal(isProjectorHeader('llama', 'clip-vision', 'x.gguf'), true); ok('type clip-vision is a projector')
assert.equal(isProjectorHeader('llama', 'model', 'mmproj-x.gguf'), true); ok('mmproj- filename is the fallback')
assert.equal(isProjectorHeader('llama', 'model', 'SmolVLM.gguf'), false); ok('a real vision model is not a projector')
assert.equal(isProjectorName('a/mmproj-x.gguf'), true); assert.equal(isProjectorName('a/model.gguf'), false)
ok('remote files classified by the same convention')

console.log('pairing in the library')
const mk = (fileName: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  path: `/models/${fileName}`, fileName, fileSize: 100, architecture:'llama', name:fileName,
  blockCount:30, contextLength:4096, embeddingLength:576, headCount:9, headCountKv:3,
  quant:'Q8_0', parameterCount:null, hasChatTemplate:true, vocabSize:49152,
  isProjector:false, mtimeMs:0, ...extra
})
const paired = pairProjectors([
  mk('SmolVLM-Q8_0.gguf'),
  mk('mmproj-SmolVLM-Q8_0.gguf', { isProjector:true, architecture:'clip', blockCount:null }),
  mk('TextOnly-Q4_K_M.gguf', { quant:'Q4_K_M' })
])
assert.equal(paired.length, 2); ok('projectors are removed from the model list')
assert.ok(paired.find(m=>m.fileName==='SmolVLM-Q8_0.gguf')!.projectorPath?.includes('mmproj'))
ok('the vision model gets its projector attached')
assert.equal(paired.find(m=>m.fileName==='TextOnly-Q4_K_M.gguf')!.projectorPath, undefined)
ok('a text model in the same folder does not')

const multi = pairProjectors([
  mk('M-Q8_0.gguf', { quant:'Q8_0' }),
  mk('mmproj-M-f16.gguf', { isProjector:true, fileSize:900 }),
  mk('mmproj-M-Q8_0.gguf', { isProjector:true, fileSize:100 })
])
assert.ok(multi[0]!.projectorPath?.includes('Q8_0')); ok('prefers the projector matching the model quant')

// No exact match: take the smaller, since VRAM is the constraint and a
// quantised projector is close to lossless.
const noMatch = pairProjectors([
  mk('M-Q4_K_M.gguf', { quant:'Q4_K_M' }),
  mk('mmproj-M-f16.gguf', { isProjector:true, fileSize:1338 }),
  mk('mmproj-M-Q8_0.gguf', { isProjector:true, fileSize:844 })
])
assert.ok(noMatch[0]!.projectorPath?.includes('Q8_0'), `picked ${noMatch[0]!.projectorPath}`)
ok('with no quant match, prefers the smaller projector over f16')

// Divergent naming: one model, one projector, names unrelated.
const lone = pairProjectors([
  mk('vision-model.gguf'),
  mk('mmproj-something-else.gguf', { isProjector:true })
])
assert.ok(lone[0]!.projectorPath); ok('a lone model+projector pair up despite unrelated names')

// But not when the folder holds several models and the names do not match.
const ambiguous = pairProjectors([
  mk('vision-model.gguf'),
  mk('other-model.gguf'),
  mk('mmproj-something-else.gguf', { isProjector:true })
])
assert.ok(ambiguous.every(m=>m.projectorPath===undefined))
ok('an ambiguous folder attaches the projector to nothing rather than guessing')

console.log('launch argv')
const withProj = buildArgs({ modelPath:'/m.gguf', ...DEFAULT_LAUNCH_CONFIG, mmprojPath:'/p.gguf' }, 1, bin)
assert.deepEqual(withProj.slice(withProj.indexOf('--mmproj'), withProj.indexOf('--mmproj')+2), ['--mmproj','/p.gguf'])
ok('--mmproj is passed when a projector is set')
assert.ok(!buildArgs({ modelPath:'/m.gguf', ...DEFAULT_LAUNCH_CONFIG, mmprojPath:null }, 1, bin).includes('--mmproj'))
ok('omitted entirely when there is none')

console.log('download pairing against the real repo')
const files = await listRepoFiles('ggml-org/SmolVLM-256M-Instruct-GGUF')
assert.ok(files.some(f=>f.isProjector)); ok(`marks ${files.filter(f=>f.isProjector).length} projector files in the repo`)
const chosen = projectorFor('SmolVLM-256M-Instruct-Q8_0.gguf', files)
assert.ok(chosen && /Q8_0/i.test(chosen.path)); ok(`picks the matching projector (${chosen!.path})`)
assert.ok(projectorFor('SmolVLM-256M-Instruct-f16.gguf', files)!.path.includes('f16'))
ok('a different quant pairs with its own projector')
const vlFiles = await listRepoFiles('ggml-org/Qwen2.5-VL-3B-Instruct-GGUF')
const q4Proj = projectorFor('Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf', vlFiles)!
assert.ok(q4Proj.path.includes('Q8_0'), `picked ${q4Proj.path}`)
ok(`a Q4_K_M model with no Q4 projector takes the Q8_0 one, not f16 (saves ${Math.round((vlFiles.find(f=>f.path.includes('mmproj')&&f.path.includes('f16'))!.size - q4Proj.size)/1e6)} MB)`)
const textRepo = await listRepoFiles('unsloth/SmolLM2-135M-Instruct-GGUF')
assert.equal(projectorFor('SmolLM2-135M-Instruct-Q2_K.gguf', textRepo), null)
ok('a text-only repo pairs with nothing')

console.log(`\n${n} assertions passed`)
process.exit(0)
