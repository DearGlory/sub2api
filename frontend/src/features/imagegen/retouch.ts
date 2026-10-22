/**
 * Retouch preset resolution and prompt assembly.
 *
 * The NewAPI imagegen page kept 73 retouch presets in one nested literal and
 * rebuilt the prompt by walking it every time. Here the tree is imported as
 * JSON (so it is tree-shaken and reviewable) and the walk is expressed as pure
 * functions, which is what the port tests exercise.
 */
import retouchPresetTree from './data/retouchPresetTree.json'
import retouchIntensities from './data/retouchIntensities.json'
import retouchSubjects from './data/retouchSubjects.json'
import type {
  RetouchCategory,
  RetouchGroup,
  RetouchOption,
  RetouchParams,
  RetouchPreset,
  RetouchSelection,
} from './types'

export const RETOUCH_CATEGORIES = retouchPresetTree as unknown as RetouchCategory[]
export const RETOUCH_INTENSITIES = retouchIntensities as RetouchOption[]
export const RETOUCH_SUBJECTS = retouchSubjects as RetouchOption[]

/** The original page opened on this preset; keep the same landing spot. */
export const DEFAULT_RETOUCH_CATEGORY = 'portrait'
export const DEFAULT_RETOUCH_GROUP = '肤色瑕疵'
export const DEFAULT_RETOUCH_PRESET = 'skin-blemish'
export const DEFAULT_RETOUCH_INTENSITY = 'standard'
export const DEFAULT_RETOUCH_SUBJECT = 'auto'

export function retouchKey(selection: RetouchSelection): string {
  return `${selection.category}/${selection.group}/${selection.preset}`
}

export function findRetouchCategory(id: string): RetouchCategory {
  return RETOUCH_CATEGORIES.find((entry) => entry.id === id) ?? RETOUCH_CATEGORIES[0]
}

export function findRetouchGroup(category: RetouchCategory, id: string): RetouchGroup {
  return category.groups.find((entry) => entry.id === id) ?? category.groups[0]
}

export function findRetouchPreset(group: RetouchGroup, id: string): RetouchPreset {
  return group.presets.find((entry) => entry.id === id) ?? group.presets[0]
}

function findRetouchOption(list: RetouchOption[], id: string, fallback: RetouchOption): RetouchOption {
  return list.find((entry) => entry.id === id) ?? fallback
}

/** Coerce any loosely-typed selection into one that exists in the tree. */
export function normalizeRetouchSelection(selection: Partial<RetouchSelection> = {}): RetouchSelection {
  const categoryId = selection.category || DEFAULT_RETOUCH_CATEGORY
  const groupId = selection.group || DEFAULT_RETOUCH_GROUP
  const presetId = selection.preset || DEFAULT_RETOUCH_PRESET

  // A preset id is globally unique in the tree, and history rows written by the
  // old page can name a preset whose category/group no longer pair with it (the
  // tree was edited). Trust the preset id when it matches anywhere, so a row
  // still resolves to the preset the user actually picked.
  for (const category of RETOUCH_CATEGORIES) {
    for (const group of category.groups) {
      for (const preset of group.presets) {
        if (preset.id !== presetId) continue
        if (category.id === categoryId && group.id === groupId) {
          return { category: category.id, group: group.id, preset: preset.id }
        }
      }
    }
  }
  if (presetId) {
    for (const category of RETOUCH_CATEGORIES) {
      for (const group of category.groups) {
        for (const preset of group.presets) {
          if (preset.id === presetId) {
            return { category: category.id, group: group.id, preset: preset.id }
          }
        }
      }
    }
  }

  const category = findRetouchCategory(categoryId)
  const group = findRetouchGroup(category, groupId)
  const preset = findRetouchPreset(group, presetId)
  return { category: category.id, group: group.id, preset: preset.id }
}

/**
 * Normalise persisted retouch state. Accepts the several shapes older history
 * rows used: a bare selection array, `{ selections: [...] }`, or a single
 * `{ category, group, preset }` object.
 */
export function normalizeRetouchParams(value: unknown = {}): RetouchParams {
  const source = value as Record<string, unknown> | RetouchSelection[] | null | undefined
  let rawSelections: Partial<RetouchSelection>[] = []

  if (Array.isArray(source)) {
    rawSelections = source
  } else if (source && Array.isArray((source as { selections?: unknown }).selections)) {
    rawSelections = (source as { selections: Partial<RetouchSelection>[] }).selections
  } else if (source && ((source as { enabled?: boolean }).enabled || (source as { preset?: string }).preset)) {
    rawSelections = [source as Partial<RetouchSelection>]
  }

  const seen = new Set<string>()
  const selections: RetouchSelection[] = []
  for (const item of rawSelections) {
    const normalized = normalizeRetouchSelection(item)
    const key = retouchKey(normalized)
    if (!seen.has(key)) {
      seen.add(key)
      selections.push(normalized)
    }
  }

  const first = selections[0] ?? normalizeRetouchSelection((source ?? {}) as Partial<RetouchSelection>)
  const record = (source ?? {}) as { intensity?: string; subject?: string }

  return {
    enabled: selections.length > 0,
    selections,
    category: first.category,
    group: first.group,
    preset: first.preset,
    intensity: findRetouchOption(RETOUCH_INTENSITIES, record.intensity ?? '', RETOUCH_INTENSITIES[1]).id,
    subject: findRetouchOption(RETOUCH_SUBJECTS, record.subject ?? '', RETOUCH_SUBJECTS[0]).id,
  }
}

/** Resolve a selection to the full preset records it points at. */
export function resolveRetouchSelection(selection: RetouchSelection): {
  selection: RetouchSelection
  category: RetouchCategory
  group: RetouchGroup
  preset: RetouchPreset
} {
  const normalized = normalizeRetouchSelection(selection)
  const category = findRetouchCategory(normalized.category)
  const group = findRetouchGroup(category, normalized.group)
  const preset = findRetouchPreset(group, normalized.preset)
  return { selection: normalized, category, group, preset }
}

function singleRetouchPrompt(preset: RetouchPreset, intensityId: string, subjectId: string): string {
  const intensity = findRetouchOption(RETOUCH_INTENSITIES, intensityId, RETOUCH_INTENSITIES[1])
  const subject = findRetouchOption(RETOUCH_SUBJECTS, subjectId, RETOUCH_SUBJECTS[0])
  return `${preset.prompt}

执行设置：${intensity.prompt}${subject.prompt} 保持专业修图逻辑：只修改当前功能相关区域，不要改动无关主体、身份、文字、构图和真实光影。`
}

function multiRetouchPrompt(items: RetouchPreset[], intensityId: string, subjectId: string): string {
  if (!items.length) return ''
  if (items.length === 1) return singleRetouchPrompt(items[0], intensityId, subjectId)

  const intensity = findRetouchOption(RETOUCH_INTENSITIES, intensityId, RETOUCH_INTENSITIES[1])
  const subject = findRetouchOption(RETOUCH_SUBJECTS, subjectId, RETOUCH_SUBJECTS[0])
  const steps = items.map((item, index) => `${index + 1}. ${item.title}：${item.prompt}`).join('\n')
  return `对输入图片执行以下专业修图组合，按顺序叠加处理，不互相覆盖：
${steps}

执行设置：${intensity.prompt}${subject.prompt} 保持专业修图逻辑：只修改已选择功能相关区域，不要改动无关主体、身份、文字、构图和真实光影。`
}

/** The hidden block appended to the visible prompt when retouch is enabled. */
export function retouchPrompt(params: RetouchParams): string {
  const normalized = normalizeRetouchParams(params)
  if (!normalized.enabled) return ''
  const presets = normalized.selections.map((item) => resolveRetouchSelection(item).preset)
  return multiRetouchPrompt(presets, normalized.intensity, normalized.subject)
}

/**
 * Final upstream prompt: user text, optional style suffix, then the retouch
 * block as its own paragraph. Mirrors the source implementation exactly so
 * existing history rows reproduce byte-identical prompts when re-run.
 */
export function buildPromptPayload(raw: string, style: string, params: RetouchParams): string {
  const user = String(raw || '').trim()
  const styleSuffix = String(style || '').trim()
  const base = styleSuffix ? (user ? `${user}, ${styleSuffix}` : styleSuffix) : user
  return [base, retouchPrompt(params)].filter(Boolean).join('\n\n')
}
