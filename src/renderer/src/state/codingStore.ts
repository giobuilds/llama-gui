import { create } from 'zustand'
import type { CodingRunSummary, JournalEvent } from '@shared/coding.js'

/**
 * A projection of the coding supervisor's state — never a second engine.
 *
 * Runs and their events come from the main process; the store holds what has
 * arrived and asks for the rest on demand. After a reload it rebuilds from
 * the journal rather than from anything it remembered, because the journal
 * is the record and this is a view of it.
 */
interface CodingState {
  project: string | null
  runs: CodingRunSummary[]
  activeRunId: string | null
  /** Events per run, in sequence order, for the runs that have been opened. */
  events: Record<string, JournalEvent[]>
  task: string
  error: string | null

  init: () => Promise<void>
  pickProject: () => Promise<void>
  setTask: (task: string) => void
  start: () => Promise<void>
  cancel: (runId?: string) => Promise<void>
  open: (runId: string) => Promise<void>
  clearError: () => void
}

export const useCodingStore = create<CodingState>((set, get) => ({
  project: null,
  runs: [],
  activeRunId: null,
  events: {},
  task: '',
  error: null,

  async init() {
    const { runs, lastProject } = await window.llama.coding.list()
    set({ runs, project: lastProject })
    // Reopen the newest run so a reload lands where the user was.
    const newest = runs[runs.length - 1]
    if (newest) await get().open(newest.id)
  },

  async pickProject() {
    const chosen = await window.llama.coding.pickProject()
    if (chosen) set({ project: chosen, error: null })
  },

  setTask(task) {
    set({ task })
  },

  async start() {
    const { project, task } = get()
    if (!project || !task.trim()) return
    try {
      const run = await window.llama.coding.start({ projectRoot: project, task: task.trim() })
      set({
        runs: [...get().runs, run],
        activeRunId: run.id,
        events: { ...get().events, [run.id]: get().events[run.id] ?? [] },
        task: '',
        error: null
      })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async cancel(runId) {
    const id = runId ?? get().activeRunId
    if (id) await window.llama.coding.cancel(id)
  },

  async open(runId) {
    set({ activeRunId: runId })
    // Always fetch and merge: what arrived live may be missing its head — the
    // first events race the reply that carries the run id — and the journal
    // is the record, so it wins on any gap.
    const fromDisk = await window.llama.coding.get(runId)
    const live = get().events[runId] ?? []
    const bySeq = new Map<number, JournalEvent>()
    for (const e of [...fromDisk, ...live]) bySeq.set(e.seq, e)
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    set({ events: { ...get().events, [runId]: merged } })
  },

  clearError() {
    set({ error: null })
  }
}))

/** Events and run summaries arrive from the main process; wire them in once. */
export function subscribeToCoding(): () => void {
  const offEvent = window.llama.coding.onEvent((event) => {
    const { events } = useCodingStore.getState()
    // Kept for every run, known or not: a journal is a few kilobytes, and an
    // event that arrives before the run's id does would otherwise be lost.
    const list = events[event.run] ?? []
    // Sequence numbers make a duplicate — a reconnect replaying an event
    // already applied — harmless.
    if (list.some((e) => e.seq === event.seq)) return
    useCodingStore.setState({ events: { ...events, [event.run]: [...list, event] } })
  })
  const offRuns = window.llama.coding.onRunsChanged((runs) => useCodingStore.setState({ runs }))
  return () => {
    offEvent()
    offRuns()
  }
}
