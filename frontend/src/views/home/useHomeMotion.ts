/** Scroll-position reveals and one-shot counters; no animation dependency. */
import { computed, onBeforeUnmount, onMounted, ref, toValue } from 'vue'
import type { MaybeRefOrGetter, Ref } from 'vue'

/** One-shot value reveal. Long enough to read as counting, short enough to stay out of the way. */
const COUNT_UP_MS = 800

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
  /** Bind to a single, normal-flow wrapper; its layout coordinates are the anchor. */
  target: Ref<T | null>
  /** Compatibility flag: true at the fully visible state, including fallbacks/focus. */
  revealed: Ref<boolean>
  progress: Ref<number>
}

interface RevealEntry {
  measure: () => number
  apply: (progress: number) => void
}

// One event subscription and one pending frame for all mounted home wrappers.
// Each frame finishes every layout read before publishing any style/ref changes.
const reveals = new Set<RevealEntry>()
let revealFrame: number | null = null
let revealMedia: MediaQueryList | null = null
let removeMediaListener: (() => void) | null = null

function cancelRevealFrame(): void {
  if (revealFrame !== null) {
    window.cancelAnimationFrame(revealFrame)
    revealFrame = null
  }
}

function updateReveals(): void {
  revealFrame = null
  const measurements = [...reveals].map((entry) => [entry, entry.measure()] as const)
  measurements.forEach(([entry, progress]) => entry.apply(progress))
}

function scheduleReveals(): void {
  if (!revealMedia?.matches && reveals.size && revealFrame === null) {
    revealFrame = window.requestAnimationFrame(updateReveals)
  }
}

function onRevealMediaChange(): void {
  cancelRevealFrame()
  if (revealMedia?.matches) reveals.forEach((entry) => entry.apply(1))
  else scheduleReveals()
}

function startRevealEvents(): boolean {
  if (
    typeof window.matchMedia !== 'function' ||
    typeof window.requestAnimationFrame !== 'function' ||
    typeof window.cancelAnimationFrame !== 'function'
  ) return false

  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  // Without a change subscription we cannot honor a live accessibility change.
  if (typeof media.addEventListener === 'function' && typeof media.removeEventListener === 'function') {
    media.addEventListener('change', onRevealMediaChange)
    removeMediaListener = () => media.removeEventListener('change', onRevealMediaChange)
  } else if (typeof media.addListener === 'function' && typeof media.removeListener === 'function') {
    media.addListener(onRevealMediaChange)
    removeMediaListener = () => media.removeListener(onRevealMediaChange)
  } else return false

  revealMedia = media
  window.addEventListener('scroll', scheduleReveals, { passive: true })
  window.addEventListener('resize', scheduleReveals)
  window.addEventListener('pageshow', scheduleReveals)
  return true
}

function stopRevealEvents(): void {
  cancelRevealFrame()
  window.removeEventListener('scroll', scheduleReveals)
  window.removeEventListener('resize', scheduleReveals)
  window.removeEventListener('pageshow', scheduleReveals)
  removeMediaListener?.()
  removeMediaListener = null
  revealMedia = null
}

/** Layout top ignores this wrapper's translate/scale, avoiding transform feedback. */
function layoutViewportTop(element: HTMLElement): number {
  let top = 0
  let current: HTMLElement | null = element
  while (current) {
    top += current.offsetTop
    const parent = current.offsetParent as HTMLElement | null
    if (parent) top += parent.clientTop
    current = parent
  }
  return top - window.scrollY
}

/**
 * Reversible position mapping: top 92% -> 70% of the viewport gives 0 -> 1.
 * No elapsed time, direction state, IO, transition, or timer participates.
 * Legacy delay milliseconds become 0.1px each, capped at 24px of later entrance.
 */
export function useReveal<T extends HTMLElement>(delayMs = 0): RevealHandle<T> {
  const target = ref<T | null>(null) as Ref<T | null>
  // SSR, pre-mount and missing capabilities all start readable.
  const progress = ref(1)
  const revealed = computed(() => progress.value === 1)
  const stagger = Number.isFinite(delayMs) ? Math.min(Math.max(delayMs, 0) * 0.1, 24) : 0
  let entry: RevealEntry | null = null
  let element: T | null = null
  let initialEndRatio: number | null = null

  const apply = (value: number): void => { progress.value = value }
  const focusIn = (): void => { apply(1) }

  function measure(): number {
    if (!element || revealMedia?.matches || element.contains(document.activeElement)) return 1
    const viewport = window.innerHeight
    if (!(viewport > 0) || element.offsetHeight === 0) return 1
    const top = layoutViewportTop(element)
    const start = viewport * 0.92 - stagger
    const end = initialEndRatio === null ? viewport * 0.7 - stagger : viewport * initialEndRatio
    // A mount-visible target gets a stable, shifted entrance band so restoring a
    // scroll position never hides content already being read. Keep this band on
    // reversal too: the same position must always yield the same result.
    const entrance = Math.max(start, end + viewport * 0.22)
    return Math.min(1, Math.max(0, (entrance - top) / (entrance - end)))
  }

  onMounted(() => {
    element = target.value
    if (!element || (reveals.size === 0 && !startRevealEvents())) return
    const viewport = window.innerHeight
    const top = layoutViewportTop(element)
    if (viewport > 0 && top < viewport && top + element.offsetHeight > 0) {
      initialEndRatio = Math.max(0.7 - stagger / viewport, top / viewport)
    }
    entry = { measure, apply }
    reveals.add(entry)
    element.addEventListener('focusin', focusIn)
    element.addEventListener('focusout', scheduleReveals)
    apply(measure())
  })

  onBeforeUnmount(() => {
    if (!entry) return
    element?.removeEventListener('focusin', focusIn)
    element?.removeEventListener('focusout', scheduleReveals)
    reveals.delete(entry)
    if (reveals.size === 0) stopRevealEvents()
  })

  return { target, revealed, progress }
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
