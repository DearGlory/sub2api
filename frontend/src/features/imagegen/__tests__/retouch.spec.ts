import { describe, expect, it } from 'vitest'

import {
  RETOUCH_CATEGORIES,
  RETOUCH_INTENSITIES,
  RETOUCH_SUBJECTS,
  buildPromptPayload,
  normalizeRetouchParams,
  normalizeRetouchSelection,
  resolveRetouchSelection,
  retouchKey,
  retouchPrompt,
} from '../retouch'

describe('retouch preset tree', () => {
  it('loads every category with a non-empty preset list', () => {
    expect(RETOUCH_CATEGORIES.length).toBe(9)
    for (const category of RETOUCH_CATEGORIES) {
      expect(category.id).toBeTruthy()
      expect(category.groups.length).toBeGreaterThan(0)
      for (const group of category.groups) {
        expect(group.presets.length).toBeGreaterThan(0)
        for (const preset of group.presets) {
          expect(preset.id).toBeTruthy()
          expect(preset.prompt.trim()).not.toBe('')
        }
      }
    }
  })

  it('carries the full 73 presets the source page shipped', () => {
    const total = RETOUCH_CATEGORIES.flatMap((category) => category.groups).reduce(
      (sum, group) => sum + group.presets.length,
      0,
    )
    expect(total).toBe(73)
  })

  it('keeps the four intensities and five subjects', () => {
    expect(RETOUCH_INTENSITIES.map((entry) => entry.id)).toEqual(['light', 'standard', 'strong', 'max'])
    expect(RETOUCH_SUBJECTS.map((entry) => entry.id)).toEqual(['auto', 'female', 'male', 'child', 'product'])
  })
})

describe('normalizeRetouchSelection', () => {
  it('falls back to the first category/group/preset when nothing matches', () => {
    // The source page used RETOUCH_PRESET_TREE[0] as the unknown-id fallback,
    // not the portrait landing preset. Defaults only apply when a field is
    // absent, not when it is present-but-unknown.
    const result = normalizeRetouchSelection({ category: 'nope', group: 'nope', preset: 'nope' })
    const firstCategory = RETOUCH_CATEGORIES[0]
    const firstGroup = firstCategory.groups[0]
    expect(result.category).toBe(firstCategory.id)
    expect(result.group).toBe(firstGroup.id)
    expect(result.preset).toBe(firstGroup.presets[0].id)
  })

  it('uses the portrait landing preset when fields are absent', () => {
    const result = normalizeRetouchSelection({})
    expect(result.category).toBe('portrait')
    expect(result.group).toBe('肤色瑕疵')
    expect(result.preset).toBe('skin-blemish')
  })

  it('trusts a globally unique preset id even when the category no longer matches', () => {
    // Old history rows keep the preset id but may carry a stale category.
    const category = RETOUCH_CATEGORIES[3]
    const group = category.groups[0]
    const preset = group.presets[0]
    const result = normalizeRetouchSelection({
      category: 'aiColor',
      group: 'AI追色',
      preset: preset.id,
    })
    expect(result.preset).toBe(preset.id)
    expect(result.category).toBe(category.id)
    expect(result.group).toBe(group.id)
  })

  it('keeps a valid selection untouched', () => {
    const first = RETOUCH_CATEGORIES[0]
    const group = first.groups[0]
    const preset = group.presets[0]
    const result = normalizeRetouchSelection({
      category: first.id,
      group: group.id,
      preset: preset.id,
    })
    expect(result).toEqual({ category: first.id, group: group.id, preset: preset.id })
  })
})

describe('normalizeRetouchParams', () => {
  it('reports disabled with no selections for empty input', () => {
    const result = normalizeRetouchParams({})
    expect(result.enabled).toBe(false)
    expect(result.selections).toEqual([])
    expect(result.intensity).toBe('standard')
    expect(result.subject).toBe('auto')
  })

  it('accepts a bare selection array and deduplicates it', () => {
    const first = RETOUCH_CATEGORIES[0]
    const group = first.groups[0]
    const selection = { category: first.id, group: group.id, preset: group.presets[0].id }
    const result = normalizeRetouchParams([selection, selection])
    expect(result.enabled).toBe(true)
    expect(result.selections).toHaveLength(1)
  })

  it('accepts the persisted { selections } shape', () => {
    const first = RETOUCH_CATEGORIES[0]
    const group = first.groups[0]
    const result = normalizeRetouchParams({
      selections: [{ category: first.id, group: group.id, preset: group.presets[0].id }],
      intensity: 'max',
      subject: 'female',
    })
    expect(result.selections).toHaveLength(1)
    expect(result.intensity).toBe('max')
    expect(result.subject).toBe('female')
  })

  it('coerces unknown intensity/subject back to the defaults', () => {
    const result = normalizeRetouchParams({ intensity: 'bogus', subject: 'bogus' })
    expect(result.intensity).toBe('standard')
    expect(result.subject).toBe('auto')
  })
})

describe('retouchKey', () => {
  it('composes the three-part key the workbench compares on', () => {
    expect(retouchKey({ category: 'a', group: 'b', preset: 'c' })).toBe('a/b/c')
  })
})

describe('resolveRetouchSelection', () => {
  it('resolves a selection to the full category/group/preset records', () => {
    const category = RETOUCH_CATEGORIES[2]
    const group = category.groups[0]
    const preset = group.presets[0]
    const resolved = resolveRetouchSelection({
      category: category.id,
      group: group.id,
      preset: preset.id,
    })
    expect(resolved.category.id).toBe(category.id)
    expect(resolved.group.id).toBe(group.id)
    expect(resolved.preset.id).toBe(preset.id)
  })
})

describe('retouchPrompt', () => {
  it('returns empty when disabled', () => {
    expect(retouchPrompt(normalizeRetouchParams({}))).toBe('')
  })

  it('adds the execution settings for a single preset', () => {
    const category = RETOUCH_CATEGORIES[0]
    const group = category.groups[0]
    const preset = group.presets[0]
    const params = normalizeRetouchParams({
      selections: [{ category: category.id, group: group.id, preset: preset.id }],
      intensity: 'strong',
      subject: 'male',
    })
    const prompt = retouchPrompt(params)
    expect(prompt).toContain(preset.prompt)
    expect(prompt).toContain('处理强度为明显')
    expect(prompt).toContain('按男性人像审美处理')
    expect(prompt).toContain('保持专业修图逻辑')
  })

  it('numbers multiple presets so they stack in order', () => {
    const category = RETOUCH_CATEGORIES[0]
    const group = category.groups[0]
    const params = normalizeRetouchParams({
      selections: [
        { category: category.id, group: group.id, preset: group.presets[0].id },
        { category: category.id, group: group.id, preset: group.presets[1].id },
      ],
    })
    const prompt = retouchPrompt(params)
    expect(prompt).toContain('对输入图片执行以下专业修图组合')
    expect(prompt).toContain(`1. ${group.presets[0].title}`)
    expect(prompt).toContain(`2. ${group.presets[1].title}`)
  })
})

describe('buildPromptPayload', () => {
  const disabled = normalizeRetouchParams({})

  it('returns the trimmed prompt when there is no style or retouch', () => {
    expect(buildPromptPayload('  a cat  ', '', disabled)).toBe('a cat')
  })

  it('appends the style suffix after a comma', () => {
    expect(buildPromptPayload('a cat', 'anime style', disabled)).toBe('a cat, anime style')
  })

  it('uses the style alone when the prompt is empty', () => {
    expect(buildPromptPayload('', 'anime style', disabled)).toBe('anime style')
  })

  it('appends the retouch block as its own paragraph', () => {
    const category = RETOUCH_CATEGORIES[0]
    const group = category.groups[0]
    const params = normalizeRetouchParams({
      selections: [{ category: category.id, group: group.id, preset: group.presets[0].id }],
    })
    const payload = buildPromptPayload('a cat', 'anime style', params)
    expect(payload.startsWith('a cat, anime style\n\n')).toBe(true)
    expect(payload).toContain('保持专业修图逻辑')
  })

  it('returns an empty string when every layer is empty', () => {
    expect(buildPromptPayload('', '', disabled)).toBe('')
  })
})
