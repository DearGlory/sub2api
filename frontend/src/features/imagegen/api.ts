/**
 * Upstream calls for the image-generation plaza.
 *
 * The page talks to the Sub2API gateway on the same origin as the SPA, using a
 * user API key (`sk-...`) rather than the panel JWT — that is what the gateway
 * authenticates and what bills the request to the key's owner. The panel's own
 * `/api/v1` client is deliberately not used here.
 *
 * Generation is synchronous and can legitimately take many minutes, so every
 * call takes an AbortSignal the caller drives from its own timeout.
 */
import { buildGatewayUrl } from '@/api/client'
import type { ImageRequestPayload } from './types'

/** Upstream caps a single reference image at 50MB, matching the backend. */
export const MAX_REFERENCE_BYTES = 50 * 1024 * 1024
/** The edits endpoint accepts at most 16 input images. */
export const MAX_REFERENCE_COUNT = 16
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export class ImageGenError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ImageGenError'
    this.status = status
  }
}

/** Strip invisible/formatting characters that survive copy-paste from docs. */
export function cleanApiKey(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
    .trim()
}

/**
 * A key is interpolated into an HTTP header, so anything outside printable
 * ASCII makes fetch throw an opaque TypeError. Catch it early with a message
 * that says what to fix.
 */
export function assertHeaderSafeKey(key: string): void {
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new ImageGenError('令牌含有非法字符，请只粘贴 sk- 开头的令牌，不要带中文、全角空格或其他说明文字')
  }
}

/** Gateway paths are absolute on the origin, e.g. `/v1/images/generations`. */
export function gatewayUrl(path: string): string {
  return buildGatewayUrl(path)
}

interface ImageApiOptions {
  key: string
  payload: ImageRequestPayload
  references: File[]
  mask: File | null
  format: string
  signal: AbortSignal
}

/**
 * POST one generation. With reference images this becomes a multipart
 * `/v1/images/edits` call (the backend parses `image[]` and `mask`); without
 * them it is a plain JSON `/v1/images/generations` call.
 */
export async function requestImages(options: ImageApiOptions): Promise<string[]> {
  const { key, payload, references, mask, format, signal } = options
  const editing = references.length > 0
  const url = gatewayUrl(editing ? '/v1/images/edits' : '/v1/images/generations')

  let response: Response
  if (editing) {
    const body = new FormData()
    for (const [field, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null) body.append(field, String(value))
    }
    for (const file of references) body.append('image[]', file)
    if (mask) body.append('mask', mask)
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal,
    })
  } else {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })
  }

  const data = (await response.json().catch(() => ({}))) as {
    data?: { b64_json?: string; url?: string }[]
    error?: { message?: string; type?: string; code?: string; param?: string }
    message?: string
  }

  if (!response.ok) {
    const error = data.error ?? {}
    const detail = [
      error.message || data.message || `${response.status} ${response.statusText}`,
      error.type,
      error.code,
      error.param && `param:${error.param}`,
    ]
      .filter(Boolean)
      .join(' | ')
    throw new ImageGenError(detail, response.status)
  }

  const images = (data.data ?? [])
    .map((entry) => (entry.b64_json ? `data:image/${format};base64,${entry.b64_json}` : entry.url))
    .filter((src): src is string => Boolean(src))

  if (!images.length) throw new ImageGenError('上游未返回图片数据')
  return images
}

/**
 * Validate a pasted key by listing models with it. Mirrors the source page:
 * a key counts as usable when the list contains an image model.
 */
export async function verifyApiKey(key: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(gatewayUrl('/v1/models'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    signal,
  })
  const data = (await response.json().catch(() => ({}))) as { data?: { id?: string; model?: string }[] }
  if (!response.ok) return false
  const models = Array.isArray(data.data) ? data.data.map((entry) => String(entry.id || entry.model || '')) : []
  return models.some((model) => model.includes('image'))
}

/**
 * Rewrite a template prompt through the chat completions endpoint.
 *
 * The source page hard-coded `gpt-5.5`; the model is a parameter here so an
 * operator can point it at whatever the deployment actually serves.
 */
export async function rewritePrompt(
  options: { key: string; model: string; original: string; instruction: string; signal: AbortSignal },
): Promise<string> {
  const { key, model, original, instruction, signal } = options
  const content = `现在你是一名专业的AI提示词工程师，将以下生图内容提示词修改为用户所需要的新提示词，原提示词:"${original}",用户修改期待:"${instruction}"。直接且只能输出修改后的提示词，严禁输入非修改后提示词内容`

  const response = await fetch(gatewayUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
    }),
    signal,
  })

  const data = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string }; text?: string }[]
    output_text?: string
    data?: { text?: string }[]
    error?: { message?: string; type?: string; code?: string }
    message?: string
  }

  if (!response.ok) {
    const error = data.error ?? {}
    throw new ImageGenError(
      [error.message || data.message || `${response.status} ${response.statusText}`, error.type, error.code]
        .filter(Boolean)
        .join(' | '),
      response.status,
    )
  }

  const text =
    data.choices?.[0]?.message?.content || data.choices?.[0]?.text || data.output_text || data.data?.[0]?.text || ''
  const next = String(text).trim()
  if (!next) throw new ImageGenError('AI 未返回新提示词')
  return next
}

/** Trigger a browser download for a data: or blob: URL. */
export function downloadUrl(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Copy a generated image to the clipboard, falling back to copying its URL. */
export async function copyImage(src: string): Promise<'image' | 'link'> {
  try {
    const response = await fetch(src)
    const blob = await response.blob()
    const ClipboardItemCtor = window.ClipboardItem
    if (navigator.clipboard && ClipboardItemCtor) {
      await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type || 'image/png']: blob })])
      return 'image'
    }
  } catch {
    // Fall through to the text fallback — a data: URL can be huge but still
    // pastes into the same page's reference drop zone.
  }
  await navigator.clipboard.writeText(src)
  return 'link'
}

/** Convert a data: URL to a File so a result can be reused as a reference. */
export async function dataUrlToFile(src: string, filename: string): Promise<File> {
  const response = await fetch(src)
  const blob = await response.blob()
  return new File([blob], filename, { type: blob.type || 'image/png' })
}
