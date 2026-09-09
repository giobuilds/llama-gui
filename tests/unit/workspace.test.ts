import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/coding/workspace.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const base = await mkdtemp(join(tmpdir(), 'ws-'))
const project = join(base, 'project')
await mkdir(join(project, 'src'), { recursive: true })
await mkdir(join(project, 'node_modules', 'dep'), { recursive: true })
await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1\n')
await writeFile(join(project, 'src', 'b.ts'), 'export const b = 2\n')
await writeFile(join(project, 'README.md'), '# p\n')
await writeFile(join(project, 'node_modules', 'dep', 'index.js'), 'x')

console.log('a workspace is a copy with a baseline')
const ws = await Workspace.create(project, join(base, 'ws1'))
{
  assert.equal(await readFile(join(ws.root, 'src', 'a.ts'), 'utf8'), 'export const a = 1\n'); ok('files are copied')
  assert.ok(!('node_modules/dep/index.js' in ws.manifest.files)); ok('dependency trees are not')
  assert.equal(Object.keys(ws.manifest.files).length, 3); ok('the manifest names every copied file')
  assert.match(ws.manifest.files['src/a.ts']!, /^[a-f0-9]{64}$/); ok('with a content hash each')
  const reopened = await Workspace.open(ws.root)
  assert.deepEqual(reopened.manifest.files, ws.manifest.files); ok('and it reopens from disk with the same baseline')
}

console.log('\nchanges are what differs from the baseline')
{
  assert.deepEqual((await ws.changes()).files, []); ok('nothing, before anything is written')
  await writeFile(join(ws.root, 'src', 'a.ts'), 'export const a = 10\n')
  await writeFile(join(ws.root, 'src', 'c.ts'), 'export const c = 3\n')
  await rm(join(ws.root, 'src', 'b.ts'))
  const changes = await ws.changes()
  const kinds = Object.fromEntries(changes.files.map((f) => [f.path, f.kind]))
  assert.deepEqual(kinds, { 'src/a.ts': 'modified', 'src/c.ts': 'created', 'src/b.ts': 'deleted' })
  ok('a modification, a creation and a deletion are each reported as what they are')
  const a = changes.files.find((f) => f.path === 'src/a.ts')!
  assert.ok(a.diff.includes('-export const a = 1') && a.diff.includes('+export const a = 10')); ok('with a unified diff')
  assert.ok(!(await ws.changes()).files.some((f) => f.path.includes('baseline'))); ok('the baseline file itself is never a change')
}

console.log('\napply puts changes into the project, unless the project moved')
{
  // The user edited b.ts in the project while the run was deleting it.
  await writeFile(join(project, 'src', 'b.ts'), 'export const b = 22 // user edit\n')
  const result = await ws.apply()
  assert.deepEqual(result.applied.sort(), ['src/a.ts', 'src/c.ts']); ok('unchanged files are applied')
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0]!.path, 'src/b.ts')
  ok('a file edited in the project since the baseline is a conflict, not a merge')
  assert.match(result.conflicts[0]!.reason, /edited in the project/); ok('and the reason says so')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'export const a = 10\n'); ok('the project has the applied change')
  assert.equal(await readFile(join(project, 'src', 'b.ts'), 'utf8'), 'export const b = 22 // user edit\n'); ok('and the user edit is untouched')
  assert.equal(await readFile(join(project, 'src', 'c.ts'), 'utf8'), 'export const c = 3\n'); ok('and the created file exists')
}

console.log('\nundo reverses an apply, unless the project moved again')
{
  await writeFile(join(project, 'src', 'c.ts'), 'export const c = 3 // touched after apply\n')
  const result = await ws.undo()
  assert.deepEqual(result.applied, ['src/a.ts']); ok('a file still as applied is restored')
  assert.equal(await readFile(join(project, 'src', 'a.ts'), 'utf8'), 'export const a = 1\n'); ok('to what it held before')
  assert.equal(result.conflicts[0]?.path, 'src/c.ts'); ok('a file edited after apply is left alone and reported')
  assert.ok(await stat(join(project, 'src', 'c.ts')).then(() => true, () => false)); ok('so the created file, since edited, stays')
}

console.log('\napply of a created file the project now has is a conflict')
{
  const ws2 = await Workspace.create(project, join(base, 'ws2'))
  await writeFile(join(ws2.root, 'NEW.md'), 'from the run\n')
  await writeFile(join(project, 'NEW.md'), 'from the user\n')
  const result = await ws2.apply()
  assert.equal(result.applied.length, 0); assert.equal(result.conflicts[0]?.path, 'NEW.md')
  ok('the user file is not overwritten')
  await ws2.discard()
  assert.equal(await stat(ws2.root).then(() => true, () => false), false); ok('discard removes the workspace')
}

await rm(base, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
