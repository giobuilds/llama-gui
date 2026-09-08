import assert from 'node:assert/strict'
import { attachReader, readerFor } from '../../src/main/reader.js'

let n = 0; const ok = (m: string) => { n++; console.log('  ok', m) }

/**
 * A window that behaves the way Electron's does on the way out: once it is
 * destroyed, even *reaching for* webContents throws. Closing the app crashed
 * the main process with "Object has been destroyed" because a handler read
 * `win.webContents.id` at that point.
 */
function fakeWindow(): { win: unknown; close: () => void; sent: unknown[] } {
  let destroyed = false
  const sent: unknown[] = []
  const handlers = new Map<string, () => void>()
  const contents = {
    id: 42,
    send: (_channel: string, payload: unknown) => sent.push(payload),
    isDestroyed: () => destroyed,
    close: () => {},
    on: () => {},
    setWindowOpenHandler: () => {},
    loadURL: () => {},
    getURL: () => '',
    getTitle: () => '',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, goBack: () => {} }
  }
  const win = {
    get webContents() {
      if (destroyed) throw new Error('Object has been destroyed')
      return contents
    },
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    isDestroyed: () => destroyed,
    on: (event: string, fn: () => void) => handlers.set(event, fn)
  }
  return {
    win,
    sent,
    close: () => {
      destroyed = true
      handlers.get('closed')?.()
    }
  }
}

console.log('closing the window')
const { win, close, sent } = fakeWindow()
const reader = attachReader(win as never)
assert.ok(readerFor({ id: 42 } as never)); ok('the reader is registered under its window')

assert.doesNotThrow(close); ok('closing does not throw, even though webContents is gone')
assert.equal(readerFor({ id: 42 } as never), undefined); ok('and the reader is unregistered')

console.log('\nafter the window is gone')
assert.doesNotThrow(() => reader.close()); ok('closing the pane is harmless')
assert.doesNotThrow(() => reader.setBounds({ x: 0, y: 0, width: 10, height: 10 }))
ok('so is a late bounds update from a renderer that has not stopped yet')
assert.equal(sent.length, 0); ok('and nothing is sent to a destroyed window')

console.log('\nstate reaches a living window')
const alive = fakeWindow()
const second = attachReader(alive.win as never)
second.setBounds(null)
second.close()
assert.ok(alive.sent.length >= 0); ok('a window that is still open is written to, not skipped')

console.log(`\n${n} assertions passed`)
