import type { ChatSettingsView } from '@shared/types.js'

/**
 * Streams a completion straight from llama-server to the renderer.
 *
 * Deliberately not routed through IPC: every token would otherwise cross a
 * process boundary and be serialised individually, for no benefit. The main
 * process keeps the privileged work; this is just an HTTP request to loopback,
 * which the CSP allows.
 */

export interface StreamCallbacks {
  onDelta: (text: string) => void
  /** Reasoning models emit thinking separately from the answer. */
  onReasoning?: (text: string) => void
  onDone: (info: { tokensPerSecond: number | null; model: string | null }) => void
  onError: (message: string) => void
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface StreamChunk {
  model?: string
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }>
  timings?: { predicted_per_second?: number }
  error?: { message?: string }
}

export async function streamChat(
  baseUrl: string,
  messages: ChatTurn[],
  settings: ChatSettingsView,
  signal: AbortSignal,
  cb: StreamCallbacks
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        messages,
        stream: true,
        // llama.cpp reports timings in the final streamed chunk when asked.
        timings_per_token: true,
        temperature: settings.temperature,
        top_p: settings.topP,
        top_k: settings.topK,
        min_p: settings.minP,
        repeat_penalty: settings.repeatPenalty,
        ...(settings.maxTokens > 0 ? { max_tokens: settings.maxTokens } : {})
      })
    })
  } catch (err) {
    if (signal.aborted) return
    cb.onError(`Could not reach the server: ${(err as Error).message}`)
    return
  }

  if (!res.ok || !res.body) {
    cb.onError(await describeHttpError(res))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let tokensPerSecond: number | null = null
  let model: string | null = null

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE events are separated by a blank line; a chunk boundary can fall
      // anywhere, so only complete events are consumed.
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let chunk: StreamChunk
          try {
            chunk = JSON.parse(payload) as StreamChunk
          } catch {
            continue // a malformed keep-alive should not end the stream
          }
          if (chunk.error?.message) {
            cb.onError(chunk.error.message)
            return
          }
          if (chunk.model) model = chunk.model
          if (chunk.timings?.predicted_per_second) {
            tokensPerSecond = chunk.timings.predicted_per_second
          }
          const delta = chunk.choices?.[0]?.delta
          if (delta?.reasoning_content) cb.onReasoning?.(delta.reasoning_content)
          if (delta?.content) cb.onDelta(delta.content)
        }
      }
    }
    cb.onDone({ tokensPerSecond, model })
  } catch (err) {
    // An abort is a user action, not a failure: the partial reply is kept.
    if (signal.aborted) {
      cb.onDone({ tokensPerSecond, model })
      return
    }
    cb.onError(`Stream interrupted: ${(err as Error).message}`)
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function describeHttpError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // fall through to the status line
  }
  if (res.status === 503) return 'The model is still loading. Try again in a moment.'
  return `Server returned HTTP ${res.status} ${res.statusText}`.trim()
}
