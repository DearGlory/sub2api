import { BufferAttribute, IcosahedronGeometry, Triangle, Vector3 } from 'three'
import type { BufferGeometry } from 'three'

/** One orthogonal transform per closed piece; shading normals never drive translation. */
export const cometFractureVertex = /* glsl */ `
  attribute vec4 aFractureNormal;
  vec3 fractureRotate(vec3 v, vec3 axis, float angle) {
    float c = cos(angle), s = sin(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }
  void fractureTransform(out vec3 p, out vec3 n) {
    float core = step(1.5, aFractureNormal.w);
    float speed = mix(0.7 + 0.65 * aSeed, 0.24 + 0.26 * aSeed, core);
    vec3 axis = normalize(vec3(0.37 + aSeed, 1.0 - 0.6 * aSeed, -0.45 + 0.9 * aSeed));
    float angle = uFracture * (aSeed - 0.5) * 0.72;
    p = aFaceCenter + fractureRotate(position - aFaceCenter, axis, angle);
    p += normalize(aFaceCenter) * uExpansion * speed;
    // At rest the original continuous terrain normals are untouched. As cracks open,
    // the buried walls acquire their actual face normals instead of radial shading.
    n = normalize(mix(normal, aFractureNormal.xyz, smoothstep(0.0, 0.12, uFracture)));
    n = fractureRotate(n, axis, angle);
  }
`

const vertexKey = (p: Vector3): string => p.toArray().map(value => value.toFixed(6)).join(',')
const pieceSeed = (id: number): number => {
  const value = Math.sin((id + 1) * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Retain every fine terrain triangle and weld its base-icosahedron patch into one
 * closed rock cone. Deep inward caps and a slower buried layer supply real volume,
 * with no low-poly replacement, extra mesh, groups, or per-frame geometry uploads.
 * The input is the non-indexed, displaced IcosahedronGeometry used by the surface.
 */
export function closeCometFractures(geometry: BufferGeometry): void {
  const sourcePosition = geometry.getAttribute('position')
  const sourceNormal = geometry.getAttribute('normal')
  const coarse = new IcosahedronGeometry(1, 0)
  const coarsePosition = coarse.getAttribute('position')
  const pieceCount = coarsePosition.count / 3
  // Three emits each subdivided base face contiguously, regardless of its detail.
  const patchSize = sourcePosition.count / pieceCount
  const positions = Array.from(sourcePosition.array)
  const normals = Array.from(sourceNormal.array)
  const centers = new Array<number>(positions.length)
  const barycentrics = new Array<number>(positions.length)
  const seeds = new Array<number>(sourcePosition.count)
  const fractureNormals = new Array<number>(sourcePosition.count * 4)
  const smoothNormals = new Map<string, Vector3>()
  for (let i = 0; i < sourcePosition.count; i++) {
    smoothNormals.set(vertexKey(new Vector3().fromBufferAttribute(sourcePosition, i)),
      new Vector3().fromBufferAttribute(sourceNormal, i))
  }

  const appendTriangle = (a: Vector3, b: Vector3, c: Vector3, center: Vector3, seed: number, layer: number) => {
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    for (const p of [a, b, c]) {
      const restNormal = smoothNormals.get(vertexKey(p)) ?? (p.lengthSq() > 0 ? p.clone().normalize() : new Vector3(0, 0, 1))
      positions.push(p.x, p.y, p.z)
      normals.push(restNormal.x, restNormal.y, restNormal.z)
      centers.push(center.x, center.y, center.z)
      // Energy stays on a few exterior block boundaries, never every interior triangle.
      barycentrics.push(1, 1, 1)
      seeds.push(seed)
      fractureNormals.push(normal.x, normal.y, normal.z, layer)
    }
  }

  for (let piece = 0; piece < pieceCount; piece++) {
    const start = piece * patchSize, end = start + patchSize
    const a = new Vector3().fromBufferAttribute(coarsePosition, piece * 3)
    const b = new Vector3().fromBufferAttribute(coarsePosition, piece * 3 + 1)
    const c = new Vector3().fromBufferAttribute(coarsePosition, piece * 3 + 2)
    const plane = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    const patchCenter = new Vector3()
    const boundary = new Map<string, [Vector3, Vector3]>()
    const seed = pieceSeed(piece)
    for (let i = start; i < end; i += 3) {
      const triangle = [0, 1, 2].map(j => new Vector3().fromBufferAttribute(sourcePosition, i + j))
      for (let j = 0; j < 3; j++) {
        const p = triangle[j]!, next = triangle[(j + 1) % 3]!
        patchCenter.add(p)
        const edge = [vertexKey(p), vertexKey(next)].sort().join('|')
        if (boundary.has(edge)) boundary.delete(edge)
        else boundary.set(edge, [p, next])
        // Project back through the surface's ellipsoid onto its original base face.
        // Macro barycentrics light cracks between rocks, not the fine terrain grid.
        const direction = new Vector3(p.x / 1.1, p.y / 0.92, p.z).normalize()
        direction.multiplyScalar(a.dot(plane) / direction.dot(plane))
        const bary = Triangle.getBarycoord(direction, a, b, c, new Vector3())!
        barycentrics[(i + j) * 3] = bary.x
        barycentrics[(i + j) * 3 + 1] = bary.y
        barycentrics[(i + j) * 3 + 2] = bary.z
      }
    }
    patchCenter.divideScalar(patchSize)
    const center = patchCenter.clone().multiplyScalar(0.72)
    const tip = patchCenter.clone().multiplyScalar(0.16 + seed * 0.1)
    for (let i = start; i < end; i++) {
      centers[i * 3] = center.x
      centers[i * 3 + 1] = center.y
      centers[i * 3 + 2] = center.z
      seeds[i] = seed
      fractureNormals[i * 4] = sourceNormal.getX(i)
      fractureNormals[i * 4 + 1] = sourceNormal.getY(i)
      fractureNormals[i * 4 + 2] = sourceNormal.getZ(i)
      fractureNormals[i * 4 + 3] = 0
    }
    for (const [p, next] of boundary.values()) {
      const cutNormal = p.clone().sub(next).cross(tip.clone().sub(next)).normalize()
      // A raised, buried fracture ridge makes the deep cut genuinely uneven.
      // Its shared normal is independent of the untouched exterior terrain seam.
      const ridge = next.clone().add(p).add(tip).multiplyScalar(1 / 3)
        .addScaledVector(cutNormal, patchCenter.length() * (0.009 + seed * 0.014))
      smoothNormals.set(vertexKey(ridge), cutNormal)
      appendTriangle(ridge, next, p, center, seed, 1)
      appendTriangle(ridge, p, tip, center, seed, 1)
      appendTriangle(ridge, tip, next, center, seed, 1)
    }

    // A second, fully buried stratum moves more slowly, breaking the hollow-shell
    // silhouette. Its low-detail tetrahedra remain inside the detailed resting skin.
    const corners = [a, b, c].map(corner => {
      let closest = start, alignment = -Infinity
      for (let i = start; i < end; i++) {
        const p = new Vector3().fromBufferAttribute(sourcePosition, i)
        const dot = new Vector3(p.x / 1.1, p.y / 0.92, p.z).normalize().dot(corner)
        if (dot > alignment) { alignment = dot; closest = i }
      }
      return new Vector3().fromBufferAttribute(sourcePosition, closest).multiplyScalar(0.34)
    })
    const coreCenter = corners[0]!.clone().add(corners[1]!).add(corners[2]!).multiplyScalar(0.25)
    const coreSeed = pieceSeed(piece + pieceCount)
    appendTriangle(corners[0]!, corners[1]!, corners[2]!, coreCenter, coreSeed, 2)
    for (let j = 0; j < 3; j++) {
      appendTriangle(corners[(j + 1) % 3]!, corners[j]!, new Vector3(), coreCenter, coreSeed, 2)
    }
  }
  coarse.dispose()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('aFaceCenter', new BufferAttribute(new Float32Array(centers), 3))
  geometry.setAttribute('aBarycentric', new BufferAttribute(new Float32Array(barycentrics), 3))
  geometry.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1))
  // xyz = actual fracture-plane normal; w = terrain / wall / buried core.
  geometry.setAttribute('aFractureNormal', new BufferAttribute(new Float32Array(fractureNormals), 4))
}
