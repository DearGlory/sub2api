import { afterEach } from 'vitest'
import { SUBJECT_Z } from '../constants'
import { createCometVisual } from '../cometVisual'
import type { CometVisualFrame } from '../cometVisualContract'

const visuals: ReturnType<typeof createCometVisual>[] = []
afterEach(() => { for (const visual of visuals.splice(0)) visual.dispose() })

/** Real production graph even in CPU tests; only the renderer is absent. */
export function cometVisualFixture(light = false) {
  const cometVisual = createCometVisual({ particleCount: 128, light, reducedMotion: false })
  visuals.push(cometVisual)
  cometVisual.object.position.z = SUBJECT_Z
  const cometVisualFrame: CometVisualFrame = {
    phase: 'travel', progress: 0, time: 0, delta: 0,
    headX: 0, headY: 0, headZ: 0, glyphMix: 0, departure: 0,
    light, reducedMotion: false,
  }
  return { cometVisual, cometVisualFrame, hasIntegrated: false }
}
