import { Group } from 'three'
import type { CometVisual, CometVisualOptions } from './cometVisualContract'
import { createCometSurface } from './cometSurface'
import { createCometVolume } from './cometVolume'
import { createCometEventField } from './cometEventField'

/** Creates the rocky nucleus and birth-driven gas in the caller's fixed SUBJECT_Z frame. */
export function createCometVisual(options: CometVisualOptions): CometVisual {
  const object = new Group()
  object.name = 'comet-visual'
  const surface = createCometSurface(options)
  const volume = createCometVolume(options)
  const event = createCometEventField(options)
  object.add(surface.mesh, volume.coma, volume.tail, event.mesh)
  let geometryBytes = 0
  for (const mesh of [surface.mesh, volume.coma, volume.tail, event.mesh]) {
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
      event.update(frame)
    },
    dispose() {
      if (disposed) return
      disposed = true
      surface.dispose()
      volume.dispose()
      event.dispose()
      object.clear()
      object.removeFromParent()
    },
  }
}
