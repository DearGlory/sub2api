<script setup lang="ts">
/**
 * Vue shell around the three.js particle engine.
 *
 * FROZEN — owned by the integrator. Lane 4 (the home page) renders this and must
 * not change it; if it needs a new prop, say so and the integrator adds it.
 *
 * The shell owns everything that is Vue's business — mount/unmount, theme, motion
 * preference, sizing, tab visibility — and nothing that is the engine's. The
 * container is `pointer-events-none`: the engine reads pointer moves off `window`
 * so the background never swallows a click meant for the page.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BRANDS } from './engine/constants'
import type { BrandDescriptor, CometPhase, EngineStats } from './engine/types'
import { ParticleEngine } from './engine/ParticleEngine'
import { probeQualityProfile } from './engine/quality'

const props = withDefaults(
  defineProps<{
    /** Pause the render loop without tearing the scene down (modal open, tab out). */
    active?: boolean
    brands?: BrandDescriptor[]
  }>(),
  { active: true }
)

const emit = defineEmits<{
  brandChange: [slug: string, index: number]
  phaseChange: [phase: CometPhase]
}>()

const host = ref<HTMLDivElement | null>(null)
/** WebGL unavailable or the context blew up: fall back to a static backdrop. */
const failed = ref(false)
/**
 * Whether the photograph should be showing.
 *
 * Driven from script rather than from a `:global(.dark) .home-space-sky` rule because
 * that rule does NOT survive Vue's scoped-CSS compiler — it compiles to a bare `.dark`,
 * silently dropping the descendant, so the sky stays `display:none` forever. That was a
 * live bug in this file's fallback styles before the photograph existed, invisible
 * because a dark-theme-only rule that never applies looks exactly like one that does.
 *
 * Bound to the same observer that feeds the engine, so the sky and the palette can never
 * disagree about which theme is active.
 */
const skyVisible = ref(false)

let engine: ParticleEngine | null = null
let themeObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null
let motionQuery: MediaQueryList | null = null

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark')
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function handleWindowResize(): void {
  engine?.resize()
}

function handleMotionChange(event: MediaQueryListEvent): void {
  engine?.setReducedMotion(event.matches)
}

function handleVisibilityChange(): void {
  if (!engine || !props.active) return
  if (document.hidden) engine.stop()
  else engine.start()
}

onMounted(() => {
  const container = host.value
  if (!container) return

  // Set before the engine is built: if the engine throws on a missing WebGL context the
  // photograph is still the right backdrop, and this is the only place the theme is read
  // at mount time.
  skyVisible.value = isDarkTheme()

  try {
    engine = new ParticleEngine({
      container,
      brands: props.brands ?? BRANDS,
      isLightTheme: !isDarkTheme(),
      reducedMotion: prefersReducedMotion(),
      quality: probeQualityProfile(window.innerWidth),
      onBrandChange: (slug, index) => emit('brandChange', slug, index),
      onPhaseChange: (phase) => emit('phaseChange', phase),
      onError: () => {
        failed.value = true
      },
    })
  } catch {
    // No WebGL, or the driver refused a context. Degrade instead of throwing
    // inside a lifecycle hook, which would blank the whole route.
    failed.value = true
    engine = null
    return
  }

  if (props.active) engine.start()

  // The app toggles `.dark` on <html>, so the class attribute is the theme signal.
  themeObserver = new MutationObserver(() => {
    const dark = isDarkTheme()
    skyVisible.value = dark
    engine?.setTheme(!dark)
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })

  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionQuery.addEventListener('change', handleMotionChange)

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => engine?.resize())
    resizeObserver.observe(container)
  } else {
    window.addEventListener('resize', handleWindowResize)
  }

  // Visibility is a hard pause: the render loop is cancelled, not skipped, so a
  // hidden tab costs no CPU at all.
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

watch(
  () => props.active,
  (value) => {
    if (value) engine?.start()
    else engine?.stop()
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)

  themeObserver?.disconnect()
  themeObserver = null

  resizeObserver?.disconnect()
  resizeObserver = null

  window.removeEventListener('resize', handleWindowResize)

  if (motionQuery) {
    motionQuery.removeEventListener('change', handleMotionChange)
    motionQuery = null
  }

  engine?.dispose()
  engine = null
})

defineExpose({
  getStats: (): EngineStats | null => engine?.getStats() ?? null,
})
</script>

<template>
  <div
    ref="host"
    class="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    aria-hidden="true"
    data-testid="home-particle-background"
  >
    <!--
      The real Milky Way photograph, on the DOM behind the WebGL canvas.

      Behind rather than in the scene on purpose: a `scene.background` texture is
      another draw call against §6's budget of six, while a CSS background costs
      none — and the canvas is transparent, so this shows through it. It also means
      the photograph survives a lost GL context, so a visitor whose driver refused a
      context still gets a real sky instead of a flat colour.

      `no-repeat` is load-bearing: the master is a 360-degree equirectangular strip,
      so tiling on x restarts the galactic band at a hard cut mid-screen.

      Visibility is a BOUND CLASS, not a `:global(.dark) …` rule — see `skyVisible`.
    -->
    <div v-show="skyVisible" class="home-space-sky absolute inset-0" />

    <!--
      Non-WebGL degradation. The starfield is a CSS dot grid here because there is
      no GL context to draw one in; the flat space colour keeps the page readable
      either way. This is the only gradient in the feature and it exists solely to
      stand in for a failed canvas, not as decoration.
    -->
    <div
      v-if="failed"
      class="home-particle-fallback absolute inset-0 bg-gray-50"
      :class="skyVisible ? 'home-particle-fallback--on-sky' : 'dark:bg-dark-950'"
    />
  </div>
</template>

<style scoped>
.home-space-sky {
  /*
   * Referenced through the `@/` alias, not as `../assets/...`.
   *
   * A relative url() in a Vue SFC's style block is resolved by the BROWSER against the
   * stylesheet's own URL — `/src/features/home-particle/HomeParticleBackground.vue?...` —
   * so `../assets/space/x.webp` turns into `/assets/space/x.webp`, which is not a file the
   * dev server has. Vite answers it with the SPA fallback: HTTP 200, `text/html`, 3 KB of
   * index.html. The network panel shows a clean 200 and the picture simply never appears,
   * which is the single nastiest way for this to fail.
   *
   * The `@/` alias goes through Vite's own resolver instead, so it works in dev and is
   * rewritten to a hashed, cache-busted asset URL in the build.
   */
  background-image: url('@/features/home-particle/assets/space/stars-milkyway.webp');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

/*
 * THE CANVAS MUST BE POSITIONED, or the photograph swallows it.
 *
 * CSS 2.1 Appendix E paints in-flow non-positioned descendants (the canvas, which
 * the engine appends with only `display/width/height` set) in an EARLIER step than
 * positioned ones with `z-index: auto` — which is what `.home-space-sky` is. So the
 * sky div above, despite coming first in the DOM, painted OVER the canvas and the
 * particles were invisible on the real page.
 *
 * The engine cannot be blamed: it is told to fill its container and does. Nor could
 * any unit test catch it — jsdom applies no CSS from a scoped SFC block, so a green
 * suite coexisted with a hero showing zero particles.
 *
 * Positioned here so both children are positioned; the DOM-order tiebreak then puts
 * the canvas last, which is what the renderer's `alpha: true` + clear-alpha 0 in dark
 * mode was always built for: photograph behind, additive particles in front.
 */
:deep(canvas) {
  position: absolute;
  inset: 0;
}

/*
 * Hand the small file to viewports that cannot tell the difference: a phone at
 * 2-3x DPR and a low-DPI laptop both resolve far below the 4096px master, so the
 * 234 KB lite pass buys the same picture for a twelfth of the bytes. Vite emits
 * only the file a given visitor matches.
 */
@media (max-width: 900px), (max-resolution: 1.5dppx) {
  .home-space-sky {
    background-image: url('@/features/home-particle/assets/space/stars-milkyway-lite.webp');
  }
}

.home-particle-fallback::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, rgb(148 163 184 / 0.5) 1px, transparent 1px);
  background-size: 46px 46px;
  opacity: 0.35;
}

/*
 * A failed context over the photograph: the sky is already a real star field, so the
 * fallback's dot grid would be a second star field at a different scale — noise, not
 * decoration. Drop the grid and let the photograph stand in.
 */
.home-particle-fallback--on-sky {
  background-color: transparent;
}

.home-particle-fallback--on-sky::after {
  display: none;
}
</style>
