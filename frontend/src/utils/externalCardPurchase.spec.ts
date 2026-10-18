import { describe, expect, it } from 'vitest'
import {
  buildExternalCardPurchaseUrl,
  normalizeExternalCardPurchaseDisplayMode,
} from './externalCardPurchase'

describe('buildExternalCardPurchaseUrl', () => {
  it('uses the configured shop URL without forwarding site credentials or user context', () => {
    const url = buildExternalCardPurchaseUrl('https://catfk.com/shop/GloryCode')

    expect(url).toBe('https://catfk.com/shop/GloryCode')
    expect(url).not.toMatch(/[?&](token|user_id|src_url)=/i)
  })

  it('removes reserved site-context query parameters from a configured URL', () => {
    expect(buildExternalCardPurchaseUrl('https://catfk.com/shop/GloryCode?token=site&jwt=x&access_token=y&user_id=7&src_url=%2Fpurchase&ref=campaign'))
      .toBe('https://catfk.com/shop/GloryCode?ref=campaign')
  })

  it('removes source URL variants regardless of casing or encoding while keeping product filters', () => {
    expect(buildExternalCardPurchaseUrl('https://catfk.com/shop/GloryCode?ref=campaign&source_url=%2Fpayment&SOURCE_URL=again&sourceUrl=x&source-url=y&product=balance'))
      .toBe('https://catfk.com/shop/GloryCode?ref=campaign&product=balance')
  })
  it.each([
    'source_url=%2Fpurchase',
    'SOURCE_URL=%2Fpurchase',
    'source%5Furl=%2Fpurchase',
    'source_url=first&source_url=second',
    'sourceUrl=%2Fpurchase',
    'source-url=%2Fpurchase',
  ])('removes external source URL parameter %s while preserving product query parameters', (sourceParameter) => {
    expect(buildExternalCardPurchaseUrl(`https://catfk.com/shop/GloryCode?${sourceParameter}&ref=campaign&product=balance`))
      .toBe('https://catfk.com/shop/GloryCode?ref=campaign&product=balance')
  })

  it.each([
    'javascript:alert(1)',
    'http://catfk.com/shop/GloryCode',
    'https://user:password@catfk.com/shop/GloryCode',
    '/shop/GloryCode',
    '',
  ])('rejects unsafe or non-HTTPS configured URLs: %s', (input) => {
    expect(buildExternalCardPurchaseUrl(input)).toBe('')
  })
})

describe('normalizeExternalCardPurchaseDisplayMode', () => {
  it.each([
    ['embed', 'embed'],
    ['new_window', 'new_window'],
    ['both', 'both'],
    ['', 'both'],
    ['unsupported', 'both'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeExternalCardPurchaseDisplayMode(input)).toBe(expected)
  })
})