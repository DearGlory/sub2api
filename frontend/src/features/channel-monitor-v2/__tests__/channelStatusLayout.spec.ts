import { describe, expect, it } from 'vitest'
import { buildChannelStatusLayout, channelStatusLayoutBlockKey } from '../channelStatusLayout'

describe('buildChannelStatusLayout', () => {
  it('groups platforms with two or more rows into a labeled cluster', () => {
    const blocks = buildChannelStatusLayout([
      { platform: 'anthropic', rows: ['a', 'b'] },
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'cluster', platform: 'anthropic' })
  })

  it('packs consecutive single-row platforms into one compact band', () => {
    // Otherwise each single-group platform would occupy a full-width row of its
    // own and the board would scroll for no reason.
    const blocks = buildChannelStatusLayout([
      { platform: 'openai', rows: ['a'] },
      { platform: 'gemini', rows: ['b'] },
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'compact' })
    if (blocks[0].kind !== 'compact') throw new Error('expected a compact block')
    expect(blocks[0].items.map(item => item.platform)).toEqual(['openai', 'gemini'])
  })

  it('flushes the pending compact band before a cluster starts', () => {
    const blocks = buildChannelStatusLayout([
      { platform: 'openai', rows: ['a'] },
      { platform: 'anthropic', rows: ['b', 'c'] },
      { platform: 'gemini', rows: ['d'] },
    ])

    expect(blocks.map(block => block.kind)).toEqual(['compact', 'cluster', 'compact'])
  })

  it('drops platforms with no rows instead of rendering an empty band', () => {
    const blocks = buildChannelStatusLayout([
      { platform: 'empty', rows: [] },
      { platform: 'anthropic', rows: ['a'] },
    ])

    expect(blocks).toHaveLength(1)
    if (blocks[0].kind !== 'compact') throw new Error('expected a compact block')
    expect(blocks[0].items[0].platform).toBe('anthropic')
  })
})

describe('channelStatusLayoutBlockKey', () => {
  it('keys a cluster by platform so reordering does not recycle DOM', () => {
    const key = channelStatusLayoutBlockKey({ kind: 'cluster', platform: 'anthropic', rows: ['a'] })
    expect(key).toBe('cluster:anthropic')
  })

  it('keys a compact band by the platforms it holds, not by list position', () => {
    const key = channelStatusLayoutBlockKey({
      kind: 'compact',
      items: [{ platform: 'openai', row: 'a' }, { platform: 'gemini', row: 'b' }],
    })
    expect(key).toBe('compact:openai|gemini')
  })
})
