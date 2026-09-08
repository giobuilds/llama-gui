import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerSupervisor } from './supervisor.js'
import { probeAll } from './probe.js'
import { SettingsStore } from './settings.js'
import { ConversationStore } from './conversations.js'
import { ProfileStore } from './profiles.js'
import { recordSuccessfulLaunches } from './profileRecorder.js'
import { DownloadManager } from './downloads.js'
import { registerIpc, wireEvents } from './ipc.js'
import type { BinaryInfo } from '@shared/types.js'

const dirname = fileURLToPath(new URL('.', import.meta.url))

let supervisor: ServerSupervisor | null = null
let downloads: DownloadManager | null = null

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

  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  await settings.load()

  const discovered = await probeAll(
    settings.current.binaryPath ?? process.env['LLAMA_SERVER_PATH']
  )
  // A previously chosen binary wins; otherwise take the first discovered, which
  // prefers the unified `llama` CLI over a possibly stale distro llama-server.
  const chosen =
    discovered.find((b) => b.path === settings.current.binaryPath) ??
    discovered[0] ??
    // The UI still opens with nothing installed — it shows a "not found" state
    // rather than the app failing to launch at all.
    ({
      path: '',
      kind: 'unified',
      argvPrefix: [],
      version: 'not found',
      flags: [],
      flashAttnStyle: 'bare',
      devices: [],
      label: 'no llama.cpp found'
    } satisfies BinaryInfo)

  const conversations = new ConversationStore(join(app.getPath('userData'), 'conversations'))
  await conversations.init()

  const profiles = new ProfileStore(join(app.getPath('userData'), 'profiles.json'))
  await profiles.load()

  supervisor = new ServerSupervisor(chosen, join(app.getPath('userData'), 'server.json'))
  recordSuccessfulLaunches(supervisor, profiles)

  // The manager reads the binary lazily so a binary swap is picked up without
  // having to rebuild it.
  downloads = new DownloadManager(
    () => supervisor!.binaryInfo,
    (job) => {
      void settings.patch({
        downloadHistory: [job, ...settings.current.downloadHistory.filter((j) => j.id !== job.id)]
          .slice(0, 20)
      })
    }
  )
  downloads.restore(settings.current.downloadHistory)
  registerIpc(supervisor, settings, conversations, profiles, downloads, discovered)
  wireEvents(supervisor, downloads)
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
    downloads?.shutdown()
    void supervisor.shutdown().finally(() => app.quit())
  })
}
