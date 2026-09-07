import { ipcMain, dialog, BrowserWindow } from 'electron'
import { ZodError } from 'zod'
import type { BinaryInfo, GpuDevice, IpcResponse, LogLine, ServerStatus } from '@shared/types.js'
import { IPC } from '@shared/ipc.js'
import { launchConfigSchema } from '@shared/schema.js'
import type { ServerSupervisor } from './supervisor.js'
import { readDevices } from './probe.js'

/** Wrap a handler so a thrown error becomes a typed failure instead of an opaque IPC rejection. */
function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResponse<T>> => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  })
}

/**
 * A raw ZodError serialises to an unreadable JSON blob. The UI shows this string
 * verbatim, so it is flattened into "field: reason" here.
 */
function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
      .join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

export function registerIpc(supervisor: ServerSupervisor, binary: BinaryInfo): void {
  handle<ServerStatus>(IPC.serverStatus, () => supervisor.status)

  handle<ServerStatus>(IPC.serverStart, async (raw) => {
    // Renderer input reaches a process spawn, so it is validated, not trusted.
    const config = launchConfigSchema.parse(raw)
    await supervisor.start(config)
    return supervisor.status
  })

  handle<ServerStatus>(IPC.serverStop, async () => {
    await supervisor.stop()
    return supervisor.status
  })

  handle<LogLine[]>(IPC.logsSince, (afterSeq) => {
    const seq = typeof afterSeq === 'number' && Number.isFinite(afterSeq) ? afterSeq : 0
    return supervisor.logs.since(seq)
  })

  handle<BinaryInfo>(IPC.binaryInfo, () => binary)

  handle<GpuDevice[]>(IPC.binaryDevices, () => readDevices(binary.path))

  handle<string | null>(IPC.pickModelFile, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}

/** Push status and log-availability events to every open window. */
export function wireEvents(supervisor: ServerSupervisor): void {
  const broadcast = (channel: string, payload?: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  supervisor.on('status', (status) => broadcast(IPC.serverStatusChanged, status))

  // llama-server can emit hundreds of lines per second; coalesce the "there is
  // new output" hint so the renderer polls at most ~10x/sec instead of per line.
  let pending = false
  supervisor.on('log', () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      broadcast(IPC.logsChanged)
    }, 100)
  })
}
