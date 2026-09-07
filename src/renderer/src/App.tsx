import { useEffect, useState } from 'react'
import { LaunchPanel } from './views/LaunchPanel.js'
import { LogPane } from './views/LogPane.js'
import { Chat } from './views/Chat.js'
import { subscribeToMain, useServerStore } from './state/serverStore.js'
import { useChatStore } from './state/chatStore.js'
import { StatusBadge } from './components/StatusBadge.js'

type Tab = 'chat' | 'server'

export default function App(): React.JSX.Element {
  const init = useServerStore((s) => s.init)
  const status = useServerStore((s) => s.status)
  const [tab, setTab] = useState<Tab>('chat')

  useEffect(() => {
    void init()
    return subscribeToMain()
  }, [init])

  // A reply is persisted when it finishes, so closing mid-generation would drop
  // whatever had streamed. Flush what is in flight before the window goes.
  useEffect(() => {
    const onUnload = (): void => {
      const chat = useChatStore.getState()
      chat.stopAll()
      void chat.flushInFlight()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <nav className="flex items-center gap-1 border-b border-edge bg-panel px-3 py-1.5">
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat
        </TabButton>
        <TabButton active={tab === 'server'} onClick={() => setTab('server')}>
          Server
        </TabButton>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-muted">
          {status?.phase === 'ready' && status.config?.modelPath && (
            <span className="max-w-[22rem] truncate" title={status.config.modelPath}>
              {status.config.modelPath.split('/').pop()}
            </span>
          )}
          <StatusBadge phase={status?.phase ?? 'stopped'} />
        </div>
      </nav>

      <main className="min-h-0 flex-1">
        {tab === 'chat' ? (
          <Chat />
        ) : (
          <div className="flex h-full">
            <LaunchPanel />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-4 border-b border-edge px-4 py-2 text-xs text-muted">
                {status?.loadStage && <span className="text-amber-200">{status.loadStage}…</span>}
                {status?.phase === 'ready' && status.port && (
                  <span>
                    listening on <code className="text-slate-300">127.0.0.1:{status.port}</code>
                  </span>
                )}
                {status?.pid && <span>pid {status.pid}</span>}
              </div>
              <LogPane />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-ink text-slate-100' : 'text-muted hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  )
}
