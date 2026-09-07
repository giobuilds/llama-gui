import { useEffect } from 'react'
import { useDownloadStore } from '../state/downloadStore.js'
import type { DownloadJob, HfFile } from '@shared/types.js'

const mb = (b: number): string =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`

const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

/**
 * Model downloads.
 *
 * Search and quant choice come from the Hugging Face API; the transfer itself is
 * handed to `llama download`, which already knows how to resolve a repo, fetch a
 * matching mmproj and write the HF cache layout correctly.
 */
export function Downloads(): React.JSX.Element {
  const {
    query, results, searching, expanded, files, filesLoading, jobs, error
  } = useDownloadStore()
  const setQuery = useDownloadStore((s) => s.setQuery)
  const search = useDownloadStore((s) => s.search)
  const expand = useDownloadStore((s) => s.expand)
  const start = useDownloadStore((s) => s.start)
  const cancel = useDownloadStore((s) => s.cancel)
  const clearError = useDownloadStore((s) => s.clearError)

  useEffect(() => {
    if (results.length === 0) void search()
    // Intentionally once on mount: the popular list is a starting point, not
    // something to refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = jobs.filter((j) => j.state === 'running')
  const recent = jobs.filter((j) => j.state !== 'running').slice(0, 6)

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="Search Hugging Face for GGUF models…"
            className="flex-1 rounded-md border border-edge bg-ink px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void search()}
            disabled={searching}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-ink hover:brightness-110 disabled:opacity-40"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </header>

        {error && (
          <p
            onClick={clearError}
            className="cursor-pointer border-b border-rose-900 bg-rose-950/40 px-4 py-2 text-xs text-rose-200"
          >
            {error} <span className="opacity-60">(click to dismiss)</span>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {results.length === 0 && !searching && (
            <p className="p-6 text-center text-xs text-muted">No results.</p>
          )}
          <ul>
            {results.map((m) => (
              <li key={m.id} className="border-b border-edge/60">
                <button
                  type="button"
                  onClick={() => void expand(m.id)}
                  className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left hover:bg-panel/60"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{m.id}</span>
                  {m.gated && (
                    <span
                      title="Gated repo — needs an accepted licence and an HF token"
                      className="shrink-0 rounded bg-amber-900/50 px-1.5 text-[10px] text-amber-200"
                    >
                      gated
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-muted">
                    ↓{compact(m.downloads)} · ♥{compact(m.likes)}
                  </span>
                </button>

                {expanded === m.id && (
                  <div className="border-t border-edge/60 bg-ink/40 px-4 py-2">
                    {filesLoading ? (
                      <p className="text-[11px] text-muted">Loading files…</p>
                    ) : files.length === 0 ? (
                      <p className="text-[11px] text-muted">No GGUF files in this repo.</p>
                    ) : (
                      <ul className="space-y-1">
                        {files.map((f) => (
                          <FileRow key={f.path} repo={m.id} file={f} onStart={() => void start(m.id, f)} />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-panel">
        <h2 className="border-b border-edge px-3 py-2 text-xs font-semibold text-muted">
          Downloads
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {active.length === 0 && recent.length === 0 && (
            <p className="px-1 py-2 text-[11px] text-muted">Nothing downloaded yet.</p>
          )}
          {active.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => void cancel(j.id)} />
          ))}
          {recent.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => void cancel(j.id)} />
          ))}
        </div>
      </aside>
    </div>
  )
}

function FileRow({
  file,
  onStart
}: {
  repo: string
  file: HfFile
  onStart: () => void
}): React.JSX.Element {
  // The quant is the part of the name people actually choose by.
  const quant = file.path.match(/(?:^|[.\-_])((?:IQ|Q)\d[A-Z0-9_]*|F16|BF16|F32)/i)?.[1] ?? null
  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300" title={file.path}>
        {quant && (
          <span className="mr-1.5 rounded bg-edge px-1 text-[10px] text-slate-200">{quant}</span>
        )}
        {file.path}
      </span>
      <span className="shrink-0 text-[11px] text-muted">{mb(file.size)}</span>
      <button
        type="button"
        onClick={onStart}
        className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] hover:border-accent hover:text-accent"
      >
        Download
      </button>
    </li>
  )
}

function JobRow({ job, onCancel }: { job: DownloadJob; onCancel: () => void }): React.JSX.Element {
  const pct =
    job.expectedBytes > 0 ? Math.min(100, (job.receivedBytes / job.expectedBytes) * 100) : 0
  const tone =
    job.state === 'done'
      ? 'text-emerald-300'
      : job.state === 'failed'
        ? 'text-rose-300'
        : job.state === 'cancelled'
          ? 'text-amber-300'
          : 'text-slate-200'

  return (
    <div className="mb-2 rounded border border-edge bg-ink/60 p-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200" title={`${job.repo}/${job.file}`}>
          {job.file}
        </span>
        {job.state === 'running' && (
          <button type="button" onClick={onCancel} className="text-[11px] text-muted hover:text-rose-300">
            Cancel
          </button>
        )}
      </div>
      <p className="truncate text-[10px] text-muted">{job.repo}</p>

      {job.state === 'running' && (
        <>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-edge">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-muted">
            {mb(job.receivedBytes)} of {mb(job.expectedBytes)} · {pct.toFixed(0)}%
          </p>
        </>
      )}

      {job.state !== 'running' && (
        <p className={`mt-1 text-[10px] ${tone}`}>
          {job.state === 'done'
            ? 'Ready to use — it is in your model list'
            : job.state === 'cancelled'
              ? 'Cancelled — partial file kept, downloading again resumes it'
              : (job.error ?? 'Failed')}
        </p>
      )}
    </div>
  )
}
