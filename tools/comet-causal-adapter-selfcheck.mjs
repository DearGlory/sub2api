// Synthetic adapter controls only. These results are NOT product observations.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { installCausalProbe } from './comet-causal-page.mjs'
import { LIMITS, selfCheck } from './comet-causal-verdicts.mjs'
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { Scene, Points, BufferGeometry, BufferAttribute, PointsMaterial } = require('three')
const point = () => {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3))
  g.setAttribute('color', new BufferAttribute(new Float32Array(16).fill(1), 4))
  return new Points(g, new PointsMaterial({ opacity: 1 }))
}
const main = point(), tail = point(), stars = point(), scene = new Scene()
scene.add(main, tail, stars)
const e = { scene, points: main, tailPoints: tail, starfield: { object: stars },
  choreography: { state: { headX: 0, headY: 0, headZ: 0 } }, emitter: [0, 0, 0],
  tail: { age: new Float32Array(4), life: new Float32Array(4).fill(1), active: new Uint8Array(4) },
  stop() {}, advanceClock() {}, writeEmissionTable() {}, integrate() {}, upload() {}, advanceCamera() {} }
globalThis.window = { __SUB2API_PARTICLE_ENGINE__: e }
globalThis.location = { href: 'synthetic://adapter-selfcheck' }
globalThis.innerWidth = 1440; globalThis.innerHeight = 900
const contract = { main: 'points', background: ['starfield.object'],
  head: ['emitter.0', 'emitter.1', 'emitter.2'], headDescription: 'synthetic adapter fixture actual source',
  pools: [
    { id: 'glyph', points: 'points', start: 0, end: 'all', core: [0, 2], mode: 'morph' },
    { id: 'tail', points: 'tailPoints', start: 0, end: 'all', mode: 'emitted', age: 'tail.age', life: 'tail.life', active: 'tail.active' },
  ] }
const run = c => installCausalProbe({ limits: LIMITS, observe: c })
const checks = []
function check(name, action) { action(); checks.push({ name, pass: true }) }
check('unknown-contract-invalid', () => assert.match(run(null).invalid, /未知实现/))
check('unmapped-new-tail-invalid-even-main-present', () => assert.ok(run({ ...contract, pools: contract.pools.slice(0, 1) }).invalid))
check('independent-tail-points-recognized', () => assert.equal(run(contract).poolSeparation, 'independent-tail-Points'))
check('missing-lifecycle-path-rejected', () => assert.throws(() => run({ ...contract, pools: [contract.pools[0], { ...contract.pools[1], age: 'missing.age' }] }), /instrument-invalid/))
check('uncovered-range-invalid', () => assert.ok(run({ ...contract, pools: [{ ...contract.pools[0], end: 2 }, contract.pools[1]] }).invalid))
check('overlapping-pools-rejected', () => assert.throws(() => run({ ...contract, pools: [...contract.pools, contract.pools[0]] }), /overlapping/))
check('missing-actual-head-rejected', () => assert.throws(() => run({ ...contract, head: undefined }), /actual head/))
check('RGB-only-no-alpha-invalid', () => {
  const original = tail.geometry.getAttribute('color')
  tail.geometry.setAttribute('color', new BufferAttribute(new Float32Array(12), 3))
  assert.throws(() => run(contract), /color4/)
  tail.geometry.setAttribute('color', original)
})
check('same-geometry-disjoint-pool-recognized', () => {
  scene.remove(tail)
  const c = { ...contract, pools: [
    { ...contract.pools[0], end: 2 },
    { ...contract.pools[1], points: 'points', start: 2, end: 4 },
  ] }
  assert.equal(run(c).poolSeparation, 'partitioned-buffer')
})
check('long-tail-and-zero-speed-negative-controls', () => assert.equal(selfCheck().pass, true))
console.log(JSON.stringify({ pass: checks.every(c => c.pass), scope: 'synthetic adapter self-check, not measured page', checks }, null, 2))
