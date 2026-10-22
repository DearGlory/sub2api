<template>
  <div class="space-y-2">
    <!-- Drop zone -->
    <div
      class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition-colors"
      :class="
        dragActive
          ? 'border-primary-500 bg-primary-50 dark:border-primary-600 dark:bg-primary-900/20'
          : 'border-gray-300 hover:border-gray-400 dark:border-dark-600 dark:hover:border-dark-500'
      "
      role="button"
      tabindex="0"
      @click="fileInput?.click()"
      @keydown.enter.prevent="fileInput?.click()"
      @keydown.space.prevent="fileInput?.click()"
      @dragenter.prevent="dragActive = true"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="onDrop"
    >
      <Icon name="plus" size="md" class="text-gray-400 dark:text-dark-400" />
      <p class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ t('imagegen.refDropTitle') }}</p>
      <p class="text-[11px] leading-relaxed text-gray-500 dark:text-dark-400">
        {{ t('imagegen.refDropHint', { max: MAX_REFERENCE_COUNT }) }}
      </p>
      <input
        ref="fileInput"
        type="file"
        :accept="ACCEPTED_IMAGE_TYPES.join(',')"
        multiple
        class="hidden"
        @change="onPick"
      />
    </div>

    <!-- Thumbnails -->
    <div v-if="references.length" class="flex flex-wrap gap-2">
      <div
        v-for="(item, index) in references"
        :key="item.id"
        class="group relative overflow-hidden rounded-lg border border-gray-200 dark:border-dark-700"
      >
        <img :src="item.preview" :alt="item.file.name" class="h-20 w-20 object-cover" />
        <span
          class="absolute left-0 top-0 rounded-br bg-gray-900/70 px-1 text-[10px] font-medium text-white"
        >{{ index + 1 }}</span>
        <div class="absolute inset-x-0 bottom-0 flex bg-gray-900/70 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            class="flex-1 py-0.5 text-[10px] text-white disabled:opacity-40"
            :disabled="index === 0"
            :title="t('imagegen.refMoveLeft')"
            @click.prevent="emit('move', index, index - 1)"
          >←</button>
          <button
            type="button"
            class="flex-1 border-l border-white/20 py-0.5 text-[10px] text-white disabled:opacity-40"
            :disabled="index === references.length - 1"
            :title="t('imagegen.refMoveRight')"
            @click.prevent="emit('move', index, index + 1)"
          >→</button>
          <button
            type="button"
            class="flex-1 border-l border-white/20 py-0.5 text-[10px] text-red-300"
            :title="t('imagegen.refRemove')"
            @click.prevent="emit('remove', item.id)"
          >×</button>
        </div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-gray-500 dark:text-dark-400">
        {{ t('imagegen.refCount', { count: references.length }) }}
      </span>
      <div class="flex items-center gap-1.5">
        <button
          v-if="references.length"
          type="button"
          class="btn btn-secondary btn-sm"
          @click="emit('clear')"
        >
          {{ t('imagegen.refClear') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { ACCEPTED_IMAGE_TYPES, MAX_REFERENCE_COUNT } from './api'
import type { ReferenceImage } from './types'

defineProps<{
  references: ReferenceImage[]
}>()

const emit = defineEmits<{
  (e: 'add', files: File[]): void
  (e: 'remove', id: string): void
  (e: 'move', from: number, to: number): void
  (e: 'clear'): void
}>()

const { t } = useI18n()
const fileInput = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  emit('add', Array.from(input.files ?? []))
  // Reset so picking the same file twice still fires a change event.
  input.value = ''
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  emit('add', Array.from(event.dataTransfer?.files ?? []))
}

/** Paste-to-upload, matching the source page's shadow-root paste listener. */
function onPaste(event: ClipboardEvent): void {
  const items = Array.from(event.clipboardData?.items ?? [])
  const files = items
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
  if (files.length) emit('add', files)
}

onMounted(() => window.addEventListener('paste', onPaste))
onBeforeUnmount(() => window.removeEventListener('paste', onPaste))
</script>
