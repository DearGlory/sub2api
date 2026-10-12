import { BufferAttribute, IcosahedronGeometry, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
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
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vBarycentric;
  varying vec3 vView;
  varying float vSeed;
  void main() {
    // Each triangle has a single seed, centre and flat terrain normal: no stretched bridges.
    vec3 p = aFaceCenter + (position - aFaceCenter) * (1.0 - 0.46 * uFracture);
    p += normal * uExpansion * (0.55 + 0.7 * aSeed);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vView = -view.xyz;
    vNormal = normalize(normalMatrix * normal);
    vLocal = position;
    vBarycentric = aBarycentric;
    vSeed = aSeed;
    gl_Position = projectionMatrix * view;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uLightDirection;
  uniform float uRoughness;
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
  void main() {
    vec3 N = normalize(vNormal);
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
    float strata = noise(vLocal * 8.0);
    float grain = noise(vLocal * 74.0);
    float ice = smoothstep(0.51, 0.77, strata + 0.15 * sin(vLocal.y * 24.0 + strata * 6.0));
    float seam = 1.0 - smoothstep(0.018, 0.065, abs(sin(vLocal.x * 12.0 + vLocal.z * 9.0 + strata * 5.0)));
    vec3 rock = mix(vec3(0.22, 0.25, 0.29), vec3(0.42, 0.50, 0.57), ice);
    rock = mix(rock, vec3(0.32, 0.27, 0.22), smoothstep(0.59, 0.8, noise(vLocal * 5.0 + 13.0)) * 0.5);
    rock *= (0.72 + 0.32 * grain) * (1.0 - 0.65 * seam);
    vec3 ambient = vec3(0.27, 0.32, 0.40) + uLightTheme * vec3(0.035);
    vec3 color = rock * (ambient + vec3(1.02, 0.94, 0.82) * diffuse * 1.65);
    float edge = 1.0 - smoothstep(0.01, 0.07, min(vBarycentric.x, min(vBarycentric.y, vBarycentric.z)));
    color += vec3(0.22, 0.085, 0.024) * uEnergy * max(seam, edge * step(0.76, vSeed));
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Procedural rock/ice terrain, not a scanned astronomical asset. */
export function createCometSurface(options: CometVisualOptions) {
  // Non-indexed triangles keep fracture normals/centres independent. About 7k faces.
  const geometry = new IcosahedronGeometry(COMET_SURFACE_RADIUS, 18)
  geometry.deleteAttribute('uv')
  const position = geometry.getAttribute('position')
  const craters = [
    new Vector3(0.6, 0.45, 0.7).normalize(), new Vector3(-0.5, 0.1, 0.9).normalize(),
    new Vector3(0.15, -0.7, 0.6).normalize(), new Vector3(-0.2, 0.9, -0.4).normalize(),
    new Vector3(0.9, -0.1, -0.4).normalize(), new Vector3(-0.8, -0.5, -0.2).normalize(),
  ]
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) / COMET_SURFACE_RADIUS
    const y = position.getY(i) / COMET_SURFACE_RADIUS
    const z = position.getZ(i) / COMET_SURFACE_RADIUS
    let terrain = 1 + 0.065 * Math.sin(5 * x + 1) * Math.sin(6 * y - 2) * Math.cos(5 * z)
    terrain += 0.029 * Math.sin(x * 21 + y * 11) * Math.sin(z * 19 - y * 13)
    terrain += 0.018 * Math.cos(y * 32 + Math.sin(z * 8) * 2) // extruded ice strata
    for (let c = 0; c < craters.length; c++) {
      const axis = craters[c]!
      const d = Math.sqrt(Math.max(0, 2 - 2 * (x * axis.x + y * axis.y + z * axis.z)))
      const width = 0.19 + (c % 3) * 0.05
      terrain -= 0.12 * Math.exp(-Math.pow(d / width, 4))
      terrain += 0.038 * Math.exp(-Math.pow((d - width) / 0.055, 2))
    }
    position.setXYZ(i, x * COMET_SURFACE_RADIUS * terrain * 1.1,
      y * COMET_SURFACE_RADIUS * terrain * 0.92, z * COMET_SURFACE_RADIUS * terrain)
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
  const center = new Float32Array(position.count * 3)
  const barycentric = new Float32Array(position.count * 3)
  const seed = new Float32Array(position.count)
  for (let i = 0; i < position.count; i += 3) {
    const cx = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3
    const cy = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3
    const cz = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3
    const random = Math.sin(i * 12.9898 + 78.233) * 43758.5453
    for (let j = 0; j < 3; j++) {
      const vertex = i + j
      center[vertex * 3] = cx
      center[vertex * 3 + 1] = cy
      center[vertex * 3 + 2] = cz
      barycentric[vertex * 3 + j] = 1
      seed[vertex] = random - Math.floor(random)
    }
  }
  geometry.setAttribute('aFaceCenter', new BufferAttribute(center, 3))
  geometry.setAttribute('aBarycentric', new BufferAttribute(barycentric, 3))
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 1))
  geometry.computeBoundingSphere()
  // Fragments may expand beyond the resting surface's bounds.
  geometry.boundingSphere!.radius += 1.6
  const material = new ShaderMaterial({
    name: 'comet-rough-rock-ice', vertexShader, fragmentShader,
    uniforms: {
      uLightDirection: { value: new Vector3(-0.65, 0.85, 1.4).normalize() },
      uRoughness: { value: 0.92 }, uOpacity: { value: 1 }, uEnergy: { value: 0 },
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
