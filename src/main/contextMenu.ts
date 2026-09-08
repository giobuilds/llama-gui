import { Menu, MenuItem, clipboard, shell, type BrowserWindow } from 'electron'

/**
 * Right-click menu.
 *
 * Chromium spell-checks editable fields and underlines mistakes on its own, but
 * the suggestions are only reachable through a context menu the application has
 * to build. Without one the underline is a report of a problem with no way to
 * act on it, which is worse than no spell-check at all.
 */
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu()

    // Spelling first: it is the reason most right-clicks happen in a text box.
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(
          new MenuItem({
            label: suggestion,
            click: () => win.webContents.replaceMisspelling(suggestion)
          })
        )
      }
      if (params.dictionarySuggestions.length === 0) {
        menu.append(new MenuItem({ label: 'No suggestions', enabled: false }))
      }
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({
          label: `Add “${params.misspelledWord}” to dictionary`,
          click: () =>
            win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        })
      )
      menu.append(new MenuItem({ type: 'separator' }))
    }

    if (params.linkURL) {
      menu.append(
        new MenuItem({
          label: 'Open Link in Browser',
          click: () => void shell.openExternal(params.linkURL)
        })
      )
      menu.append(
        new MenuItem({
          label: 'Copy Link Address',
          click: () => clipboard.writeText(params.linkURL)
        })
      )
      menu.append(new MenuItem({ type: 'separator' }))
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'undo' }))
      menu.append(new MenuItem({ role: 'redo' }))
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(new MenuItem({ role: 'cut' }))
      menu.append(new MenuItem({ role: 'copy', enabled: params.selectionText.length > 0 }))
      menu.append(new MenuItem({ role: 'paste' }))
      menu.append(new MenuItem({ role: 'selectAll' }))
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }))
      menu.append(new MenuItem({ role: 'selectAll' }))
    }

    // An empty menu would flash open and shut, which reads as a broken click.
    if (menu.items.length > 0) menu.popup({ window: win })
  })
}
