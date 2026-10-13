<script setup lang="ts">
/** A single layout-preserving wrapper; all visual state comes from scroll progress. */
import { computed, watch } from 'vue'
import { useReveal } from './useHomeMotion'

const props = withDefaults(
  defineProps<{
    /** Legacy ms value: now 0.1px/ms of spatial stagger, capped at 24px. */
    delay?: number
  }>(),
  { delay: 0 },
)

const { target, progress } = useReveal<HTMLDivElement>(props.delay)
const motionStyle = computed(() => {
  const remaining = 1 - progress.value
  return {
    opacity: String(progress.value),
    // Clear the transform at rest so card backdrop/compositing is unaffected.
    transform: remaining === 0 ? 'none' : `translateY(${24 * remaining}px) scale(${1 - 0.01 * remaining})`,
    willChange: progress.value > 0 && progress.value < 1 ? 'opacity, transform' : '',
    pointerEvents: progress.value === 0 ? 'none' as const : undefined,
  }
})

// Vue normally patches on a microtask. Focus must expose the wrapper in the
// focusin call itself; use the same progress-derived style for that sync write.
// Scroll updates still arrive only after the shared batch of layout reads.
watch([target, motionStyle], ([element, style]) => {
  if (element) Object.assign(element.style, { ...style, pointerEvents: style.pointerEvents ?? '' })
}, { flush: 'sync' })
</script>

<template>
  <div ref="target" :style="motionStyle">
    <slot />
  </div>
</template>
