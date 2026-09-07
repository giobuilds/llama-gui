import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerSupervisor } from './supervisor.js'
import { findLlamaServer, probeBinary } from './probe.js'
import { registerIpc, wireEvents } from './ipc.js'
import type { BinaryInfo } from '@shared/types.js'

const dirname = fileURLToPath(new URL('.', import.meta.url))

let supervisor: ServerSupervisor | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'llama-gui',
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * The renderer streams tokens straight from llama-server, so it needs to reach
 * loopback HTTP — and nothing else. Everything remote stays blocked.
 */
function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const dev = Boolean(process.env['ELECTRON_RENDERER_URL'])
    const csp = [
      "default-src 'self'",
      // Vite injects inline styles in dev; production is bundled and needs no exception.
      dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
      `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*${dev ? ' ws://localhost:*' : ''}`,
      "object-src 'none'",
      "frame-src 'none'"
    ].join('; ')
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
    })
  })
}

async function bootstrap(): Promise<void> {
  applyCsp()

  const binPath = findLlamaServer(process.env['LLAMA_SERVER_PATH'])
  let binary: BinaryInfo
  if (binPath) {
    binary = await probeBinary(binPath)
  } else {
    // The UI still opens — it shows a "cannot find llama-server" state rather
    // than the app failing to launch at all.
    binary = { path: '', version: 'not found', flags: [], devices: [] }
  }

  supervisor = new ServerSupervisor(binary.path, join(app.getPath('userData'), 'server.json'))
  registerIpc(supervisor, binary)
  wireEvents(supervisor)
  await supervisor.adoptOrReap()

  createWindow()
}

// A second instance would fight over the handoff file and spawn a rival server.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(bootstrap)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Do not let the app exit while a child llama-server is still alive.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting || !supervisor || supervisor.status.pid === null) return
    event.preventDefault()
    quitting = true
    void supervisor.shutdown().finally(() => app.quit())
  })
}
