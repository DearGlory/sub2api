import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils'
import StripePaymentInline from '../StripePaymentInline.vue'

const stripe = vi.hoisted(() => ({ elements: vi.fn() }))
const paymentElement = vi.hoisted(() => ({ mount: vi.fn(), on: vi.fn() }))
const elements = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: vi.fn(async () => stripe) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/api/payment', () => ({ paymentAPI: {} }))
vi.mock('vue-router', () => ({ useRouter: () => ({}) }))
vi.mock('@/stores', () => ({ useAppStore: () => ({}) }))

enableAutoUnmount(afterEach)
const root = document.documentElement
let originalClass: string
let originalUniverseTheme: string | undefined
let originalPreference: string | null

beforeEach(() => {
  originalClass = root.className
  originalUniverseTheme = root.dataset.universeTheme
  originalPreference = localStorage.getItem('theme')
  stripe.elements.mockReset().mockReturnValue(elements)
  elements.create.mockReset().mockReturnValue(paymentElement)
  paymentElement.mount.mockReset()
  paymentElement.on.mockReset()
})

afterEach(() => {
  root.className = originalClass
  if (originalUniverseTheme === undefined) delete root.dataset.universeTheme
  else root.dataset.universeTheme = originalUniverseTheme
  if (originalPreference === null) localStorage.removeItem('theme')
  else localStorage.setItem('theme', originalPreference)
})

describe('StripePaymentInline surface appearance', () => {
  it.each([
    { universe: 'cosmos', dark: false, theme: 'night' },
    { universe: undefined, dark: false, theme: 'stripe' },
    { universe: undefined, dark: true, theme: 'night' },
  ])('uses $theme with universe=$universe and dark=$dark', async ({ universe, dark, theme }) => {
    root.classList.toggle('dark', dark)
    if (universe === undefined) delete root.dataset.universeTheme
    else root.dataset.universeTheme = universe
    localStorage.setItem('theme', dark ? 'dark' : 'light')
    shallowMount(StripePaymentInline, {
      props: {
        orderId: 42, amount: 100, clientSecret: 'pi_test_secret',
        publishableKey: 'pk_test', payAmount: 103,
      },
    })
    await flushPromises()
    await flushPromises()

    expect(stripe.elements).toHaveBeenCalledWith({
      clientSecret: 'pi_test_secret',
      appearance: { theme, variables: { borderRadius: '8px' } },
    })
    expect(paymentElement.mount).toHaveBeenCalledOnce()
    expect(root.classList.contains('dark')).toBe(dark)
    expect(localStorage.getItem('theme')).toBe(dark ? 'dark' : 'light')
  })
})
