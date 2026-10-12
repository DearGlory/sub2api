import { describe, expect, it, vi } from 'vitest'
import { Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector3, WebGLRenderer } from 'three'
import { createCometVisual } from '../cometVisual'
import type { CometVisualFrame } from '../cometVisualContract'
import { EmittedTail } from '../emittedTail'

const options = { particleCount: 18000, light: false, reducedMotion: false }
function frame(phase: CometVisualFrame['phase'], progress: number): CometVisualFrame {
  return { phase, progress, time: 31, delta: 1 / 60, headX: 2.56, headY: -0.2, headZ: 180,
    glyphMix: 0.4, departure: 0, light: false, reducedMotion: false }
}
function eventOf(visual: ReturnType<typeof createCometVisual>) {
  const events = visual.object.children.filter(o => o instanceof Mesh &&
    o.material instanceof ShaderMaterial && 'uEventMode' in o.material.uniforms)
  expect(events, 'a real event mesh must exist in the production graph; baseline has none').toHaveLength(1)
  return events[0] as Mesh<import('three').BoxGeometry, ShaderMaterial>
}

describe('production event field graph', () => {
  it('requires one local box with real uniforms and accounts for every attribute and index', () => {
    const visual = createCometVisual(options)
    try {
      const mesh = eventOf(visual)
      expect(mesh.geometry.type).toBe('BoxGeometry')
      expect(mesh.parent).toBe(visual.object)
      expect(mesh.material.uniforms.uHead.value).toBeInstanceOf(Vector3)
      let bytes = 0
      visual.object.traverse(o => { if (o instanceof Mesh) {
        bytes += o.geometry.index?.array.byteLength ?? 0
        for (const attr of Object.values(o.geometry.attributes)) bytes += attr.array.byteLength
      } })
      expect(visual.geometryBytes).toBe(bytes)
      expect(bytes + 18000 * 32 + 18000 * 28).toBeLessThanOrEqual(3500000)
    } finally { visual.dispose() }
  })

  it('supports only gather and early scatter, resets inactive uniforms, and preserves the head anchor', async () => {
    const { createCometEventField } = await import('../cometEventField')
    const event = createCometEventField(options)
    const u = event.mesh.material.uniforms
    try {
      for (const phase of ['travel', 'gather', 'hold', 'scatter'] as const) {
        for (let i = 0; i <= 100; i++) {
          const f = frame(phase, i / 100)
          event.update(f)
          expect(u.uEventProgress.value).toBeGreaterThanOrEqual(0)
          expect(u.uEventProgress.value).toBeLessThanOrEqual(1)
          expect(u.uEventStrength.value).toBeGreaterThanOrEqual(0)
          expect(u.uEventStrength.value).toBeLessThanOrEqual(1)
          expect(Number.isFinite(u.uRadius.value)).toBe(true)
          expect(u.uRadius.value).toBeGreaterThan(0)
          expect(event.mesh.position.toArray()).toEqual([f.headX, f.headY, f.headZ])
          expect(u.uHead.value.toArray()).toEqual(event.mesh.position.toArray())
          if (phase === 'travel' || phase === 'hold' || phase === 'scatter' && f.progress >= 0.62) {
            expect(event.mesh.visible).toBe(false)
            expect(u.uEventMode.value).toBe(0)
            expect(u.uEventStrength.value).toBe(0)
          }
        }
      }
      event.update(frame('gather', 0.15))
      expect(event.mesh.visible).toBe(true)
      expect(u.uEventMode.value).toBe(1)
      expect(u.uEventProgress.value).toBe(0.15)
      event.update(frame('scatter', 0.31))
      expect(event.mesh.visible).toBe(true)
      expect(u.uEventMode.value).toBe(2)
      expect(u.uEventProgress.value).toBeCloseTo(0.5)
    } finally { event.dispose() }
  })

  it('uses parent world coordinates for the camera, handles themes/reduced motion and disposes exactly once', async () => {
    const { createCometEventField } = await import('../cometEventField')
    const event = createCometEventField(options)
    const visual = createCometVisual(options)
    const mesh = eventOf(visual)
    const pool = new EmittedTail(32)
    visual.object.position.z = -60
    visual.object.add(event.mesh)
    const f = frame('scatter', 0.25)
    event.update(f)
    const camera = new PerspectiveCamera()
    camera.position.set(3, 4, 260)
    camera.updateMatrixWorld()
    visual.object.updateMatrixWorld(true)
    event.mesh.onBeforeRender({} as WebGLRenderer, new Scene(), camera, event.mesh.geometry, event.mesh.material, null as never)
    expect(event.mesh.material.uniforms.uCameraFrame.value.toArray()).toEqual([3, 4, 320])
    expect(event.mesh.position.toArray()).toEqual([2.56, -0.2, 180])
    visual.update(f, pool)
    f.light = true
    visual.update(f, pool)
    expect(mesh.material.uniforms.uLightTheme.value).toBe(1)
    f.reducedMotion = true
    visual.update(f, pool)
    expect(mesh.visible).toBe(false)
    expect(mesh.material.uniforms.uEventMode.value).toBe(0)
    expect(mesh.material.uniforms.uEventStrength.value).toBe(0)
    const gd = vi.spyOn(event.mesh.geometry, 'dispose'), md = vi.spyOn(event.mesh.material, 'dispose')
    event.dispose(); event.dispose(); event.update(frame('gather', 0.2))
    expect(gd).toHaveBeenCalledTimes(1)
    expect(md).toHaveBeenCalledTimes(1)
    expect(event.mesh.visible).toBe(false)
    expect(event.mesh.parent).toBeNull()
    visual.dispose()
    expect(visual.object.children).toHaveLength(0)
  })
})
