import { useChatStore } from '../state/chatStore.js'

const when = (ts: number): string => {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ChatSidebar(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.active?.id)
  const open = useChatStore((s) => s.open)
  const create = useChatStore((s) => s.create)
  const remove = useChatStore((s) => s.remove)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-panel">
      <div className="p-2">
        <button
          type="button"
          onClick={() => void create()}
          className="w-full rounded-md border border-edge px-3 py-1.5 text-xs hover:border-accent hover:text-accent"
        >
          + New chat
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <li className="px-3 py-2 text-[11px] text-muted">No conversations yet.</li>
        )}
        {conversations.map((c) => (
          <li key={c.id} className="group relative">
            <button
              type="button"
              onClick={() => void open(c.id)}
              className={`w-full px-3 py-2 text-left hover:bg-ink/60 ${
                c.id === activeId ? 'bg-ink/80' : ''
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-100">{c.title}</span>
                <span className="shrink-0 text-[10px] text-muted">{when(c.updatedAt)}</span>
              </div>
              {c.preview && (
                <p className="mt-0.5 truncate text-[11px] text-muted">{c.preview}</p>
              )}
            </button>
            <button
              type="button"
              title="Delete conversation"
              onClick={() => void remove(c.id)}
              className="absolute right-1 top-1 hidden rounded px-1.5 text-[11px] text-muted
                         hover:text-rose-300 group-hover:block"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
