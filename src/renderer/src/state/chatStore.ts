import { create } from 'zustand'
import type {
  ChatMessageView,
  ChatSettingsView,
  ConversationSummaryView,
  ConversationView
} from '@shared/types.js'
import { streamChat, type ChatTurn } from '../api/chatClient.js'
import { useServerStore } from './serverStore.js'

const DEFAULT_SETTINGS: ChatSettingsView = {
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  maxTokens: -1
}

interface ChatState {
  conversations: ConversationSummaryView[]
  active: ConversationView | null
  /** Non-null while a reply is streaming. */
  streamingId: string | null
  abort: AbortController | null
  error: string | null

  load: () => Promise<void>
  open: (id: string) => Promise<void>
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  send: (text: string) => Promise<void>
  stop: () => void
  regenerate: () => Promise<void>
  editUserMessage: (id: string, content: string) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
  setSystemPrompt: (text: string) => Promise<void>
  setSettings: (patch: Partial<ChatSettingsView>) => Promise<void>
  clearError: () => void
}

/** Title comes from the first user turn, mirroring how the built-in UI names chats. */
function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New chat'
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  active: null,
  streamingId: null,
  abort: null,
  error: null,

  async load() {
    const conversations = await window.llama.chat.list()
    set({ conversations })
    // Open the most recent chat so the app does not start on an empty screen.
    if (!get().active && conversations[0]) await get().open(conversations[0].id)
  },

  async open(id) {
    get().stop()
    const active = await window.llama.chat.get(id)
    if (active) set({ active, error: null })
  },

  async create() {
    get().stop()
    const active = await window.llama.chat.create()
    set({ active, error: null })
    set({ conversations: await window.llama.chat.list() })
  },

  async remove(id) {
    await window.llama.chat.remove(id)
    const conversations = await window.llama.chat.list()
    set({ conversations })
    if (get().active?.id === id) {
      const next = conversations[0]
      if (next) await get().open(next.id)
      else await get().create()
    }
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    let conversation = get().active
    if (!conversation) {
      await get().create()
      conversation = get().active
      if (!conversation) return
    }

    const userMessage: ChatMessageView = {
      id: newId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now()
    }
    const withUser: ConversationView = {
      ...conversation,
      title:
        conversation.messages.some((m) => m.role === 'user')
          ? conversation.title
          : deriveTitle(trimmed),
      messages: [...conversation.messages, userMessage]
    }
    set({ active: withUser })
    await persist(withUser, set)
    await runCompletion(withUser, set, get)
  },

  stop() {
    const { abort } = get()
    if (abort) abort.abort()
    set({ abort: null, streamingId: null })
  },

  /** Drop the last assistant turn and ask again from the same point. */
  async regenerate() {
    const conversation = get().active
    if (!conversation) return
    get().stop()
    const messages = [...conversation.messages]
    while (messages.length && messages[messages.length - 1]!.role === 'assistant') messages.pop()
    if (!messages.length) return
    const trimmed = { ...conversation, messages }
    set({ active: trimmed })
    await persist(trimmed, set)
    await runCompletion(trimmed, set, get)
  },

  /**
   * Editing a user turn discards everything after it: the replies that followed
   * were answers to the old wording and would be misleading if kept.
   */
  async editUserMessage(id, content) {
    const conversation = get().active
    if (!conversation) return
    const idx = conversation.messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    get().stop()
    const messages = conversation.messages.slice(0, idx + 1)
    messages[idx] = { ...messages[idx]!, content }
    const next = { ...conversation, messages }
    set({ active: next })
    await persist(next, set)
    await runCompletion(next, set, get)
  },

  async deleteMessage(id) {
    const conversation = get().active
    if (!conversation) return
    const next = { ...conversation, messages: conversation.messages.filter((m) => m.id !== id) }
    set({ active: next })
    await persist(next, set)
  },

  async setSystemPrompt(text) {
    const conversation = get().active
    if (!conversation) return
    const next = { ...conversation, systemPrompt: text }
    set({ active: next })
    await persist(next, set)
  },

  async setSettings(patch) {
    const conversation = get().active
    if (!conversation) return
    const next = { ...conversation, settings: { ...conversation.settings, ...patch } }
    set({ active: next })
    await persist(next, set)
  },

  clearError() {
    set({ error: null })
  }
}))

type Setter = (partial: Partial<ChatState>) => void
type Getter = () => ChatState

async function persist(conversation: ConversationView, set: Setter): Promise<void> {
  try {
    const saved = await window.llama.chat.save(conversation)
    set({ active: saved, conversations: await window.llama.chat.list() })
  } catch (err) {
    set({ error: `Could not save: ${(err as Error).message}` })
  }
}

/**
 * Streams one assistant reply into the conversation.
 *
 * Deltas are applied to local state as they arrive and persisted once at the
 * end — writing the file on every token would mean thousands of writes per
 * reply for no benefit, and a stopped or failed reply is still saved.
 */
async function runCompletion(
  conversation: ConversationView,
  set: Setter,
  get: Getter
): Promise<void> {
  const status = useServerStore.getState().status
  if (!status || status.phase !== 'ready' || !status.port) {
    set({ error: 'Start a model on the Server tab before chatting.' })
    return
  }
  const baseUrl = `http://127.0.0.1:${status.port}`

  const turns: ChatTurn[] = []
  if (conversation.systemPrompt.trim()) {
    turns.push({ role: 'system', content: conversation.systemPrompt })
  }
  for (const m of conversation.messages) {
    if (m.role === 'system') continue
    turns.push({ role: m.role, content: m.content })
  }

  const reply: ChatMessageView = {
    id: newId(),
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  }
  const abort = new AbortController()
  set({
    abort,
    streamingId: reply.id,
    active: { ...conversation, messages: [...conversation.messages, reply] },
    error: null
  })

  let content = ''
  let reasoning = ''
  const apply = (patch: Partial<ChatMessageView>): void => {
    const current = get().active
    if (!current) return
    set({
      active: {
        ...current,
        messages: current.messages.map((m) => (m.id === reply.id ? { ...m, ...patch } : m))
      }
    })
  }

  await streamChat(baseUrl, turns, conversation.settings ?? DEFAULT_SETTINGS, abort.signal, {
    onDelta: (text) => {
      content += text
      apply({ content })
    },
    onReasoning: (text) => {
      reasoning += text
      apply({ reasoning })
    },
    onDone: ({ tokensPerSecond, model }) => {
      apply({
        content,
        reasoning: reasoning || undefined,
        tokensPerSecond: tokensPerSecond ?? undefined,
        model: model ?? undefined,
        stopped: abort.signal.aborted || undefined
      })
    },
    onError: (message) => {
      apply({ content, error: message })
      set({ error: message })
    }
  })

  set({ abort: null, streamingId: null })

  const finished = get().active
  if (!finished) return

  // Stopping before the first token leaves an empty assistant bubble, which
  // reads as the model having answered with nothing. Drop it instead.
  const produced = finished.messages.find((m) => m.id === reply.id)
  const isEmpty =
    produced && !produced.content.trim() && !produced.reasoning?.trim() && !produced.error
  const cleaned = isEmpty
    ? { ...finished, messages: finished.messages.filter((m) => m.id !== reply.id) }
    : finished

  await persist(cleaned, set)
}
