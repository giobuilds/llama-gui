import { activeConversation, useChatStore } from '../state/chatStore.js'
import { useServerStore } from '../state/serverStore.js'

/**
 * Which tools the model may call.
 *
 * Switched individually rather than all at once, because every enabled
 * definition is sent with every message whether it is used or not — measured at
 * roughly 50 tokens each on this machine. The running cost is shown so the
 * trade is visible at the point of making it.
 */
function ToolToggles({ onConfigure }: { onConfigure: () => void }): React.JSX.Element | null {
  const tools = useChatStore((s) => s.availableTools)
  const enabled = useChatStore((s) => activeConversation(s)?.tools ?? [])
  const toggle = useChatStore((s) => s.toggleTool)
  const canCall = useServerStore((s) => s.status?.supportsTools ?? false)
  if (tools.length === 0) return null

  // Roughly four characters to a token, over the JSON actually sent.
  const cost = tools
    .filter((t) => enabled.includes(t.name))
    .reduce((total, t) => total + Math.ceil(JSON.stringify(t).length / 4), 0)

  return (
    <section className="rounded border border-edge bg-ink/50 p-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-medium text-muted">Tools</h3>
        {cost > 0 && (
          <span className="text-[11px] text-muted" title="Sent with every message in this conversation">
            ~{cost} tokens per message
          </span>
        )}
        <button
          type="button"
          onClick={onConfigure}
          className="ml-auto text-[11px] text-muted hover:text-slate-200"
        >
          Configure…
        </button>
      </div>

      {!canCall && (
        <p className="mt-1 text-[11px] text-amber-300">
          The running model does not support tool calls, so these will be ignored.
        </p>
      )}

      <div className="mt-1.5 space-y-1">
        {tools.map((t) => (
          <label key={t.name} className="flex gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={enabled.includes(t.name)}
              onChange={() => void toggle(t.name)}
            />
            <span>
              <span className="text-xs text-slate-200">{t.label}</span>
              <span className="block text-[11px] leading-snug text-muted">{t.description}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  )
}

/**
 * Per-conversation sampler settings and system prompt. They live with the
 * conversation rather than globally, so reopening an old chat reproduces the
 * conditions it was created under.
 */
export function ChatSettings({
  onConfigureTools
}: {
  onConfigureTools: () => void
}): React.JSX.Element | null {
  const active = useChatStore(activeConversation)
  const setSettings = useChatStore((s) => s.setSettings)
  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt)
  if (!active) return null
  const s = active.settings

  return (
    <div className="border-b border-edge bg-panel/60 p-3">
      <div className="mx-auto max-w-3xl space-y-3">
        <ToolToggles onConfigure={onConfigureTools} />

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
