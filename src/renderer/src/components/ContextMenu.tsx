import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContextMenuCommand, ContextMenuRequest } from '@shared/types.js'

/** A divider carries no label; every other entry does. */
type Entry =
  | { separator: true }
  | {
      separator?: false
      label: string
      command?: ContextMenuCommand
      enabled?: boolean
      emphasis?: boolean
    }

/**
 * The application's own right-click menu.
 *
 * Drawn here rather than by the platform so it looks like the rest of the app.
 * The spell-check data it needs cannot be obtained in the page — Chromium keeps
 * it in the main process — so it arrives by message, and the commands go back
 * the same way.
 */
export function ContextMenu(): React.JSX.Element | null {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return window.llama.contextMenu.onShow((r) => {
      setRequest(r)
      setPosition({ x: r.x, y: r.y })
    })
  }, [])

  // Keep the menu on screen: near an edge it opens back towards the middle.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !request) return
    const { width, height } = el.getBoundingClientRect()
    const x = request.x + width > window.innerWidth ? Math.max(0, request.x - width) : request.x
    const y = request.y + height > window.innerHeight ? Math.max(0, request.y - height) : request.y
    if (x !== position.x || y !== position.y) setPosition({ x, y })
  }, [request, position.x, position.y])

  useEffect(() => {
    if (!request) return
    const close = (): void => setRequest(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // Any interaction elsewhere dismisses it, including scrolling, which would
    // otherwise leave the menu floating over content it no longer refers to.
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [request])

  if (!request) return null

  const entries = buildEntries(request)
  if (entries.length === 0) return null

  const run = (command?: ContextMenuCommand): void => {
    setRequest(null)
    if (command) window.llama.contextMenu.send(command)
  }

  return (
    <div
      ref={ref}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      style={{ left: position.x, top: position.y }}
      className="fixed z-[100] min-w-[13rem] overflow-hidden rounded-md border border-edge
                 bg-panel py-1 shadow-xl shadow-black/50"
    >
      {entries.map((entry, i) =>
        entry.separator ? (
          <div key={`sep-${i}`} className="my-1 border-t border-edge" />
        ) : (
          <button
            key={entry.label + i}
            role="menuitem"
            type="button"
            disabled={entry.enabled === false}
            onClick={() => run(entry.command)}
            className={`block w-full px-3 py-1.5 text-left text-xs
                        ${entry.emphasis ? 'font-medium text-slate-100' : 'text-slate-300'}
                        hover:bg-accent hover:text-ink disabled:cursor-default
                        disabled:text-muted/50 disabled:hover:bg-transparent
                        disabled:hover:text-muted/50`}
          >
            {entry.label}
          </button>
        )
      )}
    </div>
  )
}

function buildEntries(r: ContextMenuRequest): Entry[] {
  const entries: Entry[] = []

  // Spelling first: it is why most right-clicks in a text box happen.
  if (r.misspelledWord) {
    if (r.dictionarySuggestions.length === 0) {
      entries.push({ label: 'No suggestions', enabled: false })
    } else {
      for (const word of r.dictionarySuggestions.slice(0, 6)) {
        entries.push({
          label: word,
          emphasis: true,
          command: { type: 'replace-misspelling', word }
        })
      }
    }
    entries.push({ separator: true })
    entries.push({
      label: `Add “${r.misspelledWord}” to dictionary`,
      command: { type: 'add-to-dictionary', word: r.misspelledWord }
    })
    entries.push({ separator: true })
  }

  if (r.linkURL) {
    entries.push({ label: 'Open link in browser', command: { type: 'open-external', url: r.linkURL } })
    entries.push({ label: 'Copy link address', command: { type: 'copy-text', text: r.linkURL } })
    entries.push({ separator: true })
  }

  if (r.isEditable) {
    entries.push({ label: 'Undo', enabled: r.canUndo, command: { type: 'undo' } })
    entries.push({ label: 'Redo', enabled: r.canRedo, command: { type: 'redo' } })
    entries.push({ separator: true })
    entries.push({ label: 'Cut', enabled: r.canCut, command: { type: 'cut' } })
    entries.push({ label: 'Copy', enabled: r.canCopy, command: { type: 'copy' } })
    entries.push({ label: 'Paste', enabled: r.canPaste, command: { type: 'paste' } })
    entries.push({ label: 'Select all', command: { type: 'select-all' } })
  } else if (r.selectionText) {
    entries.push({ label: 'Copy', command: { type: 'copy' } })
    entries.push({ label: 'Select all', command: { type: 'select-all' } })
  }

  // Trailing separators look like a menu with something missing.
  while (entries.length > 0 && entries[entries.length - 1]!.separator) entries.pop()
  return entries
}
