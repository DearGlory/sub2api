/**
 * LANE L3 — deep-space starfield. STUB: replaced by the lane.
 *
 * Three parallax layers of stars plus a faint nebula wash, recycled as the camera
 * dollies forward so the field never runs out. See HOME-PARTICLE-DESIGN.md §1 (R1).
 */
import { Object3D } from 'three'
import type { Starfield, StarfieldOptions } from './types'

export function createStarfield(_options: StarfieldOptions): Starfield {
  const object = new Object3D()

  return {
    object,
    update(_deltaSeconds: number, _cameraZ: number, _time: number): void {
      /* lane L3 */
    },
    setTheme(_isLightTheme: boolean): void {
      /* lane L3 */
    },
    setReducedMotion(_value: boolean): void {
      /* lane L3 */
    },
    dispose(): void {
      /* lane L3 */
    },
  }
}
