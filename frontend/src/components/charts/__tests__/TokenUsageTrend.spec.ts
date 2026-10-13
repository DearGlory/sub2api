import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import TokenUsageTrend from '../TokenUsageTrend.vue'

const messages: Record<string, string> = {
  'admin.dashboard.tokenUsageTrend': 'Token Usage Trend',
  'admin.dashboard.noDataAvailable': 'No data available',
}

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => messages[key] ?? key,
    }),
  }
})

vi.mock('vue-chartjs', () => ({
  Line: {
    props: ['data', 'options'],
    template: '<div class="chart-data">{{ JSON.stringify(data) }}</div><div class="chart-options">{{ JSON.stringify(options) }}</div>',
  },
}))

describe('TokenUsageTrend', () => {
  it.each([
    { universe: 'cosmos', dark: false, text: '#e5e7eb', grid: '#374151' },
    { universe: undefined, dark: false, text: '#374151', grid: '#e5e7eb' },
    { universe: undefined, dark: true, text: '#e5e7eb', grid: '#374151' },
  ])('uses surface colors with universe=$universe and dark=$dark', ({ universe, dark, text, grid }) => {
    const root = document.documentElement
    const originalClass = root.className
    const originalUniverseTheme = root.dataset.universeTheme
    root.classList.toggle('dark', dark)
    if (universe === undefined) delete root.dataset.universeTheme
    else root.dataset.universeTheme = universe
    const wrapper = mount(TokenUsageTrend, {
      props: {
        trendData: [{
          date: '2026-05-08', requests: 1, input_tokens: 500, output_tokens: 100,
          cache_creation_tokens: 0, cache_read_tokens: 1500, cost: 0.01, actual_cost: 0.005,
        }],
      },
    })

    try {
      const options = JSON.parse(wrapper.find('.chart-options').text())
      expect(options.plugins.legend.labels.color).toBe(text)
      expect(options.scales.x.ticks.color).toBe(text)
      expect(options.scales.y.ticks.color).toBe(text)
      expect(options.scales.x.grid.color).toBe(grid)
      const data = JSON.parse(wrapper.find('.chart-data').text())
      expect(data.datasets[0].borderColor).toBe('#ff6708')
      expect(data.datasets[1].borderColor).toBe('#10b981')
      expect(root.classList.contains('dark')).toBe(dark)
    } finally {
      wrapper.unmount()
      root.className = originalClass
      if (originalUniverseTheme === undefined) delete root.dataset.universeTheme
      else root.dataset.universeTheme = originalUniverseTheme
    }
  })

  it('calculates cache hit rate against all prompt tokens', () => {
    const wrapper = mount(TokenUsageTrend, {
      props: {
        trendData: [
          {
            date: '2026-05-08',
            requests: 1,
            input_tokens: 500,
            output_tokens: 100,
            cache_creation_tokens: 0,
            cache_read_tokens: 1500,
            cost: 0.01,
            actual_cost: 0.005,
          },
        ],
      },
      global: {
        stubs: {
          LoadingSpinner: true,
        },
      },
    })

    const chartData = JSON.parse(wrapper.find('.chart-data').text())
    const hitRateDataset = chartData.datasets.find(
      (ds: any) => ds.label === 'Cache Hit Rate'
    )
    // Hit rate = 1500 / (500 + 1500 + 0) * 100 = 75%
    expect(hitRateDataset.data[0]).toBe(75)
  })

  it('returns 0 hit rate when all prompt tokens are zero', () => {
    const wrapper = mount(TokenUsageTrend, {
      props: {
        trendData: [
          {
            date: '2026-05-08',
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            cost: 0,
            actual_cost: 0,
          },
        ],
      },
      global: {
        stubs: {
          LoadingSpinner: true,
        },
      },
    })

    const chartData = JSON.parse(wrapper.find('.chart-data').text())
    const hitRateDataset = chartData.datasets.find(
      (ds: any) => ds.label === 'Cache Hit Rate'
    )
    expect(hitRateDataset.data[0]).toBe(0)
  })

  it('includes cache_creation_tokens in denominator for Anthropic models', () => {
    const wrapper = mount(TokenUsageTrend, {
      props: {
        trendData: [
          {
            date: '2026-05-08',
            requests: 1,
            input_tokens: 200,
            output_tokens: 50,
            cache_creation_tokens: 300,
            cache_read_tokens: 500,
            cost: 0.02,
            actual_cost: 0.01,
          },
        ],
      },
      global: {
        stubs: {
          LoadingSpinner: true,
        },
      },
    })

    const chartData = JSON.parse(wrapper.find('.chart-data').text())
    const hitRateDataset = chartData.datasets.find(
      (ds: any) => ds.label === 'Cache Hit Rate'
    )
    // Hit rate = 500 / (200 + 500 + 300) * 100 = 50%
    expect(hitRateDataset.data[0]).toBe(50)
  })
})