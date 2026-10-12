// Synthetic adversarial controls. Mock GL verifies adapter logic, never product/GPU evidence.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installCausalProbe } from './comet-causal-page.mjs'
import { LIMITS, compactVerdict } from './comet-causal-verdicts.mjs'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { Scene, Points, BufferGeometry, BufferAttribute, PointsMaterial, ShaderLib } = require('three')
const exact = shader => {
  shader.vertexShader = `attribute float cometScale;\n${shader.vertexShader}`.replace(
    'gl_PointSize = size;', 'gl_PointSize = size * cometScale;'
  )
}
function fixture() {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(16).fill(.005), 4))
  geometry.setAttribute('cometScale', new BufferAttribute(new Float32Array([1, 2, 3, 4]), 1))
  const material = new PointsMaterial({ vertexColors: true })
  material.onBeforeCompile = exact
  material.customProgramCacheKey = () => 'comet-body-coverage-v1'
  const points = new Points(geometry, material), scene = new Scene()
  scene.add(points)
  let current, gpuValues, bound, mutateVertex = false, mutateFragment = false, stale = false
  const properties = new Map()
  const gl = Object.fromEntries(['LINK_STATUS', 'VERTEX_ATTRIB_ARRAY_ENABLED', 'VERTEX_ATTRIB_ARRAY_SIZE', 'VERTEX_ATTRIB_ARRAY_TYPE', 'VERTEX_ATTRIB_ARRAY_NORMALIZED', 'VERTEX_ATTRIB_ARRAY_STRIDE', 'VERTEX_ATTRIB_ARRAY_POINTER', 'VERTEX_ATTRIB_ARRAY_BUFFER_BINDING', 'COPY_READ_BUFFER_BINDING', 'COPY_READ_BUFFER', 'BUFFER_SIZE', 'FLOAT'].map(k => [k, k]))
  Object.assign(gl, {
    getProgramParameter: () => true, getShaderSource: s => s,
    getAttribLocation: () => 0,
    getVertexAttrib: (_, key) => ({ VERTEX_ATTRIB_ARRAY_ENABLED: true, VERTEX_ATTRIB_ARRAY_SIZE: 1, VERTEX_ATTRIB_ARRAY_TYPE: 'FLOAT', VERTEX_ATTRIB_ARRAY_NORMALIZED: false, VERTEX_ATTRIB_ARRAY_STRIDE: 0, VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: gpuValues })[key],
    getVertexAttribOffset: () => 0, getParameter: () => bound,
    bindBuffer: (_, b) => { bound = b }, getBufferParameter: () => gpuValues.byteLength,
    getBufferSubData: (_, offset, dest) => { dest.set(gpuValues); if (stale) dest[0] += 1 },
  })
  const renderer = {
    getContext: () => gl, properties: { get: m => properties.get(m) },
    render(s) {
      current = s.children[0]
      const shader = { vertexShader: ShaderLib.points.vertexShader, fragmentShader: ShaderLib.points.fragmentShader }
      current.material.onBeforeCompile(shader)
      if (current.material === material && mutateVertex) shader.vertexShader += '\ngl_Position.x += 1.0;'
      if (current.material === material && mutateFragment) shader.fragmentShader += '\ngl_FragColor.a = 0.0;'
      properties.set(current.material, { currentProgram: { program: {}, vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader } })
      gpuValues = current.geometry.getAttribute('cometScale')?.array
    },
  }
  const e = { scene, points, geometry, renderer, choreography: { state: { headX: 0, headY: 0, headZ: 0 } },
    stop() {}, advanceClock() {}, writeEmissionTable() {}, integrate() {}, advanceCamera() {},
    upload() { this.geometry.getAttribute('cometScale').needsUpdate = true } }
  globalThis.window = { __SUB2API_PARTICLE_ENGINE__: e }
  globalThis.location = { href: 'synthetic://shader-adapter-selfcheck' }
  globalThis.innerWidth = 1440; globalThis.innerHeight = 900
  const contract = { main: 'points', head: ['choreography.state.headX', 'choreography.state.headY', 'choreography.state.headZ'], headDescription: 'synthetic source', pools: [{ id: 'body', points: 'points', start: 0, end: 'all', core: [0, 2], mode: 'morph' }] }
  return { e, material, geometry, run: () => installCausalProbe({ limits: LIMITS, observe: contract }),
    badVertex: () => { mutateVertex = true }, badFragment: () => { mutateFragment = true }, stale: () => { stale = true } }
}
const checks = []
function check(name, action) { const f = fixture(); action(f); checks.push({ name, pass: true }) }
const invalid = f => assert.throws(f.run, /instrument-invalid/)
check('exact-size-hook-sentinel-final-shader-GPU-pass', f => {
  const before = f.geometry.getAttribute('color').array.slice(), r = f.run().shaderAudit[0]
  assert.equal(r.kind, 'comet-body-coverage-v1')
  assert.equal(r.sentinel.finalFragment, r.sentinel.fragment)
  assert.equal(r.finalShader.fragmentUnchanged, true)
  assert.equal(r.gpu.exactGeometryMatch, true)
  assert.deepEqual(f.geometry.getAttribute('color').array, before)
})
check('stock-PointsMaterial-f110b9ffc-compatible', f => {
  f.e.points.material = new PointsMaterial()
  f.geometry.deleteAttribute('cometScale')
  assert.equal(f.run().shaderAudit[0].kind, 'stock-PointsMaterial')
})
check('position-hook-invalid', f => { f.material.onBeforeCompile = shader => { shader.vertexShader += '\ngl_Position.x += 1.0;' }; invalid(f) })
check('fragment-alpha-hook-invalid', f => { f.material.onBeforeCompile = shader => { shader.fragmentShader += '\ngl_FragColor.a = 0.0;' }; invalid(f) })
check('color-hook-invalid', f => { f.material.onBeforeCompile = shader => { shader.vertexShader += '\nvColor.rgb *= 0.5;' }; invalid(f) })
check('unknown-noop-hook-invalid', f => { f.material.onBeforeCompile = () => {}; invalid(f) })
check('conditional-hook-invalid', f => { f.material.onBeforeCompile = shader => { exact(shader); if (shader.vertexShader.includes('USE_COLOR')) shader.fragmentShader += '\ngl_FragColor.a = 0.0;' }; invalid(f) })
check('spoofed-toString-invalid', f => { const hook = shader => { shader.fragmentShader = '' }; hook.toString = () => exact.toString(); f.material.onBeforeCompile = hook; invalid(f) })
check('unknown-cache-key-invalid', f => { f.material.customProgramCacheKey = () => 'unknown'; invalid(f) })
check('missing-scale-invalid', f => { f.geometry.deleteAttribute('cometScale'); invalid(f) })
check('scale-count-invalid', f => { f.geometry.setAttribute('cometScale', new BufferAttribute(new Float32Array([1]), 1)); invalid(f) })
check('scale-itemSize-invalid', f => { f.geometry.setAttribute('cometScale', new BufferAttribute(new Float32Array(8).fill(1), 2)); invalid(f) })
for (const v of [0, -1, NaN, Infinity]) check('illegal-scale-' + v, f => { f.geometry.getAttribute('cometScale').array[0] = v; invalid(f) })
check('normalized-scale-invalid', f => { f.geometry.getAttribute('cometScale').normalized = true; invalid(f) })
check('missing-upload-invalid', f => { f.e.upload = () => {}; invalid(f) })
check('final-GPU-position-injection-invalid', f => { f.badVertex(); invalid(f) })
check('final-GPU-fragment-alpha-injection-invalid', f => { f.badFragment(); invalid(f) })
check('stale-GPU-scale-invalid', f => { f.stale(); invalid(f) })
check('empty-visible-main-never-passes-compact', () => assert.equal(compactVerdict({ n: 0, p95: null, far3: 0 }), false))
console.log(JSON.stringify({ pass: true, scope: 'synthetic adversarial adapter controls with mock GL; actual GPU validation requires browser probe', checks }, null, 2))
