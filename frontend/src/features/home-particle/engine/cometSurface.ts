import { IcosahedronGeometry, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import { closeCometFractures, cometFractureVertex } from './cometFracture'
import { COMET_SURFACE_RADIUS } from './cometVisualContract'
import type { CometVisualFrame, CometVisualOptions } from './cometVisualContract'

export const smoothEnvelope = (start: number, end: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - start) / (end - start)))
  return t * t * (3 - 2 * t)
}

/** Shared continuous visibility; the emitted tail deliberately does not use this envelope. */
export function nucleusEnvelope(frame: CometVisualFrame): number {
  if (frame.phase === 'gather') return 1 - smoothEnvelope(0.12, 0.55, frame.progress)
  if (frame.phase === 'hold') return 0
  if (frame.phase === 'scatter') return smoothEnvelope(0.7, 1, Math.min(frame.progress / 0.62, 1))
  return 1
}

const vertexShader = /* glsl */ `
  attribute vec3 aFaceCenter;
  attribute vec3 aBarycentric;
  attribute float aSeed;
  uniform float uFracture;
  uniform float uExpansion;
  uniform float uTerrainScale;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vBarycentric;
  varying vec3 vView;
  varying float vSeed;
  ${cometFractureVertex}
  void main() {
    vec3 p, n;
    fractureTransform(p, n);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vView = -view.xyz;
    vNormal = normalize(normalMatrix * n);
    // Keep rock/ice strata and roughness attached to the same enlarged terrain.
    vLocal = position * uTerrainScale;
    vBarycentric = aBarycentric;
    vSeed = aSeed;
    gl_Position = projectionMatrix * view;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uLightDirection;
  uniform float uRoughness;
  uniform float uSurfaceExposure;
  uniform float uOpacity;
  uniform float uEnergy;
  uniform float uLightTheme;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vBarycentric;
  varying vec3 vView;
  varying float vSeed;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                   mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                   mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }
  float relief(vec3 p) {
    vec3 warp = vec3(noise(p*3.1), noise(p*3.1+17.0), noise(p*3.1-9.0));
    return noise(p*24.0+warp*2.3)*0.012 + noise(p*67.0+warp)*0.0035;
  }
  void main() {
    vec3 N = normalize(vNormal);
    // Surface-gradient bump uses actual view-space tangents, so relief follows the terrain.
    vec3 dx = dFdx(-vView), dy = dFdy(-vView);
    vec3 rx = cross(dy, N), ry = cross(N, dx);
    float det = dot(dx, rx);
    float height = relief(vLocal);
    N = normalize(abs(det)*N - sign(det)*(dFdx(height)*rx + dFdy(height)*ry));
    vec3 L = normalize((viewMatrix * vec4(uLightDirection, 0.0)).xyz);
    vec3 V = normalize(vView);
    float nl = max(dot(N, L), 0.0);
    float nv = max(dot(N, V), 0.01);
    // Oren–Nayar rough diffuse: terrain normals, view and an independent world sun.
    float sigma2 = uRoughness * uRoughness;
    float A = 1.0 - 0.5 * sigma2 / (sigma2 + 0.33);
    float B = 0.45 * sigma2 / (sigma2 + 0.09);
    float grazing = max(dot(L - N * nl, V - N * nv), 0.0);
    float diffuse = nl * (A + B * grazing / max(max(nl, nv), 0.12));
    float strata = noise(vLocal * 5.0 + noise(vLocal * 2.8) * 2.0);
    float grain = noise(vLocal * 74.0);
    float ice = smoothstep(0.47, 0.76, strata + 0.18 * noise(vLocal * 17.0));
    vec3 rock = mix(vec3(0.20, 0.225, 0.25), vec3(0.43, 0.49, 0.53), ice);
    rock = mix(rock, vec3(0.30, 0.26, 0.22), smoothstep(0.59, 0.8, noise(vLocal * 5.0 + 13.0)) * 0.5);
    rock *= 0.76 + 0.3 * grain;
    // Low sky fill preserves the dark hemisphere without flattening sun-facing relief.
    vec3 ambient = vec3(0.085, 0.105, 0.14) + uLightTheme * vec3(0.025);
    vec3 color = rock * (ambient + vec3(1.02, 0.94, 0.82) * diffuse * 1.08);
    float edge = 1.0 - smoothstep(0.01, 0.07, min(vBarycentric.x, min(vBarycentric.y, vBarycentric.z)));
    color += vec3(0.28, 0.10, 0.026) * uEnergy * edge * step(0.76, vSeed);
    // Expose linear radiance before the display transform; preserve solid depth and alpha.
    gl_FragColor = vec4(color * uSurfaceExposure, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const terrainHash = (x: number, y: number, z: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return h - Math.floor(h)
}
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
function terrainNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz)
  return mix(mix(mix(terrainHash(ix, iy, iz), terrainHash(ix + 1, iy, iz), u),
    mix(terrainHash(ix, iy + 1, iz), terrainHash(ix + 1, iy + 1, iz), u), v),
  mix(mix(terrainHash(ix, iy, iz + 1), terrainHash(ix + 1, iy, iz + 1), u),
    mix(terrainHash(ix, iy + 1, iz + 1), terrainHash(ix + 1, iy + 1, iz + 1), u), v), w)
}
function terrainRadius(x: number, y: number, z: number): number {
  const warp = terrainNoise(x * 2.7 + 5, y * 2.7, z * 2.7)
  const field = terrainNoise(x * 4.1 + warp, y * 4.1 - warp * 0.6, z * 4.1 + warp * 0.8)
  // Broad, broken erosional channels are actual geometry, not dark contour paint.
  const channel = 1 - smoothEnvelope(0.025, 0.13, Math.abs(field - 0.48))
  const erosion = 0.35 + 0.65 * terrainNoise(x * 7 - 3, y * 7 + 8, z * 7)
  return 1 + 0.22 * (terrainNoise(x * 2.5, y * 2.5, z * 2.5) - 0.5)
    + 0.085 * (terrainNoise(x * 8, y * 8, z * 8) - 0.5)
    + 0.025 * (terrainNoise(x * 15, y * 15, z * 15) - 0.5) - 0.16 * channel * erosion
}

/** Procedural rock/ice terrain, not a scanned astronomical asset. */
export function createCometSurface(options: CometVisualOptions) {
  // Non-indexed triangles retain fracture centres. Continuous terrain normals share their height field.
  const geometry = new IcosahedronGeometry(COMET_SURFACE_RADIUS, 18)
  geometry.deleteAttribute('uv')
  const position = geometry.getAttribute('position')
  const normals = geometry.getAttribute('normal')
  const direction = new Vector3(), edge = new Vector3(), face = new Vector3()
  const sharedNormals = new Map<string, Vector3>()
  const keys: string[] = []
  for (let i = 0; i < position.count; i++) {
    direction.fromBufferAttribute(position, i).normalize()
    const { x, y, z } = direction
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`
    keys.push(key)
    if (!sharedNormals.has(key)) sharedNormals.set(key, new Vector3())
    const terrain = terrainRadius(x, y, z)
    position.setXYZ(i, x * COMET_SURFACE_RADIUS * terrain * 1.1,
      y * COMET_SURFACE_RADIUS * terrain * 0.92, z * COMET_SURFACE_RADIUS * terrain)
  }
  // Area-weighted normals from the rendered triangles, welded only for resting shading.
  // The geometry stays non-indexed so fracture centres and barycentrics remain independent.
  for (let i = 0; i < position.count; i += 3) {
    direction.fromBufferAttribute(position, i)
    edge.fromBufferAttribute(position, i + 1).sub(direction)
    face.fromBufferAttribute(position, i + 2).sub(direction)
    face.crossVectors(edge, face)
    for (let j = 0; j < 3; j++) sharedNormals.get(keys[i + j]!)!.add(face)
  }
  for (let i = 0; i < position.count; i++) {
    direction.copy(sharedNormals.get(keys[i]!)!).normalize()
    normals.setXYZ(i, direction.x, direction.y, direction.z)
  }
  position.needsUpdate = true
  normals.needsUpdate = true
  closeCometFractures(geometry)
  geometry.computeBoundingSphere()
  // Fragments may expand beyond the resting surface's bounds.
  geometry.boundingSphere!.radius += 1.6
  const material = new ShaderMaterial({
    name: 'comet-rough-rock-ice', vertexShader, fragmentShader,
    uniforms: {
      uLightDirection: { value: new Vector3(-1.4, 0.95, 0.55).normalize() },
      uRoughness: { value: 0.92 }, uSurfaceExposure: { value: 0.162 },
      uTerrainScale: { value: 0.72 / COMET_SURFACE_RADIUS },
      uOpacity: { value: 1 }, uEnergy: { value: 0 },
      uFracture: { value: 0 }, uExpansion: { value: 0 }, uLightTheme: { value: options.light ? 1 : 0 },
    },
    transparent: true, blending: NormalBlending, depthTest: true, depthWrite: true,
  })
  const mesh = new Mesh(geometry, material)
  mesh.name = 'comet-nucleus'
  const uniforms = material.uniforms
  return {
    mesh,
    update(frame: CometVisualFrame) {
      const envelope = nucleusEnvelope(frame)
      const fracture = frame.phase === 'gather' && !frame.reducedMotion
        ? smoothEnvelope(0.05, 0.3, frame.progress) : 0
      mesh.visible = envelope > 0
      mesh.position.set(frame.headX, frame.headY, frame.headZ)
      mesh.scale.setScalar(frame.phase === 'scatter' ? 0.12 + 0.88 * envelope : 1)
      if (!frame.reducedMotion) mesh.rotation.set(0.18 + frame.time * 0.018, frame.time * 0.075, 0.12)
      uniforms.uOpacity!.value = envelope
      uniforms.uFracture!.value = fracture
      uniforms.uExpansion!.value = fracture * (0.55 + 0.65 * smoothEnvelope(0.3, 0.55, frame.progress))
      uniforms.uEnergy!.value = frame.phase === 'gather' && !frame.reducedMotion
        ? (0.12 + 0.58 * smoothEnvelope(0, 0.07, frame.progress)) * envelope : 0
      uniforms.uLightTheme!.value = frame.light ? 1 : 0
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
