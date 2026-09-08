/**
 * Keeping a conversation inside the window it has.
 *
 * A chat gets one slot's worth of context — `--ctx-size` divided by
 * `--parallel` — and when it fills, llama.cpp stops mid-sentence rather than
 * forgetting anything. Compaction trades the oldest turns for a summary of
 * them, which is the only way to keep talking without either losing the thread
 * or restarting the chat.
 *
 * The messages are never deleted: the transcript still shows everything, and
 * only what is *sent* changes.
 */
import type { ChatMessageView, ConversationView } from '@shared/types.js'
import { streamChat, type ChatTurn } from '../api/chatClient.js'

/** Compact once the next request would use this much of the window. */
export const COMPACT_AT = 0.75

/** Turns kept verbatim after a compaction, so recent context stays exact. */
export const KEEP_RECENT_TURNS = 4

/**
 * How much of the window those kept turns may occupy.
 *
 * Four turns is the right number in a roomy window and far too many in a small
 * one: a chat with 1,024 tokens and a model that writes 900-token replies can
 * keep exactly one. Keeping a fixed count there summarises almost nothing and
 * the next request fails anyway.
 */
const KEEP_RECENT_SHARE = 0.35

/** A summary has to fit too, so its length follows the window rather than a constant. */
export function summaryBudget(contextPerSlot: number | null): { tokens: number; words: number } {
  const tokens = Math.max(120, Math.min(700, Math.round((contextPerSlot ?? 4096) * 0.15)))
  return { tokens, words: Math.round(tokens * 0.65) }
}

/**
 * Tokens the next request will need, from what the server counted last time.
 *
 * Grounded in the server's own numbers rather than a characters-over-four
 * guess: the last request's prompt plus what it generated is exactly what the
 * next prompt will contain, give or take the new message.
 */
export function projectedPromptTokens(conversation: ConversationView, pending: string): number {
  const withUsage = [...conversation.messages].reverse().find((m) => m.usage)
  const measured = withUsage?.usage
    ? withUsage.usage.promptTokens + withUsage.usage.predictedTokens
    : null
  if (measured === null) return estimateTokens(conversation)
  // Anything after the measured turn has not been through the server yet.
  const index = conversation.messages.indexOf(withUsage!)
  const since = conversation.messages
    .slice(index + 1)
    .reduce((n, m) => n + roughTokens(m.content), 0)
  return measured + since + roughTokens(pending)
}

/** Only used before the first reply, when the server has counted nothing yet. */
function estimateTokens(conversation: ConversationView): number {
  return (
    roughTokens(conversation.systemPrompt) +
    conversation.messages.reduce((n, m) => n + roughTokens(m.content), 0)
  )
}

/** Four characters to a token is wrong in detail and close enough in aggregate. */
function roughTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Whether the next message should be preceded by a compaction. */
export function shouldCompact(
  conversation: ConversationView,
  pending: string,
  contextPerSlot: number | null
): boolean {
  if (!conversation.autoCompact || !contextPerSlot) return false
  if (compactableMessages(conversation, contextPerSlot).length === 0) return false
  return projectedPromptTokens(conversation, pending) > contextPerSlot * COMPACT_AT
}

/**
 * The messages a summary would replace: everything before the last few turns,
 * and nothing already covered by an earlier summary.
 */
export function compactableMessages(
  conversation: ConversationView,
  contextPerSlot: number | null = null
): ChatMessageView[] {
  const covered = conversation.compaction
    ? conversation.messages.findIndex((m) => m.id === conversation.compaction!.throughMessageId)
    : -1
  const candidates = conversation.messages.slice(covered + 1)

  // Walk back from the newest, keeping turns while they still fit the share of
  // the window reserved for them. At least one is always kept: the message
  // being answered cannot be summarised away.
  const budget = contextPerSlot ? contextPerSlot * KEEP_RECENT_SHARE : Number.POSITIVE_INFINITY
  let kept = 0
  let used = 0
  for (let i = candidates.length - 1; i >= 0 && kept < KEEP_RECENT_TURNS; i--) {
    used += roughTokens(candidates[i]!.content)
    if (used > budget && kept > 0) break
    kept += 1
  }
  return candidates.slice(0, candidates.length - kept)
}

function instruction(words: number): string {
  return (
    'Summarise the conversation so far for your own use as notes. Keep decisions, ' +
    'facts, names, code and anything the user asked for; drop pleasantries and ' +
    `repetition. Write it as compact prose in the third person, under ${words} words. ` +
    'Reply with the summary only.'
  )
}

/**
 * Ask the running model to summarise its own older turns.
 *
 * Done with the same server and no tools: it is a plain generation, and using a
 * second model to summarise would need a second model loaded.
 */
export async function summarise(
  baseUrl: string,
  conversation: ConversationView,
  older: ChatMessageView[],
  previous: string | null,
  contextPerSlot: number | null,
  signal: AbortSignal
): Promise<string> {
  const budget = summaryBudget(contextPerSlot)
  const transcript = older
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const turns: ChatTurn[] = [
    {
      role: 'user',
      content:
        (previous ? `Notes from earlier still to be carried forward:\n\n${previous}\n\n---\n\n` : '') +
        `${transcript}\n\n---\n\n${instruction(budget.words)}`
    }
  ]

  let summary = ''
  let failure: string | null = null
  await streamChat(
    baseUrl,
    turns,
    // Low temperature: this is a record, not a performance.
    { ...conversation.settings, temperature: 0.3, maxTokens: budget.tokens },
    signal,
    {
      onDelta: (text) => {
        summary += text
      },
      onDone: () => {},
      onError: (message) => {
        failure = message
      }
    }
  )
  if (failure) throw new Error(failure)
  const trimmed = summary.trim()
  if (!trimmed) throw new Error('The model returned an empty summary.')
  return trimmed
}
