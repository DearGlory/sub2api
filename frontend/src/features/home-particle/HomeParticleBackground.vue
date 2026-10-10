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
    engine?.setTheme(!isDarkTheme())
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

      Dark theme only. The photograph is a deep-space exposure; on the pale page it
      would invert the whole design's contrast story, which is why `display:none` is
      the base rule and `.dark` turns it on.

      `background-repeat: no-repeat` is load-bearing: the master is a 360-degree
      equirectangular strip, so tiling on x restarts the galactic band at a hard cut
      in the middle of the screen.
    -->
    <div class="home-space-sky absolute inset-0" />

    <!--
      Non-WebGL degradation. The starfield is a CSS dot grid here because there is
      no GL context to draw one in; the flat space colour keeps the page readable
      either way. This is the only gradient in the feature and it exists solely to
      stand in for a failed canvas, not as decoration.
    -->
    <div v-if="failed" class="home-particle-fallback absolute inset-0 bg-gray-50 dark:bg-dark-950" />
  </div>
</template>

<style scoped>
.home-space-sky {
  /* Base is off: the light theme keeps its pale page. */
  display: none;
}

:global(.dark) .home-space-sky {
  display: block;
  background-image: url('../assets/space/stars-milkyway.webp');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

/*
 * Hand the small file to viewports that cannot tell the difference: a phone at
 * 2-3x DPR and a low-DPI laptop both resolve far below the 4096px master, so the
 * 148 KB lite pass buys the same picture for a twelfth of the bytes. Vite emits
 * only the file a given visitor matches.
 */
@media (max-width: 900px), (max-resolution: 1.5dppx) {
  :global(.dark) .home-space-sky {
    background-image: url('../assets/space/stars-milkyway-lite.webp');
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
 * On a failed context the sky is still there, so the fallback's dot grid has to sit
 * over it rather than beside it — two star fields at different scales read as noise.
 */
:global(.dark) .home-particle-fallback::after {
  display: none;
}

:global(.dark) .home-particle-fallback {
  background-color: transparent;
}

:global(:not(.dark)) .home-particle-fallback::after {
  background-image: radial-gradient(circle, rgb(226 232 240 / 0.6) 1px, transparent 1px);
  opacity: 0.55;
}
</style>
