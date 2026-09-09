import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodingRunSummary, CodingStartRequest, JournalEvent } from '@shared/coding.js'
import { Grant } from '../../agent/grant.js'
import { runTask } from '../../agent/loop.js'
import type { ServerSupervisor } from '../supervisor.js'
import { Journal } from './journal.js'

/**
 * Owns coding runs the way the llama.cpp supervisor owns model processes.
 *
 * The two have different jobs and this one never touches the other's process:
 * it asks whether a model is ready and which, records that in the run, and
 * runs the loop against it. A run is a grant, a journal and an abort
 * controller. The journal is written before anything is sent to the renderer,
 * so a reload can rebuild exactly what the interface had, and a crash leaves
 * a record that says "in progress" rather than one that claims a result.
 *
 * Stage 1: the loop runs in this process. It has no Electron in it and takes
 * nothing from here but a grant and a callback, so moving it to a utility
 * process is a transport change, not a redesign — and it is read-only, so
 * what it can do from here is list, search and read inside one directory.
 */
export class CodingSupervisor extends EventEmitter<{
  event: [JournalEvent]
  runs: [CodingRunSummary[]]
}> {
  private readonly runs = new Map<string, CodingRunSummary>()
  private readonly live = new Map<string, { abort: AbortController; journal: Journal }>()

  constructor(
    private readonly dir: string,
    private readonly inference: () => ServerSupervisor | null
  ) {
    super()
  }

  /** Rebuild the list from what is on disk, oldest first. */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.jsonl')) continue
      const summary = summarise(await Journal.read(join(this.dir, name)))
      if (summary) this.runs.set(summary.id, summary)
    }
    this.emit('runs', this.list())
  }

  list(): CodingRunSummary[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  async events(id: string): Promise<JournalEvent[]> {
    if (!this.runs.has(id)) return []
    const running = this.live.get(id)
    return running ? running.journal.read() : Journal.read(this.file(id))
  }

  async start(req: CodingStartRequest): Promise<CodingRunSummary> {
    const server = this.inference()
    const status = server?.status
    if (!server || !status || status.phase !== 'ready' || !status.port) {
      throw new Error('Start a model on the Server tab first: a coding run needs one loaded.')
    }
    // Grant.open resolves the root and throws if it does not exist, which is
    // the right time to find out — not on the first tool call.
    const grant = await Grant.open(req.projectRoot)

    const id = randomUUID()
    const model = status.config?.modelPath?.split('/').pop() ?? 'unknown model'
    const journal = new Journal(this.file(id))
    const abort = new AbortController()
    this.live.set(id, { abort, journal })

    const summary: CodingRunSummary = {
      id,
      task: req.task,
      projectRoot: grant.root,
      model,
      startedAt: Date.now(),
      finishedAt: null,
      outcome: 'running',
      answer: '',
      rounds: 0,
      denials: 0
    }
    this.runs.set(id, summary)
    this.emit('runs', this.list())

    // Not awaited: the caller gets the summary at once and follows events.
    void this.drive(id, summary, grant, journal, abort, `http://127.0.0.1:${status.port}`, req.task, status.contextPerSlot)
    return summary
  }

  cancel(id: string): boolean {
    const running = this.live.get(id)
    if (!running) return false
    running.abort.abort()
    return true
  }

  /** The app is closing. Every run ends as cancelled, in its journal. */
  shutdown(): void {
    for (const { abort } of this.live.values()) abort.abort()
  }

  private async drive(
    id: string,
    summary: CodingRunSummary,
    grant: Grant,
    journal: Journal,
    abort: AbortController,
    baseUrl: string,
    task: string,
    contextLimit: number | null
  ): Promise<void> {
    try {
      const result = await runTask({
        baseUrl,
        model: summary.model,
        task,
        grant,
        settings: { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: -1 },
        maxRounds: 12,
        timeoutMs: 6 * 60_000,
        signal: abort.signal,
        runId: id,
        contextLimit,
        onEvent: (event) => {
          // Journal first. The renderer is a view of the record, not the
          // other way round.
          void journal.append(event).then(() => this.emit('event', event))
        }
      })
      Object.assign(summary, {
        finishedAt: Date.now(),
        outcome: result.outcome,
        answer: result.answer,
        rounds: result.rounds,
        denials: result.denials
      })
    } catch (err) {
      Object.assign(summary, {
        finishedAt: Date.now(),
        outcome: 'error',
        answer: err instanceof Error ? err.message : String(err)
      })
    } finally {
      await journal.read() // let the last append land before anyone reads the file
      this.live.delete(id)
      this.emit('runs', this.list())
    }
  }

  private file(id: string): string {
    // ids are our own UUIDs, but they cross IPC on the way back in.
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid run id')
    return join(this.dir, `${id}.jsonl`)
  }
}

/**
 * A summary from a journal alone. A run with a start and no finish was cut
 * off — by a crash or a quit — and is reported as exactly that, never as a
 * result.
 */
export function summarise(events: JournalEvent[]): CodingRunSummary | null {
  const started = events.find((e) => e.type === 'run.started')
  if (!started || started.type !== 'run.started') return null
  const finished = events.find((e) => e.type === 'run.finished')
  const denials = events.filter((e) => e.type === 'tool.result' && e.denied).length
  if (finished && finished.type === 'run.finished') {
    return {
      id: started.run,
      task: started.task,
      projectRoot: started.grantRoot,
      model: started.model,
      startedAt: started.ts,
      finishedAt: finished.ts,
      outcome: finished.outcome,
      answer: finished.answer,
      rounds: finished.rounds,
      denials
    }
  }
  const rounds = events.filter((e) => e.type === 'model.request').length
  return {
    id: started.run,
    task: started.task,
    projectRoot: started.grantRoot,
    model: started.model,
    startedAt: started.ts,
    finishedAt: events[events.length - 1]?.ts ?? started.ts,
    outcome: 'error',
    answer: 'The app closed while this run was in progress. What it had read is in the journal; it produced no answer.',
    rounds,
    denials
  }
}
