/**
 * LANE L3 — brand glyph sampler. STUB: replaced by the lane.
 *
 * Rasterises the official brand SVGs (`assets/brands/<slug>.svg`) and turns each
 * alpha mask into particle anchors via the vendored sampler. Lazy by design: a
 * glyph is only decoded when prefetched, so the first frame never waits on 28
 * image decodes. See HOME-PARTICLE-DESIGN.md §6 item 7.
 */
import type { BrandTargetSource, BrandTargets } from './types'

export function createBrandTargetSource(): BrandTargetSource {
  const cache = new Map<string, BrandTargets>()

  return {
    get(slug: string): BrandTargets | null {
      return cache.get(slug) ?? null
    },
    prefetch(_slug: string, _count: number): void {
      /* lane L3 */
    },
    ensure(_slug: string, _count: number): BrandTargets | null {
      /* lane L3 */
      return null
    },
    dispose(): void {
      cache.clear()
    },
  }
}
