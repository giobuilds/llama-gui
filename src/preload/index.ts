import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc.js'
import type {
  BinaryInfo,
  GpuDevice,
  IpcResponse,
  LaunchConfig,
  LogLine,
  ServerStatus
} from '@shared/types.js'

/**
 * The entire privileged surface available to the renderer. Anything not listed
 * here is unreachable from the UI — no fs, no child_process, no ipcRenderer.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

/** Returns an unsubscribe function so React effects can clean up properly. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  server: {
    status: () => invoke<ServerStatus>(IPC.serverStatus),
    start: (config: LaunchConfig) => invoke<ServerStatus>(IPC.serverStart, config),
    stop: () => invoke<ServerStatus>(IPC.serverStop),
    onStatus: (cb: (status: ServerStatus) => void) => subscribe(IPC.serverStatusChanged, cb)
  },
  logs: {
    since: (afterSeq: number) => invoke<LogLine[]>(IPC.logsSince, afterSeq),
    onChanged: (cb: () => void) => subscribe<void>(IPC.logsChanged, cb)
  },
  binary: {
    info: () => invoke<BinaryInfo>(IPC.binaryInfo),
    devices: () => invoke<GpuDevice[]>(IPC.binaryDevices)
  },
  dialog: {
    pickModelFile: () => invoke<string | null>(IPC.pickModelFile)
  }
}

export type LlamaGuiApi = typeof api

contextBridge.exposeInMainWorld('llama', api)
