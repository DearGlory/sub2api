import { Group } from 'three'
import type { CometVisual, CometVisualOptions } from './cometVisualContract'
import { createCometVolume } from './cometVolume'

/** Only faint connective gas lives here; the nucleus, sheath and jets are particles. */
export function createCometVisual(options: CometVisualOptions): CometVisual {
  const object = new Group()
  object.name = 'comet-visual'
  const volume = createCometVolume(options)
  object.add(volume.coma, volume.tail)
  let geometryBytes = 0
  for (const mesh of [volume.coma, volume.tail]) {
    geometryBytes += mesh.geometry.index?.array.byteLength ?? 0
    for (const attribute of Object.values(mesh.geometry.attributes)) geometryBytes += attribute.array.byteLength
  }
  let disposed = false
  return {
    object, geometryBytes,
    update(frame, tail) {
      if (disposed) return
      volume.update(frame, tail)
    },
    dispose() {
      if (disposed) return
      disposed = true
      volume.dispose()
      object.clear()
      object.removeFromParent()
    },
  }
}
