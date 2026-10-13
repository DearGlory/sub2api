import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import App from '@/App.vue'

const fixtures = vi.hoisted(() => ({ app: null as unknown, route: null as unknown }))
vi.mock('@/stores', () => ({
  useAppStore: () => fixtures.app,
  useAuthStore: () => ({ isAuthenticated: false, isAdmin: false }),
  useSubscriptionStore: () => ({ clear: vi.fn() }),
  useAnnouncementStore: () => ({ reset: vi.fn() }),
  useAdminComplianceStore: () => ({ reset: vi.fn() }),
  useAdminSettingsStore: () => ({ customMenuItems: [] }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => fixtures.route,
  useRouter: () => ({ afterEach: vi.fn(), replace: vi.fn() }),
  RouterView: { template: '<main data-testid="route-content" />' },
}))
vi.mock('@/api/setup', () => ({ getSetupStatus: async () => ({ needs_setup: false }) }))
vi.mock('@/router/title', () => ({ resolveRouteDocumentTitle: () => 'Universe test' }))
vi.mock('@/utils/branding', () => ({ updateFavicon: vi.fn() }))
vi.mock('@/utils/featureFlags', () => ({ FeatureFlags: {}, isFeatureFlagEnabled: () => false }))
vi.mock('@/utils/siteBillingMode', () => ({ resolveSiteBillingMode: () => 'balance' }))
vi.mock('@/features/universe/UniverseBackground.vue', () => ({ default: { template: '<div data-testid="universe-background" />' } }))
vi.mock('@/components/common/Toast.vue', () => ({ default: { template: '<div data-testid="toast" />' } }))
vi.mock('@/components/common/NavigationProgress.vue', () => ({ default: { template: '<div data-testid="navigation" />' } }))
vi.mock('@/components/common/AnnouncementPopup.vue', () => ({ default: { template: '<div data-testid="announcement" />' } }))
vi.mock('@/components/admin/AdminComplianceDialog.vue', () => ({ default: { template: '<div data-testid="compliance" />' } }))

const settings = reactive({ home_content: '', compact_home_enabled: false })
const route = reactive({ name: 'Home', path: '/', fullPath: '/', meta: {} })
let wrapper: ReturnType<typeof mount> | undefined

beforeEach(() => {
  settings.home_content = ''
  settings.compact_home_enabled = false
  route.name = 'Home'
  fixtures.route = route
  fixtures.app = reactive({
    cachedPublicSettings: settings, siteName: 'Universe', siteLogo: '',
    fetchPublicSettings: vi.fn().mockResolvedValue(undefined),
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.documentElement.classList.remove('dark')
  document.documentElement.removeAttribute('data-universe-theme')
})

describe('App universe routing and theme scope', () => {
  it.each([false, true])('keeps the saved dark preference %s and uses only HomeView on the default home', async (dark) => {
    document.documentElement.classList.toggle('dark', dark)
    wrapper = mount(App)
    await flushPromises()
    expect(document.documentElement.classList.contains('dark')).toBe(dark)
    expect(document.documentElement.dataset.universeTheme).toBe('cosmos')
    expect(wrapper.classes()).toEqual(['universe-app', 'dark'])
    expect(wrapper.find('[data-testid="universe-background"]').exists()).toBe(false)
    for (const id of ['route-content', 'toast', 'navigation', 'announcement', 'compliance']) {
      expect(wrapper.find(`.universe-app .universe-page-shell [data-testid="${id}"]`).exists()).toBe(true)
    }
  })

  it('reacts to loaded settings and route changes with custom > compact > default priority', async () => {
    wrapper = mount(App)
    await flushPromises()
    settings.compact_home_enabled = true
    await nextTick()
    expect(wrapper.findAll('[data-testid="universe-background"]')).toHaveLength(1)

    settings.home_content = '  <div class="dark:bg-white">custom</div>  '
    await nextTick()
    expect(document.documentElement.hasAttribute('data-universe-theme')).toBe(false)
    expect(wrapper.classes()).not.toContain('dark')
    expect(wrapper.find('[data-testid="universe-background"]').exists()).toBe(false)

    route.name = 'Login'
    await nextTick()
    expect(document.documentElement.dataset.universeTheme).toBe('cosmos')
    expect(wrapper.findAll('[data-testid="universe-background"]')).toHaveLength(1)

    route.name = 'Home'
    settings.home_content = '   '
    settings.compact_home_enabled = false
    await nextTick()
    expect(document.documentElement.dataset.universeTheme).toBe('cosmos')
    expect(wrapper.find('[data-testid="universe-background"]').exists()).toBe(false)

    wrapper.unmount()
    wrapper = undefined
    expect(document.documentElement.hasAttribute('data-universe-theme')).toBe(false)
  })
})
