import { useEffect, useState } from 'react'
import type { AboutView } from '@shared/types.js'
import { useServerStore } from '../state/serverStore.js'

const REPO = 'https://github.com/giobuilds/lowerbeam'

/**
 * About, in the app's own dress.
 *
 * This was a native message box, which on this desktop looked like a different
 * program entirely. It also says more than a message box could: which llama.cpp
 * is in use matters more than which Electron is, because it decides what the
 * app can do and how fast it runs.
 */
export function About({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [about, setAbout] = useState<AboutView | null>(null)
  const binary = useServerStore((s) => s.binary)

  useEffect(() => {
    void window.llama.app.about().then(setAbout)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const device = binary?.devices?.[0]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-edge bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-edge px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-100">{about?.name ?? 'Lowerbeam'}</h2>
          <p className="text-xs text-muted">
            {about ? `Version ${about.version}` : 'Loading…'}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            A desktop control panel for llama.cpp: it owns the server process, so
            picking a model, fitting it to your GPU and chatting with it all
            happen in one place.
          </p>
        </div>

        <dl className="divide-y divide-edge text-xs">
          <Row label="llama.cpp">
            {binary?.path ? (
              <>
                <span className="text-slate-200">{binary.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted" title={binary.path}>
                  {binary.path}
                </span>
              </>
            ) : (
              <span className="text-amber-300">Not found</span>
            )}
          </Row>

          <Row label="Device">
            {device ? (
              <span className="text-slate-200">
                {device.name}
                <span className="text-muted"> · {(device.totalMiB / 1024).toFixed(1)} GiB</span>
              </span>
            ) : (
              <span className="text-muted">CPU only</span>
            )}
          </Row>

          <Row label="Built on">
            <span className="text-muted">
              {about
                ? `Electron ${about.electron} · Chromium ${about.chrome.split('.')[0]} · Node ${about.node}`
                : '—'}
            </span>
          </Row>
        </dl>

        <div className="flex items-center gap-3 border-t border-edge px-5 py-3">
          <a href={REPO} data-external="true" className="text-[11px] text-accent hover:underline">
            Source
          </a>
          <a
            href={`${REPO}/issues/new`}
            data-external="true"
            className="text-[11px] text-accent hover:underline"
          >
            Report an issue
          </a>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="ml-auto rounded bg-ink px-3 py-1 text-xs text-slate-200 hover:text-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex gap-4 px-5 py-2.5">
      <dt className="w-20 shrink-0 pt-0.5 text-[11px] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}
