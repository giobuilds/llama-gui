import { useEffect } from 'react'
import { LaunchPanel } from './views/LaunchPanel.js'
import { LogPane } from './views/LogPane.js'
import { subscribeToMain, useServerStore } from './state/serverStore.js'

export default function App(): React.JSX.Element {
  const init = useServerStore((s) => s.init)
  const status = useServerStore((s) => s.status)

  useEffect(() => {
    void init()
    return subscribeToMain()
  }, [init])

  return (
    <div className="flex h-full">
      <LaunchPanel />
      <main className="flex min-w-0 flex-1 flex-col">
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
      </main>
    </div>
  )
}
