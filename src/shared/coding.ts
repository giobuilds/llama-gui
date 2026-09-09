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
  /** The prefix the server already held; with the other two, the window's occupancy. */
  cacheTokens?: number
}

export type JournalEvent =
  | (Base & {
      type: 'run.started'
      task: string
      model: string
      grantRoot: string
      mode?: CodingMode
    })
  | (Base & {
      type: 'model.request'
      round: number
      turns: number
      tools: string[]
      /** Older tool results sent as their first line only, to stay inside the window. */
      folded?: number
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

/**
 * What a run may do. `inspect` is list, search and read inside the project.
 * `edit` adds write_file and edit_file — against an isolated copy of the
 * project, never the project itself; the person applies the result.
 */
export type CodingMode = 'inspect' | 'edit'

export type ChangeKind = 'created' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  kind: ChangeKind
  /** A unified diff against the baseline, or '(binary)'. Empty for a deletion. */
  diff: string
}

export interface ChangeSet {
  files: FileChange[]
  /** When the baseline was taken, so "since the run began" has a time. */
  baselineAt: number
}

export interface ApplyResult {
  applied: string[]
  /** Files left alone, and why. Nothing is merged and nothing is guessed. */
  conflicts: Array<{ path: string; reason: string }>
}

/** What the interface needs to list runs and show one, without the whole journal. */
export interface CodingRunSummary {
  id: string
  task: string
  projectRoot: string
  mode: CodingMode
  /** Set once an edit run's changes have been applied to the project. */
  appliedAt: number | null
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
  mode: CodingMode
}

/** What a tool hands back to the loop. Text is what the model sees; the rest is for the journal. */
export interface AgentToolResult {
  ok: boolean
  denied?: boolean
  content: string
}
