import { describe, expect, it } from 'vitest'
import { Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import { createCometVisual } from '../cometVisual'
import { COMET_COMA_RADIUS } from '../cometVisualContract'
import type { CometTailView, CometVisualFrame } from '../cometVisualContract'

const options = { particleCount: 18000, light: false, reducedMotion: false }
const frame = (changes: Partial<CometVisualFrame> = {}): CometVisualFrame => ({
  phase: 'travel', progress: 0, time: 0, delta: 1 / 60, headX: 2, headY: 1,
  headZ: -8, glyphMix: 0, departure: 1, light: false, reducedMotion: false, ...changes,
})
const pool = (count = 4): CometTailView => ({
  count, positions: new Float32Array(count * 3), colors: new Float32Array(count * 4),
  birthPosition: new Float32Array(count * 3), birthVelocity: new Float32Array(count * 3),
  birthTime: new Float64Array(count), age: new Float32Array(count),
  life: new Float32Array(count).fill(4), active: new Uint8Array(count),
})
const material = (mesh: Mesh) => mesh.material as ShaderMaterial

describe('particle-first comet scene', () => {
  it('attaches only two faint gas proxies, with no surface or event geometry in any phase', () => {
    const visual = createCometVisual(options)
    expect(visual.object.children.map(o => o.name)).toEqual(['comet-coma-volume', 'comet-tail-volume'])
    let bytes = 0
    for (const child of visual.object.children) {
      const mesh = child as Mesh, shader = material(mesh)
      bytes += mesh.geometry.index?.array.byteLength ?? 0
      for (const attribute of Object.values(mesh.geometry.attributes)) bytes += attribute.array.byteLength
      expect(shader.blending).toBe(NormalBlending)
      expect(shader.depthWrite).toBe(false)
      expect(shader.uniforms.uOpacity!.value).toBeLessThanOrEqual(0.06)
      expect(shader.uniforms.uVolumeExposure!.value).toBeLessThanOrEqual(0.55)
      expect(Object.values(shader.uniforms).some(uniform => uniform.value?.isTexture)).toBe(false)
      expect(shader.uniforms.uEventMode).toBeUndefined()
    }
    expect(visual.geometryBytes).toBe(bytes)
    expect(bytes).toBeLessThan(1000)
    for (const phase of ['travel', 'gather', 'hold', 'scatter'] as const) {
      visual.update(frame({ phase, progress: 0.5, glyphMix: 0.5 }), pool())
      expect(visual.object.children).toHaveLength(2)
      expect(visual.object.getObjectByName('comet-nucleus')).toBeUndefined()
    }
    visual.dispose()
  })

  it('follows body visibility continuously without a time-driven flash', () => {
    const visual = createCometVisual(options)
    const coma = visual.object.getObjectByName('comet-coma-volume') as Mesh
    const shader = material(coma)
    visual.update(frame({ headZ: -12000 }), pool())
    expect(coma.position.toArray()).toEqual([2, 1, -12000])
    expect(shader.uniforms.uOpacity!.value).toBe(0.045)
    visual.update(frame({ phase: 'gather', glyphMix: 0.5 }), pool())
    expect(shader.uniforms.uOpacity!.value).toBeCloseTo(0.0225)
    visual.update(frame({ phase: 'gather', glyphMix: 1 }), pool())
    expect(coma.visible).toBe(false)
    visual.update(frame({ phase: 'hold', glyphMix: 0 }), pool())
    expect(coma.visible).toBe(false)
    visual.update(frame({ time: 999, phase: 'scatter', glyphMix: 1 }), pool())
    expect(coma.visible).toBe(false)
    expect(shader.uniforms.uTime!.value).toBe(0)
    expect(visual.object.position.toArray()).toEqual([0, 0, 0])
    visual.dispose()
  })

  it('disposes every geometry and material once and tolerates repeated disposal', () => {
    const visual = createCometVisual(options)
    let resources = 0, disposals = 0
    visual.object.traverse(object => {
      if (!(object instanceof Mesh)) return
      for (const resource of [object.geometry, material(object)]) {
        resources++
        resource.addEventListener('dispose', () => disposals++)
      }
    })
    visual.dispose(); visual.dispose()
    visual.update(frame(), pool())
    expect(disposals).toBe(resources)
    expect(resources).toBe(4)
    expect(visual.object.children).toHaveLength(0)
  })
})

describe('emitted volume', () => {
  const tailMesh = (visual: ReturnType<typeof createCometVisual>) => visual.object.getObjectByName('comet-tail-volume') as Mesh
  const born = (tail: CometTailView, i: number, x: number, age = 0.4) => {
    tail.active[i] = 1
    tail.birthTime[i] = 0.2
    tail.age[i] = age
    tail.positions.set([x, 2, -9], i * 3)
  }

  it('uses the contract radius for continuous coma support wholly inside its proxy', () => {
    const visual = createCometVisual(options)
    try {
      visual.update(frame({ headZ: -12000 }), pool())
      const coma = visual.object.getObjectByName('comet-coma-volume') as Mesh
      const shader = material(coma)
      expect(shader.uniforms.uComaRadius?.value).toBe(COMET_COMA_RADIUS)
      expect(shader.fragmentShader).toContain('(p-uCenter) / uComaRadius')
      expect(shader.fragmentShader).not.toContain('/ 1.53')
      expect(shader.fragmentShader).not.toContain('smoothstep(0.38, 0.58, radius)')
      expect(shader.uniforms.uVolumeExposure!.value).toBeLessThanOrEqual(1)
      expect(shader.uniforms.uLightDirection!.value.length()).toBeCloseTo(1)
      const center = shader.uniforms.uCenter!.value as Vector3
      expect(center.toArray()).toEqual([2, 1, -12000])
      const size = shader.uniforms.uSize!.value as Vector3
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(size[axis] / 2).toBeGreaterThanOrEqual(shader.uniforms.uComaRadius!.value)
        expect(coma.scale[axis]).toBe(size[axis])
      }
    } finally { visual.dispose() }
  })

  it('uses only active births, never the head, uninitialized slots or a death upload', () => {
    const visual = createCometVisual(options)
    const tail = pool(24)
    tail.birthTime.fill(-1)
    visual.update(frame(), tail)
    const mesh = tailMesh(visual)
    expect(mesh.visible).toBe(false)
    born(tail, 0, -4)
    born(tail, 1, -6)
    born(tail, 2, 900)
    tail.active[2] = 2
    born(tail, 3, 800)
    tail.birthTime[3] = -1
    visual.update(frame(), tail)
    const uniforms = material(mesh).uniforms
    const bins = uniforms.uBins!.value as Float32Array
    const densities = uniforms.uDensities!.value as Float32Array
    const occupied = Array.from(densities).findIndex(value => value > 0)
    expect(occupied).toBeGreaterThanOrEqual(0)
    expect(bins[occupied * 4]).toBeCloseTo(-5)
    expect(bins[occupied * 4 + 1]).toBeCloseTo(2)
    expect(bins[occupied * 4 + 2]).toBeCloseTo(-9)
    const saved = Array.from(bins)
    visual.update(frame({ phase: 'hold', headX: 1000, headZ: -1000 }), tail)
    expect(Array.from(bins)).toEqual(saved)
    expect(mesh.visible).toBe(true)
    tail.active.fill(0)
    visual.update(frame({ phase: 'hold' }), tail)
    expect(mesh.visible).toBe(false)
    expect(Array.from(densities).every(value => value === 0)).toBe(true)
    expect(uniforms.uBins!.value).toBe(bins)
    expect(uniforms.uDensities!.value).toBe(densities)
    visual.dispose()
  })

  it('keeps axial spread out of transverse width and bounds rotated support at deep world Z', () => {
    const visual = createCometVisual(options)
    const tail = pool(96)
    const mesh = tailMesh(visual), uniforms = material(mesh).uniforms
    const axis = new Vector3(2, 1, 4).normalize()
    const across = new Vector3(-1, 2, 0).normalize()
    const populate = (stretch: number) => {
      for (let i = 0; i < tail.count; i++) {
        const bin = Math.floor(i / 32)
        const along = bin * 2 + ((i % 32) - 15.5) * 0.035 * stretch
        born(tail, i, 0, 0.08 + bin * 0.16)
        tail.positions.set([
          axis.x * along + across.x * (i % 2 ? 0.035 : -0.035),
          axis.y * along + across.y * (i % 2 ? 0.035 : -0.035),
          -12000 + axis.z * along,
        ], i * 3)
      }
      visual.update(frame(), tail)
    }
    populate(1)
    const bins = uniforms.uBins!.value as Float32Array
    const axes = uniforms.uBinAxes!.value as Float32Array
    const width = bins[7]!, long = axes[7]!
    populate(5)
    expect(bins[7]).toBeCloseTo(width, 2)
    expect(axes[7]).toBeGreaterThan(long)
    for (let j = 0; j < 3; j++) {
      const k = j * 4
      const direction = new Vector3(axes[k], axes[k + 1], axes[k + 2])
      expect(direction.length()).toBeCloseTo(1, 5)
      expect(direction.dot(axis)).toBeGreaterThan(0.999)
      expect(axes[k + 3]!).toBeGreaterThan(bins[k + 3]! * 3)
      if (j < 2) {
        const distance = Math.hypot(bins[k + 4]! - bins[k]!, bins[k + 5]! - bins[k + 1]!, bins[k + 6]! - bins[k + 2]!)
        expect(axes[k + 3]! + axes[k + 7]!).toBeGreaterThan(distance * 2)
      }
      const center = new Vector3(bins[k], bins[k + 1], bins[k + 2])
      for (const sign of [-1, 1]) {
        const endpoint = center.clone().addScaledVector(direction, sign * axes[k + 3]!).sub(mesh.position)
        expect(Math.abs(endpoint.x)).toBeLessThanOrEqual(mesh.scale.x / 2 + 0.002)
        expect(Math.abs(endpoint.y)).toBeLessThanOrEqual(mesh.scale.y / 2 + 0.002)
        expect(Math.abs(endpoint.z)).toBeLessThanOrEqual(mesh.scale.z / 2 + 0.002)
      }
    }
    const savedAxes = Array.from(axes)
    visual.update(frame({ phase: 'hold', headX: 9999, time: 9 }), tail)
    expect(Array.from(axes)).toEqual(savedAxes)
    expect(uniforms.uBinAxes!.value).toBe(axes)
    visual.update(frame({ reducedMotion: true, time: 100 }), tail)
    expect(uniforms.uTime!.value).toBe(0)
    visual.dispose()
  })

  it('bounds sparse density, fades with age, and keeps the two gas proxies texture-free', () => {
    const visual = createCometVisual(options)
    const tail = pool(24)
    const mesh = tailMesh(visual)
    born(tail, 0, -4)
    visual.update(frame(), tail)
    const densities = material(mesh).uniforms.uDensities!.value as Float32Array
    const sparse = Math.max(...densities)
    expect(sparse).toBeGreaterThan(0)
    expect(sparse).toBeLessThan(0.05)
    for (let i = 1; i < tail.count; i++) born(tail, i, -4 + i * 0.01)
    visual.update(frame(), tail)
    const young = Math.max(...densities)
    expect(young).toBeGreaterThan(sparse * 5)
    tail.age.fill(3.7)
    visual.update(frame(), tail)
    expect(Math.max(...densities)).toBeLessThan(young * 0.1)
    expect(visual.object.children).toHaveLength(2)
    const event = visual.object.children.find(object => 'uEventMode' in material(object as Mesh).uniforms)
    expect(event).toBeUndefined()
    for (const object of visual.object.children) {
      expect(object).toBeInstanceOf(Mesh)
      const shader = material(object as Mesh)
      expect(shader.blending).toBe(NormalBlending)
      expect(Object.values(shader.uniforms).some(uniform => uniform.value?.isTexture)).toBe(false)
    }
    expect(material(mesh).defines.MARCH_STEPS).toBe(12)
    expect(material(mesh).depthWrite).toBe(false)
    const coma = visual.object.getObjectByName('comet-coma-volume') as Mesh
    expect(coma.scale.x).toBeCloseTo(COMET_COMA_RADIUS * 2)
    const comaExposure = material(coma).uniforms.uVolumeExposure!.value
    for (const light of [false, true]) {
      visual.update(frame({ light }), tail)
      expect(material(coma).uniforms.uVolumeExposure!.value).toBe(comaExposure)
      expect(material(coma).uniforms.uOpacity!.value).toBe(0.045)
      expect(material(mesh).uniforms.uVolumeExposure!.value).toBe(0.55)
      expect(material(mesh).uniforms.uOpacity!.value).toBe(0.06)
    }
    visual.update(frame({ phase: 'gather', progress: 1, glyphMix: 1 }), tail)
    expect(coma.visible).toBe(false)
    visual.update(frame({ phase: 'hold' }), tail)
    expect(coma.visible).toBe(false)
    visual.dispose()
    const mobile = createCometVisual({ ...options, particleCount: 800 })
    expect(material(tailMesh(mobile)).defines.MARCH_STEPS).toBe(8)
    mobile.dispose()
  })
})
