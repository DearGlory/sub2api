<script setup lang="ts">
/**
 * How it works — three steps from signing up to reading the bill.
 *
 * Mirrors the reference section's shape (eyebrow → two-part headline → three
 * numbered cards, each with an icon, a step label and a forward arrow) but drops
 * the reference's glow orbs, gradient hairlines and 32px radii, which
 * DESIGN-LANGUAGE.md rules out.
 *
 * The numbers are mono and the connecting rule between cards is a plain border,
 * which is how the whole site draws a relationship.
 */
import { useI18n } from 'vue-i18n'

import Icon from '@/components/icons/Icon.vue'
import SectionReveal from './SectionReveal.vue'

const { t } = useI18n()

interface Step {
  num: string
  icon: 'creditCard' | 'key' | 'chartBar'
  eyebrowKey: string
  titleKey: string
  descKey: string
}

const steps: Step[] = [
  {
    num: '01',
    icon: 'creditCard',
    eyebrowKey: 'home.sections.howItWorks.step1Eyebrow',
    titleKey: 'home.sections.howItWorks.step1Title',
    descKey: 'home.sections.howItWorks.step1Desc',
  },
  {
    num: '02',
    icon: 'key',
    eyebrowKey: 'home.sections.howItWorks.step2Eyebrow',
    titleKey: 'home.sections.howItWorks.step2Title',
    descKey: 'home.sections.howItWorks.step2Desc',
  },
  {
    num: '03',
    icon: 'chartBar',
    eyebrowKey: 'home.sections.howItWorks.step3Eyebrow',
    titleKey: 'home.sections.howItWorks.step3Title',
    descKey: 'home.sections.howItWorks.step3Desc',
  },
]
</script>

<template>
  <section data-testid="home-how-it-works" class="relative z-10 px-6 py-20 md:py-28">
    <div class="mx-auto max-w-6xl">
      <SectionReveal>
        <div class="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div class="max-w-2xl">
            <p
              class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-dark-800 dark:bg-dark-900 dark:text-dark-300"
            >
              <Icon name="login" size="sm" class="text-gray-400 dark:text-dark-500" />
              {{ t('home.sections.howItWorks.eyebrow') }}
            </p>
            <h2 class="mt-5 text-3xl font-semibold tracking-[-0.02em] text-gray-900 md:text-4xl dark:text-white">
              {{ t('home.sections.howItWorks.title') }}
            </h2>
          </div>
          <p class="max-w-md text-sm leading-7 text-gray-600 dark:text-dark-400">
            {{ t('home.sections.howItWorks.lead') }}
          </p>
        </div>
      </SectionReveal>

      <div class="mt-10 grid gap-4 md:grid-cols-3">
        <SectionReveal v-for="(step, index) in steps" :key="step.num" :delay="index * 60">
          <div
            class="group flex h-full flex-col rounded-xl border border-gray-200 bg-white p-6 transition-colors duration-200 hover:border-gray-300 md:p-7 dark:border-dark-800 dark:bg-dark-900 dark:hover:border-dark-700"
          >
            <div class="mb-8 flex items-center justify-between gap-4">
              <span
                class="flex h-12 w-12 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-500 dark:border-dark-700 dark:bg-dark-800 dark:text-dark-300"
              >
                <Icon :name="step.icon" size="lg" />
              </span>
              <span class="font-mono text-sm text-gray-400 tabular-nums dark:text-dark-500">
                {{ step.num }}
              </span>
            </div>

            <p class="mb-2 text-xs font-medium tracking-[0.12em] text-gray-500 uppercase dark:text-dark-500">
              {{ t(step.eyebrowKey) }}
            </p>
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">
              {{ t(step.titleKey) }}
            </h3>
            <p class="mt-3 flex-1 text-sm leading-7 text-gray-600 dark:text-dark-400">
              {{ t(step.descKey) }}
            </p>

            <div class="mt-7 flex items-center gap-3">
              <span class="h-px flex-1 bg-gray-200 dark:bg-dark-700" />
              <Icon
                name="arrowRight"
                size="sm"
                class="text-gray-400 transition-colors duration-200 group-hover:text-gray-600 dark:text-dark-500 dark:group-hover:text-dark-300"
              />
            </div>
          </div>
        </SectionReveal>
      </div>
    </div>
  </section>
</template>
