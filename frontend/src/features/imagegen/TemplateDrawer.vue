<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="fixed inset-0 z-[60] bg-gray-900/40 backdrop-blur-sm" @click="close" />
    </Transition>

    <Transition name="slide-right">
      <aside
        v-if="open"
        class="fixed inset-y-0 right-0 z-[61] flex w-full max-w-2xl flex-col border-l border-gray-200 bg-white shadow-xl dark:border-dark-800 dark:bg-dark-900"
        role="dialog"
        aria-modal="true"
      >
        <!-- Header -->
        <div class="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-dark-800">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('imagegen.templatesTitle') }}</h2>
          <button type="button" class="btn btn-secondary btn-sm" @click="close">
            {{ t('imagegen.templatesClose') }}
          </button>
        </div>

        <!-- Search -->
        <div class="border-b border-gray-100 px-4 py-2.5 dark:border-dark-800">
          <div class="relative">
            <Icon
              name="search"
              size="sm"
              class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              v-model="query"
              type="search"
              class="input pl-9"
              :placeholder="t('imagegen.templatesSearch')"
            />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto px-4 py-3">
          <div v-if="catalog.loading.value && !catalog.templates.value.length" class="py-10 text-center">
            <LoadingSpinner />
            <p class="mt-2 text-xs text-gray-500 dark:text-dark-400">{{ t('imagegen.templatesLoading') }}</p>
          </div>

          <template v-else>
            <!-- Custom templates -->
            <section v-if="filteredCustom.length" class="mb-5">
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-400">
                {{ t('imagegen.templatesCustom') }}
              </h3>
              <div class="space-y-1.5">
                <div
                  v-for="template in filteredCustom"
                  :key="template.id"
                  class="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-dark-700"
                >
                  <button
                    type="button"
                    class="min-w-0 flex-1 text-left"
                    @click="applyTemplate(template)"
                  >
                    <p class="truncate text-xs font-medium text-gray-900 dark:text-white">{{ template.name }}</p>
                    <p class="truncate text-[11px] text-gray-500 dark:text-dark-400">{{ template.prompt }}</p>
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon shrink-0 text-red-600 dark:text-red-400"
                    :title="t('imagegen.templatesDeleteCustom')"
                    @click="emit('deleteCustom', template.id)"
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                </div>
              </div>
            </section>

            <!-- Category tabs -->
            <div class="mb-3 flex flex-wrap gap-1.5">
              <button
                v-for="category in catalog.categories.value"
                :key="category.id"
                type="button"
                class="rounded-md border px-2.5 py-1 text-xs transition-colors"
                :class="
                  category.id === catalog.activeCategory.value
                    ? 'border-primary-500 bg-primary-50 text-primary-800 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-dark-700 dark:text-dark-300 dark:hover:border-dark-600'
                "
                @click="catalog.setCategory(category.id)"
              >
                {{ categoryLabel(category.id) }}
                <span class="ml-0.5 opacity-60">{{ category.count }}</span>
              </button>
            </div>

            <!-- Built-in grid -->
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-400">
              {{ t('imagegen.templatesBuiltin') }}
              <span class="ml-1 font-normal normal-case text-gray-400 dark:text-dark-500">{{ catalog.status.value }}</span>
            </h3>

            <div v-if="!filteredBuiltin.length" class="py-8 text-center text-xs text-gray-500 dark:text-dark-400">
              {{ t('imagegen.templatesEmpty') }}
            </div>

            <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <button
                v-for="template in filteredBuiltin"
                :key="template.id"
                type="button"
                class="group overflow-hidden rounded-lg border border-gray-200 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-dark-700 dark:hover:border-dark-600 dark:hover:bg-dark-800"
                @click="openPreview(template)"
              >
                <div class="relative aspect-[4/3] w-full overflow-hidden bg-gray-100 dark:bg-dark-800">
                  <img
                    v-if="template.preview"
                    :src="template.preview"
                    :alt="template.name"
                    loading="lazy"
                    class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                  />
                  <div v-else class="flex h-full items-center justify-center text-gray-300 dark:text-dark-600">
                    <Icon name="sparkles" size="lg" />
                  </div>
                </div>
                <div class="px-2 py-1.5">
                  <p class="truncate text-[11px] font-medium text-gray-900 dark:text-white">{{ template.name }}</p>
                  <p class="truncate text-[10px] text-gray-500 dark:text-dark-400">{{ template.category }}</p>
                </div>
              </button>
            </div>
          </template>
        </div>
      </aside>
    </Transition>

    <!-- Preview stage -->
    <Transition name="fade">
      <div
        v-if="previewTemplate"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-gray-900/60 p-4 backdrop-blur-sm"
        @click.self="closePreview"
      >
        <div
          class="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-dark-800 dark:bg-dark-900"
        >
          <div class="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-dark-800">
            <div class="flex min-w-0 items-center gap-2">
              <strong class="truncate text-sm text-gray-900 dark:text-white">{{ previewTemplate.name }}</strong>
              <span
                v-if="aiEdited"
                class="badge badge-primary shrink-0"
              >{{ t('imagegen.templatesAiEdited') }}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="closePreview">
              {{ t('imagegen.templatesClose') }}
            </button>
          </div>

          <div class="flex-1 overflow-y-auto">
            <img
              v-if="previewTemplate.preview"
              :src="previewTemplate.preview"
              :alt="previewTemplate.name"
              class="max-h-[45vh] w-full bg-gray-100 object-contain dark:bg-dark-950"
            />
            <div class="space-y-3 p-4">
              <label class="block">
                <span class="input-label">{{ t('imagegen.templatesOriginalPrompt') }}</span>
                <textarea
                  v-model="draftPrompt"
                  rows="6"
                  class="input font-mono text-xs"
                  readonly
                />
              </label>

              <label class="block">
                <span class="input-label">{{ t('imagegen.templatesEditInstruction') }}</span>
                <textarea
                  v-model="instruction"
                  rows="2"
                  class="input text-xs"
                  :placeholder="t('imagegen.templatesEditPlaceholder')"
                />
              </label>

              <div class="flex flex-wrap items-center gap-2">
                <label class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-dark-400">
                  {{ t('imagegen.templatesRewriteModel') }}
                  <input v-model="rewriteModelProxy" class="input w-36 py-1 text-xs" />
                </label>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :disabled="rewriting"
                  @click="emit('rewrite', instruction)"
                >
                  {{ rewriting ? t('imagegen.templatesRewriting') : t('imagegen.templatesRewrite') }}
                </button>
                <button type="button" class="btn btn-primary btn-sm" @click="applyPreviewTemplate">
                  {{ t('imagegen.templatesApplyPrompt') }}
                </button>
              </div>

              <p v-if="editStatus" class="text-xs text-gray-500 dark:text-dark-400">{{ editStatus }}</p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import type { ImageTemplate } from './types'
import { useTemplateCatalog } from './templateCatalog'

const props = defineProps<{
  open: boolean
  customTemplates: ImageTemplate[]
  rewriteModel: string
  rewriting: boolean
  editStatus: string
  /** Prompt handed back by the parent after an AI rewrite. */
  rewrittenPrompt: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', template: ImageTemplate, prompt?: string): void
  (e: 'deleteCustom', id: string): void
  (e: 'rewrite', instruction: string): void
  (e: 'update:rewriteModel', value: string): void
}>()

const { t } = useI18n()
const catalog = useTemplateCatalog()
const query = ref('')
const previewTemplate = ref<ImageTemplate | null>(null)
const draftPrompt = ref('')
const instruction = ref('')
const aiEdited = ref(false)

const rewriteModelProxy = computed({
  get: () => props.rewriteModel,
  set: (value: string) => emit('update:rewriteModel', value),
})

const filteredCustom = computed(() => filterByQuery(props.customTemplates))
const filteredBuiltin = computed(() => filterByQuery(catalog.filtered.value))

function filterByQuery(list: ImageTemplate[]): ImageTemplate[] {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return list
  return list.filter(
    (template) =>
      template.name.toLowerCase().includes(needle) ||
      template.prompt.toLowerCase().includes(needle) ||
      template.category.toLowerCase().includes(needle),
  )
}

function categoryLabel(id: string): string {
  return id === '全部' ? t('imagegen.templatesAll') : id
}

function close(): void {
  emit('close')
}

function openPreview(template: ImageTemplate): void {
  previewTemplate.value = template
  draftPrompt.value = template.prompt
  instruction.value = ''
  aiEdited.value = false
}

function closePreview(): void {
  previewTemplate.value = null
}

function applyTemplate(template: ImageTemplate): void {
  emit('apply', template)
  close()
}

function applyPreviewTemplate(): void {
  if (!previewTemplate.value) return
  emit('apply', previewTemplate.value, draftPrompt.value)
  closePreview()
  close()
}

watch(
  () => props.rewrittenPrompt,
  (value) => {
    if (!value) return
    draftPrompt.value = value
    aiEdited.value = true
  },
)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void catalog.load()
  },
  { immediate: true },
)
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease-out;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.2s ease-out;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}
</style>
