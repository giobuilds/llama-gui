import type { VramPlanView } from '@shared/types.js'

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

/**
 * Shows what a launch is expected to cost in VRAM, as a proportion of what is
 * free. The estimate is labelled and its arithmetic is listed underneath — the
 * numbers come from the GGUF header, not from a guess about the model.
 */
export function VramBar({ plan }: { plan: VramPlanView }): React.JSX.Element {
  const scale = plan.freeMiB ?? plan.totalMiB
  const pct = (v: number): number => (scale > 0 ? Math.min(100, (v / scale) * 100) : 0)
  const over = plan.fits === false

  return (
    <section className="rounded-md border border-edge bg-ink/60 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold text-muted">Estimated VRAM</h3>
        <span className={`text-xs font-medium ${over ? 'text-rose-300' : 'text-emerald-300'}`}>
          {fmt(plan.totalMiB)} MiB
          {plan.freeMiB !== null && <span className="text-muted"> / {fmt(plan.freeMiB)} free</span>}
        </span>
      </div>

      <div
        className="mt-2 flex h-3 overflow-hidden rounded-full bg-edge/60"
        title="weights · KV cache · compute · backend reserve"
      >
        <div className="bg-accent" style={{ width: `${pct(plan.weightsMiB)}%` }} />
        <div className="bg-violet-400" style={{ width: `${pct(plan.kvCacheMiB)}%` }} />
        <div className="bg-amber-400" style={{ width: `${pct(plan.computeMiB)}%` }} />
        <div className="bg-slate-500" style={{ width: `${pct(plan.backendOverheadMiB)}%` }} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <Legend color="bg-accent" label="weights" value={plan.weightsMiB} />
        <Legend color="bg-violet-400" label="KV cache" value={plan.kvCacheMiB} />
        <Legend color="bg-amber-400" label="compute" value={plan.computeMiB} />
        {plan.backendOverheadMiB > 0 && (
          <Legend color="bg-slate-500" label="backend" value={plan.backendOverheadMiB} />
        )}
      </div>

      <p className="mt-2 text-[11px] text-muted">
        {plan.offloadedLayers}/{plan.totalLayers} layers on GPU
        {plan.slots > 1 && (
          <>
            {' · '}
            {plan.slots} concurrent chats at{' '}
            <span className="text-slate-200">{plan.contextPerSlot.toLocaleString()}</span> tokens each
          </>
        )}
        {plan.maxGpuLayers !== null && plan.maxGpuLayers < plan.totalLayers && (
          <> · most that should fit: <span className="text-slate-200">{plan.maxGpuLayers}</span></>
        )}
      </p>

      {over && (
        <p className="mt-2 rounded border border-rose-800 bg-rose-950/50 p-2 text-[11px] text-rose-200">
          This exceeds free VRAM and will likely fail to allocate. Reduce GPU layers
          {plan.maxGpuLayers !== null && <> to {plan.maxGpuLayers}</>}, shrink the context,
          or quantise the KV cache.
        </p>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted hover:text-accent">
          How this is calculated
        </summary>
        <ul className="mt-1 space-y-0.5 pl-4 text-[11px] text-muted">
          {plan.notes.map((n) => (
            <li key={n} className="list-disc">{n}</li>
          ))}
          <li className="list-disc">
            KV cache is exact arithmetic. Weights, compute and backend reserve are
            estimates calibrated against measured launches — compute is the least
            certain, since it changes between llama.cpp releases.
          </li>
        </ul>
      </details>
    </section>
  )
}

function Legend({
  color,
  label,
  value
}: {
  color: string
  label: string
  value: number
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <span className={`h-2 w-2 rounded-sm ${color}`} />
      {label} <span className="text-slate-300">{fmt(value)}</span>
    </span>
  )
}
