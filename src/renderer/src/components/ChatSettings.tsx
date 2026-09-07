import { useChatStore } from '../state/chatStore.js'

/**
 * Per-conversation sampler settings and system prompt. They live with the
 * conversation rather than globally, so reopening an old chat reproduces the
 * conditions it was created under.
 */
export function ChatSettings(): React.JSX.Element | null {
  const active = useChatStore((s) => s.active)
  const setSettings = useChatStore((s) => s.setSettings)
  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt)
  if (!active) return null
  const s = active.settings

  return (
    <div className="border-b border-edge bg-panel/60 p-3">
      <div className="mx-auto max-w-3xl space-y-3">
        <label className="block">
          <span className="text-[11px] font-medium text-muted">System prompt</span>
          <textarea
            value={active.systemPrompt}
            onChange={(e) => void setSystemPrompt(e.target.value)}
            rows={2}
            placeholder="Optional instructions that apply to the whole conversation"
            className="mt-1 w-full resize-y rounded border border-edge bg-ink px-2 py-1.5 text-xs outline-none focus:border-accent"
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <Slider label="Temperature" value={s.temperature} min={0} max={2} step={0.05}
            onChange={(v) => void setSettings({ temperature: v })} />
          <Slider label="Top-p" value={s.topP} min={0} max={1} step={0.01}
            onChange={(v) => void setSettings({ topP: v })} />
          <Slider label="Min-p" value={s.minP} min={0} max={1} step={0.01}
            onChange={(v) => void setSettings({ minP: v })} />
          <Slider label="Top-k" value={s.topK} min={0} max={200} step={1}
            onChange={(v) => void setSettings({ topK: v })} />
          <Slider label="Repeat penalty" value={s.repeatPenalty} min={1} max={2} step={0.01}
            onChange={(v) => void setSettings({ repeatPenalty: v })} />
          <label className="block">
            <span className="text-[11px] font-medium text-muted">Max tokens</span>
            <input
              type="number"
              min={-1}
              value={s.maxTokens}
              onChange={(e) => void setSettings({ maxTokens: Number(e.target.value) })}
              className="mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-xs outline-none focus:border-accent"
            />
            <span className="text-[10px] text-muted/70">-1 = until the model stops</span>
          </label>
        </div>
      </div>
    </div>
  )
}

function Slider({
  label, value, min, max, step, onChange
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="flex justify-between text-[11px] font-medium text-muted">
        {label} <span className="text-slate-300">{value}</span>
      </span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--color-accent)]"
      />
    </label>
  )
}
