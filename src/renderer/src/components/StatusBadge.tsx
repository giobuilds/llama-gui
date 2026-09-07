import type { ServerPhase } from '@shared/types.js'

const STYLES: Record<ServerPhase, { label: string; dot: string; text: string }> = {
  stopped: { label: 'Stopped', dot: 'bg-slate-500', text: 'text-slate-300' },
  starting: { label: 'Starting', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-200' },
  loading: { label: 'Loading', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-200' },
  ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-200' },
  degraded: { label: 'Degraded', dot: 'bg-orange-400 animate-pulse', text: 'text-orange-200' },
  stopping: { label: 'Stopping', dot: 'bg-slate-400 animate-pulse', text: 'text-slate-300' },
  crashed: { label: 'Crashed', dot: 'bg-rose-500', text: 'text-rose-200' }
}

export function StatusBadge({ phase }: { phase: ServerPhase }): React.JSX.Element {
  const s = STYLES[phase]
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-edge bg-panel px-3 py-1">
      <span className={`h-2 w-2 rounded-full ${s.dot}`} />
      <span className={`text-xs font-medium tracking-wide ${s.text}`}>{s.label}</span>
    </span>
  )
}
