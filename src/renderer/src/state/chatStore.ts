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

interface ActiveStream {
  abort: AbortController
  /** The assistant message being written into. */
  messageId: string
}

interface ChatState {
  conversations: ConversationSummaryView[]
  /**
   * Conversations held in memory: the visible one plus any still generating.
   * Generation must survive switching away, so a reply cannot live only in the
   * state of whichever chat happens to be on screen.
   */
  byId: Record<string, ConversationView>
  activeId: string | null
  /** Keyed by conversation id, so several chats can generate at once. */
  streams: Record<string, ActiveStream>
  error: string | null

  load: () => Promise<void>
  open: (id: string) => Promise<void>
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  send: (text: string) => Promise<void>
  stop: (conversationId?: string) => void
  stopAll: () => void
  flushInFlight: () => Promise<void>
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
  byId: {},
  activeId: null,
  streams: {},
  error: null,

  async load() {
    const conversations = await window.llama.chat.list()
    set({ conversations })
    if (!get().activeId && conversations[0]) await get().open(conversations[0].id)
  },

  /** Switching chats never interrupts generation — the stream keeps running. */
  async open(id) {
    if (get().byId[id]) {
      set({ activeId: id, error: null })
      return
    }
    const loaded = await window.llama.chat.get(id)
    if (loaded) {
      set({ byId: { ...get().byId, [id]: loaded }, activeId: id, error: null })
    }
  },

  async create() {
    const created = await window.llama.chat.create()
    set({
      byId: { ...get().byId, [created.id]: created },
      activeId: created.id,
      error: null,
      conversations: await window.llama.chat.list()
    })
  },

  async remove(id) {
    get().stop(id)
    await window.llama.chat.remove(id)
    const { [id]: _removed, ...rest } = get().byId
    const conversations = await window.llama.chat.list()
    set({ byId: rest, conversations })
    if (get().activeId === id) {
      set({ activeId: null })
      const next = conversations[0]
      if (next) await get().open(next.id)
      else await get().create()
    }
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    let conversation = activeConversation(get())
    if (!conversation) {
      await get().create()
      conversation = activeConversation(get())
      if (!conversation) return
    }
    // One in-flight reply per conversation; a second send would race the first
    // into the same message list.
    if (get().streams[conversation.id]) return

    const userMessage: ChatMessageView = {
      id: newId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now()
    }
    const withUser: ConversationView = {
      ...conversation,
      title: conversation.messages.some((m) => m.role === 'user')
        ? conversation.title
        : deriveTitle(trimmed),
      messages: [...conversation.messages, userMessage]
    }
    put(set, get, withUser)
    await persist(withUser, set, get)
    await runCompletion(withUser.id, set, get)
  },

  stop(conversationId) {
    const id = conversationId ?? get().activeId
    if (!id) return
    const stream = get().streams[id]
    if (!stream) return
    stream.abort.abort()
    // The stream's own finally-block clears the entry; doing it here too would
    // race with the completion writing its final state.
  },

  stopAll() {
    for (const stream of Object.values(get().streams)) stream.abort.abort()
  },

  /**
   * Replies are written to disk once they finish, so a quit mid-generation
   * would otherwise lose whatever had streamed so far. This flushes every
   * in-flight conversation as it stands.
   */
  async flushInFlight() {
    const { streams, byId } = get()
    await Promise.all(
      Object.keys(streams).map(async (id) => {
        const conversation = byId[id]
        if (!conversation) return
        try {
          await window.llama.chat.save(conversation)
        } catch {
          // Nothing useful to do while the window is closing.
        }
      })
    )
  },

  async regenerate() {
    const conversation = activeConversation(get())
    if (!conversation || get().streams[conversation.id]) return
    const messages = [...conversation.messages]
    while (messages.length && messages[messages.length - 1]!.role === 'assistant') messages.pop()
    if (!messages.length) return
    const trimmed = { ...conversation, messages }
    put(set, get, trimmed)
    await persist(trimmed, set, get)
    await runCompletion(trimmed.id, set, get)
  },

  /**
   * Editing a user turn discards everything after it: the replies that followed
   * were answers to the old wording and would be misleading if kept.
   */
  async editUserMessage(id, content) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const idx = conversation.messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    get().stop(conversation.id)
    const messages = conversation.messages.slice(0, idx + 1)
    messages[idx] = { ...messages[idx]!, content }
    const next = { ...conversation, messages }
    put(set, get, next)
    await persist(next, set, get)
    await runCompletion(next.id, set, get)
  },

  async deleteMessage(id) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, messages: conversation.messages.filter((m) => m.id !== id) }
    put(set, get, next)
    await persist(next, set, get)
  },

  async setSystemPrompt(text) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, systemPrompt: text }
    put(set, get, next)
    await persist(next, set, get)
  },

  async setSettings(patch) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const next = { ...conversation, settings: { ...conversation.settings, ...patch } }
    put(set, get, next)
    await persist(next, set, get)
  },

  clearError() {
    set({ error: null })
  }
}))

type Setter = (partial: Partial<ChatState>) => void
type Getter = () => ChatState

/** The conversation currently on screen, if any. */
export function activeConversation(state: ChatState): ConversationView | null {
  return state.activeId ? (state.byId[state.activeId] ?? null) : null
}

/** Is this conversation generating right now? */
export function isStreaming(state: ChatState, conversationId: string): boolean {
  return Boolean(state.streams[conversationId])
}

function put(set: Setter, get: Getter, conversation: ConversationView): void {
  set({ byId: { ...get().byId, [conversation.id]: conversation } })
}

async function persist(
  conversation: ConversationView,
  set: Setter,
  get: Getter
): Promise<void> {
  try {
    const saved = await window.llama.chat.save(conversation)
    put(set, get, saved)
    set({ conversations: await window.llama.chat.list() })
  } catch (err) {
    set({ error: `Could not save: ${(err as Error).message}` })
  }
}

/**
 * Streams one assistant reply into a conversation, addressed by id rather than
 * by "whatever is active" — the user may switch away mid-generation, and the
 * tokens still belong to the conversation that asked for them.
 *
 * Deltas are applied to memory as they arrive and written to disk once at the
 * end; persisting per token would be thousands of writes per reply.
 */
async function runCompletion(conversationId: string, set: Setter, get: Getter): Promise<void> {
  const conversation = get().byId[conversationId]
  if (!conversation) return

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

  put(set, get, { ...conversation, messages: [...conversation.messages, reply] })
  set({
    streams: { ...get().streams, [conversationId]: { abort, messageId: reply.id } },
    error: null
  })

  let content = ''
  let reasoning = ''
  const apply = (patch: Partial<ChatMessageView>): void => {
    const current = get().byId[conversationId]
    if (!current) return
    put(set, get, {
      ...current,
      messages: current.messages.map((m) => (m.id === reply.id ? { ...m, ...patch } : m))
    })
  }

  try {
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
  } finally {
    const { [conversationId]: _done, ...remaining } = get().streams
    set({ streams: remaining })
  }

  const finished = get().byId[conversationId]
  if (!finished) return

  // Stopping before the first token leaves an empty assistant bubble, which
  // reads as the model having answered with nothing. Drop it instead.
  const produced = finished.messages.find((m) => m.id === reply.id)
  const isEmpty =
    produced && !produced.content.trim() && !produced.reasoning?.trim() && !produced.error
  const cleaned = isEmpty
    ? { ...finished, messages: finished.messages.filter((m) => m.id !== reply.id) }
    : finished

  await persist(cleaned, set, get)
}
