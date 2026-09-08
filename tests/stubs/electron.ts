/**
 * Just enough of Electron to load a main-process module under plain node.
 *
 * Only what the modules under test reach for at import time or on a path a test
 * actually drives — a test that needs a real window belongs in a drive of the
 * running app, not here.
 */
export class WebContentsView {
  webContents = {
    id: 1,
    close(): void {},
    isDestroyed: () => false,
    on(): void {},
    setWindowOpenHandler(): void {},
    loadURL(): void {},
    getURL: () => '',
    getTitle: () => '',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, goBack(): void {} }
  }
  setBounds(): void {}
  setVisible(): void {}
}

export const session = {
  fromPartition: () => ({
    setPermissionRequestHandler(): void {},
    setPermissionCheckHandler(): void {},
    on(): void {}
  })
}

export const shell = { openExternal: (): void => {} }
