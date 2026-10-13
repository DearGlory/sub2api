import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import Toast from '../Toast.vue'
import NotFoundView from '@/views/NotFoundView.vue'

const { back, hideToast } = vi.hoisted(() => ({ back: vi.fn(), hideToast: vi.fn() }))
const state = reactive({
  toasts: [
    { id: 'reset', type: 'error', message: '无效的重置链接' },
    { id: 'wechat', type: 'error', title: '微信支付', message: '微信支付回调缺少恢复令牌。' }
  ]
})
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ ...state, hideToast }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ back }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('final gap component regressions', () => {
  it('teleports both error messages and preserves live announcements and close targets', async () => {
    const wrapper = mount(Toast, { attachTo: document.body })
    const region = document.body.querySelector('[aria-live="polite"]')!
    expect(region.getAttribute('aria-atomic')).toBe('true')
    expect(region.textContent).toContain('无效的重置链接')
    expect(region.textContent).toContain('微信支付回调缺少恢复令牌。')
    expect(region.querySelectorAll('.text-red-500')).toHaveLength(2)
    ;(region.querySelectorAll('button')[1] as HTMLButtonElement).click()
    await nextTick()
    expect(hideToast).toHaveBeenCalledWith('wechat')
    wrapper.unmount()
  })

  it('keeps the 404 display and both navigation actions', async () => {
    const wrapper = mount(NotFoundView, {
      global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } }
    })
    expect(wrapper.find('span').text()).toBe('404')
    await wrapper.find('button').trigger('click')
    expect(back).toHaveBeenCalledOnce()
    expect(wrapper.find('a[href="/dashboard"]').text()).toContain('Go to Dashboard')
    wrapper.unmount()
  })
})
