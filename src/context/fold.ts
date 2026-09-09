import type { ChatTurn } from '@shared/chatClient.js'

/**
 * Bounding an agent loop's working set.
 *
 * Every round of a coding run appends what its tools returned — a 200-line
 * read, thirty search hits — and the next request carries all of it. Twelve
 * rounds of that is the window gone. So older tool results are folded to
 * their first line: the fact that the call happened and what it found stays
 * on the record, the body it returned does not.
 *
 * The most recent rounds are kept in full, because they are what the model
 * is reasoning about right now. How many is a decision the caller makes from
 * the server's own token count for the last request, not from a guess.
 */

/**
 * Fold every tool result before `foldBefore`. The index is the caller's and
 * only ever moves forward: a prefix that keeps changing is a prefix the
 * server cannot cache, and re-reading the whole prompt every round costs
 * more than the folding saves. Measured: folding on every round past half the
 * window tripled the tokens processed on one task while occupancy fell.
 */
export function foldToolTurns(turns: ChatTurn[], foldBefore: number): { turns: ChatTurn[]; folded: number } {
  if (foldBefore <= 0) return { turns, folded: 0 }
  let folded = 0
  const out = turns.map((turn, i) => {
    if (turn.role !== 'tool' || i >= foldBefore) return turn
    const firstLine = turn.content.split('\n')[0] ?? ''
    if (turn.content.length <= firstLine.length + 1) return turn // already one line
    folded += 1
    return { ...turn, content: `${firstLine}\n(result folded — ask again to see it in full)` }
  })
  return { turns: out, folded }
}

/** Fold once the window is this full; then leave the prefix alone until it is again. */
export const FOLD_AT = 0.6

/**
 * Where the fold index should move to when the window is filling: the start
 * of the newest round, so everything the model is reasoning about right now
 * stays whole and everything before it goes to a line. Returns the current
 * index when there is no reason to move.
 */
export function nextFoldIndex(
  turns: ChatTurn[],
  current: number,
  occupancy: number | null,
  contextLimit: number | null
): number {
  if (occupancy === null || contextLimit === null) return current
  if (occupancy < contextLimit * FOLD_AT) return current
  let lastRound = 0
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.role === 'assistant' && turns[i]!.toolCalls?.length) lastRound = i
  }
  return Math.max(current, lastRound)
}
