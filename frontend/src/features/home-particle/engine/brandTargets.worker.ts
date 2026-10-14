import { buildGlyphTargets } from './brandTargetsRaster'
import type { BrandTargetsRequest, BrandTargetsResponse } from './brandTargetsRaster'

// Structural worker scope avoids adding WebWorker globals to the DOM tsconfig.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BrandTargetsRequest>) => void) | null
  postMessage: (message: BrandTargetsResponse, transfer: Transferable[]) => void
}

scope.onmessage = ({ data }) => {
  let result: BrandTargetsResponse['result'] = null
  try {
    result = buildGlyphTargets(
      data.source, data.count, data.canvasSize, new OffscreenCanvas(data.canvasSize, data.canvasSize)
    )
  } catch {
    // Missing worker canvas support or allocation failure retries via the DOM path.
  }
  scope.postMessage(
    { id: data.id, slug: data.slug, result },
    result ? [result.targets.buffer, result.strokeDepth.buffer] : []
  )
}
