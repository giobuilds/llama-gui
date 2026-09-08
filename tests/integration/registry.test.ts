import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanModels } from '../../src/main/registry.js'

let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}
const REAL = execFileSync('bash',['-c','ls ~/.cache/huggingface/hub/*/snapshots/*/*.gguf | grep -v mmproj | head -1'],{encoding:'utf8'}).trim()

// Reproduce the Hugging Face cache layout, where snapshots/<sha>/<name>.gguf is
// a symlink into blobs/. A plain isFile() check misses every model in it.
const root = await mkdtemp(join(tmpdir(),'registry-'))
const blobs = join(root,'models--org--repo/blobs')
const snap  = join(root,'models--org--repo/snapshots/abc123')
await mkdir(blobs,{recursive:true}); await mkdir(snap,{recursive:true})
const blobPath = join(blobs,'deadbeef')
await copyFile(REAL, blobPath)
await symlink(blobPath, join(snap,'linked-model.gguf'))

// A plain file, a dangling link, and a non-GGUF, to check the edges.
const plain = join(root,'plain')
await mkdir(plain)
await copyFile(REAL, join(plain,'direct-model.gguf'))
await symlink(join(root,'gone'), join(snap,'dangling.gguf'))
await writeFile(join(plain,'notes.txt'),'not a model')

const models = await scanModels([root])
models.forEach(m=>console.log(`   ${m.fileName.padEnd(22)} ${m.architecture} ${m.quant} ${m.blockCount}L ${m.error ? 'ERR '+m.error : ''}`))

assert.equal(models.length, 2, `expected 2 models, got ${models.length}`)
ok('finds both the symlinked and the plain model')
const linked = models.find(m=>m.fileName==='linked-model.gguf')
assert.ok(linked, 'symlinked model missing'); ok('resolves an HF-style snapshot symlink')
assert.equal(linked!.error, undefined); ok('parses the header through the link')
// Assert on structure rather than a particular model, so the suite survives
// whatever happens to be on disk.
const direct = models.find(m=>m.fileName==='direct-model.gguf')!
assert.equal(linked!.architecture, direct.architecture)
assert.equal(linked!.blockCount, direct.blockCount)
assert.ok(linked!.blockCount! > 0)
ok(`metadata read through the link matches the same file read directly (${linked!.architecture} ${linked!.quant} ${linked!.blockCount}L)`)
assert.ok(linked!.fileSize>0); ok('size follows the link to the blob')
assert.ok(!models.some(m=>m.fileName==='dangling.gguf')); ok('skips a dangling symlink')
assert.ok(!models.some(m=>m.fileName==='notes.txt')); ok('ignores non-GGUF files')

await rm(root,{recursive:true,force:true})
console.log(`\n${n} assertions passed`)
