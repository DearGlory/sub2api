<script setup lang="ts">
/**
 * Hero — the first screen.
 *
 * Structure follows the reference (badge → oversized headline → value line →
 * supporting copy → capability chips → CTA pair, with a product visual on the
 * right), content is this gateway's, and the styling is DESIGN-LANGUAGE.md:
 * one accent used only on the primary action, borders instead of shadows,
 * border radius capped at 16px, weights capped at 600.
 *
 * There is no scrim behind the copy. The particle canvas is a full-viewport
 * `z-0` layer and this section is `z-10`; text sits directly on it, the way
 * x.ai lets type sit over its background rather than boxing it in.
 */
import { useI18n } from 'vue-i18n'

import Icon from '@/components/icons/Icon.vue'
import SectionReveal from './SectionReveal.vue'

const { t } = useI18n()

// Keep Chinese clauses together, including their punctuation. English remains
// one wrapping span so narrow screens can still break naturally between words.
const heroPhrases = (message: string) => message.split(/(?<=[，、])/u)

withDefaults(
  defineProps<{
    siteName: string
    siteSubtitle: string
    isAuthenticated: boolean
    /** Where the primary action goes once signed in. */
    dashboardPath: string
    /** Sanitised documentation URL; the secondary action hides when empty. */
    docUrl: string
  }>(),
  { siteName: 'Sub2API', siteSubtitle: '', isAuthenticated: false, dashboardPath: '/dashboard', docUrl: '' },
)
</script>

<template>
  <section
    data-testid="home-hero"
    class="relative z-10 flex min-h-[calc(100svh-4rem)] items-center px-6 pt-16 pb-20 md:pt-20 md:pb-28"
  >
    <div class="mx-auto w-full max-w-6xl">
      <div class="flex flex-col items-center gap-14 lg:flex-row lg:items-center lg:gap-16">
        <!-- Copy -->
        <SectionReveal class="w-full min-w-0 flex-1 text-center lg:text-left">
          <p
            class="inline-flex max-w-full items-center gap-2 rounded-full border border-gray-200 bg-accent-950/80 px-3 py-1.5 text-xs font-medium leading-5 text-gray-600 dark:border-dark-800 dark:text-dark-300"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500 dark:bg-primary-400" />
            <span class="min-w-0 text-pretty">{{ t('home.sections.hero.badge') }}</span>
          </p>

          <h1 class="mt-6 whitespace-nowrap text-[clamp(2rem,9vw,3rem)] font-semibold tracking-[-0.03em] text-gray-900 lg:text-6xl dark:text-white">
            {{ t('home.sections.hero.title') }}
          </h1>

          <p class="hero-copy mx-auto mt-4 max-w-xl text-pretty text-lg font-medium leading-8 text-gray-800 sm:text-xl lg:mx-0 dark:text-dark-100">
            <span v-for="(phrase, index) in heroPhrases(t('home.heroSubtitle', { siteName }))" :key="index" class="hero-phrase">{{ phrase }}</span>
          </p>

          <div class="hero-copy mx-auto mt-4 max-w-xl space-y-2 text-pretty text-sm leading-7 text-gray-600 lg:mx-0 dark:text-dark-200">
            <p><span v-for="(phrase, index) in heroPhrases(t('home.heroDescription'))" :key="index" class="hero-phrase">{{ phrase }}</span></p>
            <p><span v-for="(phrase, index) in heroPhrases(t('home.sections.hero.integration'))" :key="index" class="hero-phrase">{{ phrase }}</span></p>
            <p><span v-for="(phrase, index) in heroPhrases(t('home.sections.hero.assurance'))" :key="index" class="hero-phrase">{{ phrase }}</span></p>
          </div>

          <!-- Capability chips: reuse the three claims the old landing page already made. -->
          <ul class="mt-7 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
            <li
              class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-accent-950/80 px-3 py-2 text-xs font-medium text-gray-700 dark:border-dark-800 dark:text-dark-200"
            >
              <Icon name="swap" size="sm" class="text-gray-500 dark:text-dark-400" />
              {{ t('home.tags.subscriptionToApi') }}
            </li>
            <li
              class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-accent-950/80 px-3 py-2 text-xs font-medium text-gray-700 dark:border-dark-800 dark:text-dark-200"
            >
              <Icon name="shield" size="sm" class="text-gray-500 dark:text-dark-400" />
              {{ t('home.tags.stickySession') }}
            </li>
            <li
              class="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-accent-950/80 px-3 py-2 text-xs font-medium text-gray-700 dark:border-dark-800 dark:text-dark-200"
            >
              <Icon name="chartBar" size="sm" class="text-gray-500 dark:text-dark-400" />
              {{ t('home.tags.realtimeBilling') }}
            </li>
          </ul>

          <div class="mt-9 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <router-link
              :to="isAuthenticated ? dashboardPath : '/login'"
              class="btn btn-primary gap-1.5"
            >
              {{ isAuthenticated ? t('home.goToDashboard') : t('home.getStarted') }}
              <Icon name="arrowRight" size="sm" />
            </router-link>
            <a
              v-if="docUrl"
              :href="docUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="btn gap-1.5 border border-dark-700 bg-accent-950/80 text-gray-200 hover:border-dark-600"
            >
              <Icon name="book" size="sm" />
              {{ t('home.viewDocs') }}
            </a>
          </div>

          <p v-if="siteSubtitle" class="mx-auto mt-6 max-w-xl text-pretty text-xs leading-5 text-gray-500 lg:mx-0 dark:text-dark-400">
            {{ siteSubtitle }}
          </p>
        </SectionReveal>

        <!-- Product visual: a real request against the gateway's own endpoint. -->
        <SectionReveal :delay="60" class="flex w-full min-w-0 flex-1 justify-center lg:w-auto lg:justify-end">
          <div class="terminal-container">
            <div class="terminal-window">
              <div class="terminal-header">
                <div class="terminal-buttons" aria-hidden="true">
                  <span class="btn-close"></span>
                  <span class="btn-minimize"></span>
                  <span class="btn-maximize"></span>
                </div>
                <span class="terminal-title">terminal</span>
              </div>
              <div class="terminal-body">
                <div class="code-line line-1">
                  <span class="code-prompt">$</span>
                  <span class="code-cmd">curl</span>
                  <span class="code-flag">-X POST</span>
                  <span class="code-url">/v1/messages</span>
                </div>
                <div class="code-line line-2">
                  <span class="code-comment"># Routing to upstream...</span>
                </div>
                <div class="code-line line-3">
                  <span class="code-success">200 OK</span>
                  <span class="code-response">{ "content": "Hello!" }</span>
                </div>
                <div class="code-line line-4">
                  <span class="code-prompt">$</span>
                  <span class="cursor" aria-hidden="true"></span>
                </div>
              </div>
            </div>
          </div>
        </SectionReveal>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero-phrase {
  display: inline-block;
  max-width: 100%;
}

/* Flat surface + 1px border + 12px radius. No glow, no tilt, no gradient. */
.terminal-container {
  --terminal-bg: rgba(15, 17, 19, 0.8);
  --terminal-border: rgba(255, 255, 255, 0.08);
  --terminal-hover-border: rgba(255, 255, 255, 0.16);
  --terminal-divider: rgba(255, 255, 255, 0.06);
  --terminal-muted: #9ca3af;
  --terminal-cmd: #e4e4e7;
  --terminal-text: #d4d4d8;
  --terminal-comment: #94a3b8;
  --terminal-success: #6ee7b7;
  width: 100%;
  max-width: 420px;
}

.terminal-window {
  background: var(--terminal-bg);
  border: 1px solid var(--terminal-border);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.terminal-window:hover {
  border-color: var(--terminal-hover-border);
}

.terminal-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: transparent;
  border-bottom: 1px solid var(--terminal-divider);
}

.terminal-buttons {
  display: flex;
  gap: 8px;
}

/* Neutral window controls: the palette is grey-scale, colour is reserved. */
.terminal-buttons span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #3f3f46;
}

.terminal-title {
  flex: 1;
  text-align: center;
  font-family: theme('fontFamily.mono');
  font-size: 12px;
  color: var(--terminal-muted);
  margin-right: 46px;
}

.terminal-body {
  padding: 20px 24px;
  font-family: theme('fontFamily.mono');
  font-size: 13px;
  line-height: 2;
}

.code-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  opacity: 1;
}

.code-prompt {
  color: var(--terminal-muted);
  font-weight: 600;
}
.code-cmd {
  color: var(--terminal-cmd);
}
.code-flag {
  color: var(--terminal-muted);
}
.code-url {
  color: var(--terminal-text);
}
.code-comment {
  color: var(--terminal-comment);
}
.code-success {
  color: var(--terminal-success);
  background: transparent;
  border: 1px solid rgba(16, 185, 129, 0.14);
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 500;
}
.code-response {
  color: var(--terminal-text);
}

/* Steady block, never blinking (DESIGN-LANGUAGE bans flashing cursors). */
.cursor {
  display: inline-block;
  width: 8px;
  height: 15px;
  background: #52525b;
}
</style>
