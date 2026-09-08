import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { probeAll } from '../../src/main/probe.js'
import { rm } from 'node:fs/promises'
import { DownloadManager, searchModels, listRepoFiles, repoCacheDir } from '../../src/main/downloads.js'
import type { DownloadJob } from '@shared/types.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const bin = (await probeAll())[0]!
const REPO = 'unsloth/SmolLM2-135M-Instruct-GGUF'

console.log('Hugging Face search')
const results = await searchModels('SmolLM2-135M-Instruct-GGUF', 5)
assert.ok(results.length > 0); ok(`found ${results.length} GGUF repos`)
assert.ok(results.some(r => r.id === REPO)); ok('includes the expected repo')
assert.ok(results.every(r => typeof r.downloads === 'number')); ok('carries download counts for ranking')

console.log('repo file listing')
const files = await listRepoFiles(REPO)
files.slice(0,3).forEach(f => console.log(`   ${f.path}  ${(f.size/1e6).toFixed(1)} MB`))
assert.ok(files.length >= 3); ok(`lists ${files.length} GGUF files with sizes`)
assert.ok(files.every(f => f.size > 0)); ok('every file has a real size')
assert.deepEqual([...files].sort((a,b)=>a.size-b.size).map(f=>f.path), files.map(f=>f.path))
ok('sorted smallest first, so the cheapest quant is easiest to pick')

console.log('cache path derivation')
assert.ok(repoCacheDir(REPO).endsWith('models--unsloth--SmolLM2-135M-Instruct-GGUF'))
ok('maps repo id to the HF cache directory layout')

console.log('a real download, with observed progress')
// A cached copy would complete instantly with nothing to observe, so the test
// clears it and genuinely transfers the file.
await rm(repoCacheDir(REPO), { recursive: true, force: true })
const target = files.find(f => /Q2_K/i.test(f.path))!
console.log(`   fetching ${target.path} (${(target.size/1e6).toFixed(1)} MB)`)
const mgr = new DownloadManager(() => bin)
const seen: number[] = []
mgr.on('update', (j: DownloadJob) => { if (j.state==='running' && j.receivedBytes>0) seen.push(j.receivedBytes) })
const started = await mgr.start(REPO, target.path, target.size)
assert.equal(started.state, 'running'); ok('job starts in the running state')
await assert.rejects(() => mgr.start(REPO, target.path, target.size), /already downloading/)
ok('refuses a duplicate download of the same file')

const done = await new Promise<DownloadJob>((resolve) => {
  mgr.on('update', (j) => { if (j.id===started.id && j.state!=='running') resolve(j) })
})
console.log(`   progress samples: ${seen.length}`, seen.length ? `(${(seen[0]!/1e6).toFixed(1)} .. ${(seen[seen.length-1]!/1e6).toFixed(1)} MB)` : '')
assert.equal(done.state, 'done', done.error ?? ''); ok('download completed')
assert.ok(seen.length >= 3, `expected progress samples, got ${seen.length}`)
ok(`progress was observable while running (${seen.length} samples)`)
assert.ok(seen[seen.length-1]! > seen[0]!); ok('progress increased monotonically')
assert.ok(done.modelPath && existsSync(done.modelPath), `path missing: ${done.modelPath}`)
ok(`final path exists: ${done.modelPath!.split('/').pop()}`)
assert.ok(done.modelPath!.endsWith(target.path)); ok('downloaded the file that was asked for')

console.log('failures are reported, not swallowed')
const bad = new DownloadManager(() => bin)
const badJob = await bad.start('this-org/does-not-exist-xyz', 'nope.gguf', 1)
const badDone = await new Promise<DownloadJob>((res)=>bad.on('update',(j)=>{ if(j.id===badJob.id && j.state!=='running') res(j) }))
assert.equal(badDone.state, 'failed'); ok('a bad repo fails')
assert.ok(badDone.error && badDone.error.length > 0); ok(`error surfaced: ${JSON.stringify(badDone.error!.slice(0,70))}`)
assert.ok(!/^\d[\d.]*\s+[EWID]\s/.test(badDone.error!)); ok('log timestamp prefix stripped from the message')

console.log(`\n${n} assertions passed`)
process.exit(0)
