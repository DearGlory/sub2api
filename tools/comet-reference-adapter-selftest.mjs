import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { installShapeAdapter, referenceSpaceInstallerSource } from './comet-reference-space-page.mjs'
import { resourceBudget } from './comet-reference-checks.mjs'
import { sourceRecorder, REQUIRED_PRODUCTS, boundedWrite, rawEvidence, MAX_FILE_BYTES } from './comet-reference-evidence.mjs'
import { hash } from './comet-reference-image.mjs'

const args = Object.fromEntries(process.argv.slice(2).flatMap((v, i, a) => v.startsWith('--') ? [[v.slice(2), a[i + 1]]] : []))
for (const k of ['visual', 'transition', 'out']) if (!args[k]) throw Error('required --' + k)
const out = path.resolve(args.out)
await fs.mkdir(out, { recursive: true })
if (await fs.stat(path.join(out, 'result.json')).catch(() => null)) throw Error('use fresh --out')
const require = createRequire(new URL('../frontend/package.json', import.meta.url)), ts = require('typescript'), { Vector3, Matrix4 } = require('three')
const sources = [], checks = []
// Execute exact product modules in memory; never copy/merge them into the judge tree.
function load(root, name, cache = new Map()) {
  if (cache.has(name)) return cache.get(name)
  if (!['emittedTail', 'cometFlow', 'cometVisualContract', 'cometTransition', 'constants'].includes(name)) throw Error('unexpected runtime dependency: ' + name)
  const file = path.join(root, 'frontend/src/features/home-particle/engine', name + '.ts'), source = readFileSync(file, 'utf8')
  sources.push({ file, sha256: hash(source) })
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }; cache.set(name, module.exports)
  vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: file })(specifier => {
    if (!specifier.startsWith('./')) throw Error('unexpected external dependency: ' + specifier)
    return load(root, specifier.slice(2), cache)
  }, module, module.exports)
  return module.exports
}
const { EmittedTail, createCometBody } = load(args.visual, 'emittedTail')
const { assignCometCore } = load(args.transition, 'cometTransition')
function fixture(sign = 1, mutate = () => {}) {
  const pool = new EmittedTail(1024), table = { xyz: new Float64Array([2, 1, 8]), axis: new Float64Array([sign * .8, .1, -.6]), side1: new Float64Array([0, 1, 0]), side2: new Float64Array([1, 0, 0]), vel: new Float64Array([-sign * 2, 0, 3]) }
  const state = { headX: 2, headY: 1, headZ: 8, phase: 'travel', phaseProgress: .4 }
  pool.update(.1, 1, true, table, 2, 1, 8, {}, {}, false)
  mutate(pool)
  const body = createCometBody(1024), basis = pool.flowBasis.slice()
  const e = { scratch: { emittedTail: pool, tailTable: table, body, bodyBasis: basis, coreAssignment: Uint32Array.from({ length: 1024 }, (_, i) => i), vecA: new Vector3() }, choreography: { state }, scene: { updateMatrixWorld() {} }, tailPoints: { matrixWorld: new Matrix4().makeTranslation(0, 0, -6) }, dollySeconds: 1 }
  return { e, pool, table, adapter: installShapeAdapter(e) }
}
async function test(id, fn) {
  try { const detail = await fn(); checks.push({ id, status: 'pass', detail }) }
  catch (error) { checks.push({ id, status: 'fail', error: String(error.stack || error) }) }
}
new vm.Script(referenceSpaceInstallerSource())
for (const sign of [-1, 1]) await test('actual-product-birth-and-inertia-direction-' + sign, () => {
  const { e, pool, table, adapter } = fixture(sign)
  adapter.observe(); const births = adapter.take()
  assert.ok(births.count > 0); assert.equal(births.errors.length, 0); assert.equal(adapter.proof().status, 'pass')
  e.choreography.state.headX = 900; table.axis.fill(7); table.vel.fill(-20)
  pool.update(.04, 1.04, false, table, 900, 500, 400, {}, {}, false)
  adapter.observe(); assert.equal(adapter.take().inertiaErrors.length, 0)
  const i = pool.active.findIndex(x => x === 1)
  pool.positions[i * 3] += .02
  adapter.observe(); assert.ok(adapter.take().inertiaErrors.length > 0)
  return { births: births.count, maxReconstructionError: Math.max(...births.examples.map(b => b.reconstruction.error)), proof: adapter.proof(), inertiaMutationRejected: true }
})
await test('wrong-birth-location-rejected-at-1e-5', () => {
  const { pool, adapter } = fixture(), i = pool.active.findIndex(x => x === 1)
  pool.birthPosition[i * 3] += .0002; pool.positions[i * 3] = pool.birthPosition[i * 3]
  adapter.observe(); const r = adapter.take(); assert.ok(r.errors.some(e => e.reconstruction.error > 1e-5)); return r.errors[0].reconstruction
})
for (const kind of ['scaled-basis', 'zero-axis-Z', 'flat-aperture']) await test('self-consistent-' + kind + '-rejected', () => {
  const { pool, adapter } = fixture(1, pool => {
    if (kind === 'scaled-basis') for (let i = 0; i < 3; i++) pool.flowBasis[i] *= 2
    if (kind === 'zero-axis-Z') pool.flowBasis.set([1, 0, 0, 0, 1, 0, 0, 0, 1])
    if (kind === 'flat-aperture') for (let i = 0; i < pool.count; i++) pool.aperture[i * 3 + 2] = 0
    // Match the corrupted parameters exactly: equality to itself must not pass shape proof.
    for (let i = 0; i < pool.count; i++) if (pool.active[i] === 1) for (let j = 0; j < 3; j++) pool.positions[i * 3 + j] = pool.birthPosition[i * 3 + j] = [2, 1, 8][j] + pool.flowBasis[j] * pool.aperture[i * 3] + pool.flowBasis[j + 3] * pool.aperture[i * 3 + 1] + pool.flowBasis[j + 6] * pool.aperture[i * 3 + 2]
  })
  adapter.observe(); assert.ok(adapter.take().errors.length > 0); assert.equal(adapter.proof().status, 'fail'); return { live: Array.from(pool.active).filter(x => x === 1).length, proof: adapter.proof() }
})
await test('actual-rank-transport-reassigned-each-scatter', () => {
  const { e, adapter } = fixture(), { body, bodyBasis: b, coreAssignment: assignment } = e.scratch, count = assignment.length
  const source = new Float32Array(count * 3), sourceOrder = new Uint32Array(count), coreOrder = new Uint32Array(count), sourceRadii = new Float64Array(count), coreRadii = new Float64Array(count)
  let previous, changed = 0, wrongIdentityError = 0
  for (let scatter = 0; scatter < 2; scatter++) {
    for (let i = 0; i < count; i++) source.set([2 + (scatter ? count - i : i + 1) / count * 8, 1, 8], i * 3)
    assignCometCore(assignment, sourceOrder, coreOrder, sourceRadii, coreRadii, source, body.offsets, 2, 1, 8)
    for (let i = 0; i < count; i++) {
      const p = Array.from(body.offsets.subarray(assignment[i] * 3, assignment[i] * 3 + 3)), actual = adapter.offset(i)
      for (let j = 0; j < 3; j++) assert.ok(Math.abs(actual[j] - b[j] * p[0] - b[j + 3] * p[1] - b[j + 6] * p[2]) < 1e-12)
      if (assignment[i] !== i) wrongIdentityError = Math.max(wrongIdentityError, Math.hypot(...p.map((x, j) => x - body.offsets[i * 3 + j])))
      if (previous && assignment[i] !== previous[i]) changed++
    }
    previous = assignment.slice()
  }
  assert.ok(changed > 0 && wrongIdentityError > 1e-4)
  assignment[0] = assignment[1]; assert.throws(() => adapter.offset(0), /permutation/)
  return { changed, wrongIdentityError, duplicateRejected: true }
})
await test('d85-no-new-fields-identity-fallback', () => {
  const { EmittedTail: LegacyTail } = load(path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')), 'emittedTail')
  const { e, table } = fixture(), pool = new LegacyTail(1024)
  pool.update(.1, 1, true, table, 2, 1, 8, { r: 1, g: 1, b: 1 }, { r: 1, g: 1, b: 1 }, false)
  e.scratch.emittedTail = pool
  delete e.scratch.bodyBasis; delete e.scratch.coreAssignment
  assert.ok(pool.aperture && !pool.flowBasis && !pool.birthAcceleration)
  const adapter = installShapeAdapter(e); adapter.observe()
  assert.equal(adapter.take().errors.length, 0); assert.equal(adapter.proof().status, 'skip'); assert.deepEqual(adapter.offset(0), Array.from(e.scratch.body.offsets.subarray(0, 3)))
})
// Explicit recorder fixtures test event/inline-map binding, not a browser positive control.
await test('source-recorder-cometFlow-required-loaded-and-bound', async () => {
  const root = path.join(out, 'recorder-fixture'), engine = path.join(root, 'frontend/src/features/home-particle/engine')
  await fs.mkdir(engine, { recursive: true })
  const run = async (label, imported, includeFlow, runtimeImport, mismatch = false) => {
    const listeners = [], bodies = new Map(), ws = { addEventListener: (_, fn) => listeners.push(fn) }, cdp = { send: async (_, { requestId }) => ({ body: bodies.get(requestId) }) }
    const recorder = sourceRecorder({ cdp, ws, out: path.join(root, label), repo: root }), emit = (method, params) => listeners.forEach(fn => fn({ data: JSON.stringify({ method, params }) }))
    emit('Page.frameNavigated', { frame: { loaderId: label, id: 'frame', url: 'http://fixture/' } })
    for (const name of [...REQUIRED_PRODUCTS, ...(includeFlow ? ['cometFlow'] : [])]) {
      const content = name === 'ParticleEngine' && imported ? "import { writeCometFlowBasis } from './cometFlow'\nexport const fixture = writeCometFlowBasis\n" : 'export const fixture = true\n'
      await fs.writeFile(path.join(engine, name + '.ts'), content + (mismatch && name === 'cometFlow' ? '// changed\n' : ''))
      const map = Buffer.from(JSON.stringify({ sources: [name + '.ts'], sourcesContent: [content] })).toString('base64')
      bodies.set(name, (name === 'ParticleEngine' && runtimeImport ? "import { writeCometFlowBasis } from '/src/features/home-particle/engine/cometFlow.ts?t=123';\n" : '') + 'export const fixture = true;\n//# sourceMappingURL=data:application/json;base64,' + map)
      emit('Network.responseReceived', { requestId: name, loaderId: label, response: { url: 'http://fixture/src/features/home-particle/engine/' + name + '.ts', status: 200 } })
      emit('Network.loadingFinished', { requestId: name })
    }
    await recorder.seal(); return recorder.finish()
  }
  const results = {}
  for (const [label, imported, loaded, runtime, mismatch, expected] of [['old', false, false, false, false, 'pass'], ['new', true, true, true, false, 'pass'], ['missing', true, false, true, false, 'instrument-invalid'], ['unimported', true, true, false, false, 'instrument-invalid'], ['mismatch', true, true, true, true, 'instrument-invalid']]) {
    const result = await run(label, imported, loaded, runtime, mismatch)
    assert.equal(result.status, expected); results[label] = { status: result.status, required: result.required, missing: result.missing, flowBinding: result.flowBinding }
  }
  return results
})
await test('resource-budget-boundary-and-rejections', () => {
  const row = { drawCalls: 10, geometryBytes: 3500000 }
  assert.equal(resourceBudget([row]).status, 'pass')
  assert.equal(resourceBudget([{ ...row, drawCalls: 11 }]).status, 'fail')
  assert.equal(resourceBudget([{ ...row, geometryBytes: 3500001 }]).status, 'fail')
  assert.equal(resourceBudget([{}]).status, 'instrument-invalid')
})
await test('raw-evidence-parts-remain-under-10MB', async () => {
  const manifest = await rawEvidence(out, 'split-fixture.json', 'x'.repeat(8_000_001))
  assert.equal(manifest.parts.length, 2)
  for (const part of manifest.parts) assert.ok((await fs.stat(path.join(out, part.file))).size < MAX_FILE_BYTES)
  return manifest
})
const result = { status: checks.every(c => c.status === 'pass') ? 'pass' : 'fail', total: checks.length, checks, sources, scope: 'focused adapter/product-module and explicit recorder-fixture tests; not a live 5210 positive control' }
await boundedWrite(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ status: result.status, total: result.total, failures: checks.filter(c => c.status !== 'pass'), out }))
process.exitCode = result.status === 'pass' ? 0 : 1
