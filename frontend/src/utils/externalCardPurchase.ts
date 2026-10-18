export type ExternalCardPurchaseDisplayMode = 'embed' | 'new_window' | 'both'

export function normalizeExternalCardPurchaseDisplayMode(raw: string | null | undefined): ExternalCardPurchaseDisplayMode {
  if (raw === 'embed' || raw === 'new_window' || raw === 'both') return raw
  return 'both'
}

export function externalCardPurchaseDisplayName(raw: string | null | undefined, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || fallback
}

/** Returns a configured HTTPS shop URL without site identity parameters. */
export function buildExternalCardPurchaseUrl(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return ''

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return ''
    const reservedKeys = new Set([
      'token', 'jwt', 'access_token', 'id_token', 'auth', 'auth_token', 'authorization',
      'user_id', 'src_url', 'source_url', 'sourceurl', 'source-url', 'src', 'redirect', 'redirect_uri', 'return_url',
    ])
    for (const key of [...url.searchParams.keys()]) {
      if (reservedKeys.has(key.toLowerCase())) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return ''
  }
}