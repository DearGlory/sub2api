/**
 * Server template catalog for the image-generation plaza.
 *
 * The catalog is hosted by the backend from `<data_dir>/imagegen-assets` and
 * served at `/api/v1/imagegen-assets/...`, not bundled into the SPA. Operators
 * add, remove or reorder templates by editing files on the server; no rebuild
 * and no new binary. A cached copy keeps the drawer usable offline, keyed by
 * URL so a changed path cannot serve stale rows.
 */
import { ref, computed } from 'vue'
import type { ImageTemplate, RetouchParams } from './types'
import { normalizeRetouchParams } from './retouch'
import { safeGet, safeSet } from './storage'
import { buildApiUrl } from '@/api/url'

const TEMPLATE_CATALOG_PATH = '/imagegen-assets/templates/templates.json'
const TEMPLATE_CATALOG_CACHE_KEY = 'imgGenTemplateCatalogCache'
const CATALOG_CACHE_VERSION = 2

/** Shape of one entry in `templates.json` before normalisation. */
interface RawTemplate {
  id?: string
  name?: string
  tag?: string
  category?: string
  desc?: string
  prompt?: string
  preview?: string
  source?: string
  params?: {
    model?: string
    size?: string
    quality?: string
    count?: number
    n?: number
    format?: string
    output_format?: string
    background?: string
    moderation?: string
    compression?: number
    style?: string
    retouch?: unknown
  }
}

interface CatalogCache {
  version: number
  url: string
  savedAt: number
  templates: RawTemplate[]
}

/**
 * Absolute base for the catalog. The path is prefixed with the panel API base
 * (`/api/v1` by default) because the backend, not the SPA bundle, serves it.
 *
 * Resolution falls back to a placeholder origin when the page has an opaque one
 * (`about:blank`, or jsdom without a configured URL), so relative preview paths
 * still resolve instead of throwing.
 */
function catalogBase(): string {
  const path = buildApiUrl(TEMPLATE_CATALOG_PATH)
  try {
    return new URL(path, window.location.href).href
  } catch {
    return `http://localhost${path}`
  }
}

function catalogUrl(): string {
  return catalogBase()
}

function resolvePreview(value: string | undefined): string {
  if (!value) return ''
  if (value.startsWith('linear-gradient') || value.startsWith('data:') || /^https?:\/\//.test(value)) return value
  // Catalog preview paths are relative to templates.json, not the site root.
  return new URL(value, catalogBase()).href
}

/** Template sizes are normalised to a 1:1 square unless explicitly set. */
function normalizeSize(size: string | undefined): string {
  const value = String(size || '').trim()
  return /^\d+x\d+$/.test(value) ? value : '1024x1024'
}

function normalizeTemplate(raw: RawTemplate, index: number): ImageTemplate {
  const params = raw.params ?? {}
  const count = Number.isFinite(Number(params.count))
    ? Number(params.count)
    : Number.isFinite(Number(params.n))
      ? Number(params.n)
      : 1

  const normalized: ImageTemplate = {
    id: raw.id || `server-${index}`,
    name: raw.name || `模板 ${index + 1}`,
    tag: raw.tag || '服务器模板',
    category: raw.category || raw.tag || '其他',
    desc: raw.desc || raw.tag || '',
    prompt: raw.prompt || '',
    preview: resolvePreview(raw.preview),
    params: {
      size: normalizeSize(params.size),
      quality: params.quality || 'auto',
      count,
      format: params.format || params.output_format || 'png',
      background: params.background || 'auto',
      moderation: params.moderation || 'auto',
      compression: Number.isFinite(Number(params.compression)) ? Number(params.compression) : 80,
      style: params.style || '',
      retouch: normalizeRetouchParams(params.retouch ?? {}) as unknown as RetouchParams,
    },
  }
  if (typeof params.model === 'string' && params.model) normalized.params.model = params.model
  return normalized
}

function readCache(): RawTemplate[] | null {
  try {
    const data = JSON.parse(safeGet(TEMPLATE_CATALOG_CACHE_KEY) || 'null') as CatalogCache | null
    if (!data || data.version !== CATALOG_CACHE_VERSION) return null
    if (data.url !== catalogUrl()) return null
    return Array.isArray(data.templates) && data.templates.length ? data.templates : null
  } catch {
    return null
  }
}

function writeCache(templates: RawTemplate[]): void {
  const payload: CatalogCache = {
    version: CATALOG_CACHE_VERSION,
    url: catalogUrl(),
    savedAt: Date.now(),
    templates,
  }
  safeSet(TEMPLATE_CATALOG_CACHE_KEY, JSON.stringify(payload))
}

export function useTemplateCatalog() {
  const templates = ref<ImageTemplate[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const status = ref('')
  const activeCategory = ref('全部')

  const categories = computed(() => {
    const seen = new Set<string>()
    for (const template of templates.value) seen.add(template.category || '其他')
    return [
      { id: '全部', count: templates.value.length },
      ...[...seen].map((id) => ({ id, count: templates.value.filter((t) => (t.category || '其他') === id).length })),
    ]
  })

  const filtered = computed(() => {
    const category = activeCategory.value
    if (category === '全部') return templates.value
    return templates.value.filter((template) => (template.category || '其他') === category)
  })

  async function load(force = false): Promise<ImageTemplate[]> {
    if (loaded.value && !force) return templates.value
    if (loading.value) return templates.value

    loading.value = true
    try {
      const response = await fetch(catalogUrl(), { cache: force ? 'no-store' : 'default' })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = (await response.json()) as { templates?: RawTemplate[] } | RawTemplate[]
      const raw = Array.isArray(payload) ? payload : (payload.templates ?? [])
      if (!raw.length) throw new Error('模板列表为空')
      templates.value = raw.map(normalizeTemplate)
      loaded.value = true
      status.value = `已加载 ${templates.value.length} 个模板`
      writeCache(raw)
    } catch (error) {
      // Fall back to the cached copy so the drawer still opens offline.
      const cached = readCache()
      if (cached) {
        templates.value = cached.map(normalizeTemplate)
        loaded.value = true
        status.value = `已加载 ${templates.value.length} 个模板 · 本地缓存`
      } else {
        status.value = `模板加载失败：${(error as Error).message}`
      }
    } finally {
      loading.value = false
    }
    return templates.value
  }

  function setCategory(id: string): void {
    activeCategory.value = id
  }

  return { templates, filtered, categories, loading, loaded, status, activeCategory, load, setCategory }
}
