import type { LogLine, LogStream } from '@shared/types.js'

/**
 * Bounded log store. llama-server is chatty (per-slot lines on every request),
 * so an unbounded array is a slow memory leak. Renderer pulls deltas by seq
 * rather than being pushed the whole buffer on every line.
 */
export class LogBuffer {
  private readonly lines: LogLine[] = []
  private nextSeq = 1

  constructor(private readonly capacity = 5000) {}

  append(stream: LogStream, text: string): LogLine {
    const line: LogLine = { seq: this.nextSeq++, ts: Date.now(), stream, text }
    this.lines.push(line)
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity)
    }
    return line
  }

  /** Lines with seq strictly greater than `afterSeq`. */
  since(afterSeq: number): LogLine[] {
    if (afterSeq <= 0) return [...this.lines]
    // Buffer is sorted by seq, so a binary search beats scanning 5k entries
    // on every poll.
    let lo = 0
    let hi = this.lines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.lines[mid]!.seq <= afterSeq) lo = mid + 1
      else hi = mid
    }
    return this.lines.slice(lo)
  }

  get latestSeq(): number {
    return this.nextSeq - 1
  }

  clear(): void {
    this.lines.length = 0
  }
}

/**
 * Splits a stream of chunks into complete lines, holding a partial trailing
 * line until the rest of it arrives. llama-server writes progress with \r,
 * which we treat as a line break so load progress updates land as separate lines.
 */
export class LineSplitter {
  private pending = ''

  push(chunk: string): string[] {
    this.pending += chunk
    const parts = this.pending.split(/\r\n|\r|\n/)
    this.pending = parts.pop() ?? ''
    return parts.filter((l) => l.length > 0)
  }

  /** Flush whatever is left when the stream closes. */
  flush(): string[] {
    const rest = this.pending.trim()
    this.pending = ''
    return rest ? [rest] : []
  }
}
