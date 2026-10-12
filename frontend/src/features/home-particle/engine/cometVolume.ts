import { BackSide, BoxGeometry, Matrix4, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import { COMET_COMA_RADIUS } from './cometVisualContract'
import type { CometTailView, CometVisualFrame, CometVisualOptions } from './cometVisualContract'
import { nucleusEnvelope } from './cometSurface'

const BIN_COUNT = 20
const vertexShader = /* glsl */ `
  uniform vec3 uCenter;
  uniform vec3 uSize;
  varying vec3 vFrame;
  void main() {
    vFrame = position * uSize + uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragmentShader = /* glsl */ `
  uniform vec3 uCenter;
  uniform vec3 uSize;
  uniform vec3 uCameraFrame;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uLightTheme;
  uniform vec4 uBins[20];
  uniform float uDensities[20];
  varying vec3 vFrame;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float density(vec3 p) {
    float base = 0.0;
    #if IS_COMA == 1
      float radius = length((p-uCenter) / 1.53);
      base = pow(max(0.0, 1.0-radius*radius), 2.0) * 0.37;
      // The solid nucleus owns the centre, with a faint, genuinely 3D outer envelope.
      base *= smoothstep(0.38, 0.58, radius);
      vec3 q = (p-uCenter) * 3.6;
    #else
      for (int j=0; j<20; j++) {
        if (uDensities[j] > 0.00001) {
          vec3 d = (p-uBins[j].xyz) / max(uBins[j].w, 0.01);
          float support = max(0.0, 1.0-dot(d,d));
          base += support * support * uDensities[j];
        }
      }
      // World-frame density: no head-attached scrolling or screen-space sheets.
      vec3 q = p * vec3(3.1, 5.8, 4.5);
    #endif
    if (base < 0.00001) return 0.0;
    float coarse = noise(q + vec3(0.0, uTime * 0.025, 0.0));
    float fine = noise(q * 2.7 + coarse * 1.4);
    float filament = smoothstep(0.24, 0.8, coarse * 0.7 + fine * 0.3);
    return base * (0.12 + filament * 1.35);
  }
  void main() {
    vec3 ray = normalize(vFrame-uCameraFrame);
    // Safe slab intersection; march only the projected local proxy, never the viewport.
    vec3 invRay = 1.0 / (sign(ray + vec3(0.0000001)) * max(abs(ray), vec3(0.000001)));
    vec3 lo = (uCenter-uSize*0.5-uCameraFrame)*invRay;
    vec3 hi = (uCenter+uSize*0.5-uCameraFrame)*invRay;
    vec3 nearT = min(lo,hi), farT = max(lo,hi);
    float enter = max(0.0, max(nearT.x,max(nearT.y,nearT.z)));
    float leave = min(farT.x,min(farT.y,farT.z));
    if (leave <= enter) discard;
    float stepLength = (leave-enter)/float(MARCH_STEPS);
    float jitter = hash(floor(vFrame*173.0));
    float opacity = 0.0;
    vec3 light = vec3(0.0);
    for (int i=0; i<MARCH_STEPS; i++) {
      vec3 p = uCameraFrame + ray * (enter + (float(i)+0.25+0.5*jitter)*stepLength);
      float d = density(p);
      float alpha = 1.0-exp(-d * stepLength * uOpacity * 1.45);
      float ion = noise(p*2.4+7.0);
      vec3 tint = mix(vec3(0.36,0.39,0.43), vec3(0.43,0.58,0.69), smoothstep(0.38,0.72,ion));
      tint = mix(tint, vec3(0.44,0.38,0.31), smoothstep(0.66,0.85,ion)*0.35);
      tint = mix(tint, tint*0.57, uLightTheme);
      light += (1.0-opacity)*alpha*tint;
      opacity += (1.0-opacity)*alpha;
      if (opacity > 0.66) break;
    }
    if (opacity < 0.001) discard;
    gl_FragColor = vec4(light / max(opacity,0.0001), min(opacity,0.66));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

function proxy(name: string, coma: boolean, steps: number, options: CometVisualOptions,
  bins: Float32Array, densities: Float32Array) {
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.deleteAttribute('normal')
  geometry.deleteAttribute('uv')
  const material = new ShaderMaterial({
    name, vertexShader, fragmentShader, defines: { IS_COMA: coma ? 1 : 0, MARCH_STEPS: steps },
    uniforms: {
      uCenter: { value: new Vector3() }, uSize: { value: new Vector3(1, 1, 1) },
      uCameraFrame: { value: new Vector3() }, uOpacity: { value: 1 }, uTime: { value: 0 },
      uLightTheme: { value: options.light ? 1 : 0 }, uBins: { value: bins }, uDensities: { value: densities },
    },
    side: BackSide, blending: NormalBlending, transparent: true, depthWrite: false, depthTest: true,
  })
  const mesh = new Mesh(geometry, material)
  mesh.name = name
  mesh.visible = false
  const inverse = new Matrix4()
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const cameraFrame = material.uniforms.uCameraFrame!.value as Vector3
    cameraFrame.setFromMatrixPosition(camera.matrixWorld)
    if (mesh.parent) cameraFrame.applyMatrix4(inverse.copy(mesh.parent.matrixWorld).invert())
  }
  return mesh
}

export function createCometVolume(options: CometVisualOptions) {
  const bins = new Float32Array(BIN_COUNT * 4)
  const densities = new Float32Array(BIN_COUNT)
  const mass = new Float64Array(BIN_COUNT)
  const means = new Float64Array(BIN_COUNT * 3)
  const variance = new Float64Array(BIN_COUNT)
  const ages = new Float64Array(BIN_COUNT)
  const samples = new Uint32Array(BIN_COUNT)
  const steps = options.particleCount <= 1200 ? 16 : 28
  const coma = proxy('comet-coma-volume', true, steps, options, bins, densities)
  const tail = proxy('comet-tail-volume', false, steps, options, bins, densities)
  const comaUniforms = coma.material.uniforms
  const tailUniforms = tail.material.uniforms
  const expectedPerBin = Math.max(12, options.particleCount / BIN_COUNT * 0.55)
  let noiseTime = 0
  return {
    coma, tail,
    update(frame: CometVisualFrame, pool: CometTailView) {
      const envelope = nucleusEnvelope(frame)
      coma.visible = envelope > 0
      coma.position.set(frame.headX, frame.headY, frame.headZ)
      coma.scale.setScalar(COMET_COMA_RADIUS * 2)
      comaUniforms.uCenter!.value.copy(coma.position)
      comaUniforms.uSize!.value.copy(coma.scale)
      comaUniforms.uOpacity!.value = envelope * 0.72
      if (!frame.reducedMotion) noiseTime = frame.time
      comaUniforms.uTime!.value = tailUniforms.uTime!.value = noiseTime
      comaUniforms.uLightTheme!.value = tailUniforms.uLightTheme!.value = frame.light ? 1 : 0
      mass.fill(0); means.fill(0); variance.fill(0); ages.fill(0); samples.fill(0)
      bins.fill(0); densities.fill(0)
      // One linear pool scan, weighted Welford variance avoids cancellation at deep chronology Z.
      for (let i = 0; i < pool.count; i++) {
        if (pool.active[i] !== 1 || !Number.isFinite(pool.birthTime[i]) || pool.birthTime[i]! < 0) continue
        const age = pool.age[i]!, life = pool.life[i]!
        if (!Number.isFinite(age) || !Number.isFinite(life) || life <= 0 || age <= 0 || age >= life) continue
        const k = i * 3
        const x = pool.positions[k]!, y = pool.positions[k + 1]!, z = pool.positions[k + 2]!
        if (!Number.isFinite(x + y + z)) continue
        const b = Math.min(BIN_COUNT - 1, Math.floor(age / 3.2 * BIN_COUNT))
        const m = b * 3
        const weight = Math.pow(1 - age / life, 1.7) * Math.min(1, age / 0.035)
        const nextMass = mass[b]! + weight
        const dx = x - means[m]!, dy = y - means[m + 1]!, dz = z - means[m + 2]!
        means[m] += dx * weight / nextMass
        means[m + 1] += dy * weight / nextMass
        means[m + 2] += dz * weight / nextMass
        variance[b] += weight * (dx * (x - means[m]!) + dy * (y - means[m + 1]!) + dz * (z - means[m + 2]!))
        mass[b] = nextMass
        ages[b] += age * weight
        samples[b]++
      }
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (let b = 0; b < BIN_COUNT; b++) {
        if (mass[b]! <= 0) continue
        const m = b * 3, k = b * 4
        const radius = Math.min(2.8, 0.22 + ages[b]! / mass[b]! * 0.18 + 2.1 * Math.sqrt(Math.max(0, variance[b]! / mass[b]!)))
        const x = means[m]!, y = means[m + 1]!, z = means[m + 2]!
        bins[k] = x; bins[k + 1] = y; bins[k + 2] = z; bins[k + 3] = radius
        // Both sample count and surviving mass matter: a lone survivor cannot inflate a luminous cone.
        densities[b] = Math.min(1, mass[b]! / expectedPerBin) * Math.min(1, samples[b]! / 8) * 0.92
        minX = Math.min(minX, x - radius); maxX = Math.max(maxX, x + radius)
        minY = Math.min(minY, y - radius); maxY = Math.max(maxY, y + radius)
        minZ = Math.min(minZ, z - radius); maxZ = Math.max(maxZ, z + radius)
      }
      tail.visible = minX < Infinity
      if (tail.visible) {
        tail.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
        tail.scale.set(maxX - minX, maxY - minY, maxZ - minZ)
        tailUniforms.uCenter!.value.copy(tail.position)
        tailUniforms.uSize!.value.copy(tail.scale)
      }
    },
    dispose() {
      coma.geometry.dispose(); coma.material.dispose()
      tail.geometry.dispose(); tail.material.dispose()
    },
  }
}
