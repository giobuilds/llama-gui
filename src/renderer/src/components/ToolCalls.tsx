import { useState } from 'react'
import type { ToolCallView } from '@shared/types.js'

const LABELS: Record<string, string> = {
  web_search: 'Searched the web',
  fetch_page: 'Read a page'
}

/**
 * What the model did before answering.
 *
 * Shown collapsed: the point of the two-tier design is that the full result is
 * not the answer, and a wall of page text above every reply would bury the reply.
 * The sources stay visible, because a claim drawn from the web is worth being
 * able to check.
 */
export function ToolCalls({ calls }: { calls: ToolCallView[] }): React.JSX.Element | null {
  const [openId, setOpenId] = useState<string | null>(null)
  if (calls.length === 0) return null

  return (
    <div className="mb-2 space-y-1.5">
      {calls.map((call) => {
        const query = readQuery(call)
        const open = openId === call.id
        return (
          <div key={call.id} className="rounded border border-edge bg-ink/50 px-2 py-1.5">
            <div className="flex items-baseline gap-2 text-[11px]">
              <span className={call.ok === false ? 'text-rose-300' : 'text-violet-300'}>
                {LABELS[call.name] ?? call.name}
              </span>
              {query && <span className="min-w-0 flex-1 truncate text-slate-300">{query}</span>}
              {call.summary === undefined && (
                <span className="animate-pulse text-muted">working…</span>
              )}
              {call.approxTokens !== undefined && (
                <span className="shrink-0 text-muted" title="Roughly what this result cost in context">
                  ~{call.approxTokens} tokens
                </span>
              )}
              {call.content && (
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : call.id)}
                  className="shrink-0 text-muted hover:text-accent"
                >
                  {open ? 'hide' : 'show'}
                </button>
              )}
            </div>

            {call.sources && call.sources.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {call.sources.map((s) => (
                  <li key={s.url} className="truncate text-[11px]">
                    <a href={s.url} className="text-accent hover:underline" title={s.url}>
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {open && call.content && (
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-[11px] text-muted">
                {call.content}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

function readQuery(call: ToolCallView): string {
  try {
    const args = JSON.parse(call.argumentsJson) as Record<string, unknown>
    return String(args['query'] ?? args['url'] ?? '')
  } catch {
    return ''
  }
}
