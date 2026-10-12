import { expect, it } from 'vitest'
import { Mesh, ShaderMaterial } from 'three'
import { createCometVisual } from '../cometVisual'

it('production graph includes the event carrier (fails on the pre-event baseline)', () => {
  const visual = createCometVisual({ particleCount: 18000, light: false, reducedMotion: false })
  try {
    const events = visual.object.children.filter(o => o instanceof Mesh &&
      o.material instanceof ShaderMaterial && 'uEventMode' in o.material.uniforms)
    expect(events).toHaveLength(1)
  } finally { visual.dispose() }
})
