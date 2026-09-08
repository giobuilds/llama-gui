import { useMemo, useState } from 'react'
import { useServerStore } from '../state/serverStore.js'

/**
 * Searchable reference for the flags the *installed* binary supports.
 *
 * Read from its own `--help` rather than bundled, so it can never drift from
 * the build in use — llama.cpp adds and renames options often enough that a
 * copied list would eventually describe flags that do not exist.
 */
export function FlagReference({ onClose }: { onClose: () => void }): React.JSX.Element {
  const binary = useServerStore((s) => s.binary)
  const [query, setQuery] = useState('')

  const sections = useMemo(() => {
    const docs = binary?.flagDocs ?? []
    const q = query.trim().toLowerCase()
    const matched = q
      ? docs.filter(
          (d) =>
            d.names.toLowerCase().includes(q) ||
            d.description.toLowerCase().includes(q) ||
            (d.env ?? '').toLowerCase().includes(q)
        )
      : docs
    const grouped = new Map<string, typeof matched>()
    for (const d of matched) {
      const list = grouped.get(d.section)
      if (list) list.push(d)
      else grouped.set(d.section, [d])
    }
    return [...grouped.entries()]
  }, [binary, query])

  const total = binary?.flagDocs?.length ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-edge bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">llama.cpp flags</h2>
            <p className="truncate text-[11px] text-muted">
              {binary?.path
                ? `${total} options, read from ${binary.label}`
                : 'No llama.cpp binary found'}
            </p>
          </div>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search flags and descriptions…"
            className="ml-auto w-72 rounded-md border border-edge bg-ink px-3 py-1.5 text-xs outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {sections.length === 0 && (
            <p className="py-6 text-center text-xs text-muted">
              {total === 0
                ? 'No flags could be read from the installed binary.'
                : 'Nothing matches that search.'}
            </p>
          )}
          {sections.map(([section, docs]) => (
            <section key={section} className="mb-5">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                {section}
              </h3>
              <ul className="space-y-2">
                {docs.map((d) => (
                  <li key={d.names + d.argument} className="border-b border-edge/40 pb-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <code className="text-xs text-slate-100">{d.names}</code>
                      {d.argument && (
                        <code className="text-[11px] text-violet-300">{d.argument}</code>
                      )}
                      {d.env && (
                        <code
                          className="ml-auto text-[10px] text-muted"
                          title="Environment variable that sets the same thing"
                        >
                          {d.env}
                        </code>
                      )}
                    </div>
                    {d.description && (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted">{d.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
