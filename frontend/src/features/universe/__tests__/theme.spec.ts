import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDarkSurface } from '../theme'

const root = document.documentElement
let originalClass: string
let originalUniverseTheme: string | undefined
let originalPreference: string | null

beforeEach(() => {
  originalClass = root.className
  originalUniverseTheme = root.dataset.universeTheme
  originalPreference = localStorage.getItem('theme')
  root.classList.remove('dark')
  delete root.dataset.universeTheme
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  root.className = originalClass
  if (originalUniverseTheme === undefined) delete root.dataset.universeTheme
  else root.dataset.universeTheme = originalUniverseTheme
  if (originalPreference === null) localStorage.removeItem('theme')
  else localStorage.setItem('theme', originalPreference)
})

describe('isDarkSurface', () => {
  it.each([false, true])('uses dark colors for cosmos with dark preference=%s', (dark) => {
    root.dataset.universeTheme = 'cosmos'
    root.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')

    expect(isDarkSurface()).toBe(true)
    expect(root.classList.contains('dark')).toBe(dark)
    expect(localStorage.getItem('theme')).toBe(dark ? 'dark' : 'light')
  })

  it.each([
    [undefined, false],
    [undefined, true],
    ['other', false],
    ['other', true],
  ])('follows html.dark outside cosmos (universe=%s, dark=%s)', (universe, dark) => {
    if (universe !== undefined) root.dataset.universeTheme = universe
    root.classList.toggle('dark', dark)

    expect(isDarkSurface()).toBe(dark)
  })

  it('reads the current root before mount without caching the initial preference', () => {
    localStorage.setItem('theme', 'light')
    const media = vi.spyOn(window, 'matchMedia')
    expect(isDarkSurface()).toBe(false)
    root.dataset.universeTheme = 'cosmos'
    expect(isDarkSurface()).toBe(true)
    delete root.dataset.universeTheme
    root.classList.add('dark')
    expect(isDarkSurface()).toBe(true)
    expect(media).not.toHaveBeenCalled()
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('returns false during SSR without document or window', () => {
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('window', undefined)

    expect(isDarkSurface()).toBe(false)
  })
})
