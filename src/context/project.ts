import type { ConversationView } from '@shared/types.js'
import type { ChatTurn } from '@shared/chatClient.js'

/**
 * What a conversation looks like to the model.
 *
 * The transcript on screen and the turns that are sent are different things,
 * and this is where they part: a compaction summary stands in for everything
 * it covers, older tool results shrink to their one-line summaries, and the
 * user's own words from the summarised range ride inside the summary turn.
 * Nothing here changes the conversation; it only decides what is sent.
 *
 * Lives outside the renderer because it is not about the renderer — the same
 * projection has to hold for a coding run reading a journal.
 */

/**
 * Tool results are kept in full only for the most recent assistant turn.
 *
 * A page fetched three questions ago is almost never what the next answer
 * needs, and at ~1,300 tokens a page it would otherwise be paid for on every
 * message for the rest of the conversation. Older results are replaced by
 * their one-line summary, which keeps the fact that a search happened and
 * what it found without the cost of what it returned.
 */
export const KEEP_FULL_RESULTS_FOR_TURNS = 1

export function projectConversation(conversation: ConversationView): ChatTurn[] {
  const turns: ChatTurn[] = []
  if (conversation.systemPrompt.trim()) {
    turns.push({ role: 'system', content: conversation.systemPrompt })
  }

  const assistantTurns = conversation.messages.filter((m) => m.role === 'assistant')
  const recent = new Set(
    assistantTurns.slice(-KEEP_FULL_RESULTS_FOR_TURNS).map((m) => m.id)
  )

  // Everything the summary covers is represented by the summary alone. The
  // messages stay in the transcript; they simply stop being sent.
  const compaction = conversation.compaction
  let skipUntil = compaction
    ? conversation.messages.findIndex((m) => m.id === compaction.throughMessageId)
    : -1
  if (compaction && skipUntil === -1) skipUntil = -1 // a summary whose anchor is gone covers nothing
  if (compaction && skipUntil >= 0) {
    // The user's words go in the same turn rather than as replayed user turns:
    // several user messages in a row with no replies between them is not a
    // shape every chat template accepts.
    const asked = compaction.userMessages.length
      ? `\n\nEarlier, the user asked, in their own words:\n` +
        compaction.userMessages.map((m) => `- ${m}`).join('\n')
      : ''
    turns.push({
      role: 'system',
      content: `Summary of the earlier part of this conversation:\n\n${compaction.summary}${asked}`
    })
  }

  for (const [index, m] of conversation.messages.entries()) {
    if (skipUntil >= 0 && index <= skipUntil) continue
    if (m.role === 'system') continue
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const keepFull = recent.has(m.id)
      const note = m.toolCalls
        .map((c) =>
          keepFull && c.content
            ? `${c.summary ?? c.name}\n${c.content}`
            : (c.summary ?? `${c.name} was used`)
        )
        .join('\n\n')
      // Folded into the assistant's own turn, so the transcript stays a plain
      // alternation and no orphaned tool messages are sent.
      turns.push({ role: 'assistant', content: [note, m.content].filter(Boolean).join('\n\n') })
      continue
    }
    turns.push({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })
  }
  return turns
}
