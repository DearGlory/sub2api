<script setup lang="ts">
/**
 * Features — the capability grid.
 *
 * Reference structure kept: a numbered bento of four capabilities with a small
 * proof visual attached to each, then a row of four supporting properties.
 *
 * Content is the five comparisons the product actually makes (unified key,
 * account pool, per-token billing, protocol compatibility), drawn from the
 * `home.features` / `home.comparison` copy that already existed.
 *
 * Design language applied strictly here: no glow, no gradient, no gradient
 * text, no `blur-3xl` orbs and no coloured icon tiles. Hierarchy comes from a
 * 1px border and the translucent cosmos surface. The single accent appears only
 * on real state — the live dot and the focus ring — never as decoration.
 */
import { useI18n } from 'vue-i18n'

import Icon from '@/components/icons/Icon.vue'
import SectionReveal from './SectionReveal.vue'
import { HOME_PLATFORM_NAMES } from './homeSections.data'

const { t } = useI18n()

/** A representative slice of the catalogue for the "one key, every model" visual. */
const platformPreview = HOME_PLATFORM_NAMES.slice(0, 9)

interface BentoFeature {
  id: string
  num: string
  icon: 'key' | 'users' | 'dollar' | 'swap'
  titleKey: string
  descKey: string
  /** Column span on the 3-column bento. */
  span: string
}

const bentoFeatures: BentoFeature[] = [
  {
    id: 'unified-key',
    num: '01',
    icon: 'key',
    titleKey: 'home.features.unifiedGateway',
    descKey: 'home.features.unifiedGatewayDesc',
    span: 'md:col-span-2',
  },
  {
    id: 'account-pool',
    num: '02',
    icon: 'users',
    titleKey: 'home.features.multiAccount',
    descKey: 'home.features.multiAccountDesc',
    span: 'md:col-span-1',
  },
  {
    id: 'metered-billing',
    num: '03',
    icon: 'dollar',
    titleKey: 'home.features.balanceQuota',
    descKey: 'home.features.balanceQuotaDesc',
    span: 'md:col-span-1',
  },
  {
    id: 'protocol-compat',
    num: '04',
    icon: 'swap',
    titleKey: 'home.sections.features.compatTitle',
    descKey: 'home.sections.features.compatDesc',
    span: 'md:col-span-2',
  },
]

interface Capability {
  icon: 'shield' | 'chart' | 'server' | 'terminal'
  titleKey: string
  descKey: string
}

const capabilities: Capability[] = [
  { icon: 'server', titleKey: 'home.sections.features.capUptime', descKey: 'home.sections.features.capUptimeDesc' },
  { icon: 'shield', titleKey: 'home.sections.features.capControl', descKey: 'home.sections.features.capControlDesc' },
  { icon: 'chart', titleKey: 'home.sections.features.capRecords', descKey: 'home.sections.features.capRecordsDesc' },
  { icon: 'terminal', titleKey: 'home.sections.features.capCompat', descKey: 'home.sections.features.capCompatDesc' },
]

/** Translate at render time so switching locales also updates the proof visual. */
const poolRows = [
  { key: 'home.sections.features.poolActive', accent: true },
  { key: 'home.sections.features.poolFailover', accent: false },
  { key: 'home.sections.features.poolLimit', accent: false },
]

</script>

<template>
  <section data-testid="home-features" class="relative z-10 px-6 py-20 md:py-28">
    <div class="mx-auto max-w-6xl">
      <SectionReveal>
        <div class="max-w-2xl">
          <p
            class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-accent-950/80 px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-dark-800 dark:text-dark-300"
          >
            <Icon name="cube" size="sm" class="text-gray-500 dark:text-dark-400" />
            {{ t('home.sections.features.eyebrow') }}
          </p>
          <h2 class="mt-5 text-3xl font-semibold tracking-[-0.02em] text-gray-900 md:text-4xl dark:text-white">
            {{ t('home.sections.features.title') }}
          </h2>
          <p class="mt-4 text-sm leading-7 text-gray-600 dark:text-dark-400">
            {{ t('home.sections.features.lead') }}
          </p>
        </div>
      </SectionReveal>

      <!-- Each card reveals independently; child borders keep the grid transparent. -->
      <div
        class="mt-10 grid overflow-hidden rounded-2xl border border-gray-200 md:grid-cols-3 dark:border-dark-800"
      >
        <SectionReveal
          v-for="(feature, index) in bentoFeatures"
          :key="feature.id"
          :delay="index * 60"
          class="min-w-0 border-gray-200 dark:border-dark-800"
          :class="[
            feature.span,
            index > 0 ? 'border-t' : '',
            index === 1 ? 'md:border-t-0 md:border-l' : '',
            index === 3 ? 'md:border-l' : '',
          ]"
        >
          <div class="group relative flex h-full min-w-0 flex-col bg-accent-950/80 p-6 transition-colors duration-200 md:p-7">
            <div class="mb-5 flex items-center justify-between gap-4">
              <span class="flex items-center gap-2.5">
                <span
                  class="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-transparent font-mono text-xs text-gray-500 dark:border-dark-700 dark:bg-transparent dark:text-dark-400"
                >
                  {{ feature.num }}
                </span>
                <Icon :name="feature.icon" size="md" class="text-gray-500 dark:text-dark-400" />
              </span>
            </div>

            <h3 class="text-base font-semibold text-gray-900 dark:text-white">
              {{ t(feature.titleKey) }}
            </h3>
            <p class="mt-2.5 max-w-xl text-sm leading-7 text-gray-600 dark:text-dark-400">
              {{ t(feature.descKey) }}
            </p>

            <!-- Proof visual 1: the catalogue itself, as plain tiles. -->
            <div v-if="feature.id === 'unified-key'" class="mt-6 grid grid-cols-3 gap-2">
              <div
                v-for="name in platformPreview"
                :key="name"
                class="truncate rounded-lg border border-gray-200 bg-transparent px-3 py-2 text-center font-mono text-[11px] text-gray-600 dark:border-dark-800 dark:bg-transparent dark:text-dark-400"
              >
                {{ name }}
              </div>
            </div>

            <!-- Proof visual 2: what the pool absorbs. -->
            <div v-else-if="feature.id === 'account-pool'" class="mt-6 space-y-2.5">
              <div
                v-for="row in poolRows"
                :key="row.key"
                class="flex items-center gap-2.5 text-xs text-gray-500 dark:text-dark-400"
              >
                <span
                  class="h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="row.accent ? 'bg-primary-500 dark:bg-primary-400' : 'bg-gray-300 dark:bg-dark-600'"
                />
                <span class="text-pretty leading-5">{{ t(row.key) }}</span>
              </div>
            </div>

            <!-- Proof visual 3: a metered invoice line. -->
            <div
              v-else-if="feature.id === 'metered-billing'"
              class="mt-6 flex items-baseline gap-2 rounded-lg border border-gray-200 bg-transparent px-4 py-3 dark:border-dark-800 dark:bg-transparent"
            >
              <span class="font-mono text-xl font-semibold tabular-nums text-gray-900 dark:text-white">
                {{ t('home.sections.features.billingExample') }}
              </span>
              <span class="font-mono text-[11px] text-gray-500 dark:text-dark-400">
                {{ t('home.sections.features.billingUnit') }}
              </span>
            </div>

            <!-- Proof visual 4: a request line, in mono. -->
            <div
              v-else
              class="mt-6 rounded-lg border border-gray-200 bg-transparent p-4 font-mono text-[11px] leading-6 text-gray-600 dark:border-dark-800 dark:bg-transparent dark:text-dark-400"
            >
              <p><span class="text-gray-900 dark:text-dark-100">POST</span> /v1/messages</p>
              <p>model: <span class="text-gray-900 dark:text-dark-100">claude-sonnet-4-5</span></p>
              <p>anthropic · openai · gemini</p>
            </div>
          </div>
        </SectionReveal>
      </div>

      <!-- Supporting properties -->
      <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SectionReveal
          v-for="(capability, index) in capabilities"
          :key="capability.titleKey"
          :delay="index * 40"
        >
          <div
            class="h-full rounded-xl border border-gray-200 bg-accent-950/80 p-5 transition-colors duration-200 hover:border-gray-300 dark:border-dark-800 dark:hover:border-dark-700"
          >
            <span
              class="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-transparent text-gray-500 dark:border-dark-700 dark:bg-transparent dark:text-dark-300"
            >
              <Icon :name="capability.icon" size="md" />
            </span>
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
              {{ t(capability.titleKey) }}
            </h3>
            <p class="mt-2 text-pretty text-xs leading-6 text-gray-500 dark:text-dark-400">
              {{ t(capability.descKey).replace('API Key', 'API\u00a0Key') }}
            </p>
          </div>
        </SectionReveal>
      </div>
    </div>
  </section>
</template>

<style scoped>
h2 {
  text-wrap: balance;
}

p {
  text-wrap: pretty;
  word-break: normal;
}
</style>
