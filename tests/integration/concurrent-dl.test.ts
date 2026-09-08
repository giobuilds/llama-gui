import assert from 'node:assert/strict'
import { probeAll } from '../../src/main/probe.js'
import { DownloadManager, listRepoFiles, projectorFor } from '../../src/main/downloads.js'
import type { DownloadJob } from '@shared/types.js'
let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const bin=(await probeAll())[0]!
const REPO='ggml-org/SmolVLM-256M-Instruct-GGUF'
const files=await listRepoFiles(REPO)
const model=files.find(f=>!f.isProjector && /Q8_0/.test(f.path))!
const proj=projectorFor(model.path, files)!
console.log(`model ${(model.size/1e6).toFixed(0)} MB + projector ${(proj.size/1e6).toFixed(0)} MB, downloading together`)

const mgr=new DownloadManager(()=>bin)
const over: Array<{file:string;pct:number}> = []
mgr.on('update', (j: DownloadJob) => {
  if (j.state==='running' && j.expectedBytes>0) {
    const pct=j.receivedBytes/j.expectedBytes*100
    if (pct>100.5) over.push({file:j.file, pct})
  }
})
const a=await mgr.start(REPO, model.path, model.size)
const b=await mgr.start(REPO, proj.path, proj.size)
assert.equal(a.state,'running'); assert.equal(b.state,'queued')
ok('the second file from the same repo is queued, not run in parallel')
const finished=new Set<string>()
await new Promise<void>(res=>{ mgr.on('update', j=>{ if(j.state!=='running'){ finished.add(j.id); if(finished.has(a.id)&&finished.has(b.id)) res() } }) })

console.log(`   progress readings above 100%: ${over.length}`)
if (over.length) console.log('    e.g.', over.slice(0,3).map(o=>`${o.file} ${o.pct.toFixed(0)}%`).join(', '))
assert.equal(over.length, 0, 'a job counted another job\'s bytes')
ok('progress never exceeds 100%')
const jobs=mgr.list()
assert.ok(jobs.every(j=>j.state==='done'), jobs.map(j=>j.state+':'+j.error).join(' '))
ok('both files downloaded successfully')
console.log(`\n${n} assertions passed`)
process.exit(0)
