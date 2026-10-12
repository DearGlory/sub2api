import { describe, expect, it } from 'vitest'
import { BufferGeometry, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import { createCometVisual } from '../cometVisual'
import { COMET_COMA_RADIUS, COMET_SURFACE_RADIUS } from '../cometVisualContract'
import type { CometTailView, CometVisualFrame } from '../cometVisualContract'

const options = { particleCount: 2000, light: false, reducedMotion: false }
const frame = (changes: Partial<CometVisualFrame> = {}): CometVisualFrame => ({
  phase: 'travel', progress: 0, time: 0, delta: 1 / 60, headX: 2, headY: 1,
  headZ: -8, glyphMix: 0, departure: 1, light: false, reducedMotion: false, ...changes,
})
const pool = (count = 4): CometTailView => ({
  count, positions: new Float32Array(count * 3), colors: new Float32Array(count * 3),
  birthPosition: new Float32Array(count * 3), birthVelocity: new Float32Array(count * 3),
  birthTime: new Float64Array(count), age: new Float32Array(count),
  life: new Float32Array(count).fill(4), active: new Uint8Array(count),
})
const nucleus = (visual: ReturnType<typeof createCometVisual>) => visual.object.getObjectByName('comet-nucleus') as Mesh
const material = (mesh: Mesh) => mesh.material as ShaderMaterial

describe('procedural comet surface', () => {
  it('has an irregular, finite, genuinely three dimensional rock and exact byte accounting', () => {
    const visual = createCometVisual(options)
    const mesh = nucleus(visual)
    const geometry = mesh.geometry
    geometry.computeBoundingBox()
    const span = geometry.boundingBox!.getSize(new Vector3())
    expect(Math.min(span.x, span.y, span.z)).toBeGreaterThan(COMET_SURFACE_RADIUS * 1.35)
    expect(Math.max(span.x, span.y, span.z)).toBeLessThan(COMET_SURFACE_RADIUS * 2.8)
    const position = geometry.getAttribute('position')
    const radii = Array.from({ length: position.count }, (_, i) => Math.hypot(position.getX(i), position.getY(i), position.getZ(i)))
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.16)
    for (const attribute of Object.values(geometry.attributes)) expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true)
    expect(geometry.getAttribute('normal').count).toBe(position.count)
    expect(geometry.getAttribute('aFaceCenter').count).toBe(position.count)
    let bytes = 0
    visual.object.traverse(object => {
      if (object instanceof Mesh) {
        const meshGeometry = object.geometry as BufferGeometry
        for (const attribute of Object.values(meshGeometry.attributes)) bytes += attribute.array.byteLength
        bytes += meshGeometry.index?.array.byteLength ?? 0
      }
    })
    expect(visual.geometryBytes).toBe(bytes)
    expect(bytes).toBeLessThan(3.5 * 1024 * 1024)
    expect(COMET_COMA_RADIUS / 1.02).toBeCloseTo(1.5)
    visual.dispose()
  })

  it('uses rough directional lighting without textures or additive blending in either theme', () => {
    const visual = createCometVisual(options)
    const shader = material(nucleus(visual))
    expect(shader.blending).toBe(NormalBlending)
    expect(shader.uniforms.uRoughness!.value).toBeGreaterThan(0.7)
    expect(shader.uniforms.uLightDirection!.value.length()).toBeCloseTo(1)
    expect(shader.fragmentShader).toContain('dot(N, L)')
    visual.update(frame({ light: true }), pool())
    expect(shader.uniforms.uLightTheme!.value).toBe(1)
    expect(Object.values(shader.uniforms).some(uniform => uniform.value?.isTexture)).toBe(false)
    visual.dispose()
  })

  it('rotates around its own head without rotating the fixed frame or accumulating translation', () => {
    const visual = createCometVisual(options)
    visual.update(frame({ time: 2 }), pool())
    const mesh = nucleus(visual)
    const rotation = mesh.rotation.y
    visual.update(frame({ time: 8 }), pool())
    expect(mesh.rotation.y).not.toBe(rotation)
    expect(mesh.position.toArray()).toEqual([2, 1, -8])
    expect(visual.object.position.toArray()).toEqual([0, 0, 0])
    visual.update(frame({ time: 20, reducedMotion: true }), pool())
    const stopped = mesh.rotation.y
    visual.update(frame({ time: 40, reducedMotion: true }), pool())
    expect(mesh.rotation.y).toBe(stopped)
    visual.dispose()
  })

  it('fractures triangle-local faces after .05 and hides by .55, then reforms at scatter .62', () => {
    const visual = createCometVisual(options)
    const mesh = nucleus(visual)
    const shader = material(mesh)
    visual.update(frame({ phase: 'gather', progress: 0 }), pool())
    expect(mesh.visible).toBe(true)
    expect(shader.uniforms.uFracture!.value).toBe(0)
    visual.update(frame({ phase: 'gather', progress: 0.05 }), pool())
    expect(shader.uniforms.uFracture!.value).toBe(0)
    visual.update(frame({ phase: 'gather', progress: 0.3 }), pool())
    expect(shader.uniforms.uFracture!.value).toBe(1)
    visual.update(frame({ phase: 'gather', progress: 0.55 }), pool())
    expect(mesh.visible).toBe(false)
    visual.update(frame({ phase: 'gather', progress: 1 }), pool())
    expect(mesh.visible).toBe(false)
    visual.update(frame({ phase: 'hold' }), pool())
    expect(mesh.visible).toBe(false)
    visual.update(frame({ phase: 'scatter', progress: 0.62 * 0.7 }), pool())
    expect(mesh.visible).toBe(false)
    visual.update(frame({ phase: 'scatter', progress: 0.62 * 0.85 }), pool())
    expect(mesh.visible).toBe(true)
    expect(mesh.scale.x).toBeGreaterThan(0)
    expect(mesh.scale.x).toBeLessThan(1)
    visual.update(frame({ phase: 'scatter', progress: 0.62 }), pool())
    expect(mesh.visible).toBe(true)
    expect(mesh.scale.x).toBe(1)
    expect(shader.uniforms.uOpacity!.value).toBe(1)
    visual.update(frame({ phase: 'gather', progress: 0.3, reducedMotion: true }), pool())
    expect(shader.uniforms.uFracture!.value).toBe(0)
    visual.dispose()
  })

  it('disposes every geometry and material once and tolerates repeated disposal', () => {
    const visual = createCometVisual(options)
    let resources = 0
    let disposals = 0
    visual.object.traverse(object => {
      if (!(object instanceof Mesh)) return
      for (const resource of [object.geometry, material(object)]) {
        resources++
        resource.addEventListener('dispose', () => disposals++)
      }
    })
    visual.dispose()
    visual.dispose()
    expect(disposals).toBe(resources)
    expect(visual.object.children).toHaveLength(0)
  })
})
