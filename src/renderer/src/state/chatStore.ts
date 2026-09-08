import { create } from 'zustand'
import type {
  ChatMessageView,
  ChatSettingsView,
  ConversationSummaryView,
  ConversationView
} from '@shared/types.js'
import { streamChat, type ChatTurn, type StreamedToolCall } from '../api/chatClient.js'
import type { ToolCallView, ToolDefinition } from '@shared/types.js'
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

/**
 * How many rounds of tool use one message may take.
 *
 * A model that searches, reads a page, then searches again is behaving
 * reasonably. One that does it twenty times is stuck, and every round costs both
 * context and time, so the loop stops and lets it answer with what it has.
 */
const MAX_TOOL_ROUNDS = 4

/**
 * Full tool output is dropped from history once the model has answered from it.
 *
 * Keeping it would mean every later turn re-sends every page ever fetched: at
 * roughly 1,300 tokens a page, a handful of searches would fill a conversation's
 * whole context with material nobody is reading. The one-line summary and the
 * sources stay, so the conversation still records what was consulted.
 */
const KEEP_FULL_RESULTS_FOR_TURNS = 1

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
  /** Tools the model may call, and which of them are switched on. */
  availableTools: ToolDefinition[]
  error: string | null

  load: () => Promise<void>
  loadTools: () => Promise<void>
  toggleTool: (name: string) => Promise<void>
  open: (id: string) => Promise<void>
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  send: (text: string, images?: string[]) => Promise<void>
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
  availableTools: [],
  error: null,

  async loadTools() {
    try {
      set({ availableTools: await window.llama.tools.list() })
    } catch {
      // Without tools the app simply cannot search; nothing else breaks.
    }
  },

  async toggleTool(name) {
    const conversation = activeConversation(get())
    if (!conversation) return
    const on = conversation.tools ?? []
    const next = {
      ...conversation,
      tools: on.includes(name) ? on.filter((t) => t !== name) : [...on, name]
    }
    put(set, get, next)
    await persist(next, set, get)
  },

  async load() {
    const conversations = await window.llama.chat.list()
    set({ conversations })
    void get().loadTools()
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
    const created = await window.llama.chat.create('', activeConversation(get())?.tools ?? [])
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

  async send(text, images) {
    const trimmed = text.trim()
    // An image on its own is a valid message; the model is being asked to
    // describe it.
    if (!trimmed && !images?.length) return
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
      ...(images?.length ? { images } : {}),
      createdAt: Date.now()
    }
    const withUser: ConversationView = {
      ...conversation,
      title: conversation.messages.some((m) => m.role === 'user')
        ? conversation.title
        : deriveTitle(trimmed || 'Image'),
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

/**
 * Turn a stored conversation into the messages sent to the model.
 *
 * Tool output older than the most recent turn is replaced by its one-line
 * summary. The model has already answered from the full text; re-sending it on
 * every later message would fill the context with pages nobody is reading.
 */
export function buildTurns(conversation: ConversationView): ChatTurn[] {
  const turns: ChatTurn[] = []
  if (conversation.systemPrompt.trim()) {
    turns.push({ role: 'system', content: conversation.systemPrompt })
  }

  const assistantTurns = conversation.messages.filter((m) => m.role === 'assistant')
  const recent = new Set(
    assistantTurns.slice(-KEEP_FULL_RESULTS_FOR_TURNS).map((m) => m.id)
  )

  for (const m of conversation.messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const keepFull = recent.has(m.id)
      const note = m.toolCalls
        .map((c) =>
          keepFull && c.content
            ? `${c.summary ?? c.name}\n${c.content}`
            : (c.summary ?? `${c.name} was used`)
        )
        .join('\n\n')
      // Folded into the assistant's own turn, so the transcript stays a plain
      // alternation and no orphaned tool messages are sent.
      turns.push({ role: 'assistant', content: [note, m.content].filter(Boolean).join('\n\n') })
      continue
    }
    turns.push({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })
  }
  return turns
}

/** Arguments come from model output, so a malformed object is handled, not thrown. */
async function runToolCall(
  call: StreamedToolCall
): Promise<{ ok: boolean; summary: string; content: string; sources?: ToolCallView['sources'] }> {
  let args: Record<string, unknown> = {}
  try {
    args = call.argumentsJson ? (JSON.parse(call.argumentsJson) as Record<string, unknown>) : {}
  } catch {
    return {
      ok: false,
      summary: `${call.name}: arguments could not be read`,
      content: 'The arguments were not valid JSON. Try the call again with simpler arguments.'
    }
  }
  try {
    return await window.llama.tools.run(call.name, args)
  } catch (err) {
    return { ok: false, summary: `${call.name} failed`, content: (err as Error).message }
  }
}

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

  const turns = buildTurns(conversation)

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
  const toolCalls: ToolCallView[] = []
  const apply = (patch: Partial<ChatMessageView>): void => {
    const current = get().byId[conversationId]
    if (!current) return
    put(set, get, {
      ...current,
      messages: current.messages.map((m) => (m.id === reply.id ? { ...m, ...patch } : m))
    })
  }

  // Only the tools the user switched on are declared, because every definition
  // is sent with every request whether or not it is used.
  const chosen = activeConversation(get())?.tools ?? []
  const enabled = get().availableTools.filter((t) => chosen.includes(t.name))
  const toolSpec = enabled.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let requested: StreamedToolCall[] = []
      let failed = false

      await streamChat(
        baseUrl,
        turns,
        conversation.settings ?? DEFAULT_SETTINGS,
        abort.signal,
        {
          onDelta: (text) => {
            content += text
            apply({ content })
          },
          onReasoning: (text) => {
            reasoning += text
            apply({ reasoning })
          },
          onDone: ({ tokensPerSecond, model, toolCalls: calls }) => {
            requested = calls.filter((c) => c.name)
            apply({
              content,
              reasoning: reasoning || undefined,
              tokensPerSecond: tokensPerSecond ?? undefined,
              model: model ?? undefined,
              stopped: abort.signal.aborted || undefined
            })
          },
          onError: (message) => {
            failed = true
            apply({ content, error: message })
            set({ error: message })
          }
        },
        toolSpec.length > 0 ? toolSpec : undefined
      )

      if (failed || abort.signal.aborted || requested.length === 0) break

      if (round === MAX_TOOL_ROUNDS) {
        // Out of rounds: say so in the conversation rather than looping on.
        apply({ content: content || '', error: 'Stopped after too many tool calls.' })
        break
      }

      // Show the calls before running them, so a slow search is visible.
      for (const call of requested) {
        toolCalls.push({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })
      }
      apply({ toolCalls: [...toolCalls] })

      turns.push({ role: 'assistant', content, toolCalls: requested })

      for (const call of requested) {
        const result = await runToolCall(call)
        const entry = toolCalls.find((t) => t.id === call.id)
        if (entry) {
          entry.summary = result.summary
          entry.ok = result.ok
          entry.sources = result.sources
          entry.content = result.content
          entry.approxTokens = Math.ceil(result.content.length / 4)
        }
        apply({ toolCalls: [...toolCalls] })
        turns.push({ role: 'tool', toolCallId: call.id, content: result.content })
      }

      // The next round continues the same reply rather than starting a new one.
      content = ''
      reasoning = ''
    }
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
