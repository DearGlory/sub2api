import { Group } from 'three'
import type { CometVisual, CometVisualOptions } from './cometVisualContract'
import { createCometSurface } from './cometSurface'
import { createCometVolume } from './cometVolume'

/** Creates the rocky nucleus and birth-driven gas in the caller's fixed SUBJECT_Z frame. */
export function createCometVisual(options: CometVisualOptions): CometVisual {
  const object = new Group()
  object.name = 'comet-visual'
  const surface = createCometSurface(options)
  const volume = createCometVolume(options)
  object.add(surface.mesh, volume.coma, volume.tail)
  let geometryBytes = 0
  for (const mesh of [surface.mesh, volume.coma, volume.tail]) {
    geometryBytes += mesh.geometry.index?.array.byteLength ?? 0
    for (const attribute of Object.values(mesh.geometry.attributes)) geometryBytes += attribute.array.byteLength
  }
  let disposed = false
  return {
    object, geometryBytes,
    update(frame, tail) {
      if (disposed) return
      surface.update(frame)
      volume.update(frame, tail)
    },
    dispose() {
      if (disposed) return
      disposed = true
      surface.dispose()
      volume.dispose()
      object.clear()
      object.removeFromParent()
    },
  }
}
