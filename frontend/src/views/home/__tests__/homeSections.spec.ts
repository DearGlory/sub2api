import { describe, expect, it, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'

import en from '@/i18n/locales/en'
import CtaSection from '../CtaSection.vue'
import FeaturesSection from '../FeaturesSection.vue'
import HeroSection from '../HeroSection.vue'
import HowItWorksSection from '../HowItWorksSection.vue'
import StatsSection from '../StatsSection.vue'
import { HOME_STATS } from '../homeSections.data'

/**
 * `t` resolves against the real English locale rather than echoing the key
 * back, so this spec doubles as a key check: a typo renders as a literal
 * unresolved key string and fails the assertions below.
 *
 * (The suite aliases vue-i18n to its runtime-only build, which ships no message
 * compiler, so a plain `createI18n` cannot format string messages here.)
 */
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()

  const lookup = (key: string): string => {
    let current: unknown = en
    for (const segment of key.split('.')) {
      if (current === null || typeof current !== 'object') return key
      current = (current as Record<string, unknown>)[segment]
    }
    return typeof current === 'string' ? current : key
  }

  return { ...actual, useI18n: () => ({ t: lookup }) }
})

const global = {
  stubs: {
    RouterLink: RouterLinkStub,
    Icon: { template: '<span data-testid="icon" />' },
  },
}

const messages = en.home

describe('home sections', () => {
  it('renders the hero with the site name, value line and both actions', () => {
    const wrapper = mount(HeroSection, {
      global,
      props: {
        siteName: 'Acme Gateway',
        siteSubtitle: 'Gateway subtitle',
        isAuthenticated: false,
        dashboardPath: '/dashboard',
        docUrl: 'https://docs.example.com',
      },
    })

    const hero = wrapper.get('[data-testid="home-hero"]')
    expect(hero.text()).toContain('Acme Gateway')
    expect(hero.text()).toContain('Gateway subtitle')
    expect(hero.text()).toContain(messages.heroSubtitle)
    expect(hero.text()).toContain(messages.heroDescription)
    // Three capability chips.
    expect(wrapper.findAll('li')).toHaveLength(3)
    // Primary action plus the docs action.
    expect(wrapper.findAll('.btn')).toHaveLength(2)
  })

  it('hides the docs action in the hero when no documentation URL is configured', () => {
    const wrapper = mount(HeroSection, {
      global,
      props: {
        siteName: 'Acme',
        siteSubtitle: '',
        isAuthenticated: false,
        dashboardPath: '/dashboard',
        docUrl: '',
      },
    })

    expect(wrapper.findAll('.btn')).toHaveLength(1)
  })

  it('sends the hero primary action to login when signed out and to the dashboard when signed in', () => {
    const signedOut = mount(HeroSection, {
      global,
      props: { siteName: 'Acme', isAuthenticated: false, dashboardPath: '/admin/dashboard' },
    })
    expect(signedOut.getComponent(RouterLinkStub).props('to')).toBe('/login')

    const signedIn = mount(HeroSection, {
      global,
      props: { siteName: 'Acme', isAuthenticated: true, dashboardPath: '/admin/dashboard' },
    })
    expect(signedIn.getComponent(RouterLinkStub).props('to')).toBe('/admin/dashboard')
  })

  it('renders one stats figure per catalogue-derived stat, with translated labels', () => {
    const wrapper = mount(StatsSection, { global })
    const text = wrapper.get('[data-testid="home-stats"]').text()

    for (const stat of HOME_STATS) {
      // Label and hint come from the locale, not from a raw key.
      expect(text).toContain(messages.sections.stats.items[stat.key].label)
      expect(text).toContain(messages.sections.stats.items[stat.key].hint)
    }
    expect(text).not.toContain('home.sections.stats')
    // Figures are read from the backend-generated catalogue, never invented.
    expect(HOME_STATS).toHaveLength(4)
    expect(HOME_STATS.every((stat) => stat.value > 0)).toBe(true)
  })

  it('renders the four features and four supporting capabilities, translated', () => {
    const wrapper = mount(FeaturesSection, { global })
    const text = wrapper.get('[data-testid="home-features"]').text()

    expect(text).toContain(messages.sections.features.title)
    expect(text).toContain(messages.features.unifiedGateway)
    expect(text).toContain(messages.sections.features.compatTitle)
    expect(text).toContain(messages.sections.features.capRecords)
    expect(text).not.toContain('home.sections.features')
    // Four bento cards plus four capability cards.
    expect(wrapper.findAll('h3')).toHaveLength(8)
    // The proof visual lists real platform names from the catalogue.
    expect(text).toContain('Anthropic')
  })

  it('renders the three workflow steps with their numbers, translated', () => {
    const wrapper = mount(HowItWorksSection, { global })
    const text = wrapper.get('[data-testid="home-how-it-works"]').text()

    expect(wrapper.findAll('h3')).toHaveLength(3)
    expect(text).toContain(messages.sections.howItWorks.title)
    expect(text).toContain(messages.sections.howItWorks.step1Title)
    expect(text).toContain(messages.sections.howItWorks.step3Title)
    expect(text).not.toContain('home.sections.howItWorks')
    for (const num of ['01', '02', '03']) {
      expect(text).toContain(num)
    }
  })

  it('renders the closing call to action with the shared CTA copy', () => {
    const wrapper = mount(CtaSection, {
      global,
      props: { isAuthenticated: false, dashboardPath: '/dashboard' },
    })

    const text = wrapper.get('[data-testid="home-cta"]').text()
    expect(text).toContain(messages.cta.title)
    expect(text).toContain(messages.cta.description)
    expect(text).toContain(messages.cta.button)
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/login')
  })

  it('sends the closing call to action to the dashboard once signed in', () => {
    const wrapper = mount(CtaSection, {
      global,
      props: { isAuthenticated: true, dashboardPath: '/admin/dashboard' },
    })

    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/admin/dashboard')
  })

  it('renders every section without a single unresolved i18n key', () => {
    const mounts = [
      mount(HeroSection, { global, props: { siteName: 'Acme' } }),
      mount(StatsSection, { global }),
      mount(FeaturesSection, { global }),
      mount(HowItWorksSection, { global }),
      mount(CtaSection, { global }),
    ]

    for (const wrapper of mounts) {
      expect(wrapper.text()).not.toMatch(/home\.[a-zA-Z.]+\.[a-zA-Z]/)
    }
  })
})
