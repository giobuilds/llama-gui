import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../state/chatStore.js'
import { useServerStore } from '../state/serverStore.js'
import { Message } from '../components/Message.js'
import { ChatSidebar } from '../components/ChatSidebar.js'
import { ChatSettings } from '../components/ChatSettings.js'

export function Chat(): React.JSX.Element {
  const { active, streamingId, error } = useChatStore()
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const regenerate = useChatStore((s) => s.regenerate)
  const editUserMessage = useChatStore((s) => s.editUserMessage)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const clearError = useChatStore((s) => s.clearError)
  const load = useChatStore((s) => s.load)

  const serverPhase = useServerStore((s) => s.status?.phase ?? 'stopped')
  const ready = serverPhase === 'ready'

  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    void load()
  }, [load])

  // Follow the stream, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    if (!stickToBottom.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active?.messages, streamingId])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  const submit = (): void => {
    if (!input.trim() || streamingId) return
    const text = input
    setInput('')
    stickToBottom.current = true
    void send(text)
  }

  const messages = active?.messages ?? []
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')

  return (
    <div className="flex h-full min-h-0">
      <ChatSidebar />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-edge px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {active?.title ?? 'New chat'}
          </h2>
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent"
          >
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
        </header>

        {showSettings && <ChatSettings />}

        {!ready && (
          <p className="border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
            No model is running — start one on the <strong>Server</strong> tab to chat.
          </p>
        )}

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <p className="text-sm text-muted">Nothing here yet.</p>
                <p className="mt-1 text-xs text-muted/70">
                  Ask something below. Shift+Enter for a new line.
                </p>
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                streaming={m.id === streamingId}
                canRegenerate={m.id === lastAssistant?.id && !streamingId}
                onEdit={(content) => void editUserMessage(m.id, content)}
                onDelete={() => void deleteMessage(m.id)}
                onRegenerate={() => void regenerate()}
              />
            ))
          )}
        </div>

        {error && (
          <p
            onClick={clearError}
            className="cursor-pointer border-t border-rose-900 bg-rose-950/40 px-4 py-2 text-xs text-rose-200"
          >
            {error} <span className="opacity-60">(click to dismiss)</span>
          </p>
        )}

        <footer className="border-t border-edge p-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={Math.min(10, input.split('\n').length)}
              placeholder={ready ? 'Send a message…' : 'Start a model to chat'}
              disabled={!ready}
              className="max-h-56 flex-1 resize-none rounded-md border border-edge bg-ink px-3 py-2
                         text-sm outline-none focus:border-accent disabled:opacity-50"
            />
            {streamingId ? (
              <button
                type="button"
                onClick={stop}
                className="rounded-md border border-edge px-4 py-2 text-sm hover:border-rose-500 hover:text-rose-200"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!ready || !input.trim()}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ink
                           hover:brightness-110 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  )
}
