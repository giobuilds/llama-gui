/**
 * The record of a coding run.
 *
 * Every event a run produces is appended here before its side effect, with a
 * run id, a sequence number and a timestamp, so the interface can reconnect
 * without inventing state, a crash leaves an honest trail, and a compaction
 * record can be checked against what actually happened rather than against
 * what the model says happened.
 *
 * Versioned from the start: the journal outlives whichever engine wrote it.
 */

export const JOURNAL_VERSION = 1

interface Base {
  v: typeof JOURNAL_VERSION
  run: string
  seq: number
  /** ms since epoch */
  ts: number
}

export interface TokenCount {
  promptTokens: number
  predictedTokens: number
}

export type JournalEvent =
  | (Base & {
      type: 'run.started'
      task: string
      model: string
      grantRoot: string
    })
  | (Base & {
      type: 'model.request'
      round: number
      turns: number
      tools: string[]
    })
  | (Base & {
      type: 'model.response'
      round: number
      contentChars: number
      reasoningChars: number
      toolCalls: number
      usage: TokenCount | null
      finishReason: string | null
      ms: number
    })
  | (Base & {
      type: 'tool.call'
      callId: string
      name: string
      args: Record<string, unknown>
    })
  | (Base & {
      type: 'tool.result'
      callId: string
      ok: boolean
      /** The call asked for something outside the grant and was refused. */
      denied: boolean
      summary: string
      chars: number
    })
  | (Base & {
      type: 'run.finished'
      outcome: RunOutcome
      answer: string
      rounds: number
      ms: number
      tokens: TokenCount
      /** Tool calls refused for reaching outside the grant. */
      denials: number
    })

export type RunOutcome =
  /** The model stopped calling tools and gave an answer. */
  | 'answered'
  /** The model used every round without answering. */
  | 'rounds'
  | 'timeout'
  | 'cancelled'
  | 'error'

/** What the interface needs to list runs and show one, without the whole journal. */
export interface CodingRunSummary {
  id: string
  task: string
  projectRoot: string
  model: string
  startedAt: number
  finishedAt: number | null
  outcome: RunOutcome | 'running'
  answer: string
  rounds: number
  denials: number
}

export interface CodingStartRequest {
  projectRoot: string
  task: string
}

/** What a tool hands back to the loop. Text is what the model sees; the rest is for the journal. */
export interface AgentToolResult {
  ok: boolean
  denied?: boolean
  content: string
}
