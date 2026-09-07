import { useMemo, useState } from 'react'
import type { ModelEntryView } from '@shared/types.js'
import { useServerStore } from '../state/serverStore.js'

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`

const params = (n: number | null): string | null => {
  if (!n) return null
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  return `${Math.round(n / 1e6)}M`
}

/**
 * Model library. Shows what the GGUF header actually says — architecture,
 * quantisation, layer count, trained context — because those are the numbers
 * that decide the launch flags, and they are otherwise only visible by
 * launching the model and reading the log.
 */
export function ModelPicker({ disabled }: { disabled: boolean }): React.JSX.Element {
  const models = useServerStore((s) => s.models)
  const loading = useServerStore((s) => s.modelsLoading)
  const selected = useServerStore((s) => s.draft.modelPath)
  const setDraft = useServerStore((s) => s.setDraft)
  const loadModels = useServerStore((s) => s.loadModels)
  const addModelDir = useServerStore((s) => s.addModelDir)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.fileName.toLowerCase().includes(q) ||
        m.architecture.toLowerCase().includes(q) ||
        (m.quant ?? '').toLowerCase().includes(q)
    )
  }, [models, query])

  const current = models.find((m) => m.path === selected)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted">Model</h2>
        <div className="flex gap-2 text-[11px]">
          <button type="button" onClick={() => void addModelDir()} className="text-muted hover:text-accent">
            Add folder
          </button>
          <button
            type="button"
            onClick={() => void loadModels(true)}
            className="text-muted hover:text-accent"
          >
            {loading ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-edge bg-ink px-2.5 py-2 text-left text-sm
                   hover:border-accent disabled:opacity-50"
      >
        {current ? (
          <>
            <div className="truncate text-slate-100">{current.name}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted">
              {[current.architecture, current.quant, params(current.parameterCount),
                current.blockCount ? `${current.blockCount} layers` : null,
                gb(current.fileSize)]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </>
        ) : selected ? (
          <span className="truncate text-slate-300">{selected.split('/').pop()}</span>
        ) : (
          <span className="text-muted">Choose a model…</span>
        )}
      </button>

      {open && !disabled && (
        <div className="rounded-md border border-edge bg-ink">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${models.length} models…`}
            className="w-full border-b border-edge bg-transparent px-2.5 py-1.5 text-xs outline-none"
          />
          <ul className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="px-2.5 py-3 text-[11px] text-muted">
                {models.length === 0
                  ? 'No .gguf files found. Use “Add folder”, or “Browse…” below.'
                  : 'Nothing matches that filter.'}
              </li>
            )}
            {filtered.map((m) => (
              <ModelRow
                key={m.path}
                model={m}
                active={m.path === selected}
                onPick={() => {
                  setDraft({ modelPath: m.path })
                  setOpen(false)
                  setQuery('')
                }}
              />
            ))}
          </ul>
          <button
            type="button"
            onClick={async () => {
              const path = await window.llama.dialog.pickModelFile()
              if (path) setDraft({ modelPath: path })
              setOpen(false)
            }}
            className="w-full border-t border-edge px-2.5 py-2 text-left text-[11px] text-muted hover:text-accent"
          >
            Browse for a file outside these folders…
          </button>
        </div>
      )}
    </section>
  )
}

function ModelRow({
  model,
  active,
  onPick
}: {
  model: ModelEntryView
  active: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={`w-full px-2.5 py-1.5 text-left hover:bg-panel ${active ? 'bg-panel' : ''}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-slate-100">{model.name}</span>
          <span className="shrink-0 text-[10px] text-muted">{gb(model.fileSize)}</span>
        </div>
        <div className="truncate text-[10px] text-muted">
          {model.error ? (
            <span className="text-rose-300">unreadable: {model.error}</span>
          ) : (
            [
              model.architecture,
              model.quant,
              model.blockCount ? `${model.blockCount}L` : null,
              model.contextLength ? `${(model.contextLength / 1024).toFixed(0)}k ctx` : null,
              model.hasChatTemplate ? 'chat template' : 'no template'
            ]
              .filter(Boolean)
              .join(' · ')
          )}
        </div>
      </button>
    </li>
  )
}
