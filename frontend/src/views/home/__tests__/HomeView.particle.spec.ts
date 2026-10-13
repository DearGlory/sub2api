import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'

import HomeView from '../../HomeView.vue'
import SectionReveal from '../SectionReveal.vue'
import heroSource from '../HeroSection.vue?raw'

const { appStore, authStore } = vi.hoisted(() => ({
  appStore: {
    cachedPublicSettings: {} as Record<string, unknown>,
    siteName: 'Fallback site',
    siteLogo: '',
    docUrl: '',
    publicSettingsLoaded: true,
    fetchPublicSettings: vi.fn(),
  },
  authStore: {
    isAuthenticated: false,
    isAdmin: false,
    user: null as { email?: string } | null,
    checkAuth: vi.fn(),
  },
}))

vi.mock('@/stores', () => ({
  useAppStore: () => appStore,
  useAuthStore: () => authStore,
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => appStore,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${Object.values(values).join(' ')}` : key,
    }),
  }
})

function mountHome(settings: Record<string, unknown> = {}) {
  appStore.cachedPublicSettings = {
    site_name: 'Test site',
    site_subtitle: 'Test subtitle',
    ...settings,
  }

  return mount(HomeView, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        LocaleSwitcher: { template: '<div data-testid="locale-switcher" />' },
        Icon: { template: '<span data-testid="icon" />' },
        // The particle canvas needs WebGL, which jsdom has none of; the shell's
        // own fallback path is already covered by the feature's tests.
        HomeParticleBackground: {
          template: '<div data-testid="home-particle-background" />',
        },
      },
    },
  })
}

/**
 * Branch order is the highest rule in HOME-PARTICLE-DESIGN.md (§0 rule 3):
 * admin `home_content` → compact page → particle home page.
 */
describe('HomeView default particle home branch', () => {
  beforeEach(() => {
    authStore.isAuthenticated = false
    authStore.isAdmin = false
    authStore.user = null
    authStore.checkAuth.mockClear()
    appStore.fetchPublicSettings.mockClear()
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    // Unlike the compact-mode spec, this one gives matchMedia a complete
    // MediaQueryList: HomeView only mounts the particle canvas when the platform
    // can actually register a motion-preference listener (see
    // `particleBackgroundSupported`).
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    } as unknown as MediaQueryList)
  })

  it.each(['light', 'dark'])('keeps the default home dark for saved %s while preserving the theme toggle', async (theme) => {
    localStorage.setItem('theme', theme)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    const wrapper = mountHome()
    const home = wrapper.get('[data-testid="home-particle"]')

    expect(home.classes()).toEqual(expect.arrayContaining(['dark', 'bg-transparent', 'text-white']))
    expect(localStorage.getItem('theme')).toBe(theme)
    expect(document.documentElement.classList.contains('dark')).toBe(theme === 'dark')
    await wrapper.get('header button').trigger('click')
    expect(localStorage.getItem('theme')).toBe(theme === 'dark' ? 'light' : 'dark')
    expect(document.documentElement.classList.contains('dark')).toBe(theme !== 'dark')
    expect(home.classes()).toContain('dark')
    expect(wrapper.find('[data-testid="home-particle-background"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it.each([
    { authenticated: false, admin: false, destination: '/login' },
    { authenticated: true, admin: false, destination: '/dashboard' },
    { authenticated: true, admin: true, destination: '/admin/dashboard' },
  ])('keeps the orange header action routed to $destination', ({ authenticated, admin, destination }) => {
    authStore.isAuthenticated = authenticated
    authStore.isAdmin = admin
    authStore.user = authenticated ? { email: 'ada@example.com' } : null
    const wrapper = mountHome()
    const action = wrapper.get('header').getComponent(RouterLinkStub)
    expect(action.props('to')).toBe(destination)
    expect(action.classes()).toContain('btn-primary')
    if (authenticated) {
      expect(action.get('span').text()).toBe('A')
      expect(action.get('span').classes()).toContain('btn-primary')
    }
    wrapper.unmount()
  })

  it('keeps twenty scroll units and alpha on the surface instead of its content', () => {
    const wrapper = mountHome({ doc_url: 'https://docs.example.com' })
    expect(wrapper.findAllComponents(SectionReveal)).toHaveLength(20)
    for (const id of ['home-hero', 'home-stats', 'home-features', 'home-how-it-works', 'home-cta']) {
      const section = wrapper.get(`[data-testid="${id}"]`)
      expect(section.findAll('[class~="bg-accent-950/80"]').length).toBeGreaterThan(0)
      expect(section.html()).not.toMatch(/bg-(?:white|gray-\d+|dark-\d+)\/60|opacity-\d+/)
    }
    expect(heroSource).toContain('--terminal-bg: rgba(15, 17, 19, 0.8)')
    expect(heroSource).toContain('--terminal-success: #6ee7b7')
    expect(heroSource).not.toContain(':global(.dark)')
    expect(heroSource).not.toContain('opacity: 0')
    wrapper.unmount()
  })

  it('renders the particle home when no admin override is set', () => {
    const wrapper = mountHome()

    expect(wrapper.find('[data-testid="home-particle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="home-particle-background"]').exists()).toBe(true)
  })

  it('renders every section of the particle home', () => {
    const wrapper = mountHome()

    for (const id of ['home-hero', 'home-stats', 'home-features', 'home-how-it-works', 'home-cta']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    }
  })

  it('prefers custom HTML over the particle home', () => {
    const wrapper = mountHome({ home_content: '<section id="custom-home">Custom home</section>' })

    expect(wrapper.get('#custom-home').text()).toBe('Custom home')
    expect(wrapper.find('[data-testid="home-particle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="home-particle-background"]').exists()).toBe(false)
  })

  it('prefers a custom URL over the particle home, rendered as an iframe', () => {
    const wrapper = mountHome({ home_content: ' https://example.com/home ' })

    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com/home')
    expect(wrapper.find('[data-testid="home-particle"]').exists()).toBe(false)
  })

  it('prefers custom content over compact mode and the particle home together', () => {
    const wrapper = mountHome({
      compact_home_enabled: true,
      home_content: '<section id="custom-home">Custom home</section>',
    })

    expect(wrapper.find('#custom-home').exists()).toBe(true)
    expect(wrapper.find('[data-testid="compact-home"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="home-particle"]').exists()).toBe(false)
  })

  it('prefers compact mode over the particle home', () => {
    const wrapper = mountHome({ compact_home_enabled: true })

    expect(wrapper.get('[data-testid="compact-home"]').text()).toContain('Test site')
    expect(wrapper.find('[data-testid="home-particle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="home-particle-background"]').exists()).toBe(false)
  })

  it('treats whitespace-only custom content as empty and falls through to compact mode', () => {
    const wrapper = mountHome({ compact_home_enabled: true, home_content: ' \n\t ' })

    expect(wrapper.find('[data-testid="compact-home"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="home-particle"]').exists()).toBe(false)
  })

  it('renders the hero copy from site settings', () => {
    const wrapper = mountHome()
    const hero = wrapper.get('[data-testid="home-hero"]')

    expect(hero.text()).toContain('Test site')
    expect(hero.text()).toContain('Test subtitle')
  })

  it('keeps the header actions: language, theme, docs and model plaza', () => {
    const wrapper = mountHome({
      doc_url: 'https://docs.example.com',
      model_plaza_enabled: true,
      model_plaza_require_auth: false,
    })

    expect(wrapper.find('[data-testid="locale-switcher"]').exists()).toBe(true)
    // Starts light (no saved theme, matchMedia mocked to no-preference), so the
    // toggle offers the dark theme.
    expect(wrapper.find('[title="home.switchToDark"]').exists()).toBe(true)
    // sanitizeUrl normalises a bare origin to a trailing slash.
    expect(wrapper.find('a[href="https://docs.example.com/"]').exists()).toBe(true)

    const plaza = wrapper
      .findAllComponents(RouterLinkStub)
      .find((link) => link.props('to') === '/model-plaza')
    expect(plaza).toBeTruthy()
  })

  it('links anonymous visitors to login', () => {
    const wrapper = mountHome()

    const login = wrapper
      .findAllComponents(RouterLinkStub)
      .filter((link) => link.props('to') === '/login')
    expect(login.length).toBeGreaterThan(0)
  })

  it('points signed-in visitors at their dashboard', () => {
    authStore.isAuthenticated = true
    authStore.user = { email: 'ada@example.com' }

    const wrapper = mountHome()

    const dashboard = wrapper
      .findAllComponents(RouterLinkStub)
      .find((link) => link.props('to') === '/dashboard')
    expect(dashboard).toBeTruthy()
    expect(wrapper.text()).toContain('ada@example.com'.charAt(0).toUpperCase())
  })

  it('points administrators at the admin dashboard', () => {
    authStore.isAuthenticated = true
    authStore.isAdmin = true

    const wrapper = mountHome()

    const adminDashboard = wrapper
      .findAllComponents(RouterLinkStub)
      .find((link) => link.props('to') === '/admin/dashboard')
    expect(adminDashboard).toBeTruthy()
  })
})
