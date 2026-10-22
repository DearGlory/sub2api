/**
 * State and actions for the image-generation plaza.
 *
 * The NewAPI original was one imperative script holding a shadow-root DOM tree
 * together with `$(id)` lookups and inline `onclick` handlers. This module is
 * that same behaviour expressed as reactive state plus plain async functions,
 * so the Vue view only has to render and call them. Splitting it out keeps the
 * long generation/queue logic testable without mounting a component.
 */
import { computed, ref, watch } from 'vue'
import {
  ACCEPTED_IMAGE_TYPES,
  ImageGenError,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_COUNT,
  assertHeaderSafeKey,
  cleanApiKey,
  downloadUrl,
  gatewayUrl,
  requestImages,
  rewritePrompt,
  verifyApiKey,
} from './api'
import type {
  GeneratedImage,
  HistoryItem,
  ImageGenOptions,
  ImageRequestPayload,
  ImageTemplate,
  QueueState,
  QueueTask,
  ReferenceImage,
  RetouchParams,
} from './types'
import {
  DEFAULT_RETOUCH_CATEGORY,
  DEFAULT_RETOUCH_GROUP,
  DEFAULT_RETOUCH_INTENSITY,
  DEFAULT_RETOUCH_PRESET,
  DEFAULT_RETOUCH_SUBJECT,
  buildPromptPayload,
  normalizeRetouchParams,
  resolveRetouchSelection,
  retouchKey,
} from './retouch'
import {
  HISTORY_LIMIT,
  deleteHistoryImages,
  loadHistoryImages,
  loadPreviewSize,
  newId,
  readRawHistory,
  saveHistoryImages,
  safeGet,
  safeSet,
  savePreviewSize,
  writeRawHistory,
} from './storage'

const API_KEY_STORAGE = 'ig_apiKey'
const GENERATION_TIMEOUT_MS = 20 * 60 * 1000

/** The size presets offered in the dropdown, grouped as in the source page. */
export const SIZE_GROUPS: { label: string; options: { value: string; label: string }[] }[] = [
  {
    label: '1K 常用',
    options: [
      { value: '1024x1024', label: '1024x1024 (1K 1:1)' },
      { value: '1536x1024', label: '1536x1024 (1K 3:2)' },
      { value: '1024x1536', label: '1024x1536 (1K 2:3)' },
      { value: '1600x1200', label: '1600x1200 (1K 4:3)' },
      { value: '1200x1600', label: '1200x1600 (1K 3:4)' },
      { value: '1792x1024', label: '1792x1024 (1K 7:4)' },
      { value: '1024x1792', label: '1024x1792 (1K 4:7)' },
    ],
  },
  {
    label: '2K 常用',
    options: [
      { value: '2048x2048', label: '2048x2048 (2K 1:1)' },
      { value: '2048x1536', label: '2048x1536 (2K 4:3)' },
      { value: '1536x2048', label: '1536x2048 (2K 3:4)' },
      { value: '2016x1344', label: '2016x1344 (2K 3:2)' },
      { value: '1344x2016', label: '1344x2016 (2K 2:3)' },
      { value: '2048x1152', label: '2048x1152 (2K 16:9)' },
      { value: '1152x2048', label: '1152x2048 (2K 9:16)' },
    ],
  },
  {
    label: '4K 常用',
    options: [
      { value: '2880x2880', label: '2880x2880 (4K 1:1)' },
      { value: '3456x2304', label: '3456x2304 (4K 3:2)' },
      { value: '2304x3456', label: '2304x3456 (4K 2:3)' },
      { value: '3264x2448', label: '3264x2448 (4K 4:3)' },
      { value: '2448x3264', label: '2448x3264 (4K 3:4)' },
      { value: '3840x2160', label: '3840x2160 (4K 16:9)' },
      { value: '2160x3840', label: '2160x3840 (4K 9:16)' },
      { value: '3840x1920', label: '3840x1920 (4K 2:1)' },
      { value: '1920x3840', label: '1920x3840 (4K 1:2)' },
      { value: '3840x1280', label: '3840x1280 (4K 3:1)' },
      { value: '1280x3840', label: '1280x3840 (4K 1:3)' },
    ],
  },
]

export const STYLE_OPTIONS = [
  { value: '', label: '无' },
  { value: 'photorealistic, 8k, detailed', label: '写实' },
  { value: 'anime style, vibrant colors', label: '动漫' },
  { value: 'oil painting, artistic', label: '油画' },
  { value: 'watercolor, soft tones', label: '水彩' },
  { value: 'pixel art, retro', label: '像素' },
  { value: '3d render, cinema 4d', label: '3D 渲染' },
]

/**
 * Model used for template prompt rewriting. The source page hard-coded
 * `gpt-5.5`, which Sub2API no longer routes on ChatGPT-backed accounts; the
 * field stays editable so an operator can switch models without a rebuild.
 */
const DEFAULT_REWRITE_MODEL = 'gpt-6-astra'

export type ToastKind = 'success' | 'error' | 'info'

export function useImageGen(toast: (message: string, kind?: ToastKind) => void) {
  // ==================== Form state ====================

  const apiKey = ref(safeGet(API_KEY_STORAGE) ?? '')
  const prompt = ref('')
  const model = ref('gpt-image-2')
  const size = ref('1024x1024')
  const customWidth = ref(1024)
  const customHeight = ref(1024)
  const quality = ref('auto')
  const count = ref(1)
  const format = ref('png')
  const background = ref('auto')
  const moderation = ref('auto')
  const compression = ref(80)
  const style = ref('')
  const rewriteModel = ref(DEFAULT_REWRITE_MODEL)

  const isCustomSize = computed(() => size.value === 'custom')

  // ==================== Retouch workbench ====================

  const retouchSelections = ref<{ category: string; group: string; preset: string }[]>([])
  const retouchIntensity = ref(DEFAULT_RETOUCH_INTENSITY)
  const retouchSubject = ref(DEFAULT_RETOUCH_SUBJECT)
  const activeRetouchCategory = ref(DEFAULT_RETOUCH_CATEGORY)
  const activeRetouchGroup = ref(DEFAULT_RETOUCH_GROUP)
  const selectedRetouchId = ref(DEFAULT_RETOUCH_PRESET)

  const retouchParams = computed<RetouchParams>(() =>
    normalizeRetouchParams({
      selections: retouchSelections.value,
      intensity: retouchIntensity.value,
      subject: retouchSubject.value,
    }),
  )
  const retouchCount = computed(() => retouchParams.value.selections.length)
  const retouchEnabled = computed(() => retouchCount.value > 0)

  function isRetouchSelected(category: string, group: string, preset: string): boolean {
    const key = retouchKey({ category, group, preset })
    return retouchSelections.value.some((item) => retouchKey(item) === key)
  }

  function toggleRetouch(category: string, group: string, preset: string): void {
    const key = retouchKey({ category, group, preset })
    const index = retouchSelections.value.findIndex((item) => retouchKey(item) === key)
    if (index >= 0) retouchSelections.value.splice(index, 1)
    else retouchSelections.value.push({ category, group, preset })
  }

  function clearRetouch(): void {
    retouchSelections.value = []
  }

  function applyRetouchParams(value: unknown): void {
    const normalized = normalizeRetouchParams(value)
    retouchSelections.value = normalized.selections.map((item) => ({ ...item }))
    const focus = normalized.selections[0] ?? {
      category: normalized.category,
      group: normalized.group,
      preset: normalized.preset,
    }
    activeRetouchCategory.value = focus.category
    activeRetouchGroup.value = focus.group
    selectedRetouchId.value = focus.preset
    retouchIntensity.value = normalized.intensity
    retouchSubject.value = normalized.subject
  }

  // ==================== References & mask ====================

  const references = ref<ReferenceImage[]>([])
  const maskFile = ref<File | null>(null)
  const maskPreview = ref('')
  const dragActive = ref(false)

  function acceptFiles(files: File[]): number {
    let added = 0
    for (const file of files) {
      if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
        toast('只支持 PNG / JPG / WEBP', 'error')
        continue
      }
      if (file.size > MAX_REFERENCE_BYTES) {
        toast('单张图片不能超过 50MB', 'error')
        continue
      }
      if (references.value.length >= MAX_REFERENCE_COUNT) {
        toast(`参考图数量已达上限（${MAX_REFERENCE_COUNT} 张）`, 'error')
        break
      }
      const duplicate = references.value.some(
        (item) =>
          item.file.name === file.name &&
          item.file.size === file.size &&
          item.file.lastModified === file.lastModified,
      )
      if (duplicate) continue
      references.value.push({ id: newId(), file, preview: URL.createObjectURL(file) })
      added += 1
    }
    return added
  }

  function addReferences(files: File[]): void {
    const added = acceptFiles(files)
    if (added) toast(`已添加 ${added} 张参考图`, 'success')
  }

  function removeReference(id: string): void {
    const index = references.value.findIndex((item) => item.id === id)
    if (index < 0) return
    URL.revokeObjectURL(references.value[index].preview)
    references.value.splice(index, 1)
    if (!references.value.length) clearMask()
  }

  function moveReference(from: number, to: number): void {
    if (from === to || from < 0 || to < 0) return
    if (from >= references.value.length || to >= references.value.length) return
    const [item] = references.value.splice(from, 1)
    references.value.splice(to, 0, item)
  }

  function clearReferences(): void {
    for (const item of references.value) URL.revokeObjectURL(item.preview)
    references.value = []
    clearMask()
  }

  function setMask(file: File | null): void {
    if (maskPreview.value) URL.revokeObjectURL(maskPreview.value)
    if (!file) {
      maskFile.value = null
      maskPreview.value = ''
      return
    }
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      toast('Mask 只支持 PNG / JPG / WEBP', 'error')
      return
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      toast('Mask 不能超过 50MB', 'error')
      return
    }
    maskFile.value = file
    maskPreview.value = URL.createObjectURL(file)
  }

  function clearMask(): void {
    if (maskPreview.value) URL.revokeObjectURL(maskPreview.value)
    maskFile.value = null
    maskPreview.value = ''
  }

  // ==================== Output ====================

  const results = ref<GeneratedImage[]>([])
  const previewSize = ref(loadPreviewSize())
  const statusText = ref('就绪')
  const progressText = ref('')
  const errorText = ref('')
  const generating = ref(false)

  watch(previewSize, (value) => savePreviewSize(value))

  function setResults(sources: string[], resultFormat: string): void {
    results.value = sources.map((src, index) => ({ src, format: resultFormat, index }))
    errorText.value = ''
  }

  function downloadResult(image: GeneratedImage): void {
    downloadUrl(image.src, `image-${Date.now()}-${image.index + 1}.${image.format}`)
  }

  function downloadAll(): void {
    results.value.forEach((image, index) => {
      // Stagger so the browser does not collapse simultaneous downloads.
      window.setTimeout(() => downloadUrl(image.src, `image-${Date.now()}-${index + 1}.${image.format}`), index * 180)
    })
  }

  // ==================== History ====================

  const history = ref<HistoryItem[]>([])
  const favoriteOnly = ref(false)
  const historyBusy = ref(false)

  const visibleHistory = computed(() =>
    favoriteOnly.value ? history.value.filter((item) => item.favorite) : history.value,
  )

  function normalizeHistoryItem(raw: Record<string, unknown>): HistoryItem {
    const images = Array.isArray(raw.images) ? (raw.images as string[]) : []
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      size: typeof raw.size === 'string' ? raw.size : '1024x1024',
      format: typeof raw.format === 'string' ? raw.format : 'png',
      quality: typeof raw.quality === 'string' ? raw.quality : 'auto',
      background: typeof raw.background === 'string' ? raw.background : 'auto',
      moderation: typeof raw.moderation === 'string' ? raw.moderation : 'auto',
      compression: Number.isFinite(Number(raw.compression)) ? Number(raw.compression) : 80,
      count: Number.isFinite(Number(raw.count)) ? Number(raw.count) : images.length || 1,
      style: typeof raw.style === 'string' ? raw.style : '',
      retouch: normalizeRetouchParams(raw.retouch ?? {}),
      favorite: Boolean(raw.favorite),
      time: typeof raw.time === 'string' ? raw.time : '',
      imageCount: Number.isFinite(Number(raw.imageCount)) ? Number(raw.imageCount) : images.length,
      images,
    }
  }

  function persistHistory(): void {
    writeRawHistory(
      history.value.map(({ images: _images, ...meta }) => meta),
    )
  }

  async function loadHistory(): Promise<void> {
    history.value = readRawHistory()
      .map((item) => normalizeHistoryItem(item as Record<string, unknown>))
      .slice(0, HISTORY_LIMIT)
    // Legacy rows carried inline images; move them into IndexedDB once.
    const legacy = history.value.filter((item) => item.id && item.images.length)
    for (const item of legacy) {
      await saveHistoryImages(item.id, item.images)
      item.images = []
    }
    if (legacy.length) persistHistory()
  }

  async function pushHistory(entry: Omit<HistoryItem, 'id' | 'favorite' | 'imageCount' | 'images'> & { images: string[] }): Promise<void> {
    const id = newId()
    const item: HistoryItem = {
      ...entry,
      id,
      favorite: false,
      imageCount: entry.images.length,
      images: [],
    }
    await saveHistoryImages(id, entry.images)
    history.value.unshift(item)
    if (history.value.length > HISTORY_LIMIT) {
      const dropped = history.value.splice(HISTORY_LIMIT)
      await Promise.all(dropped.map((row) => deleteHistoryImages(row.id)))
    }
    persistHistory()
  }

  function toggleFavorite(id: string): void {
    const item = history.value.find((row) => row.id === id)
    if (!item) return
    item.favorite = !item.favorite
    persistHistory()
  }

  async function deleteHistoryItem(id: string): Promise<void> {
    const index = history.value.findIndex((row) => row.id === id)
    if (index < 0) return
    history.value.splice(index, 1)
    await deleteHistoryImages(id)
    persistHistory()
  }

  /** Restore the parameters of a history row and show its cached images. */
  async function applyHistoryItem(item: HistoryItem): Promise<void> {
    prompt.value = item.prompt
    applySize(item.size)
    quality.value = item.quality
    format.value = item.format
    background.value = item.background
    moderation.value = item.moderation
    style.value = item.style
    compression.value = item.compression
    count.value = item.count
    applyRetouchParams(item.retouch)
    if (item.model) model.value = item.model

    const images = await loadHistoryImages(item.id)
    setResults(images, item.format)
    if (!images.length && item.imageCount) {
      errorText.value = '已恢复参数，但本地没有图片缓存，请重新生成'
    }
  }

  // ==================== Size helpers ====================

  function applySize(value: string): void {
    const known = SIZE_GROUPS.flatMap((group) => group.options).map((option) => option.value)
    if (value && known.includes(value)) {
      size.value = value
      return
    }
    if (/^\d+x\d+$/.test(value || '')) {
      const [width, height] = value.split('x')
      size.value = 'custom'
      customWidth.value = Number(width)
      customHeight.value = Number(height)
      return
    }
    size.value = '1024x1024'
  }

  /** Resolve the effective `size` string, or null when custom values are bad. */
  function resolvedSize(): string | null {
    if (size.value !== 'custom') return size.value
    const width = Number(customWidth.value)
    const height = Number(customHeight.value)
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      toast('请输入有效的宽高（正整数）', 'error')
      return null
    }
    return `${width}x${height}`
  }

  // ==================== Request assembly ====================

  function buildOptions(): ImageGenOptions {
    return {
      quality: quality.value,
      background: background.value,
      moderation: moderation.value,
      compression: Number(compression.value),
      count: Number(count.value),
      style: style.value,
      retouch: retouchParams.value,
    }
  }

  function buildPayload(effectivePrompt: string, effectiveSize: string): ImageRequestPayload {
    const payload: ImageRequestPayload = {
      model: model.value.trim(),
      prompt: effectivePrompt,
      size: effectiveSize,
      n: Number(count.value),
    }
    if (quality.value !== 'auto') payload.quality = quality.value
    if (format.value && format.value !== 'png') payload.output_format = format.value
    if (background.value === 'opaque') payload.background = background.value
    if (moderation.value !== 'auto') payload.moderation = moderation.value
    if ((format.value === 'jpeg' || format.value === 'webp') && Number.isFinite(Number(compression.value))) {
      payload.output_compression = Number(compression.value)
    }
    return payload
  }

  /** Shared validation for both direct generation and queue capture. */
  function validateInput(rawPrompt: string): { key: string; size: string } | null {
    const key = cleanApiKey(apiKey.value)
    if (key !== apiKey.value) apiKey.value = key
    if (!key) {
      toast('请输入令牌', 'error')
      return null
    }
    try {
      assertHeaderSafeKey(key)
    } catch (error) {
      toast((error as Error).message, 'error')
      return null
    }
    if (!rawPrompt) {
      toast('请输入 Prompt', 'error')
      return null
    }
    if (!model.value.trim()) {
      toast('请填写模型名称', 'error')
      return null
    }
    const effectiveSize = resolvedSize()
    if (!effectiveSize) return null
    if (maskFile.value && !references.value.length) {
      toast('请先上传参考图再上传 Mask；纯文生图请移除 Mask', 'error')
      return null
    }
    return { key, size: effectiveSize }
  }

  // ==================== Single generation ====================

  async function submit(): Promise<void> {
    if (generating.value) return
    const rawPrompt = prompt.value.trim()
    const validated = validateInput(rawPrompt)
    if (!validated) return

    saveApiKey()
    generating.value = true
    statusText.value = '生成中'
    progressText.value = ''
    errorText.value = ''

    const startedAt = Date.now()
    const controller = new AbortController()
    const ticker = window.setInterval(() => {
      progressText.value = `已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒`
    }, 1000)
    const timeout = window.setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)

    const effectivePrompt = buildPromptPayload(rawPrompt, style.value, retouchParams.value)
    const payload = buildPayload(effectivePrompt, validated.size)

    try {
      const images = await requestImages({
        key: validated.key,
        payload,
        references: references.value.map((item) => item.file),
        mask: maskFile.value,
        format: format.value,
        signal: controller.signal,
      })
      setResults(images, format.value)
      await pushHistory({
        prompt: rawPrompt,
        model: payload.model,
        size: validated.size,
        format: format.value,
        quality: quality.value,
        background: background.value,
        moderation: moderation.value,
        compression: Number(compression.value),
        count: Number(count.value),
        style: style.value,
        retouch: retouchParams.value,
        time: new Date().toLocaleString(),
        images,
      })
      toast('生成完成', 'success')
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? '请求超过 20 分钟，已自动停止' : (error as Error).message
      errorText.value = message
      toast(message, 'error')
    } finally {
      window.clearInterval(ticker)
      window.clearTimeout(timeout)
      generating.value = false
      statusText.value = '就绪'
      progressText.value = ''
    }
  }

  function saveApiKey(): void {
    const cleaned = cleanApiKey(apiKey.value)
    if (cleaned !== apiKey.value) apiKey.value = cleaned
    safeSet(API_KEY_STORAGE, cleaned)
  }

  // ==================== Key verification ====================

  const keyStatus = ref<'unknown' | 'verified' | 'invalid'>('unknown')
  const checkingKey = ref(false)

  async function checkApiKey(): Promise<void> {
    const cleaned = cleanApiKey(apiKey.value)
    apiKey.value = cleaned
    safeSet(API_KEY_STORAGE, cleaned)
    if (!cleaned) {
      keyStatus.value = 'invalid'
      toast('请输入令牌', 'error')
      return
    }
    try {
      assertHeaderSafeKey(cleaned)
    } catch (error) {
      keyStatus.value = 'invalid'
      toast((error as Error).message, 'error')
      return
    }

    checkingKey.value = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const ok = await verifyApiKey(cleaned, controller.signal)
      keyStatus.value = ok ? 'verified' : 'invalid'
      toast(ok ? '令牌有效' : '令牌无效或没有生图权限', ok ? 'success' : 'error')
    } catch {
      keyStatus.value = 'invalid'
      toast('令牌无效', 'error')
    } finally {
      window.clearTimeout(timeout)
      checkingKey.value = false
    }
  }

  // ==================== Queue ====================

  const queue = ref<QueueTask[]>([])
  const queueRunning = ref(false)
  const queueConcurrency = ref(1)

  const queueStats = computed(() => {
    const stats: Record<QueueState | 'total', number> = { total: 0, pending: 0, running: 0, success: 0, failed: 0 }
    for (const task of queue.value) {
      stats.total += 1
      stats[task.state] += 1
    }
    return stats
  })

  function captureTask(promptOverride?: string): QueueTask | null {
    const rawPrompt = (promptOverride ?? prompt.value).trim()
    const validated = validateInput(rawPrompt)
    if (!validated) return null
    const effectivePrompt = buildPromptPayload(rawPrompt, style.value, retouchParams.value)
    return {
      id: newId(),
      state: 'pending',
      key: validated.key,
      apiBase: gatewayUrl('/v1'),
      model: model.value.trim(),
      rawPrompt,
      prompt: effectivePrompt,
      size: validated.size,
      format: format.value,
      payload: buildPayload(effectivePrompt, validated.size),
      refs: references.value.map((item) => item.file),
      mask: maskFile.value,
      options: buildOptions(),
    }
  }

  function enqueue(promptOverride?: string): void {
    const task = captureTask(promptOverride)
    if (!task) return
    queue.value.push(task)
    toast('已加入任务队列', 'success')
  }

  function deleteQueueItem(id: string): void {
    const task = queue.value.find((item) => item.id === id)
    if (!task) return
    if (task.state === 'running') {
      toast('运行中的任务暂不能删除', 'error')
      return
    }
    queue.value = queue.value.filter((item) => item.id !== id)
  }

  function moveQueueItem(from: number, to: number): void {
    if (queueRunning.value) {
      toast('队列运行中不能调整顺序', 'error')
      return
    }
    if (from === to || from < 0 || to < 0) return
    if (from >= queue.value.length || to >= queue.value.length) return
    const [item] = queue.value.splice(from, 1)
    queue.value.splice(to, 0, item)
  }

  function clearQueue(): void {
    if (queueRunning.value) return
    queue.value = []
  }

  async function runQueue(): Promise<void> {
    if (queueRunning.value || !queue.value.length) return
    if (keyStatus.value !== 'verified') {
      toast('请先校验令牌后再运行队列', 'error')
      return
    }

    queueRunning.value = true
    const limit = Math.max(1, Math.min(2, Number(queueConcurrency.value) || 1))
    let cursor = 0
    let completed = 0

    const worker = async (): Promise<void> => {
      while (cursor < queue.value.length) {
        const task = queue.value[cursor]
        cursor += 1
        task.state = 'running'

        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
        try {
          const images = await requestImages({
            key: task.key,
            payload: task.payload,
            references: task.refs,
            mask: task.mask,
            format: task.format,
            signal: controller.signal,
          })
          setResults(images, task.format)
          await pushHistory({
            prompt: task.rawPrompt,
            model: task.payload.model,
            size: task.size,
            format: task.format,
            quality: task.options.quality,
            background: task.options.background,
            moderation: task.options.moderation,
            compression: task.options.compression,
            count: task.options.count,
            style: task.options.style,
            retouch: task.options.retouch,
            time: new Date().toLocaleString(),
            images,
          })
          task.state = 'success'
        } catch (error) {
          task.state = 'failed'
          const message =
            (error as Error).name === 'AbortError'
              ? '任务超过 20 分钟，已自动停止'
              : error instanceof ImageGenError
                ? error.message
                : (error as Error).message
          toast(message, 'error')
        } finally {
          window.clearTimeout(timeout)
          completed += 1
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, queue.value.length) }, worker))
    queue.value = queue.value.filter((task) => task.state !== 'success')
    queueRunning.value = false
    toast(completed ? `队列执行完成，成功 ${completed - queueStats.value.failed} 个` : '队列为空', 'info')
  }

  // ==================== Rule-driven helper used by the view ====================

  /** Presets belonging to the category/group currently open in the workbench. */
  const activeRetouchPresets = computed(() => {
    const category = resolveRetouchSelection({
      category: activeRetouchCategory.value,
      group: activeRetouchGroup.value,
      preset: selectedRetouchId.value,
    })
    return category.group.presets
  })

  const activeGroups = computed(
    () =>
      resolveRetouchSelection({
        category: activeRetouchCategory.value,
        group: activeRetouchGroup.value,
        preset: selectedRetouchId.value,
      }).category.groups,
  )

  // ==================== Templates ====================

  const templateDrawerOpen = ref(false)
  const customTemplates = ref<ImageTemplate[]>([])
  const rewriting = ref(false)
  const rewriteStatus = ref('')
  const rewrittenPrompt = ref('')

  const CUSTOM_TEMPLATES_KEY = 'imgGenCustomTemplates'

  function loadCustomTemplates(): void {
    const raw = safeGet(CUSTOM_TEMPLATES_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as ImageTemplate[]
      if (Array.isArray(parsed)) customTemplates.value = parsed
    } catch {
      customTemplates.value = []
    }
  }

  function persistCustomTemplates(): void {
    safeSet(CUSTOM_TEMPLATES_KEY, JSON.stringify(customTemplates.value))
  }

  /** Save the current prompt + parameters as a reusable custom template. */
  function saveCurrentTemplate(): void {
    const text = prompt.value.trim()
    if (!text) {
      toast('请先填写 Prompt 再保存模板', 'error')
      return
    }
    const template: ImageTemplate = {
      id: newId(),
      name: text.slice(0, 24) || '自定义模板',
      tag: '自定义',
      category: '自定义',
      desc: text.slice(0, 80),
      prompt: text,
      preview: '',
      custom: true,
      params: {
        size: size.value === 'custom' ? `${customWidth.value}x${customHeight.value}` : size.value,
        quality: quality.value,
        count: Number(count.value),
        format: format.value,
        background: background.value,
        moderation: moderation.value,
        compression: Number(compression.value),
        style: style.value,
        retouch: retouchParams.value,
      },
    }
    customTemplates.value.unshift(template)
    persistCustomTemplates()
    toast('已保存到我的模板', 'success')
  }

  function deleteCustomTemplate(id: string): void {
    customTemplates.value = customTemplates.value.filter((item) => item.id !== id)
    persistCustomTemplates()
  }

  /** Apply a template's prompt and parameters to the form. */
  function applyTemplate(template: ImageTemplate, promptOverride?: string): void {
    prompt.value = promptOverride ?? template.prompt
    const params = template.params
    if (params.size) applySize(params.size)
    if (params.quality) quality.value = params.quality
    if (params.count) count.value = Number(params.count)
    if (params.format) format.value = params.format
    if (params.background) background.value = params.background
    if (params.moderation) moderation.value = params.moderation
    if (typeof params.compression === 'number') compression.value = params.compression
    if (typeof params.style === 'string') style.value = params.style
    if (params.model) model.value = params.model
    if (params.retouch) applyRetouchParams(params.retouch)
    toast('已应用模板', 'success')
  }

  /** AI-rewrite the template prompt currently open in the preview stage. */
  async function rewriteTemplatePrompt(original: string, instruction: string): Promise<void> {
    const key = cleanApiKey(apiKey.value)
    if (!key) {
      toast('请输入令牌', 'error')
      return
    }
    try {
      assertHeaderSafeKey(key)
    } catch (error) {
      toast((error as Error).message, 'error')
      return
    }
    if (!original.trim()) {
      toast('原提示词为空', 'error')
      return
    }
    if (!instruction.trim()) {
      toast('请输入修改指令', 'error')
      return
    }

    rewriting.value = true
    rewriteStatus.value = 'AI 智能修改提示词中...'
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 120000)
    try {
      const next = await rewritePrompt({
        key,
        model: rewriteModel.value.trim() || DEFAULT_REWRITE_MODEL,
        original,
        instruction,
        signal: controller.signal,
      })
      rewrittenPrompt.value = next
      rewriteStatus.value = '已生成新提示词，可继续修改或应用'
      toast('提示词已修改', 'success')
    } catch (error) {
      const message =
        (error as Error).name === 'AbortError' ? '提示词修改请求超时' : (error as Error).message
      rewriteStatus.value = message
      toast(message, 'error')
    } finally {
      window.clearTimeout(timeout)
      rewriting.value = false
    }
  }

  function openTemplateDrawer(): void {
    templateDrawerOpen.value = true
  }

  // Persist the key on blur so a refresh keeps it without watching every keystroke.
  function persistKey(): void {
    saveApiKey()
  }

  return {
    // form
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
    saveApiKey,
    // retouch
    retouchSelections,
    retouchIntensity,
    retouchSubject,
    activeRetouchCategory,
    activeRetouchGroup,
    selectedRetouchId,
    activeRetouchPresets,
    activeGroups,
    retouchParams,
    retouchCount,
    retouchEnabled,
    isRetouchSelected,
    toggleRetouch,
    clearRetouch,
    applyRetouchParams,
    // refs
    references,
    maskFile,
    maskPreview,
    dragActive,
    addReferences,
    removeReference,
    moveReference,
    clearReferences,
    setMask,
    clearMask,
    // output
    results,
    previewSize,
    statusText,
    progressText,
    errorText,
    generating,
    setResults,
    downloadResult,
    downloadAll,
    // history
    history,
    visibleHistory,
    favoriteOnly,
    historyBusy,
    loadHistory,
    applyHistoryItem,
    toggleFavorite,
    deleteHistoryItem,
    // key
    keyStatus,
    checkingKey,
    checkApiKey,
    // queue
    queue,
    queueRunning,
    queueConcurrency,
    queueStats,
    enqueue,
    deleteQueueItem,
    moveQueueItem,
    clearQueue,
    runQueue,
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
    // actions
    applySize,
    resolvedSize,
    submit,
  }
}

export type ImageGenController = ReturnType<typeof useImageGen>
