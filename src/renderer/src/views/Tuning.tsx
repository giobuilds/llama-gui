import { useEffect } from 'react'
import { PRESETS, fastest, useBenchStore } from '../state/benchStore.js'
import { useServerStore } from '../state/serverStore.js'
import type { BenchResult } from '@shared/types.js'

const ts = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 1 })

/**
 * Benchmarks launch settings so tuning is based on measurements rather than
 * folklore. Sampler settings are not here on purpose: they do not change
 * throughput, so there would be nothing to measure.
 */
export function Tuning(): React.JSX.Element {
  const { run, selectedPresets, nPrompt, nGen, repetitions, error } = useBenchStore()
  const init = useBenchStore((s) => s.init)
  const toggle = useBenchStore((s) => s.togglePreset)
  const setSizes = useBenchStore((s) => s.setSizes)
  const start = useBenchStore((s) => s.start)
  const cancel = useBenchStore((s) => s.cancel)
  const applyBest = useBenchStore((s) => s.applyBest)
  const clearError = useBenchStore((s) => s.clearError)

  const model = useServerStore((s) => s.draft.modelPath)
  const serverRunning = useServerStore((s) => (s.status?.pid ?? null) !== null)

  useEffect(() => {
    void init()
  }, [init])

  const running = run?.state === 'running'
  const bestPrompt = run ? fastest(run.results, 'prompt') : null
  const bestGen = run ? fastest(run.results, 'generation') : null

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge bg-panel p-4">
        <header>
          <h1 className="text-sm font-semibold">Tuning</h1>
          <p className="mt-1 text-[11px] leading-snug text-muted">
            Measures how launch settings affect speed on this machine. Sampler
            settings aren&apos;t here — they don&apos;t change throughput.
          </p>
        </header>

        <div className="rounded border border-edge bg-ink/60 p-2 text-[11px]">
          <span className="text-muted">Model: </span>
          <span className="text-slate-200">
            {model ? model.split('/').pop() : 'none selected'}
          </span>
        </div>

        {serverRunning && (
          <p className="rounded border border-amber-900 bg-amber-950/40 p-2 text-[11px] text-amber-200">
            A server is running and would compete for the GPU. Stop it first, or
            the numbers will describe the contention rather than the settings.
          </p>
        )}

        <section>
          <h2 className="mb-1.5 text-xs font-medium text-muted">What to compare</h2>
          <div className="space-y-1.5">
            {PRESETS.map((p) => (
              <label key={p.id} className="flex gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selectedPresets.includes(p.id)}
                  disabled={running}
                  onChange={() => toggle(p.id)}
                />
                <span>
                  <span className="text-xs text-slate-200">{p.label}</span>
                  <span className="block text-[11px] leading-snug text-muted">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {selectedPresets.includes('kv-cache') && (
          <p className="rounded border border-edge bg-ink/60 p-2 text-[11px] leading-snug text-muted">
            Quantised KV caches are measured with flash attention on — llama.cpp
            cannot create a context without it, so those combinations are skipped
            rather than failing the run.
          </p>
        )}

        <section className="grid grid-cols-3 gap-2">
          <NumberField label="Prompt" value={nPrompt} disabled={running}
            onChange={(v) => setSizes({ nPrompt: v })} />
          <NumberField label="Generate" value={nGen} disabled={running}
            onChange={(v) => setSizes({ nGen: v })} />
          <NumberField label="Repeats" value={repetitions} disabled={running}
            onChange={(v) => setSizes({ repetitions: v })} />
        </section>

        {error && (
          <p onClick={clearError}
            className="cursor-pointer rounded border border-rose-800 bg-rose-950/50 p-2 text-[11px] text-rose-200">
            {error} <span className="opacity-60">(click to dismiss)</span>
          </p>
        )}

        {running ? (
          <button type="button" onClick={() => void cancel()}
            className="rounded-md border border-edge px-3 py-2 text-sm hover:border-rose-500 hover:text-rose-200">
            Cancel
          </button>
        ) : (
          <button type="button" onClick={() => void start()}
            disabled={!model || selectedPresets.length === 0}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink hover:brightness-110 disabled:opacity-40">
            Run benchmark
          </button>
        )}

        {running && run?.progress && (
          <div>
            <div className="h-1 overflow-hidden rounded-full bg-edge">
              <div className="h-full bg-accent transition-all"
                style={{ width: `${(run.progress.current / Math.max(1, run.progress.total)) * 100}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-muted">
              {run.progress.current} of {run.progress.total} · {run.progress.stage}
            </p>
          </div>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-edge px-4 py-2">
          <h2 className="text-sm font-medium">Results</h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!run && (
            <p className="text-xs text-muted">
              Pick what to compare and run a benchmark. Each combination is measured
              separately, so a few options can mean a long run.
            </p>
          )}
          {run?.state === 'failed' && (
            <p className="rounded border border-rose-800 bg-rose-950/50 p-3 text-xs text-rose-200">
              {run.error}
            </p>
          )}
          {run && run.results.length > 0 && (
            <>
              <ResultTable title="Generation" hint="tokens produced per second — what you feel while chatting"
                rows={run.results.filter((r) => r.kind === 'generation')} best={bestGen} onApply={applyBest} />
              <ResultTable title="Prompt processing" hint="how fast an existing conversation is re-read"
                rows={run.results.filter((r) => r.kind === 'prompt')} best={bestPrompt} onApply={applyBest} />
              <p className="mt-4 text-[11px] text-muted">
                {run.results[0]?.backend} · build {run.results[0]?.buildCommit} ·{' '}
                {run.request.nPrompt} prompt / {run.request.nGen} generated tokens ·{' '}
                {run.request.repetitions} repeat{run.request.repetitions === 1 ? '' : 's'}
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function ResultTable({
  title, hint, rows, best, onApply
}: {
  title: string
  hint: string
  rows: BenchResult[]
  best: BenchResult | null
  onApply: (r: BenchResult) => void
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => b.tokensPerSecond - a.tokensPerSecond)
  const top = sorted[0]!.tokensPerSecond

  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-slate-200">{title}</h3>
      <p className="mb-2 text-[11px] text-muted">{hint}</p>
      <table className="w-full text-[11px]">
        <thead className="text-muted">
          <tr className="border-b border-edge">
            <th className="py-1 text-left font-medium">Settings</th>
            <th className="py-1 text-right font-medium">tok/s</th>
            <th className="py-1 text-right font-medium">vs best</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const isBest = r === best
            const delta = ((r.tokensPerSecond - top) / top) * 100
            return (
              <tr key={i} className={`border-b border-edge/40 ${isBest ? 'bg-emerald-950/25' : ''}`}>
                <td className="py-1 text-slate-300">{describe(r)}</td>
                <td className="py-1 text-right tabular-nums text-slate-100">
                  {ts(r.tokensPerSecond)}
                  {r.stddev > 0 && <span className="text-muted"> ±{ts(r.stddev)}</span>}
                </td>
                <td className={`py-1 text-right tabular-nums ${delta === 0 ? 'text-emerald-300' : 'text-muted'}`}>
                  {delta === 0 ? 'best' : `${delta.toFixed(1)}%`}
                </td>
                <td className="py-1 pl-2 text-right">
                  <button type="button" onClick={() => onApply(r)}
                    className="rounded border border-edge px-1.5 py-0.5 text-[10px] hover:border-accent hover:text-accent">
                    Use
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Only the settings that varied are named; the rest would be noise in the row. */
function describe(r: BenchResult): string {
  const parts: string[] = []
  parts.push(`fa ${r.flashAttn}`)
  if (r.cacheTypeK !== 'f16' || r.cacheTypeV !== 'f16') {
    parts.push(r.cacheTypeK === r.cacheTypeV ? `kv ${r.cacheTypeK}` : `k ${r.cacheTypeK}/v ${r.cacheTypeV}`)
  }
  if (r.gpuLayers >= 0) parts.push(`${r.gpuLayers} layers`)
  if (r.ubatch) parts.push(`ub ${r.ubatch}`)
  parts.push(`${r.threads}t`)
  return parts.join(' · ')
}

function NumberField({
  label, value, disabled, onChange
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      <input type="number" min={1} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-edge bg-ink px-2 py-1 text-xs outline-none focus:border-accent disabled:opacity-50" />
    </label>
  )
}
