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
      Non-WebGL degradation. The starfield is a CSS dot grid here because there is
      no GL context to draw one in; the flat space colour keeps the page readable
      either way. This is the only gradient in the feature and it exists solely to
      stand in for a failed canvas, not as decoration.
    -->
    <div v-if="failed" class="home-particle-fallback absolute inset-0 bg-gray-50 dark:bg-dark-950" />
  </div>
</template>

<style scoped>
.home-particle-fallback::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, rgb(148 163 184 / 0.5) 1px, transparent 1px);
  background-size: 46px 46px;
  opacity: 0.35;
}

:global(.dark) .home-particle-fallback::after {
  background-image: radial-gradient(circle, rgb(226 232 240 / 0.6) 1px, transparent 1px);
  opacity: 0.55;
}
</style>
