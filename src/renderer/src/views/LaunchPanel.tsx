import { useServerStore } from '../state/serverStore.js'
import { KV_CACHE_TYPES } from '@shared/types.js'
import { Field, inputClass } from '../components/Field.js'
import { StatusBadge } from '../components/StatusBadge.js'

/** Phases in which a new launch must not be attempted. */
const LIVE_PHASES = new Set(['starting', 'loading', 'ready', 'degraded', 'stopping'])

export function LaunchPanel(): React.JSX.Element {
  const { status, binary, devices, draft, busy, error } = useServerStore()
  const setDraft = useServerStore((s) => s.setDraft)
  const start = useServerStore((s) => s.start)
  const stop = useServerStore((s) => s.stop)
  const refreshDevices = useServerStore((s) => s.refreshDevices)
  const clearError = useServerStore((s) => s.clearError)

  const phase = status?.phase ?? 'stopped'
  const live = LIVE_PHASES.has(phase)
  const supports = (flag: string): boolean => !binary || binary.flags.includes(flag)

  const pickModel = async (): Promise<void> => {
    const path = await window.llama.dialog.pickModelFile()
    if (path) setDraft({ modelPath: path })
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge bg-panel p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-wide">Server</h1>
        <StatusBadge phase={phase} />
      </header>

      {binary && binary.path === '' && (
        <p className="rounded-md border border-rose-800 bg-rose-950/50 p-2.5 text-xs text-rose-200">
          Could not find <code>llama-server</code> on this system. Set{' '}
          <code>LLAMA_SERVER_PATH</code> and restart.
        </p>
      )}

      {status?.adopted && phase === 'ready' && (
        <p className="rounded-md border border-sky-800 bg-sky-950/40 p-2.5 text-xs text-sky-200">
          Attached to a llama-server that was already running (pid {status.pid}).
        </p>
      )}

      {error && (
        <p
          className="cursor-pointer rounded-md border border-rose-800 bg-rose-950/50 p-2.5 text-xs text-rose-200"
          onClick={clearError}
        >
          {error} <span className="opacity-60">(click to dismiss)</span>
        </p>
      )}

      {status?.error && phase === 'crashed' && (
        <p className="rounded-md border border-rose-800 bg-rose-950/50 p-2.5 text-xs text-rose-200">
          {status.error}
        </p>
      )}

      <Field label="Model" hint={draft.modelPath || 'No model selected'}>
        <button
          type="button"
          onClick={() => void pickModel()}
          disabled={live}
          className={`${inputClass} text-left hover:border-accent`}
        >
          {draft.modelPath ? draft.modelPath.split('/').pop() : 'Choose a .gguf file…'}
        </button>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="GPU layers (-ngl)" hint="999 offloads everything that fits">
          <input
            type="number"
            min={0}
            className={inputClass}
            value={draft.gpuLayers}
            disabled={live}
            onChange={(e) => setDraft({ gpuLayers: Number(e.target.value) })}
          />
        </Field>
        <Field label="Context (-c)" hint="0 = use the model's trained size">
          <input
            type="number"
            min={0}
            step={512}
            className={inputClass}
            value={draft.contextSize}
            disabled={live}
            onChange={(e) => setDraft({ contextSize: Number(e.target.value) })}
          />
        </Field>
        {supports('--cache-type-k') && (
          <Field label="KV cache K (-ctk)">
            <select
              className={inputClass}
              value={draft.cacheTypeK}
              disabled={live}
              onChange={(e) => setDraft({ cacheTypeK: e.target.value as typeof draft.cacheTypeK })}
            >
              {KV_CACHE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
        {supports('--cache-type-v') && (
          <Field label="KV cache V (-ctv)">
            <select
              className={inputClass}
              value={draft.cacheTypeV}
              disabled={live}
              onChange={(e) => setDraft({ cacheTypeV: e.target.value as typeof draft.cacheTypeV })}
            >
              {KV_CACHE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Parallel slots (-np)">
          <input
            type="number"
            min={1}
            max={64}
            className={inputClass}
            value={draft.parallel}
            disabled={live}
            onChange={(e) => setDraft({ parallel: Number(e.target.value) })}
          />
        </Field>
        <Field label="Threads (-t)" hint="-1 lets llama.cpp decide">
          <input
            type="number"
            min={-1}
            className={inputClass}
            value={draft.threads}
            disabled={live}
            onChange={(e) => setDraft({ threads: Number(e.target.value) })}
          />
        </Field>
      </div>

      {supports('--flash-attn') && (
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={draft.flashAttn}
            disabled={live}
            onChange={(e) => setDraft({ flashAttn: e.target.checked })}
          />
          Flash attention (-fa)
        </label>
      )}

      <Field label="Extra flags" hint="Passed through verbatim">
        <input
          type="text"
          className={inputClass}
          placeholder="--mlock --no-mmap"
          value={draft.extraArgs}
          disabled={live}
          onChange={(e) => setDraft({ extraArgs: e.target.value })}
        />
      </Field>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={live || busy || !binary?.path}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink
                     hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Launch
        </button>
        <button
          type="button"
          onClick={() => void stop()}
          disabled={!live || busy}
          className="flex-1 rounded-md border border-edge px-3 py-2 text-sm font-medium
                     hover:border-rose-500 hover:text-rose-200 disabled:opacity-40"
        >
          Stop
        </button>
      </div>

      <section className="mt-2 border-t border-edge pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-muted">Devices</h2>
          <button
            type="button"
            onClick={() => void refreshDevices()}
            className="text-[11px] text-muted hover:text-accent"
          >
            Refresh
          </button>
        </div>
        {devices.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted">CPU only — no GPU devices reported.</p>
        ) : (
          devices.map((d) => (
            <div key={d.id} className="mt-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-300">
                  {d.id} · {d.name}
                </span>
                <span className="text-muted">
                  {(d.totalMiB - d.freeMiB).toLocaleString()} / {d.totalMiB.toLocaleString()} MiB
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink">
                <div
                  className="h-full bg-accent"
                  style={{
                    width: `${Math.min(100, ((d.totalMiB - d.freeMiB) / d.totalMiB) * 100)}%`
                  }}
                />
              </div>
            </div>
          ))
        )}
      </section>

      {binary && binary.path !== '' && (
        <footer className="mt-auto pt-3 text-[11px] leading-relaxed text-muted/70">
          <div className="truncate" title={binary.path}>
            {binary.path}
          </div>
          <div>build {binary.version}</div>
          {status?.port && (
            <a
              href={`http://127.0.0.1:${status.port}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              open built-in web UI :{status.port}
            </a>
          )}
        </footer>
      )}
    </aside>
  )
}
