'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Single source for the app's scrollbar — the side bar, the message list, the reading
 * pane and the thread column all scroll through this one component. A native scrollbar
 * cannot fade: neither
 * `::-webkit-scrollbar` nor `scrollbar-color` animates, so a bar that is only visible
 * while scrolling has to be drawn. The native one is hidden (`.scroll-hidden`) and a
 * thumb is painted over the viewport, tracking `scrollTop/scrollHeight`.
 * Dragging the thumb is deliberately NOT implemented — the wheel, the trackpad and the
 * keyboard already scroll, and a drag handle would be code nobody exercises. For the same
 * reason the thumb does NOT react to hover: scrolling with the cursor left over the list
 * is the normal case, and a hover rule would pin the thumb visible for as long as it stays
 * there — the opposite of a bar that shows up while scrolling and then gets out of the way.
 */
export const THIN_SCROLL = {
  /** Thumb width in px — the width the native thin bar reserved before it was hidden. */
  thumbWidth: 6,
  /** Gap between the thumb and the container's right edge, in px. */
  inset: 2,
  /** Time without scrolling before the thumb fades out, in ms. */
  idleMs: 2000,
  /** Fade duration in ms. Reduced motion turns this into a hard switch (0 ms). */
  fadeMs: 300,
} as const

/** Below half a pixel two measurements are the same measurement: don't re-render. */
const SAME_PX = 0.5

type Thumb = { top: number; height: number }

type Props = React.HTMLAttributes<HTMLDivElement> & {
  /** Layout box of the scroll area (its parent gives it a height or a max-height). */
  className?: string
  /** Padding / scroll behaviour of the scrolling viewport itself. */
  viewportClassName?: string
  /**
   * Handed the element that actually scrolls. A caller that measures the scroll box
   * (`scrollTop`, `getBoundingClientRect`, an IntersectionObserver `root`) needs THAT
   * element, not the outer layout box — the outer one never scrolls.
   */
  viewportRef?: React.MutableRefObject<HTMLDivElement | null>
  /**
   * Attributes for the scrolling element itself. A role a screen reader scrolls
   * (`listbox`) has to sit on the box that scrolls, so it cannot go through `...rest`,
   * which lands on the outer box. Plain events still ride `...rest`: they bubble up
   * from the viewport, which is the same visual box.
   */
  viewportProps?: React.HTMLAttributes<HTMLDivElement>
}

export function ThinScroll({ className, viewportClassName, viewportRef: outerViewportRef, viewportProps, children, ...rest }: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const setViewport = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    if (outerViewportRef) outerViewportRef.current = node
  }, [outerViewportRef])
  const idleTimer = useRef<ReturnType<typeof setTimeout>>()
  const [thumb, setThumb] = useState<Thumb | null>(null)
  const [scrolling, setScrolling] = useState(false)

  const measure = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const { clientHeight, scrollHeight, scrollTop } = el
    // Nothing to scroll: no thumb at all, rather than a full-height one pretending to be one.
    if (scrollHeight - clientHeight < 1) return setThumb(null)
    const height = (clientHeight * clientHeight) / scrollHeight
    const top = (clientHeight - height) * (scrollTop / (scrollHeight - clientHeight))
    setThumb(prev =>
      prev && Math.abs(prev.top - top) < SAME_PX && Math.abs(prev.height - height) < SAME_PX
        ? prev
        : { top, height },
    )
  }, [])

  // Deliberately dependency-free: the content of a scroll area changes with the parent's
  // render (folders arriving, an account list filtered), and re-measuring then is what
  // keeps the thumb honest. `measure` returns the previous state when nothing moved, so
  // this cannot feed itself a render loop.
  useEffect(measure)

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      clearTimeout(idleTimer.current)
    }
  }, [measure])

  const onScroll = useCallback(() => {
    measure()
    setScrolling(true)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setScrolling(false), THIN_SCROLL.idleMs)
  }, [measure])

  return (
    <div
      {...rest}
      className={cn('relative flex flex-col min-h-0', className)}
      data-thin-scroll
    >
      <div
        {...viewportProps}
        ref={setViewport}
        onScroll={onScroll}
        className={cn('flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll-hidden', viewportClassName)}
        data-thin-scroll-viewport
      >
        {children}
      </div>
      {thumb && (
        <div
          aria-hidden
          data-thin-scroll-thumb
          // The fade lives in a CLASS, not in an inline `transition` shorthand: an inline
          // shorthand outranks `motion-reduce:transition-none` and the reduced-motion user
          // would still get the 300 ms fade. Only the duration is inline, and
          // `transition-property: none` from the class beats it.
          className="absolute rounded-full scroll-thumb pointer-events-none transition-opacity ease-out motion-reduce:transition-none"
          style={{
            top: thumb.top,
            height: thumb.height,
            right: THIN_SCROLL.inset,
            width: THIN_SCROLL.thumbWidth,
            opacity: scrolling ? 1 : 0,
            transitionDuration: `${THIN_SCROLL.fadeMs}ms`,
          }}
        />
      )}
    </div>
  )
}
