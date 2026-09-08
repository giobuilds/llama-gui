import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyUserData } from '../../src/main/migrate.js'
let n=0; const ok=(m:string)=>{n++;console.log('  ok',m)}

const root = await mkdtemp(join(tmpdir(),'migrate-'))
const legacy = join(root,'llama-gui')
const fresh  = join(root,'Lowerbeam')

// A realistic old profile: settings, conversations, calibration.
await mkdir(join(legacy,'conversations'),{recursive:true})
await writeFile(join(legacy,'settings.json'), JSON.stringify({calibration:{samples:[{activeBytes:1,secondsPerToken:1,onGpu:true,at:1}]}}))
await writeFile(join(legacy,'profiles.json'), JSON.stringify({version:1,profiles:{a:{}}}))
await writeFile(join(legacy,'conversations','c1.json'), '{"id":"c1"}')

console.log('a rename carries the old data across')
const from = await migrateLegacyUserData(fresh)
assert.equal(from, legacy); ok('reports which directory it came from')
assert.deepEqual((await readdir(fresh)).sort(), ['.migrated-from','conversations','profiles.json','settings.json'])
ok('settings, profiles and conversations all arrive')
assert.equal(await readFile(join(fresh,'conversations','c1.json'),'utf8'), '{"id":"c1"}')
ok('nested conversation files copied intact')
assert.ok(JSON.parse(await readFile(join(fresh,'settings.json'),'utf8')).calibration.samples.length===1)
ok('calibration survives, so speed predictions still work')
assert.equal((await readdir(legacy)).length, 3)
ok('the old directory is left untouched, so the previous version still runs')

console.log('Electron fills the new directory before we look at it')
// A fresh profile is never empty: Electron writes caches and preferences during
// startup, so emptiness cannot be the test for "nothing of ours here".
const busy = join(root,'Busy')
await mkdir(join(busy,'Cache'),{recursive:true})
await writeFile(join(busy,'Preferences'),'{}')
await writeFile(join(busy,'Cookies'),'')
assert.equal(await migrateLegacyUserData(busy), legacy)
ok('migrates into a directory Electron has already populated')
assert.ok((await readdir(busy)).includes('settings.json'))
ok('and our files land alongside its caches')
assert.ok(!(await readdir(busy)).includes('Crashpad'))
ok("without dragging the old profile's caches across")
await rm(busy,{recursive:true,force:true})

console.log('it never runs twice or overwrites')
await writeFile(join(fresh,'settings.json'), '{"mine":true}')
assert.equal(await migrateLegacyUserData(fresh), null)
ok('a populated directory is left alone')
assert.equal(await readFile(join(fresh,'settings.json'),'utf8'), '{"mine":true}')
ok('and existing data is not clobbered')

console.log('nothing to migrate is not an error')
const bare = await mkdtemp(join(tmpdir(),'bare-'))
assert.equal(await migrateLegacyUserData(join(bare,'Lowerbeam')), null)
ok('a first-ever install migrates nothing and reports so')
const emptyLegacy = join(bare,'llama-gui'); await mkdir(emptyLegacy,{recursive:true})
assert.equal(await migrateLegacyUserData(join(bare,'Lowerbeam2')), null)
ok('an empty old directory is ignored')

await rm(root,{recursive:true,force:true}); await rm(bare,{recursive:true,force:true})
console.log(`\n${n} assertions passed`)
