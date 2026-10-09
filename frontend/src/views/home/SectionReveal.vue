<script setup lang="ts">
/**
 * Scroll reveal wrapper: fade plus a short rise, once.
 *
 * Deliberately opinionated — the only motion in the home page sections goes
 * through here, so the whole page shares one entrance and one easing curve
 * (`cubic-bezier(0.4, 0, 0.2, 1)`, i.e. Tailwind's `ease-in-out`).
 *
 * The hidden state is opacity + a 6px offset only: content is never removed from
 * the document, so it stays readable for assistive tech and for tests. Under
 * `prefers-reduced-motion` the wrapper renders straight into its final state.
 */
import { useReveal } from './useHomeMotion'

const props = withDefaults(
  defineProps<{
    /** Stagger, in ms. Keep the total across siblings under ~250ms. */
    delay?: number
  }>(),
  { delay: 0 },
)

const { target, revealed } = useReveal<HTMLDivElement>(props.delay)
</script>

<template>
  <div
    ref="target"
    class="transition-[opacity,transform] duration-200 ease-in-out motion-reduce:transition-none"
    :class="revealed ? 'translate-y-0 opacity-100' : 'translate-y-1.5 opacity-0'"
  >
    <slot />
  </div>
</template>
