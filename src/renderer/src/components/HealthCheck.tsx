import { useServerStore } from '../state/serverStore.js'

/**
 * A binary that runs, reports a version and lists devices can still segfault on
 * its first compute kernel — every cheap check passes such a build. This loads
 * the selected model and generates real tokens, which is the only step that
 * catches it, and reports where it broke if it does.
 */
export function HealthCheck({ disabled }: { disabled: boolean }): React.JSX.Element {
  const health = useServerStore((s) => s.health)
  const running = useServerStore((s) => s.healthRunning)
  const run = useServerStore((s) => s.runHealthCheck)
  const hasModel = useServerStore((s) => Boolean(s.draft.modelPath))

  return (
    <section className="rounded-md border border-edge bg-ink/60 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted">Binary check</h3>
        <button
          type="button"
          onClick={() => void run()}
          disabled={disabled || running || !hasModel}
          className="rounded border border-edge px-2 py-0.5 text-[11px] hover:border-accent
                     disabled:cursor-not-allowed disabled:opacity-40"
          title={hasModel ? 'Load the model and generate a few tokens' : 'Choose a model first'}
        >
          {running ? 'Verifying…' : 'Verify'}
        </button>
      </div>

      {!health && !running && (
        <p className="mt-1.5 text-[11px] text-muted">
          Loads the model and generates a few tokens. Catches a build that starts
          fine but cannot actually run inference.
        </p>
      )}

      {health && (
        <>
          <p
            className={`mt-2 text-xs font-medium ${
              health.ok ? 'text-emerald-300' : 'text-rose-300'
            }`}
          >
            {health.ok
              ? `Working${health.tokensPerSecond ? ` — ${health.tokensPerSecond.toFixed(0)} tok/s` : ''}`
              : 'This binary cannot run this model'}
          </p>
          <ol className="mt-1.5 space-y-0.5">
            {health.steps.map((s) => (
              <li key={s.step} className="flex items-baseline gap-2 text-[11px]">
                <span className={s.ok ? 'text-emerald-400' : 'text-rose-400'}>
                  {s.ok ? '✓' : '✕'}
                </span>
                <span className="w-16 shrink-0 text-muted">{s.step}</span>
                <span className="min-w-0 flex-1 truncate text-slate-300" title={s.detail}>
                  {s.detail}
                </span>
                <span className="shrink-0 text-muted/70">{s.ms}ms</span>
              </li>
            ))}
          </ol>
          {health.error && (
            <p className="mt-2 rounded border border-rose-800 bg-rose-950/50 p-2 text-[11px] text-rose-200">
              {health.error}
            </p>
          )}
        </>
      )}
    </section>
  )
}
