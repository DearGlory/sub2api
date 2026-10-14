import type { Group } from 'three'
import type { CometPhase } from './types'

/** All geometry is relative to a fixed SUBJECT_Z origin, never a camera-attached group. */
export interface CometVisualFrame {
  phase: CometPhase
  progress: number
  time: number
  delta: number
  headX: number
  headY: number
  headZ: number
  glyphMix: number
  departure: number
  light: boolean
  reducedMotion: boolean
}

/** Read-only view of the real independently emitted world-space pool. */
export interface CometTailView {
  readonly count: number
  readonly positions: Float32Array
  readonly colors: Float32Array
  readonly birthPosition: Float32Array
  readonly birthVelocity: Float32Array
  readonly birthTime: Float64Array
  readonly age: Float32Array
  readonly life: Float32Array
  readonly active: Uint8Array
}

export interface CometVisual {
  readonly object: Group
  readonly geometryBytes: number
  update(frame: CometVisualFrame, tail: CometTailView): void
  dispose(): void
}

export interface CometVisualOptions {
  readonly particleCount: number
  readonly light: boolean
  readonly reducedMotion: boolean
}

export const COMET_VOLUME_SCALE = 1.8
export const COMET_SURFACE_RADIUS = 0.9
export const COMET_COMA_RADIUS = 1.836
