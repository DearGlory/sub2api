<template>
  <!-- Custom Home Content: Full Page Mode -->
  <div v-if="hasHomeContent" class="min-h-screen">
    <!-- iframe mode -->
    <iframe
      v-if="isHomeContentUrl"
      :src="homeContent.trim()"
      class="h-screen w-full border-0"
      allowfullscreen
    ></iframe>
    <!-- HTML mode - SECURITY: homeContent is admin-only setting, XSS risk is acceptable -->
    <div v-else v-html="homeContent"></div>
  </div>

  <!-- Compact Home Page -->
  <div
    v-else-if="compactHomeEnabled"
    data-testid="compact-home"
    class="home-compact-sky dark relative isolate flex min-h-screen flex-col bg-transparent text-white"
  >
    <header class="border-b border-gray-200 px-4 py-4 sm:px-6 dark:border-dark-800">
      <nav class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 sm:gap-4">
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <img
            :src="siteLogo || '/logo.svg'"
            alt="Logo"
            class="h-9 w-9 shrink-0 rounded-lg object-contain"
          />
          <span class="min-w-0 truncate text-base font-semibold">{{ siteName }}</span>
        </div>
        <div class="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          <LocaleSwitcher />
          <a
            v-if="docUrl"
            :href="docUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-accent-950/80 dark:text-dark-400"
            :title="t('home.viewDocs')"
          >
            <Icon name="book" size="md" />
          </a>
          <router-link
            v-if="showModelPlazaEntry"
            to="/model-plaza"
            class="flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-gray-500 hover:bg-accent-950/80 hover:text-gray-700 dark:text-dark-400 dark:hover:text-white"
            :title="t('nav.modelPlaza')"
          >
            <Icon name="grid" size="md" />
            <span class="hidden sm:inline">{{ t('nav.modelPlaza') }}</span>
          </router-link>
          <button
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-accent-950/80 dark:text-dark-400"
            :title="isDark ? t('home.switchToLight') : t('home.switchToDark')"
            @click="toggleTheme"
          >
            <Icon v-if="isDark" name="sun" size="md" />
            <Icon v-else name="moon" size="md" />
          </button>
          <router-link
            :to="isAuthenticated ? dashboardPath : '/login'"
            class="btn-primary inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg px-4 py-2 text-sm font-medium"
          >
            {{ isAuthenticated ? t('home.dashboard') : t('home.login') }}
          </router-link>
        </div>
      </nav>
    </header>

    <main class="flex min-w-0 flex-1 items-center justify-center px-4 py-16 sm:px-6">
      <div class="min-w-0 max-w-2xl text-center">
        <img
          :src="siteLogo || '/logo.svg'"
          alt="Logo"
          class="mx-auto mb-6 h-20 w-20 rounded-xl object-contain"
        />
        <h1 class="[overflow-wrap:anywhere] text-3xl font-semibold md:text-4xl">{{ siteName }}</h1>
        <p class="mt-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-base text-gray-600 dark:text-dark-300">{{ siteSubtitle }}</p>
        <router-link
          :to="isAuthenticated ? dashboardPath : '/login'"
          class="btn-primary mt-8 inline-flex min-h-10 items-center justify-center rounded-lg px-5 py-2.5 text-sm font-medium"
        >
          {{ isAuthenticated ? t('home.goToDashboard') : t('home.login') }}
        </router-link>
      </div>
    </main>

    <footer class="min-w-0 border-t border-gray-200 px-4 py-5 text-center text-sm text-gray-500 [overflow-wrap:anywhere] sm:px-6 dark:border-dark-800 dark:text-dark-400">
      &copy; {{ currentYear }} {{ siteName }}
    </footer>
  </div>

  <!--
    Default Home Page.

    Branch order is deliberate and must not change (HOME-PARTICLE-DESIGN.md §0
    rule 3): admin `home_content` wins, then the compact page, and only then this
    particle home page.
  -->
  <div
    v-else
    data-testid="home-particle"
    class="dark relative flex min-h-screen flex-col bg-transparent text-white"
  >
    <!--
      The deep-space canvas. Fixed and full-viewport at `z-0`, `pointer-events-none`
      (set by the shell) so it never swallows a click; every section sits above it
      at `z-10`. Decorative, so it is hidden from assistive tech.
    -->
    <HomeParticleBackground v-if="particleBackgroundSupported" />

    <!-- Header -->
    <header class="relative z-20 px-6 py-4">
      <nav class="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <!-- Logo + site name -->
        <div class="flex min-w-0 items-center gap-3">
          <div
            class="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-gray-200 dark:border-dark-800"
          >
            <img :src="siteLogo || '/logo.svg'" alt="Logo" class="h-full w-full object-contain" />
          </div>
          <span class="hidden min-w-0 truncate text-base font-semibold sm:inline">{{ siteName }}</span>
        </div>

        <!-- Nav Actions -->
        <div class="flex shrink-0 items-center gap-1 sm:gap-2">
          <!-- Language Switcher -->
          <LocaleSwitcher />

          <!-- Doc Link -->
          <a
            v-if="docUrl"
            :href="docUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 transition-colors duration-150 hover:bg-accent-950/80 hover:text-gray-800 dark:text-dark-400 dark:hover:text-white"
            :title="t('home.viewDocs')"
          >
            <Icon name="book" size="md" />
          </a>

          <!-- Model Plaza Link -->
          <router-link
            v-if="showModelPlazaEntry"
            to="/model-plaza"
            class="flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-gray-500 transition-colors duration-150 hover:bg-accent-950/80 hover:text-gray-800 dark:text-dark-400 dark:hover:text-white"
            :title="t('nav.modelPlaza')"
          >
            <Icon name="grid" size="md" />
            <span class="hidden sm:inline">{{ t('nav.modelPlaza') }}</span>
          </router-link>

          <!-- Theme Toggle -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 transition-colors duration-150 hover:bg-accent-950/80 hover:text-gray-800 dark:text-dark-400 dark:hover:text-white"
            :title="isDark ? t('home.switchToLight') : t('home.switchToDark')"
            @click="toggleTheme"
          >
            <Icon v-if="isDark" name="sun" size="md" />
            <Icon v-else name="moon" size="md" />
          </button>

          <router-link
            v-if="isAuthenticated"
            :to="dashboardPath"
            class="btn-primary ml-1 inline-flex h-10 items-center gap-2 rounded-lg pl-1 pr-3 transition-colors duration-150"
          >
            <span
              class="btn-primary flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium"
            >
              {{ userInitial }}
            </span>
            <span class="text-sm font-medium">{{ t('home.dashboard') }}</span>
          </router-link>
          <router-link
            v-else
            to="/login"
            class="btn-primary ml-1 inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium transition-colors duration-150"
          >
            {{ t('home.login') }}
          </router-link>
        </div>
      </nav>
    </header>

    <!-- Sections, in the reference page's order: hero -> stats -> features -> steps -> CTA -->
    <main class="relative z-10 flex-1">
      <HeroSection
        :site-name="siteName"
        :site-subtitle="siteSubtitle"
        :is-authenticated="isAuthenticated"
        :dashboard-path="dashboardPath"
        :doc-url="docUrl"
      />
      <StatsSection />
      <FeaturesSection />
      <HowItWorksSection />
      <CtaSection :is-authenticated="isAuthenticated" :dashboard-path="dashboardPath" />
    </main>

    <!-- Footer -->
    <footer class="relative z-10 border-t border-gray-200 px-6 py-8 dark:border-dark-800">
      <div
        class="mx-auto flex max-w-6xl flex-col items-center justify-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left"
      >
        <p class="text-sm text-gray-500 dark:text-dark-400">
          &copy; {{ currentYear }} {{ siteName }}. {{ t('home.footer.allRightsReserved') }}
        </p>
        <div class="flex items-center gap-5">
          <a
            v-if="docUrl"
            :href="docUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-gray-500 transition-colors duration-150 hover:text-gray-800 dark:text-dark-400 dark:hover:text-white"
          >
            {{ t('home.docs') }}
          </a>
          <a
            :href="githubUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-gray-500 transition-colors duration-150 hover:text-gray-800 dark:text-dark-400 dark:hover:text-white"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore, useAppStore } from '@/stores'
import LocaleSwitcher from '@/components/common/LocaleSwitcher.vue'
import Icon from '@/components/icons/Icon.vue'
import HeroSection from './home/HeroSection.vue'
import StatsSection from './home/StatsSection.vue'
import FeaturesSection from './home/FeaturesSection.vue'
import HowItWorksSection from './home/HowItWorksSection.vue'
import CtaSection from './home/CtaSection.vue'
import { sanitizeUrl } from '@/utils/url'
import { HomeParticleBackground } from '@/features/home-particle'
import { FeatureFlags, isFeatureFlagEnabled } from '@/utils/featureFlags'

const { t } = useI18n()

const authStore = useAuthStore()
const appStore = useAppStore()

// Site settings - directly from appStore (already initialized from injected config)
const siteName = computed(() => appStore.cachedPublicSettings?.site_name || appStore.siteName || 'Sub2API')
const siteLogo = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.site_logo || appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const siteSubtitle = computed(() => appStore.cachedPublicSettings?.site_subtitle || 'AI API Gateway Platform')
const docUrl = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.doc_url || appStore.docUrl || ''))
const homeContent = computed(() => appStore.cachedPublicSettings?.home_content || '')
const hasHomeContent = computed(() => homeContent.value.trim().length > 0)
const compactHomeEnabled = computed(() => appStore.cachedPublicSettings?.compact_home_enabled === true)
const modelPlazaEnabled = computed(() => isFeatureFlagEnabled(FeatureFlags.modelPlaza))

// Check if homeContent is a URL (for iframe display)
const isHomeContentUrl = computed(() => {
  const content = homeContent.value.trim()
  return content.startsWith('http://') || content.startsWith('https://')
})

// Theme
const isDark = ref(document.documentElement.classList.contains('dark'))

// GitHub URL
const githubUrl = 'https://github.com/Wei-Shaw/sub2api'

// Auth state
const isAuthenticated = computed(() => authStore.isAuthenticated)
const modelPlazaRequiresAuth = computed(
  () => appStore.cachedPublicSettings?.model_plaza_require_auth === true,
)
const showModelPlazaEntry = computed(
  () => modelPlazaEnabled.value && (isAuthenticated.value || !modelPlazaRequiresAuth.value),
)
const isAdmin = computed(() => authStore.isAdmin)
const dashboardPath = computed(() => isAdmin.value ? '/admin/dashboard' : '/dashboard')
const userInitial = computed(() => {
  const user = authStore.user
  if (!user || !user.email) return ''
  return user.email.charAt(0).toUpperCase()
})

// Current year for footer
const currentYear = computed(() => new Date().getFullYear())

/**
 * The particle shell subscribes to `MediaQueryList.addEventListener` on mount,
 * which jsdom's partial `matchMedia` double does not implement. Probe for it
 * here rather than assume: without the capability we simply skip the canvas,
 * since it is decoration and the page reads fine without it.
 */
const particleBackgroundSupported = computed(() => {
  if (typeof window.matchMedia !== 'function') return false
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  return typeof query?.addEventListener === 'function'
})

// Toggle theme
function toggleTheme() {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
}

// Initialize theme
function initTheme() {
  const savedTheme = localStorage.getItem('theme')
  if (
    savedTheme === 'dark' ||
    (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)
  ) {
    isDark.value = true
    document.documentElement.classList.add('dark')
  }
}

onMounted(() => {
  initTheme()

  // Check auth state
  authStore.checkAuth()

  // Ensure public settings are loaded (will use cache if already loaded from injected config)
  if (!appStore.publicSettingsLoaded) {
    appStore.fetchPublicSettings()
  }
})
</script>

<style scoped>
.home-compact-sky::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: url('@/features/home-particle/assets/space/stars-milkyway.webp') center / cover no-repeat;
}

@media (max-width: 900px), (max-resolution: 1.5dppx) {
  .home-compact-sky::before {
    background-image: url('@/features/home-particle/assets/space/stars-milkyway-lite.webp');
  }
}
</style>
