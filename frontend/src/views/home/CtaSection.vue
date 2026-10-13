<script setup lang="ts">
/**
 * Closing CTA — one panel, one primary action.
 *
 * The reference hid this section entirely once signed in (there is nothing left
 * to sign up for), and that behaviour is kept: signed-in visitors get the
 * dashboard action instead of a duplicate registration pitch.
 *
 * The panel is a bordered surface, not a glowing gradient card: 16px radius (the
 * ceiling in DESIGN-LANGUAGE.md), no shadow, no `bg-clip-text` headline.
 */
import { useI18n } from 'vue-i18n'

import Icon from '@/components/icons/Icon.vue'
import SectionReveal from './SectionReveal.vue'

const { t } = useI18n()

withDefaults(
  defineProps<{
    isAuthenticated: boolean
    dashboardPath: string
  }>(),
  { isAuthenticated: false, dashboardPath: '/dashboard' },
)
</script>

<template>
  <section data-testid="home-cta" class="relative z-10 px-6 py-20 md:py-28">
    <SectionReveal>
      <div
        class="mx-auto max-w-4xl rounded-2xl border border-gray-200 bg-white/60 p-8 text-center md:p-12 dark:border-dark-800 dark:bg-dark-900/60"
      >
        <p
          class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-transparent px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-dark-700 dark:text-dark-300"
        >
          <Icon name="bolt" size="sm" class="text-gray-500 dark:text-dark-400" />
          {{ t('home.sections.cta.eyebrow') }}
        </p>

        <h2 class="mt-6 text-balance text-2xl font-semibold tracking-[-0.02em] text-gray-900 md:text-3xl dark:text-white">
          <span class="block">{{ t('home.sections.cta.summary') }}</span>
          <span class="mt-3 block whitespace-nowrap text-[clamp(1.75rem,8vw,3rem)]">{{ t('home.cta.title') }}</span>
        </h2>
        <p class="mx-auto mt-4 max-w-2xl text-pretty text-sm leading-7 text-gray-600 dark:text-dark-400">
          {{ t('home.cta.description') }}
        </p>

        <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
          <router-link
            :to="isAuthenticated ? dashboardPath : '/login'"
            class="btn btn-primary gap-1.5"
          >
            {{ isAuthenticated ? t('home.goToDashboard') : t('home.cta.button') }}
            <Icon name="arrowRight" size="sm" />
          </router-link>
        </div>
      </div>
    </SectionReveal>
  </section>
</template>
