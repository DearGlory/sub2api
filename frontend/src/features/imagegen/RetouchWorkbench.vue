<template>
  <div class="space-y-3">
    <!-- Strength / subject rows -->
    <div class="flex flex-wrap items-center gap-2">
      <span class="w-12 shrink-0 text-xs text-gray-500 dark:text-dark-400">{{ t('imagegen.retouchIntensity') }}</span>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="option in RETOUCH_INTENSITIES"
          :key="option.id"
          type="button"
          class="rounded-md border px-2.5 py-1 text-xs transition-colors"
          :class="
            option.id === modelValue.intensity
              ? 'border-primary-500 bg-primary-50 text-primary-800 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
              : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-dark-700 dark:text-dark-300 dark:hover:border-dark-600'
          "
          @click="emit('update:intensity', option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <span class="w-12 shrink-0 text-xs text-gray-500 dark:text-dark-400">{{ t('imagegen.retouchSubject') }}</span>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="option in RETOUCH_SUBJECTS"
          :key="option.id"
          type="button"
          class="rounded-md border px-2.5 py-1 text-xs transition-colors"
          :class="
            option.id === modelValue.subject
              ? 'border-primary-500 bg-primary-50 text-primary-800 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
              : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-dark-700 dark:text-dark-300 dark:hover:border-dark-600'
          "
          @click="emit('update:subject', option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <!-- Category tabs -->
    <div class="flex flex-wrap gap-1.5 border-t border-gray-100 pt-3 dark:border-dark-800">
      <button
        v-for="category in RETOUCH_CATEGORIES"
        :key="category.id"
        type="button"
        class="rounded-md border px-2.5 py-1 text-xs transition-colors"
        :class="
          category.id === activeCategory
            ? 'border-primary-500 bg-primary-50 text-primary-800 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
            : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-dark-700 dark:text-dark-300 dark:hover:border-dark-600'
        "
        @click="selectCategory(category.id)"
      >
        {{ category.title }}
        <span v-if="countInCategory(category.id)" class="ml-0.5 font-semibold">{{ countInCategory(category.id) }}</span>
      </button>
    </div>

    <!-- Group tabs -->
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="group in activeGroups"
        :key="group.id"
        type="button"
        class="rounded-md px-2 py-1 text-xs transition-colors"
        :class="
          group.id === activeGroup
            ? 'bg-gray-900 text-white dark:bg-dark-700'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-dark-800 dark:text-dark-300 dark:hover:bg-dark-700'
        "
        @click="selectGroup(group.id)"
      >
        {{ group.title }}
        <span v-if="countInGroup(group.id)" class="ml-0.5 font-semibold">{{ countInGroup(group.id) }}</span>
      </button>
    </div>

    <!-- Preset grid -->
    <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      <button
        v-for="preset in presets"
        :key="preset.id"
        type="button"
        class="rounded-lg border p-2 text-left transition-colors"
        :class="
          isSelected(preset.id)
            ? 'border-primary-500 bg-primary-50 dark:border-primary-600 dark:bg-primary-900/20'
            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-dark-700 dark:hover:border-dark-600 dark:hover:bg-dark-800'
        "
        :title="preset.prompt"
        @click="toggle(preset)"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="truncate text-xs font-medium text-gray-900 dark:text-white">{{ preset.title }}</span>
          <Icon v-if="isSelected(preset.id)" name="check" size="sm" class="shrink-0 text-primary-600 dark:text-primary-400" />
        </div>
        <p v-if="preset.scenario" class="mt-0.5 line-clamp-1 text-[11px] text-gray-500 dark:text-dark-400">
          {{ preset.scenario }}
        </p>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import {
  RETOUCH_CATEGORIES,
  RETOUCH_INTENSITIES,
  RETOUCH_SUBJECTS,
  findRetouchCategory,
  findRetouchGroup,
} from './retouch'
import type { RetouchParams, RetouchPreset } from './types'

const props = defineProps<{
  modelValue: RetouchParams
  activeCategory: string
  activeGroup: string
  selectedPreset: string
  selections: { category: string; group: string; preset: string }[]
}>()

const emit = defineEmits<{
  (e: 'update:intensity', value: string): void
  (e: 'update:subject', value: string): void
  (e: 'update:activeCategory', value: string): void
  (e: 'update:activeGroup', value: string): void
  (e: 'update:selectedPreset', value: string): void
  (e: 'toggle', preset: RetouchPreset): void
  (e: 'clear'): void
}>()

const { t } = useI18n()

const activeGroups = computed(() => findRetouchCategory(props.activeCategory).groups)
const presets = computed(() => findRetouchGroup(findRetouchCategory(props.activeCategory), props.activeGroup).presets)

function selectCategory(id: string): void {
  emit('update:activeCategory', id)
  const category = findRetouchCategory(id)
  emit('update:activeGroup', category.groups[0]?.id ?? '')
  emit('update:selectedPreset', category.groups[0]?.presets[0]?.id ?? '')
}

function selectGroup(id: string): void {
  emit('update:activeGroup', id)
  const group = findRetouchGroup(findRetouchCategory(props.activeCategory), id)
  emit('update:selectedPreset', group.presets[0]?.id ?? '')
}

function isSelected(presetId: string): boolean {
  return props.selections.some(
    (item) =>
      item.category === props.activeCategory && item.group === props.activeGroup && item.preset === presetId,
  )
}

function countInCategory(categoryId: string): number {
  return props.selections.filter((item) => item.category === categoryId).length
}

function countInGroup(groupId: string): number {
  return props.selections.filter((item) => item.category === props.activeCategory && item.group === groupId).length
}

function toggle(preset: RetouchPreset): void {
  emit('update:selectedPreset', preset.id)
  emit('toggle', preset)
}
</script>
