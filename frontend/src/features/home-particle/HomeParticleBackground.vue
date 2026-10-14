<script setup lang="ts">
/**
 * Vue shell around the three.js particle engine.
 *
 * The shell owns mount/unmount, motion preference, sizing, tab visibility,
 * and the fixed cosmos palette — and nothing that is the engine's. The
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
/** The existing space photograph remains visible for both saved theme preferences. */
const skyVisible = true

let engine: ParticleEngine | null = null
let resizeObserver: ResizeObserver | null = null
let motionQuery: MediaQueryList | null = null

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

  try {
    engine = new ParticleEngine({
      container,
      brands: props.brands ?? BRANDS,
      isLightTheme: false,
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

      The photograph stays visible regardless of the saved theme preference.
    -->
    <div v-show="skyVisible" class="home-space-sky absolute inset-0" />

    <!-- A failed canvas leaves the existing photograph visible. -->
    <div
      v-if="failed"
      class="home-particle-fallback home-particle-fallback--on-sky absolute inset-0 bg-transparent"
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
