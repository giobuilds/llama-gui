import { EventEmitter } from 'node:events'
import { McpServer } from './mcp.js'
import type { McpServerConfig, McpServerState, ToolDefinition, ToolResult } from '@shared/types.js'

/**
 * The set of configured MCP servers.
 *
 * Servers are started only when enabled, and their tools join the built-in ones
 * in a single list — from the model's point of view there is no difference, and
 * from the user's the only thing that matters is what a tool does and what it
 * costs to declare.
 */
export class McpRegistry extends EventEmitter<{ state: [McpServerState[]] }> {
  private servers = new Map<string, McpServer>()

  constructor(private readonly persist: (configs: McpServerConfig[]) => void) {
    super()
  }

  /** Bring the registry in line with a configuration, starting and stopping as needed. */
  async apply(configs: McpServerConfig[]): Promise<void> {
    for (const [id, server] of this.servers) {
      if (!configs.some((c) => c.id === id)) {
        server.stop()
        this.servers.delete(id)
      }
    }

    for (const config of configs) {
      const existing = this.servers.get(config.id)
      if (existing && sameCommand(existing.config, config)) {
        // A server whose command has not changed keeps running; only its
        // enabled state is acted on.
        if (config.enabled && existing.state.status === 'stopped') void existing.start()
        if (!config.enabled && existing.state.status !== 'stopped') existing.stop()
        continue
      }
      existing?.stop()
      const server = new McpServer(config)
      server.on('state', () => this.emit('state', this.states()))
      this.servers.set(config.id, server)
      if (config.enabled) void server.start()
    }

    this.persist(configs)
    this.emit('state', this.states())
  }

  /** What is configured, in the order it was saved. */
  configs(): McpServerConfig[] {
    return [...this.servers.values()].map((s) => s.config)
  }

  states(): McpServerState[] {
    return [...this.servers.values()].map((s) => s.state)
  }

  /** Every tool offered by a running server. */
  tools(): ToolDefinition[] {
    return this.states().flatMap((s) => (s.status === 'ready' ? s.tools : []))
  }

  /** Tool names carry their server's id as a prefix, which is how they are routed. */
  owns(toolName: string): boolean {
    return [...this.servers.keys()].some((id) => toolName.startsWith(id + '__'))
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    for (const [id, server] of this.servers) {
      if (toolName.startsWith(id + '__')) return server.call(toolName, args)
    }
    return { ok: false, summary: 'No such server', content: 'Nothing provides ' + toolName + '.' }
  }

  shutdown(): void {
    for (const server of this.servers.values()) server.stop()
    this.servers.clear()
  }
}

function sameCommand(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.command === b.command &&
    a.args.join(' ') === b.args.join(' ') &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  )
}
