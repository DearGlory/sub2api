<script setup lang="ts">
/**
 * Stats band — four figures, each counting up the first time it scrolls in.
 *
 * The reference used GSAP + ScrollTrigger; this app has no GSAP dependency, and
 * adding one for a four-number count-up is not a trade worth making, so the
 * count runs on IntersectionObserver + requestAnimationFrame (`useCountUp`).
 * Under `prefers-reduced-motion` the final values are rendered immediately and
 * no frame is ever scheduled.
 *
 * Every figure comes from `homeSections.data.ts`, which reads the backend-
 * generated platform catalogue — the band cannot advertise a number the gateway
 * does not actually serve.
 */
import type { ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'

import SectionReveal from './SectionReveal.vue'
import { HOME_STATS } from './homeSections.data'
import { useCountUp } from './useHomeMotion'

const { t } = useI18n()

/**
 * `useCountUp` is a composable, so it must be called once per figure during
 * setup — hence the array here rather than a call inside the template loop.
 */
const counters = HOME_STATS.map((stat) => ({
  ...stat,
  ...useCountUp(stat.value),
}))

type Counter = (typeof counters)[number]

/** Template ref callback: Vue hands us the element behind each `v-for` child. */
function bindCounter(counter: Counter, el: Element | ComponentPublicInstance | null): void {
  counter.target.value = (el as HTMLElement | null) ?? null
}
</script>

<template>
  <section data-testid="home-stats" class="relative z-10 border-y border-gray-200 dark:border-dark-800">
    <div class="mx-auto max-w-6xl px-6 py-12">
      <div
        class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 md:grid-cols-4 dark:border-dark-800 dark:bg-dark-800"
      >
        <SectionReveal v-for="counter in counters" :key="counter.key">
          <div class="h-full bg-white px-5 py-6 text-center dark:bg-dark-900">
            <span
              :ref="(el) => bindCounter(counter, el)"
              class="block font-mono text-2xl font-semibold tabular-nums text-gray-900 md:text-3xl dark:text-white"
            >
              {{ counter.display.value }}{{ counter.suffix }}
            </span>
            <span class="mt-2 block text-sm font-medium text-gray-700 dark:text-dark-200">
              {{ t(`home.sections.stats.items.${counter.key}.label`) }}
            </span>
            <span class="mt-1 block text-xs leading-5 text-gray-500 dark:text-dark-500">
              {{ t(`home.sections.stats.items.${counter.key}.hint`) }}
            </span>
          </div>
        </SectionReveal>
      </div>
    </div>
  </section>
</template>
