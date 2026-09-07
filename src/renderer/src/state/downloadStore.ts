import { create } from 'zustand'
import type { DownloadJob, HfFile, HfModel } from '@shared/types.js'
import { useServerStore } from './serverStore.js'

interface DownloadState {
  query: string
  results: HfModel[]
  searching: boolean
  /** Repo whose file list is expanded, and its GGUF files. */
  expanded: string | null
  files: HfFile[]
  filesLoading: boolean
  jobs: DownloadJob[]
  error: string | null

  setQuery: (q: string) => void
  search: () => Promise<void>
  expand: (repo: string) => Promise<void>
  start: (repo: string, file: HfFile) => Promise<void>
  cancel: (id: string) => Promise<void>
  refreshJobs: () => Promise<void>
  clearError: () => void
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  query: '',
  results: [],
  searching: false,
  expanded: null,
  files: [],
  filesLoading: false,
  jobs: [],
  error: null,

  setQuery(query) {
    set({ query })
  },

  async search() {
    set({ searching: true, error: null })
    try {
      set({ results: await window.llama.downloads.search(get().query), expanded: null, files: [] })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ searching: false })
    }
  },

  async expand(repo) {
    if (get().expanded === repo) {
      set({ expanded: null, files: [] })
      return
    }
    set({ expanded: repo, files: [], filesLoading: true, error: null })
    try {
      const files = await window.llama.downloads.files(repo)
      // Guard against a slower earlier request landing after a newer one.
      if (get().expanded === repo) set({ files })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ filesLoading: false })
    }
  },

  async start(repo, file) {
    set({ error: null })
    try {
      await window.llama.downloads.start(repo, file.path, file.size)
      await get().refreshJobs()
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async cancel(id) {
    try {
      await window.llama.downloads.cancel(id)
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async refreshJobs() {
    try {
      set({ jobs: await window.llama.downloads.list() })
    } catch {
      // The list is a convenience; failing to read it is not worth an error.
    }
  },

  clearError() {
    set({ error: null })
  }
}))

/** Push job updates from main into the store. */
export function subscribeToDownloads(): () => void {
  void useDownloadStore.getState().refreshJobs()
  return window.llama.downloads.onChanged((job) => {
    useDownloadStore.setState((s) => {
      const jobs = s.jobs.some((j) => j.id === job.id)
        ? s.jobs.map((j) => (j.id === job.id ? job : j))
        : [job, ...s.jobs]
      return { jobs }
    })
    // A finished download is a new model, so the library has to notice.
    if (job.state === 'done') void useServerStore.getState().loadModels(true)
  })
}
