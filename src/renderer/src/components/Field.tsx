import type { ReactNode } from 'react'

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-tight text-muted/70">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'rounded-md border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-100 ' +
  'outline-none focus:border-accent disabled:opacity-50'
