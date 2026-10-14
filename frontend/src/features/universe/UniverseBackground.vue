<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { probeQualityProfile } from '@/features/home-particle/engine/quality'
import { UniverseStarfield } from './UniverseStarfield'

const host = ref<HTMLDivElement | null>(null)
const failed = ref(false)
let engine: UniverseStarfield | null = null
let resizeObserver: ResizeObserver | null = null
let motionQuery: MediaQueryList | null = null

function handleVisibilityChange(): void {
  if (document.hidden) engine?.stop()
  else engine?.start()
}

function handleResize(): void {
  engine?.resize()
}

function handleMotionChange(event: MediaQueryListEvent): void {
  engine?.setReducedMotion(event.matches)
}

function removeListeners(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  motionQuery?.removeEventListener('change', handleMotionChange)
  motionQuery = null
  window.removeEventListener('resize', handleResize)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
}

onMounted(() => {
  if (!host.value) return
  try {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    engine = new UniverseStarfield({
      container: host.value,
      quality: probeQualityProfile(window.innerWidth),
      reducedMotion: motionQuery.matches,
      onError: () => {
        failed.value = true
        removeListeners()
      },
    })
    motionQuery.addEventListener('change', handleMotionChange)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(host.value)
    }
    window.addEventListener('resize', handleResize)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    handleVisibilityChange()
  } catch {
    failed.value = true
    removeListeners()
    engine?.dispose()
    engine = null
  }
})

onBeforeUnmount(() => {
  removeListeners()
  engine?.dispose()
  engine = null
})

defineExpose({ getStats: () => engine?.getStats() ?? null })
</script>

<template>
  <div
    ref="host"
    class="universe-background"
    aria-hidden="true"
    data-testid="universe-background"
    :data-fallback="failed ? 'true' : undefined"
  >
    <div class="universe-space-sky" />
  </div>
</template>

<style scoped>
.universe-background {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background-color: #03040a;
}

.universe-space-sky {
  position: absolute;
  inset: 0;
  background-image: url('@/features/home-particle/assets/space/stars-milkyway.webp');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

@media (max-width: 900px), (max-resolution: 1.5dppx) {
  .universe-space-sky {
    background-image: url('@/features/home-particle/assets/space/stars-milkyway-lite.webp');
  }
}
</style>
