/**
 * Images staged for the next message.
 *
 * They are held as data URLs so a conversation stays one self-contained
 * document; the size cap below is what keeps that viable.
 */
export function Attachments({
  images,
  onRemove
}: {
  images: string[]
  onRemove: (index: number) => void
}): React.JSX.Element | null {
  if (images.length === 0) return null
  return (
    <div className="mx-auto flex max-w-3xl flex-wrap gap-2 pb-2">
      {images.map((src, i) => (
        <div key={i} className="group relative">
          <img
            src={src}
            alt={`Attachment ${i + 1}`}
            className="h-16 w-16 rounded border border-edge object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            title="Remove"
            className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 rounded-full border border-edge
                       bg-panel text-[11px] text-muted hover:text-rose-300 group-hover:block"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
