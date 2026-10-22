/**
 * Mount smoke test for the image-generation plaza.
 *
 * The page is the one place where 73 JSON presets, an IndexedDB-backed history
 * and a Teleported drawer all meet. A type-check cannot catch a template that
 * throws on mount, so this renders the real component with the network stubbed
 * and asserts the interactive parts appear.
 *
 * vitest.config.ts aliases vue-i18n to the runtime-only build, so `t()` returns
 * the message key rather than the translated string. Assertions therefore look
 * for keys, which also makes them locale-independent.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

import ImageGenView from '@/views/ImageGenView.vue'
import zh from '@/i18n/locales/zh'

// AppLayout pulls in the whole nav tree; a passthrough keeps the test focused
// on the page's own markup.
vi.mock('@/components/layout/AppLayout.vue', () => ({
  default: { name: 'AppLayout', template: '<div><slot /></div>' },
}))

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh',
    fallbackLocale: 'zh',
    messages: { zh },
  })
}

/** Minimal fetch stub: the catalog and model list are the only real calls. */
function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.includes('templates.json')) {
      return new Response(
        JSON.stringify({
          templates: [
            {
              name: '测试模板',
              category: '海报广告',
              prompt: 'a test prompt',
              preview: 'previews/x.webp',
              params: { size: '1024x1024', quality: 'high', count: 2 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

const mountView = () => mount(ImageGenView, { global: { plugins: [makeI18n()] } })

describe('ImageGenView', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    setActivePinia(createPinia())
    originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch() as unknown as typeof globalThis.fetch
    // jsdom has no IndexedDB; the history layer tolerates its absence.
    if (!('indexedDB' in globalThis)) {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('mounts and renders the generate form', async () => {
    const wrapper = mountView()
    await flushPromises()

    // The primary action and the token field are the two things a user needs.
    const buttons = wrapper.findAll('button').map((node) => node.text())
    expect(buttons.some((label) => label.includes('imagegen.generate'))).toBe(true)
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('imagegen.promptLabel')

    wrapper.unmount()
  })

  it('seeds the default model and size', async () => {
    const wrapper = mountView()
    await flushPromises()

    const values = wrapper.findAll('input').map((node) => (node.element as HTMLInputElement).value)
    expect(values).toContain('gpt-image-2')

    // Size is a grouped <select>, not a text input.
    const sizeSelect = wrapper
      .findAll('select')
      .find((node) =>
        Array.from((node.element as HTMLSelectElement).options).some((o) => o.value === '1024x1024'),
      )
    expect(sizeSelect).toBeTruthy()
    expect((sizeSelect!.element as HTMLSelectElement).value).toBe('1024x1024')

    wrapper.unmount()
  })

  it('expands the retouch workbench with the preset categories', async () => {
    const wrapper = mountView()
    await flushPromises()

    const retouchToggle = wrapper
      .findAll('button')
      .find((node) => node.text().includes('imagegen.retouchTitle'))
    expect(retouchToggle).toBeTruthy()
    await retouchToggle!.trigger('click')
    await flushPromises()

    // Category titles come straight from the extracted preset tree, so they are
    // real Chinese strings even under the runtime-only i18n build.
    expect(wrapper.text()).toContain('人像')
    expect(wrapper.text()).toContain('AI色彩')
    expect(wrapper.text()).toContain('imagegen.retouchIntensity')
    expect(wrapper.text()).toContain('imagegen.retouchSubject')

    wrapper.unmount()
  })

  it('shows a preset from the default workbench group', async () => {
    const wrapper = mountView()
    await flushPromises()

    const retouchToggle = wrapper
      .findAll('button')
      .find((node) => node.text().includes('imagegen.retouchTitle'))
    await retouchToggle!.trigger('click')
    await flushPromises()

    // 肤色瑕疵 is the default group opened by the source page.
    expect(wrapper.text()).toContain('肤色瑕疵')

    wrapper.unmount()
  })

  it('loads the server template catalog into the drawer', async () => {
    const wrapper = mountView()
    await flushPromises()

    const openButton = wrapper
      .findAll('button')
      .find((node) => node.text().includes('imagegen.templatesOpen'))
    expect(openButton).toBeTruthy()
    await openButton!.trigger('click')
    await flushPromises()

    // The drawer Teleports to body, so it lives outside the wrapper element.
    expect(document.body.textContent).toContain('imagegen.templatesTitle')
    expect(document.body.textContent).toContain('测试模板')

    wrapper.unmount()
  })

  it('rejects generation without a token instead of calling the gateway', async () => {
    const wrapper = mountView()
    await flushPromises()

    const fetchStub = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const before = fetchStub.mock.calls.length

    const generate = wrapper
      .findAll('button')
      .find((node) => node.text().includes('imagegen.generate'))
    await generate!.trigger('click')
    await flushPromises()

    // No /v1/images call may happen without a token.
    const imageCalls = fetchStub.mock.calls.filter((call) => String(call[0]).includes('/v1/images'))
    expect(imageCalls).toHaveLength(0)
    expect(fetchStub.mock.calls.length).toBe(before)

    wrapper.unmount()
  })
})
