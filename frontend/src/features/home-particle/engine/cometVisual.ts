import { Group } from 'three'
import type { CometVisual, CometVisualOptions } from './cometVisualContract'
import { createCometSurface } from './cometSurface'

/** Creates the rocky nucleus in the caller's fixed SUBJECT_Z frame. */
export function createCometVisual(options: CometVisualOptions): CometVisual {
  const object = new Group()
  object.name = 'comet-visual'
  const surface = createCometSurface(options)
  object.add(surface.mesh)
  let geometryBytes = surface.mesh.geometry.index?.array.byteLength ?? 0
  for (const attribute of Object.values(surface.mesh.geometry.attributes)) geometryBytes += attribute.array.byteLength
  let disposed = false
  return {
    object, geometryBytes,
    update(frame) {
      if (!disposed) surface.update(frame)
    },
    dispose() {
      if (disposed) return
      disposed = true
      surface.dispose()
      object.clear()
      object.removeFromParent()
    },
  }
}
