import { useEffect, useMemo, useRef, useState } from 'react'
import { useServerStore } from '../state/serverStore.js'
import type { LogLine } from '@shared/types.js'

const STREAM_COLOR: Record<LogLine['stream'], string> = {
  app: 'text-accent',
  stderr: 'text-slate-300',
  stdout: 'text-slate-400'
}

export function LogPane(): React.JSX.Element {
  const logs = useServerStore((s) => s.logs)
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    if (!filter.trim()) return logs
    const needle = filter.toLowerCase()
    return logs.filter((l) => l.text.toLowerCase().includes(needle))
  }, [logs, filter])

  useEffect(() => {
    if (!follow) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visible, follow])

  // Turning off follow when the user scrolls up is what makes the pane usable
  // while the server is spewing — otherwise every new line yanks them back down.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollow(atBottom)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-4 py-2">
        <h2 className="text-sm font-semibold">Server log</h2>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-56 rounded-md border border-edge bg-ink px-2 py-1 text-xs outline-none focus:border-accent"
        />
        <span className="text-[11px] text-muted">
          {visible.length.toLocaleString()}
          {filter ? ` of ${logs.length.toLocaleString()}` : ''} lines
        </span>
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] hover:border-accent"
          >
            Jump to latest
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-[12px] leading-[1.5]"
      >
        {visible.length === 0 ? (
          <p className="text-muted">No output yet. Launch a model to see llama-server's log.</p>
        ) : (
          visible.map((line) => (
            <div key={line.seq} className={`whitespace-pre-wrap break-all ${STREAM_COLOR[line.stream]}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
