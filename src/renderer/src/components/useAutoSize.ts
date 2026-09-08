import { useLayoutEffect, type RefObject } from 'react'

/**
 * Grow a textarea to fit what is in it, up to a limit.
 *
 * Counting newlines does not work: a long line that wraps is still one line by
 * that measure, so the box stays a single row and the text scrolls out of sight
 * as it is typed. The rendered height has to be measured instead.
 *
 * Height is reset to `auto` before reading `scrollHeight` so the element can
 * shrink again — otherwise scrollHeight never falls below the height already
 * set, and a box that grew would never come back down.
 */
export function useAutoSize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxPixels: number
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const wanted = Math.min(el.scrollHeight, maxPixels)
    el.style.height = `${wanted}px`
    // Only scroll once the cap is reached, so short text never shows a bar.
    el.style.overflowY = el.scrollHeight > maxPixels ? 'auto' : 'hidden'
  }, [ref, value, maxPixels])
}
