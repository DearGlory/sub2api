import { Group } from 'three'
import { vi } from 'vitest'
import { SUBJECT_Z } from '../constants'
import type { CometVisual, CometVisualFrame } from '../cometVisualContract'

/** Explicit CPU-only fixture. Never installed in or selected by production code. */
export function cometVisualFixture(light = false) {
  const cometVisual: CometVisual = {
    object: new Group(), geometryBytes: 512,
    update: vi.fn(), dispose: vi.fn(),
  }
  cometVisual.object.position.z = SUBJECT_Z
  const cometVisualFrame: CometVisualFrame = {
    phase: 'travel', progress: 0, time: 0, delta: 0,
    headX: 0, headY: 0, headZ: 0, glyphMix: 0, departure: 0,
    light, reducedMotion: false,
  }
  return { cometVisual, cometVisualFrame, hasIntegrated: false }
}
