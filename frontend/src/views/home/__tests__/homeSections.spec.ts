import { beforeEach, describe, expect, it } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { baseCompile } from '@intlify/message-compiler'
import { createI18n, type MessageFunction } from 'vue-i18n'

import en from '@/i18n/locales/en/landing'
import zh from '@/i18n/locales/zh/landing'
import CtaSection from '../CtaSection.vue'
import FeaturesSection from '../FeaturesSection.vue'
import HeroSection from '../HeroSection.vue'
import HowItWorksSection from '../HowItWorksSection.vue'
import StatsSection from '../StatsSection.vue'
import { HOME_STATS } from '../homeSections.data'

/** Compile the real locale strings for the runtime-only i18n build used by Vitest. */
interface CompiledMessages {
  [key: string]: MessageFunction<string> | CompiledMessages
}

function compileMessages(messages: Record<string, unknown>): CompiledMessages {
  return Object.fromEntries(Object.entries(messages).map(([key, value]) => [
    key,
    typeof value === 'string'
      ? new Function(`return ${baseCompile(value).code}`)() as MessageFunction<string>
      : compileMessages(value as Record<string, unknown>),
  ]))
}

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en: compileMessages(en), zh: compileMessages(zh) },
})

const global = {
  plugins: [i18n],
  stubs: {
    RouterLink: RouterLinkStub,
    Icon: { template: '<span data-testid="icon" />' },
  },
}

const messages = en.home

describe('home sections', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'en'
  })

  it.each(['en', 'zh'] as const)('renders translated copy and reactive site settings in %s', async (locale) => {
    i18n.global.locale.value = locale
    const copy = { en, zh }[locale].home
    const wrapper = mount(HeroSection, {
      global,
      props: { siteName: 'Acme Gateway', siteSubtitle: 'Custom subtitle' },
    })
    expect(wrapper.get('h1').text()).toBe('ALL IN ONE')
    expect(wrapper.text()).toContain(i18n.global.t('home.heroSubtitle', { siteName: 'Acme Gateway' }))
    expect(wrapper.text()).not.toContain('{siteName}')
    expect(wrapper.text()).toContain(copy.heroDescription)
    expect(wrapper.text()).toContain(copy.sections.hero.integration)
    expect(wrapper.text()).toContain(copy.sections.hero.assurance)
    expect(wrapper.text()).toContain(copy.sections.hero.badge)
    await wrapper.setProps({ siteName: 'Updated Gateway', siteSubtitle: 'Updated subtitle' })
    expect(wrapper.text()).toContain('Updated Gateway')
    expect(wrapper.text()).toContain('Updated subtitle')
    expect(wrapper.text()).not.toContain('Acme Gateway')

    const cta = mount(CtaSection, { global })
    expect(cta.get('h2').text()).toContain('ALL IN ONE')
    expect(cta.text()).toContain(copy.sections.cta.summary)
    expect(cta.text()).not.toMatch(/免费|free trial|sign up free/i)
  })

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
    expect(hero.text()).toContain(i18n.global.t('home.heroSubtitle', { siteName: 'Acme Gateway' }))
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
