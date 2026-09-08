import { WebContentsView, session, shell, type BaseWindow, type BrowserWindow, type WebContents } from 'electron'
import { IPC } from '@shared/ipc.js'
import { EventEmitter } from 'node:events'
import type { ReaderState } from '@shared/types.js'
import { isWebUrl } from '@shared/url.js'

/**
 * The pane that shows a page from a search result.
 *
 * It exists because the alternative was worse: an ordinary link click navigated
 * the app window itself, and the preload bridge stays attached across a
 * navigation, so the page arrived holding every IPC channel this app has —
 * including the one that starts MCP servers, which runs a command. A page the
 * model found could have spawned processes.
 *
 * So the reader is a separate web contents with no preload at all, its own
 * empty session, and no way to reach the app: the bridge does not exist in it,
 * and it never shares an origin with the renderer. It draws over the window
 * rather than inside the page, which is why the renderer has to tell it where.
 */
export class Reader extends EventEmitter<{ state: [ReaderState] }> {
  private view: WebContentsView | null = null
  private bounds: Electron.Rectangle | null = null
  private lastError = ''

  constructor(private readonly window: BaseWindow) {
    super()
  }

  get state(): ReaderState {
    const wc = this.view?.webContents
    return {
      open: this.view !== null,
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      error: this.lastError
    }
  }

  open(url: string): void {
    if (!isWebUrl(url)) return
    this.lastError = ''
    const view = this.view ?? this.create()
    void view.webContents.loadURL(url)
    this.announce()
  }

  /** Where in the window the pane sits, or null while something covers it. */
  setBounds(bounds: Electron.Rectangle | null): void {
    this.bounds = bounds
    if (!this.view) return
    // Zero bounds do not hide a view — it keeps its last size and goes on
    // drawing — so visibility is what has to be switched.
    this.view.setVisible(bounds !== null)
    if (bounds) this.view.setBounds(bounds)
  }

  goBack(): void {
    const history = this.view?.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  close(): void {
    if (!this.view) return
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    // The page keeps running until its contents are destroyed: a video would go
    // on playing behind a closed pane.
    this.view.webContents.close()
    this.view = null
    this.lastError = ''
    this.announce()
  }

  /**
   * The window is going. Let go of the page without touching the window, whose
   * contentView and webContents are already destroyed by the time this runs.
   */
  dispose(): void {
    const wc = this.view?.webContents
    this.view = null
    this.bounds = null
    if (wc && !wc.isDestroyed()) wc.close()
    this.removeAllListeners()
  }

  private create(): WebContentsView {
    const partition = 'reader'
    const readerSession = session.fromPartition(partition)

    // Nothing a page asks for is worth granting: this pane exists to read text.
    readerSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    readerSession.setPermissionCheckHandler(() => false)
    readerSession.on('will-download', (event) => event.preventDefault())

    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // Deliberately no preload. This is the whole point of the pane.
        spellcheck: false
      }
    })
    this.view = view

    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      // A page opening a window means a link the reader should follow, not a
      // second window this app has to police.
      if (isWebUrl(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault()
    })

    wc.on('did-start-loading', () => this.announce())
    wc.on('did-stop-loading', () => this.announce())
    wc.on('page-title-updated', () => this.announce())
    wc.on('did-navigate', () => {
      this.lastError = ''
      this.announce()
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // Aborted loads are what a user clicking away looks like, not a failure.
      if (!isMainFrame || code === -3) return
      this.lastError = `${description || 'Could not load'} (${url})`
      this.announce()
    })

    this.window.contentView.addChildView(view)
    view.setVisible(this.bounds !== null)
    if (this.bounds) view.setBounds(this.bounds)
    return view
  }

  private announce(): void {
    this.emit('state', this.state)
  }
}

/**
 * One reader per window, found from whichever window sent the request, so the
 * handlers stay window-agnostic the way the rest of the IPC surface is.
 */
const readers = new Map<number, Reader>()

export function attachReader(win: BrowserWindow): Reader {
  const reader = new Reader(win)
  // Read once and keep it: after the window is destroyed, even reaching for its
  // webContents throws, which is what crashed the main process on quit.
  const id = win.webContents.id
  readers.set(id, reader)
  reader.on('state', (state) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(IPC.readerChanged, state)
  })
  win.on('closed', () => {
    readers.delete(id)
    reader.dispose()
  })
  return reader
}

export function readerFor(sender: WebContents): Reader | undefined {
  return readers.get(sender.id)
}

/** Hand a URL to the browser the user actually uses. */
export function openExternally(url: string): void {
  if (isWebUrl(url)) void shell.openExternal(url)
}
