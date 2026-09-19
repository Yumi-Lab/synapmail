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
 * The thumb IS grabbable: a sensitive band runs along the right edge, and a mouse inside
 * it reveals the thumb and drags it (an earlier revision left dragging out on purpose —
 * that call was reversed, a mailbox of 18 000 messages cannot be crossed at wheel speed).
 * Hover still only counts INSIDE that band: over the rest of the viewport the thumb keeps
 * fading 2 s after the last scroll, otherwise a cursor left on the list would pin it
 * visible forever — the opposite of a bar that shows up while scrolling and gets out of
 * the way. Touch is untouched: the band only answers a mouse, fingers get the platform's
 * own scrolling.
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
  /** Width of the mouse-sensitive band along the right edge, in px. */
  bandWidth: 14,
  /** Shortest the thumb may get, in px — below that it stops being grabbable. */
  minThumbHeight: 28,
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
  const [overBand, setOverBand] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** Grab offset between the pointer and the thumb's top, in px. Set on pointer down. */
  const grabOffset = useRef(0)

  const measure = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const { clientHeight, scrollHeight, scrollTop } = el
    // Nothing to scroll: no thumb at all, rather than a full-height one pretending to be one.
    if (scrollHeight - clientHeight < 1) return setThumb(null)
    // Clamped so a huge mailbox still leaves something to grab; `top` then runs over the
    // EFFECTIVE height, so the thumb reaches exactly the top and the bottom of the track.
    const height = Math.min(clientHeight, Math.max(THIN_SCROLL.minThumbHeight, (clientHeight * clientHeight) / scrollHeight))
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

  /** Puts the thumb's top at `top` px of the track and scrolls the content to match. */
  const scrollToThumbTop = useCallback((top: number, height: number) => {
    const el = viewportRef.current
    if (!el) return
    const track = el.clientHeight - height
    if (track <= 0) return
    const ratio = Math.min(1, Math.max(0, top / track))
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
  }, [])

  const onBandPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Mouse only, left button only: a finger keeps the platform's own scrolling, and the
    // right button belongs to whatever context menu the caller put on the viewport.
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const el = viewportRef.current
    if (!el || !thumb) return
    // Stops the press from reaching the viewport underneath: no marquee, no row drag, no
    // message opened — and no text selected while the thumb travels.
    e.preventDefault()
    e.stopPropagation()
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
    const onThumb = y >= thumb.top && y <= thumb.top + thumb.height
    // Pressing the bare band puts the thumb under the pointer and keeps dragging from there.
    grabOffset.current = onThumb ? y - thumb.top : thumb.height / 2
    if (!onThumb) scrollToThumbTop(y - grabOffset.current, thumb.height)
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }, [thumb, scrollToThumbTop])

  const onBandPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !thumb) return
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
    scrollToThumbTop(y - grabOffset.current, thumb.height)
  }, [dragging, thumb, scrollToThumbTop])

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }, [dragging])

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
          data-thin-scroll-band
          className="absolute top-0 bottom-0 right-0"
          style={{ width: THIN_SCROLL.bandWidth, touchAction: 'none' }}
          onPointerEnter={e => { if (e.pointerType === 'mouse') setOverBand(true) }}
          onPointerLeave={e => { if (e.pointerType === 'mouse') setOverBand(false) }}
          onPointerDown={onBandPointerDown}
          onPointerMove={onBandPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
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
            opacity: scrolling || overBand || dragging ? 1 : 0,
            transitionDuration: `${THIN_SCROLL.fadeMs}ms`,
          }}
        />
      )}
    </div>
  )
}
