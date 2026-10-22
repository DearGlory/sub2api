<template>
  <AppLayout>
    <div class="space-y-5">
      <!-- Intro -->
      <div class="card px-5 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('imagegen.subtitle') }}</h2>
            <p class="mt-1 max-w-3xl text-xs leading-relaxed text-gray-500 dark:text-dark-400">
              {{ t('imagegen.intro') }}
            </p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="openTemplateDrawer()">
            <Icon name="sparkles" size="sm" />
            {{ t('imagegen.templatesOpen') }}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
        <!-- ==================== Left: form ==================== -->
        <div class="space-y-4">
          <!-- Token -->
          <section class="card">
            <div class="card-body space-y-2.5">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.keyLabel') }}</h3>
              <div class="flex gap-2">
                <input
                  v-model="apiKey"
                  type="password"
                  class="input flex-1"
                  :placeholder="t('imagegen.keyPlaceholder')"
                  :aria-label="t('imagegen.keyLabel')"
                  autocomplete="off"
                  @blur="persistKey()"
                />
                <button
                  type="button"
                  class="btn btn-secondary btn-sm shrink-0"
                  :disabled="checkingKey"
                  @click="checkApiKey()"
                >
                  {{ checkingKey ? t('imagegen.keyChecking') : t('imagegen.keyCheck') }}
                </button>
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <span
                  v-if="keyStatus !== 'unknown'"
                  class="badge shrink-0"
                  :class="keyStatus === 'verified' ? 'badge-success' : 'badge-danger'"
                >
                  {{ keyStatus === 'verified' ? t('imagegen.keyValid') : t('imagegen.keyInvalid') }}
                </span>
                <p class="text-[11px] leading-relaxed text-gray-500 dark:text-dark-400">{{ t('imagegen.keyHint') }}</p>
              </div>
            </div>
          </section>

          <!-- Prompt + retouch + references -->
          <section class="card">
            <div class="card-body space-y-3">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.promptCardTitle') }}</h3>
              <label class="block">
                <span class="input-label">{{ t('imagegen.promptLabel') }}</span>
                <textarea
                  v-model="prompt"
                  rows="5"
                  class="input resize-y"
                  :placeholder="t('imagegen.promptPlaceholder')"
                />
              </label>

              <!-- Retouch workbench -->
              <div class="rounded-lg border border-gray-200 dark:border-dark-700">
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                  @click="retouchOpen = !retouchOpen"
                >
                  <span class="flex items-center gap-2 text-xs font-medium text-gray-900 dark:text-white">
                    <Icon name="edit" size="sm" class="text-gray-400" />
                    {{ t('imagegen.retouchTitle') }}
                  </span>
                  <span class="flex items-center gap-2">
                    <span class="badge" :class="retouchEnabled ? 'badge-primary' : 'badge-gray'">
                      {{ retouchEnabled ? t('imagegen.retouchOn') : t('imagegen.retouchOff') }}
                      <template v-if="retouchCount">&nbsp;{{ retouchCount }}</template>
                    </span>
                    <Icon :name="retouchOpen ? 'chevronUp' : 'chevronDown'" size="sm" class="text-gray-400" />
                  </span>
                </button>
                <div v-if="retouchOpen" class="border-t border-gray-100 px-3 py-3 dark:border-dark-800">
                  <RetouchWorkbench
                    :model-value="retouchParams"
                    :active-category="activeRetouchCategory"
                    :active-group="activeRetouchGroup"
                    :selected-preset="selectedRetouchId"
                    :selections="retouchSelections"
                    @update:intensity="retouchIntensity = $event"
                    @update:subject="retouchSubject = $event"
                    @update:active-category="activeRetouchCategory = $event"
                    @update:active-group="activeRetouchGroup = $event"
                    @update:selected-preset="selectedRetouchId = $event"
                    @toggle="onToggleRetouch"
                  />
                  <div class="mt-2.5 flex items-center justify-between gap-2">
                    <p class="text-[11px] text-gray-500 dark:text-dark-400">{{ t('imagegen.retouchHint') }}</p>
                    <button v-if="retouchEnabled" type="button" class="btn btn-secondary btn-sm shrink-0" @click="clearRetouch()">
                      {{ t('imagegen.retouchClear') }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- References -->
              <ReferencePicker
                :references="references"
                @add="addReferences"
                @remove="removeReference"
                @move="onMoveReference"
                @clear="clearReferences()"
              />

              <!-- Mask -->
              <div class="space-y-1.5">
                <div class="flex flex-wrap items-center gap-2">
                  <button type="button" class="btn btn-secondary btn-sm" @click="maskInput?.click()">
                    {{ t('imagegen.maskUpload') }}
                  </button>
                  <button v-if="maskFile" type="button" class="btn btn-danger btn-sm" @click="clearMask()">
                    {{ t('imagegen.maskRemove') }}
                  </button>
                  <img
                    v-if="maskPreview"
                    :src="maskPreview"
                    alt="mask"
                    class="h-9 w-9 rounded border border-gray-200 object-cover dark:border-dark-700"
                  />
                </div>
                <input
                  ref="maskInput"
                  type="file"
                  :accept="ACCEPTED_IMAGE_TYPES.join(',')"
                  class="hidden"
                  @change="onMaskPick"
                />
                <p class="text-[11px] leading-relaxed text-gray-500 dark:text-dark-400">{{ t('imagegen.maskHint') }}</p>
              </div>
            </div>
          </section>

          <!-- Parameters -->
          <section class="card">
            <div class="card-body space-y-3">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.paramsCardTitle') }}</h3>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="block">
                  <span class="input-label">{{ t('imagegen.modelLabel') }}</span>
                  <input v-model="model" class="input" />
                  <span class="input-hint">{{ t('imagegen.modelHint') }}</span>
                </label>

                <label class="block">
                  <span class="input-label">{{ t('imagegen.sizeLabel') }}</span>
                  <select v-model="size" class="input">
                    <optgroup v-for="group in SIZE_GROUPS" :key="group.label" :label="group.label">
                      <option v-for="option in group.options" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </optgroup>
                    <option value="custom">{{ t('imagegen.sizeCustom') }}</option>
                  </select>
                </label>
              </div>

              <div v-if="isCustomSize" class="grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="input-label">{{ t('imagegen.customWidth') }}</span>
                  <input v-model.number="customWidth" type="number" step="16" class="input" />
                </label>
                <label class="block">
                  <span class="input-label">{{ t('imagegen.customHeight') }}</span>
                  <input v-model.number="customHeight" type="number" step="16" class="input" />
                </label>
              </div>

              <div class="grid grid-cols-3 gap-3">
                <label class="block">
                  <span class="input-label">{{ t('imagegen.qualityLabel') }}</span>
                  <select v-model="quality" class="input">
                    <option value="auto">auto</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
                <label class="block">
                  <span class="input-label">{{ t('imagegen.countLabel') }}</span>
                  <select v-model.number="count" class="input">
                    <option v-for="n in 10" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <label class="block">
                  <span class="input-label">{{ t('imagegen.formatLabel') }}</span>
                  <select v-model="format" class="input">
                    <option value="png">png</option>
                    <option value="jpeg">jpeg</option>
                    <option value="webp">webp</option>
                  </select>
                </label>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="input-label">{{ t('imagegen.backgroundLabel') }}</span>
                  <select v-model="background" class="input">
                    <option value="auto">auto</option>
                    <option value="opaque">opaque</option>
                  </select>
                </label>
                <label class="block">
                  <span class="input-label">{{ t('imagegen.moderationLabel') }}</span>
                  <select v-model="moderation" class="input">
                    <option value="auto">auto</option>
                    <option value="low">low</option>
                  </select>
                </label>
              </div>

              <label class="block">
                <span class="input-label">{{ t('imagegen.compressionLabel') }}</span>
                <input v-model.number="compression" type="number" min="0" max="100" class="input" />
              </label>

              <label class="block">
                <span class="input-label">{{ t('imagegen.styleLabel') }}</span>
                <select v-model="style" class="input">
                  <option v-for="option in STYLE_OPTIONS" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <div class="flex flex-wrap gap-2 pt-1">
                <button type="button" class="btn btn-primary btn-md" :disabled="generating" @click="submit()">
                  <Icon name="sparkles" size="sm" />
                  {{ generating ? t('imagegen.generating') : t('imagegen.generate') }}
                </button>
                <button type="button" class="btn btn-secondary btn-md" @click="enqueue()">
                  {{ t('imagegen.enqueue') }}
                </button>
                <button type="button" class="btn btn-secondary btn-md" @click="saveCurrentTemplate()">
                  {{ t('imagegen.saveTemplate') }}
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-md"
                  :disabled="queueRunning || !queue.length"
                  @click="runQueue()"
                >
                  {{ t('imagegen.runQueue') }}
                </button>
              </div>

              <p v-if="progressText" class="text-xs text-gray-500 dark:text-dark-400">{{ progressText }}</p>
            </div>
          </section>
        </div>

        <!-- ==================== Right: output ==================== -->
        <div class="space-y-4">
          <section class="card">
            <div class="card-header flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.resultsTitle') }}</h3>
                <p class="text-[11px] text-gray-500 dark:text-dark-400">
                  {{ results.length ? t('imagegen.resultsCount', { count: results.length }) : t('imagegen.resultsWaiting') }}
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button v-if="results.length" type="button" class="btn btn-secondary btn-sm" @click="downloadAll()">
                  {{ t('imagegen.downloadAll') }}
                </button>
                <label class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-dark-400">
                  {{ t('imagegen.previewSizeLabel') }}
                  <input v-model.number="previewSize" type="range" min="60" max="100" class="w-16" />
                </label>
                <span class="badge badge-gray">{{ statusText }}</span>
              </div>
            </div>

            <div class="card-body">
              <div
                v-if="!results.length"
                class="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-200 py-16 text-center dark:border-dark-700"
              >
                <Icon name="sparkles" size="xl" class="text-gray-300 dark:text-dark-600" />
                <p class="text-sm text-gray-500 dark:text-dark-400">{{ t('imagegen.resultsEmpty') }}</p>
                <p class="text-[11px] text-gray-400 dark:text-dark-500">{{ t('imagegen.resultsEmptyHint') }}</p>
              </div>

              <div
                v-else
                class="grid gap-3"
                :class="results.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'"
              >
                <div
                  v-for="image in results"
                  :key="image.index"
                  class="overflow-hidden rounded-lg border border-gray-200 dark:border-dark-700"
                  :style="{ maxWidth: `${previewSize}%` }"
                >
                  <img :src="image.src" :alt="`result ${image.index + 1}`" class="w-full bg-gray-50 dark:bg-dark-950" />
                  <div class="flex items-center gap-1 border-t border-gray-100 px-2 py-1.5 dark:border-dark-800">
                    <button type="button" class="btn btn-ghost btn-sm flex-1" @click="downloadResult(image)">
                      {{ t('imagegen.download') }}
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm flex-1" @click="copyResult(image)">
                      {{ t('imagegen.copyImage') }}
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm flex-1" @click="reuseAsReference(image)">
                      {{ t('imagegen.reuseAsReference') }}
                    </button>
                  </div>
                </div>
              </div>

              <p
                v-if="errorText"
                class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400"
              >
                {{ errorText }}
              </p>
            </div>
          </section>

          <!-- Queue -->
          <section class="card">
            <div class="card-header flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.queueTitle') }}</h3>
                <span class="badge badge-gray">{{ queueStats.total }}</span>
              </div>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="queueRunning || !queue.length"
                @click="clearQueue()"
              >
                {{ t('imagegen.queueClear') }}
              </button>
            </div>
            <div class="card-body space-y-2.5">
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-dark-400">
                <span>{{ t('imagegen.queuePending') }} {{ queueStats.pending }}</span>
                <span>{{ t('imagegen.queueRunning') }} {{ queueStats.running }}</span>
                <span>{{ t('imagegen.queueSuccess') }} {{ queueStats.success }}</span>
                <span>{{ t('imagegen.queueFailed') }} {{ queueStats.failed }}</span>
                <label class="flex items-center gap-1.5">
                  {{ t('imagegen.queueConcurrency') }}
                  <select v-model.number="queueConcurrency" class="input w-16 py-1 text-xs">
                    <option :value="1">1</option>
                    <option :value="2">2</option>
                  </select>
                </label>
              </div>

              <p v-if="!queue.length" class="py-4 text-center text-xs text-gray-500 dark:text-dark-400">
                {{ t('imagegen.queueEmpty') }}
              </p>

              <div v-else class="space-y-1.5">
                <div
                  v-for="(task, index) in queue"
                  :key="task.id"
                  class="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2 dark:border-dark-700"
                >
                  <div class="flex flex-col gap-0.5">
                    <button
                      type="button"
                      class="text-[9px] leading-none text-gray-400 disabled:opacity-30"
                      :disabled="index === 0 || queueRunning"
                      :title="t('imagegen.queueDragHandle')"
                      @click="moveQueueItem(index, index - 1)"
                    >▲</button>
                    <button
                      type="button"
                      class="text-[9px] leading-none text-gray-400 disabled:opacity-30"
                      :disabled="index === queue.length - 1 || queueRunning"
                      :title="t('imagegen.queueDragHandle')"
                      @click="moveQueueItem(index, index + 1)"
                    >▼</button>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs text-gray-900 dark:text-white">{{ task.rawPrompt }}</p>
                    <p class="truncate text-[10px] text-gray-500 dark:text-dark-400">
                      {{ task.payload.model }} · {{ task.size }} · {{ task.options.count }} · {{ task.format }}
                    </p>
                  </div>
                  <span
                    class="badge shrink-0"
                    :class="{
                      'badge-gray': task.state === 'pending',
                      'badge-warning': task.state === 'running',
                      'badge-success': task.state === 'success',
                      'badge-danger': task.state === 'failed',
                    }"
                  >{{ queueStateLabel(task.state) }}</span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon shrink-0 text-red-600 disabled:opacity-30 dark:text-red-400"
                    :disabled="task.state === 'running'"
                    :title="t('imagegen.queueDelete')"
                    @click="deleteQueueItem(task.id)"
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- History -->
          <section class="card">
            <div class="card-header flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.historyTitle') }}</h3>
              <div class="flex flex-wrap items-center gap-1.5">
                <button type="button" class="btn btn-secondary btn-sm" @click="favoriteOnly = !favoriteOnly">
                  {{ favoriteOnly ? t('imagegen.historyShowAll') : t('imagegen.historyFavoritesOnly') }}
                </button>
                <button type="button" class="btn btn-secondary btn-sm" @click="loadHistory()">
                  <Icon name="refresh" size="sm" />
                </button>
                <button type="button" class="btn btn-secondary btn-sm" :disabled="!history.length" @click="clearHistory">
                  {{ t('imagegen.historyClear') }}
                </button>
              </div>
            </div>
            <div class="card-body">
              <p v-if="!visibleHistory.length" class="py-6 text-center text-xs text-gray-500 dark:text-dark-400">
                {{ favoriteOnly ? t('imagegen.historyNoFavorites') : t('imagegen.historyEmpty') }}
              </p>

              <div v-else class="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                <div
                  v-for="item in visibleHistory"
                  :key="item.id"
                  class="rounded-lg border border-gray-200 px-2.5 py-2 transition-colors hover:border-gray-300 dark:border-dark-700 dark:hover:border-dark-600"
                >
                  <div class="flex items-start gap-2">
                    <button
                      type="button"
                      class="btn btn-ghost btn-icon shrink-0"
                      :class="item.favorite ? 'text-amber-500' : 'text-gray-300 dark:text-dark-600'"
                      :title="item.favorite ? t('imagegen.historyUnfavorite') : t('imagegen.historyFavorite')"
                      @click="toggleFavorite(item.id)"
                    >
                      <Icon name="sparkles" size="sm" />
                    </button>

                    <button type="button" class="min-w-0 flex-1 text-left" @click="applyHistoryItem(item)">
                      <p class="truncate text-xs text-gray-900 dark:text-white">{{ item.prompt }}</p>
                      <p class="truncate text-[10px] text-gray-500 dark:text-dark-400">
                        {{ item.model || t('imagegen.historyNoModel') }} · {{ item.size }}
                        <template v-if="item.imageCount">
                          · {{ t('imagegen.historyImageCount', { count: item.imageCount }) }}
                        </template>
                        · {{ item.time }}
                      </p>
                    </button>

                    <button
                      type="button"
                      class="btn btn-ghost btn-icon shrink-0"
                      :title="t('imagegen.historyRerun')"
                      @click="rerunHistory(item.prompt, item.model)"
                    >
                      <Icon name="refresh" size="sm" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-icon shrink-0 text-red-600 dark:text-red-400"
                      :title="t('imagegen.historyDelete')"
                      @click="deleteHistoryItem(item.id)"
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <TemplateDrawer
      :open="templateDrawerOpen"
      :custom-templates="customTemplates"
      :rewrite-model="rewriteModel"
      :rewriting="rewriting"
      :edit-status="rewriteStatus"
      :rewritten-prompt="rewrittenPrompt"
      @close="templateDrawerOpen = false"
      @apply="onApplyTemplate"
      @delete-custom="onDeleteCustomTemplate"
      @rewrite="onRewrite"
      @update:rewrite-model="rewriteModel = $event"
    />
  </AppLayout>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import Icon from '@/components/icons/Icon.vue'
import { useAppStore } from '@/stores/app'
import ReferencePicker from '@/features/imagegen/ReferencePicker.vue'
import RetouchWorkbench from '@/features/imagegen/RetouchWorkbench.vue'
import TemplateDrawer from '@/features/imagegen/TemplateDrawer.vue'
import { clearHistoryImages, writeRawHistory } from '@/features/imagegen/storage'
import { ACCEPTED_IMAGE_TYPES, copyImage, dataUrlToFile } from '@/features/imagegen/api'
import { SIZE_GROUPS, STYLE_OPTIONS, useImageGen } from '@/features/imagegen/useImageGen'
import type { GeneratedImage, ImageTemplate, QueueState, RetouchPreset } from '@/features/imagegen/types'

const { t } = useI18n()
const appStore = useAppStore()

function notify(message: string, kind: 'success' | 'error' | 'info' = 'info'): void {
  appStore.showToast(kind, message, kind === 'error' ? 5000 : 3000)
}

// Destructured so the template reads as plain state; the composable returns refs.
const {
  apiKey,
  prompt,
  model,
  size,
  customWidth,
  customHeight,
  quality,
  count,
  format,
  background,
  moderation,
  compression,
  style,
  rewriteModel,
  isCustomSize,
  persistKey,
  retouchSelections,
  retouchIntensity,
  retouchSubject,
  activeRetouchCategory,
  activeRetouchGroup,
  selectedRetouchId,
  retouchParams,
  retouchCount,
  retouchEnabled,
  toggleRetouch,
  clearRetouch,
  references,
  maskFile,
  maskPreview,
  addReferences,
  removeReference,
  moveReference,
  clearReferences,
  setMask,
  clearMask,
  results,
  previewSize,
  statusText,
  progressText,
  errorText,
  generating,
  downloadResult,
  downloadAll,
  history,
  visibleHistory,
  favoriteOnly,
  loadHistory,
  applyHistoryItem,
  toggleFavorite,
  deleteHistoryItem,
  keyStatus,
  checkingKey,
  checkApiKey,
  queue,
  queueRunning,
  queueConcurrency,
  queueStats,
  enqueue,
  deleteQueueItem,
  moveQueueItem,
  clearQueue,
  runQueue,
  submit,
  // templates
  templateDrawerOpen,
  customTemplates,
  rewriting,
  rewriteStatus,
  rewrittenPrompt,
  openTemplateDrawer,
  saveCurrentTemplate,
  deleteCustomTemplate,
  applyTemplate,
  rewriteTemplatePrompt,
  loadCustomTemplates,
} = useImageGen(notify)

const retouchOpen = ref(false)
const maskInput = ref<HTMLInputElement | null>(null)
/** Prompt of the template currently open in the drawer's preview stage. */
let activeTemplatePrompt = ''

onMounted(async () => {
  loadCustomTemplates()
  await loadHistory()
})

function onToggleRetouch(preset: RetouchPreset): void {
  toggleRetouch(preset.category, preset.group, preset.id)
}

function onMoveReference(from: number, to: number): void {
  moveReference(from, to)
}

function onMaskPick(event: Event): void {
  const input = event.target as HTMLInputElement
  setMask(input.files?.[0] ?? null)
  input.value = ''
}

function queueStateLabel(state: QueueState): string {
  const map: Record<QueueState, string> = {
    pending: t('imagegen.queuePending'),
    running: t('imagegen.queueRunning'),
    success: t('imagegen.queueSuccess'),
    failed: t('imagegen.queueFailed'),
  }
  return map[state]
}

async function copyResult(image: GeneratedImage): Promise<void> {
  try {
    const mode = await copyImage(image.src)
    notify(mode === 'image' ? t('imagegen.copyImageOk') : t('imagegen.copyLinkOk'), 'success')
  } catch {
    notify(t('imagegen.copyFailed'), 'error')
  }
}

async function reuseAsReference(image: GeneratedImage): Promise<void> {
  try {
    const file = await dataUrlToFile(image.src, `result-${Date.now()}-${image.index + 1}.${image.format}`)
    addReferences([file])
  } catch {
    notify(t('imagegen.copyFailed'), 'error')
  }
}

function rerunHistory(text: string, itemModel: string): void {
  prompt.value = text
  if (itemModel) model.value = itemModel
  void submit()
}

function onApplyTemplate(template: ImageTemplate, templatePrompt?: string): void {
  activeTemplatePrompt = templatePrompt ?? template.prompt
  applyTemplate(template, templatePrompt)
}

function onDeleteCustomTemplate(id: string): void {
  deleteCustomTemplate(id)
}

function onRewrite(instruction: string): void {
  void rewriteTemplatePrompt(activeTemplatePrompt, instruction)
}

async function clearHistory(): Promise<void> {
  history.value = []
  favoriteOnly.value = false
  await clearHistoryImages()
  writeRawHistory([])
}
</script>
