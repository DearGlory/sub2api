/**
 * Motion primitives for the home page sections.
 *
 * Two rules from DESIGN-LANGUAGE.md shape everything here:
 *   - `prefers-reduced-motion` must always have a branch, and that branch shows the
 *     finished state rather than animating a shorter version of it.
 *   - No spring / bounce / pulse. Reveals are a short fade plus a few pixels of
 *     travel, over `cubic-bezier(0.4, 0, 0.2, 1)`.
 *
 * GSAP is deliberately not used here: it is not a dependency of this app and the
 * two effects the sections need (reveal on scroll, count up) fit in a rAF loop.
 */
import { onBeforeUnmount, onMounted, ref, toValue } from 'vue'
import type { MaybeRefOrGetter, Ref } from 'vue'

/** One-shot value reveal. Long enough to read as counting, short enough to stay out of the way. */
const COUNT_UP_MS = 800
const REVEAL_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'

/** The class list a revealed element carries, shared so every section feels identical. */
export const REVEAL_TRANSITION_CLASS = `transition-[opacity,transform] duration-200 ease-[${REVEAL_EASE}]`

/**
 * True when the visitor asked for reduced motion — including when the platform
 * cannot tell us, in which case we err on the side of showing the final state.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3)
}

export interface RevealHandle<T extends HTMLElement> {
  /** Bind with `ref="target"` on the element that should fade in. */
  target: Ref<T | null>
  revealed: Ref<boolean>
}

/**
 * Fades an element in the first time it enters the viewport, then stops observing.
 * Elements that never intersect keep their hidden class but stay in the DOM, so
 * text is still present for assistive tech and for tests.
 */
export function useReveal<T extends HTMLElement>(delayMs = 0): RevealHandle<T> {
  const target = ref<T | null>(null) as Ref<T | null>
  const revealed = ref(prefersReducedMotion())
  let observer: IntersectionObserver | null = null
  let timer: number | null = null

  onMounted(() => {
    if (revealed.value) return

    const element = target.value
    if (typeof IntersectionObserver === 'undefined' || !element) {
      revealed.value = true
      return
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return

        observer?.disconnect()
        observer = null

        if (delayMs > 0) {
          timer = window.setTimeout(() => {
            timer = null
            revealed.value = true
          }, delayMs)
        } else {
          revealed.value = true
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(element)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  })

  return { target, revealed }
}

export interface CountUpHandle {
  /** Bind with `ref="target"` on the element the count is scoped to. */
  target: Ref<HTMLElement | null>
  display: Ref<string>
}

/**
 * Counts from zero to `end` the first time the element scrolls into view.
 * With reduced motion (or no IntersectionObserver) the final value is rendered
 * immediately and no animation frame is ever scheduled.
 */
export function useCountUp(
  end: MaybeRefOrGetter<number>,
  options: { durationMs?: number; decimals?: number } = {},
): CountUpHandle {
  const decimals = options.decimals ?? 0
  const durationMs = options.durationMs ?? COUNT_UP_MS

  const format = (value: number): string =>
    decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString()

  const finalValue = toValue(end)
  const target = ref<HTMLElement | null>(null)
  const display = ref(format(prefersReducedMotion() ? finalValue : 0))

  let observer: IntersectionObserver | null = null
  let frame: number | null = null

  function stop(): void {
    observer?.disconnect()
    observer = null
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  }

  function run(): void {
    const total = toValue(end)
    let elapsed = 0
    let previous = performance.now()

    const step = (now: number): void => {
      // jsdom's rAF timestamp is not guaranteed to share an origin with
      // `performance.now()`, so measure the delta ourselves rather than
      // subtracting absolute clocks (which can go negative).
      elapsed += Math.max(now - previous, 0)
      previous = now

      const progress = Math.min(elapsed / durationMs, 1)
      display.value = format(total * easeOutCubic(progress))

      if (progress < 1) frame = requestAnimationFrame(step)
      else {
        // Land exactly on the target so rounding never leaves e.g. "12.9".
        frame = null
        display.value = format(total)
      }
    }

    frame = requestAnimationFrame(step)
  }

  onMounted(() => {
    if (prefersReducedMotion()) {
      display.value = format(toValue(end))
      return
    }

    const element = target.value
    if (typeof IntersectionObserver === 'undefined' || !element) {
      display.value = format(toValue(end))
      return
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        stop()
        run()
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(element)
  })

  onBeforeUnmount(stop)

  return { target, display }
}
