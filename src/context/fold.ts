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
 * How many of the newest rounds keep their results in full.
 *
 * One was the first answer and it is too few. A round is often a read
 * *followed by* the round that acts on it: the model reads the failing test,
 * and on the next round reads the implementation — at which point one-round
 * folding has already taken the test away. In a 6k window that fires early
 * and often, and the crossover family's `read-window` task failed all twelve
 * runs that way, searching for assertion text it could no longer see while
 * never opening the file it was told about. Two rounds cost more of the
 * window and compaction, not folding, is what bounds the total.
 */
export const KEEP_ROUNDS_WHOLE = 2

/**
 * Where the fold index should move to when the window is filling: the start
 * of the `KEEP_ROUNDS_WHOLE`th round from the end, so what the model is
 * reasoning about right now stays whole and everything before it goes to a
 * line. Returns the current index when there is no reason to move.
 */
export function nextFoldIndex(
  turns: ChatTurn[],
  current: number,
  occupancy: number | null,
  contextLimit: number | null
): number {
  if (occupancy === null || contextLimit === null) return current
  if (occupancy < contextLimit * FOLD_AT) return current
  const roundStarts: number[] = []
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.role === 'assistant' && turns[i]!.toolCalls?.length) roundStarts.push(i)
  }
  // Fewer rounds than we keep: there is nothing behind them to fold.
  const kept = roundStarts.slice(-KEEP_ROUNDS_WHOLE)
  return Math.max(current, kept[0] ?? 0)
}
