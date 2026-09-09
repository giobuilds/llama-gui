import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal } from '../../src/main/coding/journal.js'
import { summarise } from '../../src/main/coding/supervisor.js'
import type { JournalEvent } from '@shared/coding.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }
const dir = await mkdtemp(join(tmpdir(), 'journal-'))

const base = { v: 1 as const, run: 'r1', ts: 1 }
const ev = (seq: number, rest: Record<string, unknown>): JournalEvent =>
  ({ ...base, seq, ts: 1000 + seq, ...rest }) as JournalEvent

console.log('appends keep their order')
{
  const j = new Journal(join(dir, 'a.jsonl'))
  // Fired without awaiting, the way the loop fires them.
  const writes = [
    j.append(ev(0, { type: 'run.started', task: 't', model: 'm', grantRoot: '/p' })),
    j.append(ev(1, { type: 'tool.call', callId: 'c', name: 'read', args: { path: 'x' } })),
    j.append(ev(2, { type: 'tool.result', callId: 'c', ok: true, denied: false, summary: 's', chars: 3 }))
  ]
  await Promise.all(writes)
  const back = await j.read()
  assert.deepEqual(back.map((e) => e.seq), [0, 1, 2]); ok('three unawaited appends land in sequence')
  assert.equal(back[1]!.type, 'tool.call'); ok('and read back as what they were')
}

console.log('\na torn last line does not lose the rest')
{
  const path = join(dir, 'torn.jsonl')
  const good = JSON.stringify(ev(0, { type: 'run.started', task: 't', model: 'm', grantRoot: '/p' }))
  await writeFile(path, good + '\n{"v":1,"run":"r1","seq":1,"ty')
  const back = await Journal.read(path)
  assert.equal(back.length, 1); ok('the complete event survives')
  assert.equal(back[0]!.type, 'run.started'); ok('and the torn one is dropped, not thrown')
}

console.log('\nsummaries come from the journal alone')
{
  const finished = summarise([
    ev(0, { type: 'run.started', task: 'where is x', model: 'm', grantRoot: '/p' }),
    ev(1, { type: 'model.request', round: 1, turns: 2, tools: [] }),
    ev(2, { type: 'tool.result', callId: 'c', ok: false, denied: true, summary: 'Outside', chars: 7 }),
    ev(3, {
      type: 'run.finished', outcome: 'answered', answer: 'in y', rounds: 1, ms: 5,
      tokens: { promptTokens: 1, predictedTokens: 2 }, denials: 1
    })
  ])
  assert.ok(finished); assert.equal(finished.outcome, 'answered'); assert.equal(finished.answer, 'in y')
  ok('a finished run reports its outcome and answer')
  assert.equal(finished.denials, 1); ok('and counts refusals from the record, not from memory')

  const cut = summarise([
    ev(0, { type: 'run.started', task: 't', model: 'm', grantRoot: '/p' }),
    ev(1, { type: 'model.request', round: 1, turns: 2, tools: [] }),
    ev(2, { type: 'model.request', round: 2, turns: 4, tools: [] })
  ])
  assert.ok(cut); assert.equal(cut.outcome, 'error'); ok('a run with no finish is reported as cut off')
  assert.ok(/closed while this run was in progress/.test(cut.answer)); ok('in words, not as a result')
  assert.equal(cut.rounds, 2); ok('with how far it got')

  assert.equal(summarise([]), null); ok('and an empty journal is no run at all')
}

console.log('\nwhat is written is what was appended')
{
  const j = new Journal(join(dir, 'b.jsonl'))
  await j.append(ev(0, { type: 'run.started', task: 't', model: 'm', grantRoot: '/p' }))
  const raw = await readFile(join(dir, 'b.jsonl'), 'utf8')
  assert.ok(raw.endsWith('\n') && raw.split('\n').filter(Boolean).length === 1)
  ok('one line per event, newline-terminated')
}

await rm(dir, { recursive: true, force: true })
console.log(`\n${n} assertions passed`)
