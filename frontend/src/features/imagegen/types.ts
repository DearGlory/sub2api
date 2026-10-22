/**
 * Shared types for the image-generation plaza.
 *
 * These mirror the payload shapes accepted by the Sub2API gateway on
 * `/v1/images/generations` and `/v1/images/edits`, plus the local-only
 * bookkeeping (history, queue) that never leaves the browser.
 */

/** A single retouch preset as authored in the NewAPI imagegen source. */
export interface RetouchPreset {
  id: string
  category: string
  group: string
  title: string
  scenario?: string
  prompt: string
  params?: Record<string, unknown>
}

export interface RetouchGroup {
  id: string
  title: string
  presets: RetouchPreset[]
}

export interface RetouchCategory {
  id: string
  title: string
  summary: string
  groups: RetouchGroup[]
}

/** One selectable option row (intensity / subject). */
export interface RetouchOption {
  id: string
  label: string
  prompt: string
}

/** A retouch preset pinned by the user, addressed by category/group/preset. */
export interface RetouchSelection {
  category: string
  group: string
  preset: string
}

export interface RetouchParams {
  enabled: boolean
  selections: RetouchSelection[]
  category: string
  group: string
  preset: string
  intensity: string
  subject: string
}

/** Everything the form holds that influences the upstream request. */
export interface ImageGenOptions {
  quality: string
  background: string
  moderation: string
  compression: number
  count: number
  style: string
  retouch: RetouchParams
}

/**
 * A reference image held in memory. `file` is what gets appended to the
 * multipart body; `preview` is an object URL revoked on removal.
 */
export interface ReferenceImage {
  id: string
  file: File
  preview: string
}

/** A server template after normalisation, with a resolved preview URL. */
export interface ImageTemplate {
  id: string
  name: string
  tag: string
  category: string
  desc: string
  prompt: string
  preview: string
  params: Partial<ImageGenOptions> & { model?: string; size: string; format: string }
  custom?: boolean
}

/** A finished generation, persisted locally in IndexedDB. */
export interface HistoryItem {
  id: string
  prompt: string
  model: string
  size: string
  format: string
  quality: string
  background: string
  moderation: string
  compression: number
  count: number
  style: string
  retouch: RetouchParams
  favorite: boolean
  time: string
  imageCount: number
  /**
   * Only populated for export/import and for the transient in-memory copy.
   * The persisted metadata row keeps this empty and stores the pixels
   * separately under the same id.
   */
  images: string[]
}

export type QueueState = 'pending' | 'running' | 'success' | 'failed'

/** A queued generation. Holds live File handles, so it is never persisted. */
export interface QueueTask {
  id: string
  state: QueueState
  key: string
  apiBase: string
  model: string
  rawPrompt: string
  /** The exact prompt sent upstream, including style and retouch layers. */
  prompt: string
  size: string
  format: string
  payload: ImageRequestPayload
  refs: File[]
  mask: File | null
  options: ImageGenOptions
}

/** JSON body for `/v1/images/generations` (and for edits when form-encoded). */
export interface ImageRequestPayload {
  model: string
  prompt: string
  size: string
  n: number
  quality?: string
  output_format?: string
  background?: string
  moderation?: string
  output_compression?: number
}

/** One decoded image plus the metadata needed to save/download it. */
export interface GeneratedImage {
  src: string
  format: string
  index: number
}
