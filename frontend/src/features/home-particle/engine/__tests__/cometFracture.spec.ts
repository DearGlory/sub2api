import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Mesh, Points, Vector3 } from 'three'
import type { BufferAttribute, BufferGeometry } from 'three'
import { createCometSurface } from '../cometSurface'
import { createCometVisual } from '../cometVisual'
import { cometFractureVertex } from '../cometFracture'
import { createEngineScratch } from '../ParticleEngine'
import { createStarfield } from '../starfield'
import { createQualityProfile } from '../quality'
import { COMET_SURFACE_RADIUS } from '../cometVisualContract'
import type { CometVisualFrame } from '../cometVisualContract'

const options = { particleCount: 18000, light: false, reducedMotion: false }
const point = (geometry: BufferGeometry, i: number) => new Vector3().fromBufferAttribute(geometry.getAttribute('position'), i)
const key = (p: Vector3) => p.toArray().map(value => value.toFixed(6)).join(',')
const frame = (changes: Partial<CometVisualFrame> = {}): CometVisualFrame => ({
  phase: 'gather', progress: 0.18, time: 0, delta: 1 / 60, headX: 0, headY: 0,
  headZ: 0, glyphMix: 0, departure: 1, light: false, reducedMotion: false, ...changes,
})
const hash = (array: ArrayBufferView): string => createHash('sha256')
  .update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex')

// Evaluate the production shader's scalar/axis expressions with CPU vectors. This
// checks actual attributes and uniforms, but deliberately makes no GPU/pixel claim.
const scalar = (name: string) => {
  const expression = cometFractureVertex.match(new RegExp(`(?:float|vec3) ${name} = ([^;]+);`))![1]!
  return new Function('aSeed', 'uFracture', 'core', 'mix', 'vec3', 'normalize', `return ${expression}`)
}
const speedExpression = scalar('speed'), angleExpression = scalar('angle'), axisExpression = scalar('axis')
function transform(geometry: BufferGeometry, i: number, fracture: number, expansion: number) {
  const center = new Vector3().fromBufferAttribute(geometry.getAttribute('aFaceCenter'), i)
  const seed = geometry.getAttribute('aSeed').getX(i)
  const core = geometry.getAttribute('aFractureNormal').getW(i) > 1.5 ? 1 : 0
  const args = [seed, fracture, core, (a: number, b: number, t: number) => a + (b - a) * t,
    (x: number, y: number, z: number) => new Vector3(x, y, z), (v: Vector3) => v.normalize()]
  const axis = axisExpression(...args) as Vector3
  const angle = angleExpression(...args) as number
  const offset = center.clone().normalize().multiplyScalar(expansion * (speedExpression(...args) as number))
  return { p: point(geometry, i).sub(center).applyAxisAngle(axis, angle).add(center).add(offset), offset, axis, angle }
}
function pieces(geometry: BufferGeometry): number[][] {
  const centers = geometry.getAttribute('aFaceCenter')
  const groups = new Map<string, number[]>()
  for (let i = 0; i < centers.count; i++) {
    const id = key(new Vector3().fromBufferAttribute(centers, i))
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(i)
  }
  return [...groups.values()]
}

// These inspect the real factory, so the former triangle-only surface fails without a stub.
describe('closed, rigid comet fracture geometry', () => {
  it('closes every piece with two opposite uses of every edge', () => {
    const surface = createCometSurface(options)
    try {
      for (const group of pieces(surface.mesh.geometry)) {
        const edges = new Map<string, { uses: number; winding: number }>()
        for (let i = 0; i < group.length; i += 3) {
          const triangle = group.slice(i, i + 3).map(vertex => key(point(surface.mesh.geometry, vertex)))
          for (let j = 0; j < 3; j++) {
            const a = triangle[j]!, b = triangle[(j + 1) % 3]!
            const id = [a, b].sort().join('|')
            const edge = edges.get(id) ?? { uses: 0, winding: 0 }
            edge.uses++
            edge.winding += a < b ? 1 : -1
            edges.set(id, edge)
          }
        }
        expect([...edges.values()].filter(edge => edge.uses !== 2 || edge.winding !== 0)).toEqual([])
      }
    } finally { surface.dispose() }
  })

  it('gives every piece positive signed volume and substantial inward depth', () => {
    const surface = createCometSurface(options)
    try {
      const geometry = surface.mesh.geometry
      let totalVolume = 0
      for (const group of pieces(geometry)) {
        const center = new Vector3().fromBufferAttribute(geometry.getAttribute('aFaceCenter'), group[0]!)
        const radial = center.clone().normalize()
        let volume = 0, near = Infinity, far = -Infinity
        for (let i = 0; i < group.length; i += 3) {
          const a = point(geometry, group[i]!).sub(center)
          const b = point(geometry, group[i + 1]!).sub(center)
          const c = point(geometry, group[i + 2]!).sub(center)
          volume += a.dot(b.cross(c)) / 6
        }
        for (const vertex of group) {
          const depth = point(geometry, vertex).dot(radial)
          near = Math.min(near, depth)
          far = Math.max(far, depth)
        }
        expect(volume).toBeGreaterThan(COMET_SURFACE_RADIUS ** 3 * 0.001)
        expect(far - near).toBeGreaterThan(COMET_SURFACE_RADIUS * 0.2)
        totalVolume += volume
      }
      expect(totalVolume).toBeGreaterThan(COMET_SURFACE_RADIUS ** 3 * 2)
    } finally { surface.dispose() }
  })

  it('groups many triangles into a bounded set of rigid pieces with one seed and center each', () => {
    const surface = createCometSurface(options)
    try {
      const geometry = surface.mesh.geometry
      const groups = pieces(geometry)
      expect(groups.length).toBeGreaterThanOrEqual(12)
      expect(groups.length).toBeLessThanOrEqual(64)
      for (const group of groups) {
        expect(group.length).toBeGreaterThanOrEqual(12)
        const seeds = new Set(group.map(vertex => geometry.getAttribute('aSeed').getX(vertex)))
        expect(seeds.size).toBe(1)
      }
      // Normal-dependent displacement tears a triangle even when its center is shared.
      expect(surface.mesh.material.vertexShader).not.toMatch(/p\s*\+=\s*normal\s*\*/)
    } finally { surface.dispose() }
  })

  it('preserves pairwise distances while opening seeded gaps and retaining a slower inner layer', () => {
    const surface = createCometSurface(options)
    try {
      const geometry = surface.mesh.geometry
      expect(surface.mesh.material.vertexShader).toContain(cometFractureVertex)
      expect(cometFractureVertex).toContain('p = aFaceCenter + fractureRotate(position - aFaceCenter, axis, angle);')
      expect(cometFractureVertex).toContain('p += normalize(aFaceCenter) * uExpansion * speed;')
      expect(cometFractureVertex).toContain('v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c)')
      const groups = pieces(geometry)
      for (const q of [0.1, 0.18, 0.25, 0.4, 0.549]) {
        surface.update(frame({ progress: q }))
        const fracture = surface.mesh.material.uniforms.uFracture!.value as number
        const expansion = surface.mesh.material.uniforms.uExpansion!.value as number
        const outerSpeeds: number[] = [], innerSpeeds: number[] = []
        const seams = new Map<string, Vector3>()
        let opened = 0
        for (const group of groups) {
          const first = group[0]!
          const base = transform(geometry, first, fracture, expansion)
          const layer = geometry.getAttribute('aFractureNormal').getW(first)
          ;(layer > 1.5 ? innerSpeeds : outerSpeeds).push(base.offset.length())
          for (const i of group) {
            const moved = transform(geometry, i, fracture, expansion)
            expect(moved.p.distanceTo(base.p)).toBeCloseTo(point(geometry, i).distanceTo(point(geometry, first)), 6)
            expect(moved.offset.distanceTo(base.offset)).toBeLessThan(1e-8)
            expect(moved.axis.distanceTo(base.axis)).toBeLessThan(1e-8)
            expect(moved.angle).toBe(base.angle)
            expect(moved.p.distanceTo(geometry.boundingSphere!.center)).toBeLessThan(geometry.boundingSphere!.radius)
            const id = key(point(geometry, i))
            if (layer === 0 && seams.has(id) && moved.p.distanceTo(seams.get(id)!) > 0.001) opened++
            seams.set(id, moved.p)
          }
        }
        expect(opened).toBeGreaterThan(100)
        expect(Math.max(...innerSpeeds)).toBeLessThan(Math.min(...outerSpeeds))
        expect(Math.max(...outerSpeeds) - Math.min(...outerSpeeds)).toBeGreaterThan(expansion * 0.3)
      }
    } finally { surface.dispose() }
  })

  it('preserves the .72 terrain hashes and scales every exterior vertex to .9 with the same normals', async () => {
    // Run the real factory once at the historical radius. Keeping the ORIGINAL hashes
    // prevents a changed terrain function from passing by regenerating both references.
    vi.doMock('../cometVisualContract', async () => ({
      ...await vi.importActual<typeof import('../cometVisualContract')>('../cometVisualContract'),
      COMET_SURFACE_RADIUS: 0.72,
    }))
    vi.resetModules()
    const baseline = (await import('../cometSurface')).createCometSurface(options)
    vi.doUnmock('../cometVisualContract')
    vi.resetModules()
    const surface = createCometSurface(options)
    try {
      const geometry = surface.mesh.geometry
      const baselineVertices = 21660
      const oldPosition = (baseline.mesh.geometry.getAttribute('position').array as Float32Array).subarray(0, baselineVertices * 3)
      const oldNormal = (baseline.mesh.geometry.getAttribute('normal').array as Float32Array).subarray(0, baselineVertices * 3)
      expect(hash(oldPosition)).toBe('97b29e3c6badaa0eb0cd5a1e4a8e8c39289c7cea599d00144548d096ed6b0b43')
      expect(hash(oldNormal)).toBe('6f0af534250a985526a1b4587163a57d7350b70c1dba65c380dd642c9b9c4801')
      const position = geometry.getAttribute('position'), terrainNormal = geometry.getAttribute('normal')
      const scale = COMET_SURFACE_RADIUS / 0.72
      let maxPositionError = 0, maxNormalError = 0
      for (let i = 0; i < baselineVertices * 3; i++) {
        maxPositionError = Math.max(maxPositionError, Math.abs(position.array[i]! / scale - oldPosition[i]!))
        maxNormalError = Math.max(maxNormalError, Math.abs(terrainNormal.array[i]! - oldNormal[i]!))
      }
      // Float32 icosahedron direction rounding is the only permitted difference.
      expect(maxPositionError).toBeLessThan(0.000002)
      expect(maxNormalError).toBeLessThan(0.0001)
      baseline.mesh.geometry.computeBoundingBox()
      geometry.computeBoundingBox()
      const oldSpan = baseline.mesh.geometry.boundingBox!.getSize(new Vector3())
      const span = geometry.boundingBox!.getSize(new Vector3())
      for (const axis of ['x', 'y', 'z'] as const) expect(span[axis] / oldSpan[axis]).toBeCloseTo(1.25, 5)
      console.info('scaled terrain preservation (CPU)', { span: span.toArray(), maxPositionError, maxNormalError })
      const count = geometry.getAttribute('position').count
      for (const attribute of Object.values(geometry.attributes)) {
        expect(attribute.count).toBe(count)
        expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true)
      }
      const normal = geometry.getAttribute('normal'), cut = geometry.getAttribute('aFractureNormal')
      let interior = 0
      for (let i = 0; i < count; i++) {
        expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 5)
        expect(Math.hypot(cut.getX(i), cut.getY(i), cut.getZ(i))).toBeCloseTo(1, 5)
        if (cut.getW(i) > 0) interior++
      }
      expect(interior).toBeGreaterThan(0)
      console.info('fracture geometry (CPU)', { pieces: pieces(geometry).length, vertices: count, triangles: count / 3,
        bytes: Object.values(geometry.attributes).reduce((sum, a) => sum + a.array.byteLength, 0) })
    } finally { surface.dispose(); baseline.dispose() }
  })

  it('returns exactly to rest, disables fracture for reduced motion, and never uploads geometry during updates', () => {
    const surface = createCometSurface(options)
    const geometry = surface.mesh.geometry
    const attributes = Object.values(geometry.attributes) as BufferAttribute[]
    const before = attributes.map(attribute => ({ attribute, array: attribute.array, version: attribute.version, hash: hash(attribute.array) }))
    let geometryDisposals = 0, materialDisposals = 0
    geometry.addEventListener('dispose', () => geometryDisposals++)
    surface.mesh.material.addEventListener('dispose', () => materialDisposals++)
    try {
      for (const progress of [0, 0.05, 0.1, 0.18, 0.4, 0.55, 1]) surface.update(frame({ progress }))
      expect(surface.mesh.visible).toBe(false)
      for (const changes of [
        { phase: 'scatter' as const, progress: 1 },
        { phase: 'travel' as const, progress: 1 },
        { phase: 'gather' as const, progress: 0.25, reducedMotion: true },
      ]) {
        surface.update(frame(changes))
        expect(surface.mesh.visible).toBe(true)
        expect(surface.mesh.material.uniforms.uFracture!.value).toBe(0)
        expect(surface.mesh.material.uniforms.uExpansion!.value).toBe(0)
        for (const group of pieces(geometry)) {
          for (const i of [group[0]!, group[group.length - 1]!]) {
            expect(transform(geometry, i, 0, 0).p.distanceTo(point(geometry, i))).toBeLessThan(1e-8)
          }
        }
      }
      for (const saved of before) {
        expect(saved.attribute.array).toBe(saved.array)
        expect(saved.attribute.version).toBe(saved.version)
        expect(hash(saved.attribute.array)).toBe(saved.hash)
      }
    } finally { surface.dispose() }
    expect(geometryDisposals).toBe(1)
    expect(materialDisposals).toBe(1)
  })

  it('counts every model and event attribute within the full high-quality scene budget', () => {
    const quality = createQualityProfile()
    const visual = createCometVisual({ ...options, particleCount: quality.particleCount })
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const stars = createStarfield({ count: quality.starCount, isLightTheme: false, reducedMotion: false })
    try {
      let visualBytes = 0, starBytes = 0, draws = 2 // Existing body and emitted-tail Points.
      const bytes = (geometry: BufferGeometry) => Object.values(geometry.attributes)
        .reduce((sum, a) => sum + a.array.byteLength, geometry.index?.array.byteLength ?? 0)
      visual.object.traverse(object => {
        if (!(object instanceof Mesh)) return
        expect(Array.isArray(object.material)).toBe(false)
        if (object.name === 'comet-nucleus') expect(object.geometry.groups).toHaveLength(0)
        visualBytes += bytes(object.geometry)
        draws++
      })
      stars.object.traverse(object => { if (object instanceof Points) { starBytes += bytes(object.geometry); draws++ } })
      const scratch = createEngineScratch(quality.particleCount, quality.tailSampleCount)
      const particleBytes = scratch.positions.byteLength + scratch.colors.byteLength + scratch.body.spriteScale.byteLength
        + scratch.emittedTail.positions.byteLength + scratch.emittedTail.colors.byteLength
      const total = visualBytes + starBytes + particleBytes
      expect(visual.object.children).toHaveLength(4)
      expect(visual.geometryBytes).toBe(visualBytes)
      expect(total).toBeLessThanOrEqual(3500000)
      expect(draws).toBeLessThanOrEqual(10)
      console.info('full scene geometry budget (CPU; draw upper bound, not GPU measurement)',
        { visualBytes, particleBytes, starBytes, total, draws })
    } finally { visual.dispose(); stars.dispose(); context.mockRestore() }
  })
})
