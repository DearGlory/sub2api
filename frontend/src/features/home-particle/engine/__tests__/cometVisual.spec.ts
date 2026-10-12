import { describe, expect, it } from 'vitest'
import { BufferGeometry, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import { createCometVisual } from '../cometVisual'
import { COMET_COMA_RADIUS, COMET_SURFACE_RADIUS, COMET_VOLUME_SCALE } from '../cometVisualContract'
import type { CometTailView, CometVisualFrame } from '../cometVisualContract'

const options = { particleCount: 18000, light: false, reducedMotion: false }
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
    expect(bytes).toBeLessThanOrEqual(3500000)
    // Impact revision: body/coma scale 1.8; solid terrain grows .72 -> .9 on every axis.
    expect(COMET_VOLUME_SCALE).toBe(1.8)
    expect(COMET_COMA_RADIUS / 1.02).toBeCloseTo(1.8)
    expect(COMET_SURFACE_RADIUS).toBe(0.9)
    visual.dispose()
  })

  it('shares terrain normals at duplicate vertices while following actual displaced slopes', () => {
    const visual = createCometVisual(options)
    const geometry = nucleus(visual).geometry
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal')
    const shared = new Map<string, Vector3>()
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3()
    let duplicates = 0, sloped = 0, aligned = 0
    for (let i = 0; i < positions.count; i++) {
      a.fromBufferAttribute(positions, i)
      n.fromBufferAttribute(normals, i)
      const key = a.toArray().map(value => value.toFixed(6)).join(',')
      const previous = shared.get(key)
      if (previous) { expect(n.distanceTo(previous)).toBeLessThan(0.0001); duplicates++ }
      else shared.set(key, n.clone())
      expect(n.length()).toBeCloseTo(1, 5)
      if (n.dot(a.normalize()) < 0.95) sloped++
      if (i % 3 === 0) {
        a.fromBufferAttribute(positions, i)
        b.fromBufferAttribute(positions, i + 1).sub(a)
        c.fromBufferAttribute(positions, i + 2).sub(a)
        if (b.cross(c).normalize().dot(n) > 0.7) aligned++
      }
    }
    expect(duplicates).toBeGreaterThan(positions.count / 2)
    expect(sloped).toBeGreaterThan(positions.count * 0.2)
    expect(aligned).toBeGreaterThan(positions.count / 3 * 0.8)
    visual.dispose()
  })

  it('uses rough directional lighting without textures or additive blending in either theme', () => {
    const visual = createCometVisual(options)
    const shader = material(nucleus(visual))
    expect(shader.blending).toBe(NormalBlending)
    expect(shader.uniforms.uRoughness!.value).toBeGreaterThan(0.7)
    expect(shader.uniforms.uLightDirection!.value.length()).toBeCloseTo(1)
    expect(shader.fragmentShader).toContain('dot(N, L)')
    const exposure = shader.uniforms.uSurfaceExposure!.value
    expect(exposure).toBe(0.162)
    for (const light of [false, true]) {
      visual.update(frame({ light }), pool())
      expect(shader.uniforms.uLightTheme!.value).toBe(light ? 1 : 0)
      expect(shader.uniforms.uSurfaceExposure!.value).toBe(exposure)
      expect(shader.uniforms.uOpacity!.value).toBe(1)
      expect(shader.depthWrite).toBe(true)
    }
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
    expect(uniforms.uTime!.value).toBe(9)
    visual.dispose()
  })

  it('bounds sparse density, fades with age, and creates only three texture-free meshes', () => {
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
    expect(visual.object.children).toHaveLength(3)
    for (const object of visual.object.children) {
      expect(object).toBeInstanceOf(Mesh)
      const shader = material(object as Mesh)
      expect(shader.blending).toBe(NormalBlending)
      expect(Object.values(shader.uniforms).some(uniform => uniform.value?.isTexture)).toBe(false)
    }
    expect(material(mesh).defines.MARCH_STEPS).toBe(28)
    expect(material(mesh).depthWrite).toBe(false)
    const coma = visual.object.getObjectByName('comet-coma-volume') as Mesh
    expect(coma.scale.x).toBeCloseTo(COMET_COMA_RADIUS * 2)
    const comaExposure = material(coma).uniforms.uVolumeExposure!.value
    for (const light of [false, true]) {
      visual.update(frame({ light }), tail)
      expect(material(coma).uniforms.uVolumeExposure!.value).toBe(comaExposure)
      expect(material(coma).uniforms.uOpacity!.value).toBe(0.72)
      expect(material(mesh).uniforms.uVolumeExposure!.value).toBe(1)
      expect(material(mesh).uniforms.uOpacity!.value).toBe(1)
    }
    visual.update(frame({ phase: 'gather', progress: 1 }), tail)
    expect(coma.visible).toBe(false)
    visual.update(frame({ phase: 'hold' }), tail)
    expect(coma.visible).toBe(false)
    visual.dispose()
    const mobile = createCometVisual({ ...options, particleCount: 800 })
    expect(material(tailMesh(mobile)).defines.MARCH_STEPS).toBe(16)
    mobile.dispose()
  })
})
