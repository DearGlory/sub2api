import { expect, it } from 'vitest'
import { Mesh, ShaderMaterial } from 'three'
import { createCometVisual } from '../cometVisual'

it('production graph excludes legacy solid surface and event carriers', () => {
  const visual = createCometVisual({ particleCount: 18000, light: false, reducedMotion: false })
  try {
    const forbidden: string[] = []
    visual.object.traverse(o => {
      if (o instanceof Mesh && o.material instanceof ShaderMaterial &&
        ('uEventMode' in o.material.uniforms || 'uFracture' in o.material.uniforms)) forbidden.push(o.name)
    })
    expect(forbidden).toEqual([])
    expect(visual.object.children.map(o => o.name)).toEqual(['comet-coma-volume', 'comet-tail-volume'])
  } finally { visual.dispose() }
})
