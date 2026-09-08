import assert from 'node:assert/strict'
import { buildTurns } from '../../src/renderer/src/state/chatStore.js'
import type { ConversationView } from '@shared/types.js'

let n = 0
const ok = (m: string): void => { n++; console.log('  ok', m) }
const approxTokens = (turns: { content: string }[]): number =>
  Math.ceil(turns.reduce((t, x) => t + x.content.length, 0) / 4)

/** A fetched page, at the size one really is. */
const PAGE = 'Extracted page text. '.repeat(260) // ~5.5k chars, ~1.3k tokens

function conversationWith(rounds: number): ConversationView {
  const messages = []
  for (let i = 0; i < rounds; i++) {
    messages.push({ id: `u${i}`, role: 'user' as const, content: `question ${i}`, createdAt: i })
    messages.push({
      id: `a${i}`,
      role: 'assistant' as const,
      content: `answer ${i}`,
      createdAt: i,
      toolCalls: [
        {
          id: `c${i}`,
          name: 'fetch_page',
          argumentsJson: '{"url":"https://example.com"}',
          summary: `Read example.com`,
          ok: true,
          content: PAGE,
          approxTokens: Math.ceil(PAGE.length / 4)
        }
      ]
    })
  }
  return {
    id: 'c', title: 't', createdAt: 0, updatedAt: 0, systemPrompt: '', messages,
    settings: { temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 }
  }
}

console.log('the newest tool result is sent in full')
const one = buildTurns(conversationWith(1))
assert.ok(one.some((t) => t.content.includes('Extracted page text')))
ok('the model can still read what was just fetched')

console.log('older results are replaced by their summary')
const five = conversationWith(5)
const turns = buildTurns(five)
const full = turns.filter((t) => t.content.includes('Extracted page text')).length
assert.equal(full, 1, `${full} turns still carry full page text`)
ok('exactly one turn carries page text, however many rounds happened')
assert.equal(turns.filter((t) => t.content.includes('Read example.com')).length, 5)
ok('every round is still recorded, by its summary')

console.log('what that saves')
const compacted = approxTokens(turns)
const naive = approxTokens(
  five.messages.map((m) => ({
    content: m.content + (m.toolCalls?.map((c) => c.content ?? '').join('') ?? '')
  }))
)
console.log(`   five fetches: ~${naive} tokens kept in full, ~${compacted} tokens compacted`)
console.log(`   saving: ${Math.round((1 - compacted / naive) * 100)}% of the conversation's context`)
assert.ok(compacted < naive / 3)
ok('a conversation with five fetches costs a third or less')
assert.ok(compacted < 2500)
ok('and stays small enough to keep chatting in a 32k context')

console.log('\nno orphaned tool turns are produced')
assert.ok(!turns.some((t) => t.role === 'tool'))
ok('results are folded into the assistant turn they belong to')
assert.ok(turns.every((t) => t.role === 'user' || t.role === 'assistant' || t.role === 'system'))
ok('the transcript stays a plain alternation')

console.log('\na conversation without tools is unchanged')
const plain = buildTurns({
  ...conversationWith(0),
  systemPrompt: 'be brief',
  messages: [
    { id: 'u', role: 'user', content: 'hello', createdAt: 0 },
    { id: 'a', role: 'assistant', content: 'hi', createdAt: 0 }
  ]
})
assert.deepEqual(plain.map((t) => t.content), ['be brief', 'hello', 'hi'])
ok('ordinary chats are untouched by any of this')

console.log(`\n${n} assertions passed`)
