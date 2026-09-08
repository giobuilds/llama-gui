import assert from 'node:assert/strict'
import { probeAll, parseFlagDocs } from '../../src/main/probe.js'
let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const bin=(await probeAll())[0]!
const docs=bin.flagDocs
console.log(`parsed ${docs.length} documented options from ${bin.label}\n`)
const sections=[...new Set(docs.map(d=>d.section))]
console.log('  sections:', sections.join(' | '))
console.log('\n  samples:')
for (const name of ['--ctx-size','--flash-attn','--n-gpu-layers','--cache-type-k','--fit']) {
  const d=docs.find(x=>x.names.split(/[,\s]+/).includes(name))
  if (d) console.log(`   ${(d.names+' '+d.argument).trim().padEnd(38)} ${d.description.slice(0,72)}${d.env?`  [${d.env}]`:''}`)
}
assert.ok(docs.length>100, `only ${docs.length} options parsed`)
ok(`parsed ${docs.length} options`)
assert.ok(sections.length>1); ok(`grouped into ${sections.length} sections`)
const ctx=docs.find(d=>d.names.split(/[,\s]+/).includes('--ctx-size'))!
assert.ok(ctx.description.includes('context')); ok('descriptions carry real text')
assert.equal(ctx.argument,'N'); ok('argument placeholders separated from names')
assert.equal(ctx.env,'LLAMA_ARG_CTX_SIZE'); ok('environment variables extracted')
assert.ok(!ctx.description.includes('env:')); ok('and removed from the description')
assert.ok(docs.every(d=>d.names.startsWith('-'))); ok('every entry is actually a flag')
assert.ok(docs.every(d=>!/\n/.test(d.description))); ok('wrapped descriptions joined into one line')
console.log(`\n${n} assertions passed`)
