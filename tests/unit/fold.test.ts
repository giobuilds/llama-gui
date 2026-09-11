import assert from 'node:assert/strict'
import { foldToolTurns, nextFoldIndex, FOLD_AT, KEEP_ROUNDS_WHOLE } from '@context/fold.js'
import type { ChatTurn } from '@shared/chatClient.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

const big = (label: string) => `${label} (200 lines)\n` + Array.from({ length: 200 }, (_, i) => `${i + 1}| code`).join('\n')
const round = (i: number): ChatTurn[] => [
  { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read', argumentsJson: '{}' }] },
  { role: 'tool', toolCallId: `c${i}`, content: big(`src/file${i}.ts`) }
]
const turns: ChatTurn[] = [
  { role: 'system', content: 'policy' },
  { role: 'user', content: 'where is x?' },
  ...round(1), ...round(2), ...round(3), ...round(4)
]
const size = (ts: ChatTurn[]): number => ts.reduce((s, t) => s + t.content.length, 0)

console.log('folding before an index')
{
  // turns: system, user, then rounds at 2-3, 4-5, 6-7, 8-9
  const { turns: out, folded } = foldToolTurns(turns, 6)
  assert.equal(folded, 2); ok('everything before the index folds — two rounds here')
  assert.ok(out[3]!.content.startsWith('src/file1.ts (200 lines)')); ok('a folded result keeps its first line')
  assert.ok(out[3]!.content.includes('result folded')); ok('and says it was folded')
  assert.ok(out[7]!.content.length > 1000 && out[9]!.content.length > 1000); ok('everything from the index on stays whole')
  assert.ok(size(out) < size(turns) * 0.6); ok(`what is sent is far smaller (${size(out)} of ${size(turns)} chars)`)
  assert.ok(turns[3]!.content.length > 1000); ok('and the original turns are untouched')
  assert.equal(foldToolTurns(turns, 0).folded, 0); ok('an index of zero folds nothing')
}
{
  const short: ChatTurn[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'list_files', argumentsJson: '{}' }] },
    { role: 'tool', toolCallId: 'a', content: 'src:' },
    ...round(9)
  ]
  const { turns: out, folded } = foldToolTurns(short, 2)
  assert.equal(folded, 0); assert.equal(out[1]!.content, 'src:')
  ok('a one-line result is left alone rather than folded to itself')
}

// The index moves forward only when the window is filling, and never back:
// a prefix that keeps changing cannot be cached, and re-reading the whole
// prompt every round costs more than the fold saves.
console.log('\nwhen the index moves')
{
  assert.equal(nextFoldIndex(turns, 0, null, 16384), 0); ok('never before anything has been measured')
  assert.equal(nextFoldIndex(turns, 0, 5000, null), 0); ok('never when the window is unknown')
  assert.equal(nextFoldIndex(turns, 0, 5000, 16384), 0); ok(`stays put while under ${FOLD_AT * 100}% of the window`)
  assert.equal(KEEP_ROUNDS_WHOLE, 2)
  assert.equal(nextFoldIndex(turns, 0, 12000, 16384), 6); ok('moves so the newest two rounds stay whole, once past it')
  assert.equal(nextFoldIndex(turns, 6, 3000, 16384), 6); ok('and never moves back when the window empties again')
  assert.equal(nextFoldIndex(turns, 8, 12000, 16384), 8); ok('or below where it already is')
  // A read on one round and the edit that uses it on the next: one-round
  // folding takes the read away exactly when it is needed.
  const twoRounds: ChatTurn[] = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'fix x' }, ...round(1), ...round(2)]
  assert.equal(nextFoldIndex(twoRounds, 0, 12000, 16384), 2); ok('with two rounds in hand, both stay whole')
  const oneRound: ChatTurn[] = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'fix x' }, ...round(1)]
  assert.equal(nextFoldIndex(oneRound, 0, 12000, 16384), 2); ok('and with one, there is nothing behind it to fold')
}

console.log(`\n${n} assertions passed`)
