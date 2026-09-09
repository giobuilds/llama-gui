import assert from 'node:assert/strict'
import {
  COMPACT_AT,
  compactableMessages,
  projectedPromptTokens,
  shouldCompact,
  summaryBudget,
  trimToLastSentence,
  verbatimUserMessages,
  PREEMPT_AT
} from '../../src/renderer/src/state/compact.js'
import { buildTurns } from '../../src/renderer/src/state/chatStore.js'
import type { ChatMessageView, ConversationView } from '@shared/types.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

const msg = (
  role: ChatMessageView['role'],
  content: string,
  extra: Partial<ChatMessageView> = {}
): ChatMessageView => ({ id: `${role}-${content.slice(0, 6)}-${n}-${Math.random()}`, role, content, createdAt: 1, ...extra })

const chat = (messages: ChatMessageView[], extra: Partial<ConversationView> = {}): ConversationView => ({
  id: 'c1', title: 't', createdAt: 1, updatedAt: 1, systemPrompt: '',
  messages, tools: [], compaction: null, autoCompact: true,
  settings: { temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 },
  ...extra
})

// The server counts tokens for every request; using its numbers beats guessing
// from character counts, which is what made the old estimate untrustworthy.
console.log('projecting the next prompt')
{
  const c = chat([
    msg('user', 'first question'),
    msg('assistant', 'a long answer', { usage: { promptTokens: 900, predictedTokens: 350 } })
  ])
  assert.equal(projectedPromptTokens(c, ''), 1250)
  ok('uses the last measured prompt plus what was generated')

  assert.equal(projectedPromptTokens(c, 'x'.repeat(400)), 1350)
  ok('and adds the message about to be sent')
}
{
  const c = chat([
    msg('user', 'q1'),
    msg('assistant', 'a1', { usage: { promptTokens: 100, predictedTokens: 50 } }),
    msg('user', 'x'.repeat(800))
  ])
  assert.equal(projectedPromptTokens(c, ''), 350)
  ok('counts turns the server has not seen yet on top of the measured ones')
}
{
  const c = chat([msg('user', 'x'.repeat(4000))])
  assert.equal(projectedPromptTokens(c, ''), 1000)
  ok('falls back to an estimate before the first reply')
}

console.log('\ndeciding when to compact')
{
  const c = chat([
    ...Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i}`)),
    msg('assistant', 'last', { usage: { promptTokens: 3000, predictedTokens: 200 } })
  ])
  assert.equal(shouldCompact(c, '', 4096), true)
  ok(`compacts past ${COMPACT_AT * 100}% of the window`)
  assert.equal(shouldCompact(c, '', 16384), false)
  ok('leaves a roomy window alone')
  assert.equal(shouldCompact({ ...c, autoCompact: false }, '', 4096), false)
  ok('never compacts when the conversation has it switched off')
  assert.equal(shouldCompact(c, '', null), false)
  ok('and does nothing when the window size is unknown')
}
{
  const tiny = chat([msg('user', 'hello'), msg('assistant', 'hi', { usage: { promptTokens: 9000, predictedTokens: 0 } })])
  assert.equal(shouldCompact(tiny, '', 4096), false)
  ok('a chat with nothing old enough to summarise is left alone')
}

console.log('\nchoosing what a summary replaces')
{
  const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`))
  const older = compactableMessages(chat(messages), 16384)
  assert.equal(older.length, 6)
  assert.equal(older[older.length - 1]!.content, 'm5')
  ok('keeps the four most recent turns verbatim')

  const already = chat(messages, {
    compaction: { summary: 'earlier', throughMessageId: messages[3]!.id, messageCount: 4, at: 1, userMessages: [] }
  })
  const next = compactableMessages(already, 16384)
  assert.deepEqual(next.map((m) => m.content), ['m4', 'm5'])
  ok('and never re-summarises what a previous summary already covers')
}

// A 1,024-token window with a model that writes 900-token replies can keep
// exactly one turn. Keeping a fixed four summarised almost nothing there, and
// the request that followed failed anyway.
console.log('\na window too small for four kept turns')
{
  const long = (n: number) => msg('assistant', 'x'.repeat(n))
  const messages = [msg('user', 'q'), long(3600), msg('user', 'q2'), long(3600), msg('user', 'q3')]
  const roomy = compactableMessages(chat(messages), 16384)
  const cramped = compactableMessages(chat(messages), 1024)
  assert.ok(cramped.length > roomy.length, `${cramped.length} vs ${roomy.length}`)
  ok('summarises more of the chat when the window is small')
  assert.equal(cramped[cramped.length - 1]!.content, 'x'.repeat(3600))
  ok('keeping only the newest turn')
  assert.ok(compactableMessages(chat(messages), 1024).length < messages.length)
  ok('and never summarising the message being answered')
}
{
  const one = compactableMessages(chat([msg('user', 'only one')]), 512)
  assert.deepEqual(one, [])
  ok('a single message has nothing to summarise')
}

console.log('\nthe summary has to fit as well')
{
  assert.equal(summaryBudget(1024).tokens, 154)
  ok('a small window gets a short summary')
  assert.equal(summaryBudget(32768).tokens, 700)
  ok('a large one is capped rather than growing without limit')
  assert.ok(summaryBudget(128).tokens >= 120)
  ok('and there is a floor, below which a summary says nothing useful')
}

// Summarising costs about as long as a short reply. Started early it happens
// while the previous reply is being read; started late, it is a stall.
console.log('\nstarting before it is urgent')
{
  assert.ok(PREEMPT_AT < COMPACT_AT, `${PREEMPT_AT} should be below ${COMPACT_AT}`)
  ok('the background threshold sits below the one the user waits for')
}

// The user's own turns are short, carry the requests the conversation is
// about, and are the worst thing to hand to a small model to paraphrase.
console.log('\nkeeping the user in their own words')
{
  const older = [
    msg('user', 'make it print word by word'),
    msg('assistant', 'x'.repeat(4000)),
    msg('user', 'now add branching'),
    msg('assistant', 'y'.repeat(4000))
  ]
  assert.deepEqual(verbatimUserMessages(older, 4096), [
    'make it print word by word',
    'now add branching'
  ])
  ok('user turns are kept and assistant turns are not')

  const long = [msg('user', 'a'.repeat(8000)), msg('user', 'the recent one')]
  assert.deepEqual(verbatimUserMessages(long, 4096), ['the recent one'])
  ok('and only as many as the budget allows, newest first')

  assert.deepEqual(verbatimUserMessages([msg('user', '   ')], 4096), [])
  ok('an empty turn is not worth carrying')
}
{
  const messages = [msg('user', 'the original request'), msg('assistant', 'a1'), msg('user', 'q2'), msg('assistant', 'a2')]
  const c = chat(messages, {
    compaction: {
      summary: 'notes', throughMessageId: messages[1]!.id, messageCount: 2, at: 1,
      userMessages: ['the original request']
    }
  })
  const sent = buildTurns(c).map((t) => t.content).join(' | ')
  assert.ok(sent.includes('the original request'), sent)
  ok('what they asked reaches the model word for word, not paraphrased')
  assert.equal(buildTurns(c).filter((t) => t.role === 'user').length, 1)
  ok('carried inside the summary turn rather than as replayed user turns')
}

// A summary cut off by the token cap reads as damage in the transcript.
console.log('\nfinishing the last sentence')
{
  assert.equal(
    trimToLastSentence('He chose C. They built a story engine. Next comes inp'),
    'He chose C. They built a story engine.'
  )
  ok('a cut-off tail is trimmed back to the last full sentence')
  assert.equal(trimToLastSentence('All done here.'), 'All done here.')
  ok('a complete summary is left alone')
  const mostlyOneSentence = 'A very long single clause that never ends properly and just keeps going onward'
  assert.equal(trimToLastSentence(mostlyOneSentence), mostlyOneSentence)
  ok('but trimming is skipped when it would throw most of it away')
}

console.log('\nwhat actually gets sent')
{
  const messages = [
    msg('user', 'the very first thing'),
    msg('assistant', 'the first answer'),
    msg('user', 'a later question'),
    msg('assistant', 'a later answer')
  ]
  const c = chat(messages, {
    systemPrompt: 'be helpful',
    compaction: { summary: 'They discussed the first thing.', throughMessageId: messages[1]!.id, messageCount: 2, at: 1, userMessages: [] }
  })
  const turns = buildTurns(c)
  const text = turns.map((t) => `${t.role}:${t.content}`).join(' | ')

  assert.ok(!text.includes('the very first thing'), text)
  ok('the summarised messages are not sent')
  assert.ok(text.includes('They discussed the first thing.'))
  ok('the summary is sent in their place')
  assert.ok(text.includes('a later question') && text.includes('a later answer'))
  ok('later messages are sent verbatim')
  assert.equal(turns[0]!.role, 'system')
  assert.ok(turns[0]!.content.includes('be helpful'))
  ok('and the system prompt still leads')
}
{
  // A summary whose anchor was deleted must not silently drop the transcript.
  const messages = [msg('user', 'kept'), msg('assistant', 'also kept')]
  const c = chat(messages, {
    compaction: { summary: 's', throughMessageId: 'a-message-that-is-gone', messageCount: 2, at: 1, userMessages: [] }
  })
  const text = buildTurns(c).map((t) => t.content).join(' | ')
  assert.ok(text.includes('kept') && text.includes('also kept'))
  ok('a summary pointing at a deleted message covers nothing rather than everything')
}

console.log(`\n${n} assertions passed`)
