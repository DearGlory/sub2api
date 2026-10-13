import { installSpaceProbe } from './space-pursuit-lib/page.mjs'

// Adapts shape/dynamics only. The original 42 motion checks and tolerances are reused.
function installShapeAdapter(e) {
  const pool = e.scratch.emittedTail, table = e.scratch.tailTable
  const xyz = (a, i) => Array.from(a.subarray(i * 3, i * 3 + 3))
  const acceleration = i => pool.birthAcceleration ? xyz(pool.birthAcceleration, i) : [0, 0, 0]
  const stamps = new Float64Array(pool.count).fill(NaN), tracked = new Map()
  const transform = p => e.scratch.vecA.clone().set(...p).applyMatrix4(e.tailPoints.matrixWorld).toArray()
  const direction = p => { const origin = transform([0, 0, 0]); return transform(p).map((v, j) => v - origin[j]) }
  let batch = { count: 0, examples: [], errors: [], inertiaErrors: [] }, observed = 0
  function observe() {
    e.scene.updateMatrixWorld(true)
    const s = e.choreography.state, head = [s.headX, s.headY, s.headZ]
    for (let i = 0; i < pool.count; i++) {
      if (pool.active[i] !== 1) { tracked.delete(i); continue }
      const stamp = pool.birthTime[i], age = pool.age[i]
      if (stamps[i] !== stamp) {
        stamps[i] = stamp
        if (age > 1e-8) continue
        const b = xyz(pool.birthPosition, i), p = xyz(pool.positions, i), v = xyz(pool.birthVelocity, i), a = acceleration(i)
        const displacement = b.map((x, j) => x - head[j])
        const local = [table.axis, table.side1, table.side2].map(axis => displacement.reduce((sum, x, j) => sum + x * axis[j], 0))
        let wedge
        if (pool.birthAcceleration) {
          // Independent aperture envelope: core [-.55,1.9], sheath [-.75,2.3], scale 1.8.
          const x = local[0] / 1.8, radius = Math.hypot(local[1], local[2]) / 1.8
          const within = (start, span, radialScale) => {
            const t = (x - start) / span
            return t >= -1e-5 && t <= 1 + 1e-5 && radius <= (0.1 + .96 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.max(0, Math.min(1, t)))), .7)) * (1 - .33 * t) * radialScale + 1e-5
          }
          wedge = within(-.55, 2.45, .56) || within(-.75, 3.05, 1)
        } else wedge = Math.hypot(...displacement) <= .191 // d85 compatibility only
        const event = { i, bornAt: stamp, clock: e.dollySeconds, phase: s.phase, progress: s.phaseProgress, head: transform(head), world: transform(b), actual: transform(p), velocity: direction(v), acceleration: direction(a), local, wedge, axis: direction(xyz(table.axis, 0)), emitterVelocity: direction(xyz(table.vel, 0)) }
        batch.count++; observed++
        if (batch.examples.length < 12) batch.examples.push(event)
        if ((!wedge || Math.hypot(...b.map((x, j) => x - p[j])) > 1e-5 || s.phase === 'hold' || s.phase === 'scatter' && s.phaseProgress <= .62) && batch.errors.length < 12) batch.errors.push(event)
        // Check every live identity; only error evidence is capped, never the denominator.
        tracked.set(i, { stamp, b, v, a })
      } else {
        const t = tracked.get(i)
        if (!t || t.stamp !== stamp) continue
        let errorSquared = 0, changed = false
        for (let j = 0; j < 3; j++) {
          const k = i * 3 + j, error = pool.positions[k] - t.b[j] - t.v[j] * age - .5 * t.a[j] * age * age
          errorSquared += error * error
          changed ||= pool.birthPosition[k] !== t.b[j] || pool.birthVelocity[k] !== t.v[j] || (pool.birthAcceleration?.[k] || 0) !== t.a[j]
        }
        const error = Math.sqrt(errorSquared)
        if ((error > 1e-4 || changed) && batch.inertiaErrors.length < 12) batch.inertiaErrors.push({ i, clock: e.dollySeconds, error, changed, age })
      }
    }
  }
  function take() { const result = batch; batch = { count: 0, examples: [], errors: [], inertiaErrors: [] }; return result }
  function offset(i) {
    const p = xyz(e.scratch.body.offsets, i), b = e.scratch.bodyBasis
    return b ? [0, 1, 2].map(j => b[j] * p[0] + b[j + 3] * p[1] + b[j + 6] * p[2]) : p
  }
  function counterfactual() {
    // Snapshot all own fields, including emission cursor/credit, before perturbing live update.
    const snapshot = Object.fromEntries(Object.entries(pool).map(([k, v]) => [k, ArrayBuffer.isView(v) ? v.slice() : v]))
    const cam = e.camera.position.clone(), state = e.choreography.state, originalHead = [state.headX, state.headY, state.headZ]
    const tableCopy = Object.fromEntries(['axis', 'side1', 'side2', 'vel'].map(k => [k, table[k].slice()]))
    const identities = Array.from(pool.active, (v, i) => v === 1 && pool.age[i] + .05 < pool.life[i] ? i : -1).filter(i => i >= 0)
    let seed = 0x61f7b291, checked = 0, maxError = 0, alteredBirths = 0
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    try {
      for (let trial = 0; trial < 8; trial++) {
        for (const [k, v] of Object.entries(snapshot)) ArrayBuffer.isView(v) ? pool[k].set(v) : pool[k] = v
        const future = [0, 1, 2].map(() => (random() - .5) * 2000)
        ;[state.headX, state.headY, state.headZ] = future
        e.camera.position.set(...future.map(x => -x)); e.camera.updateMatrixWorld(true)
        for (const k of Object.keys(tableCopy)) for (let j = 0; j < 3; j++) table[k][j] = (random() - .5) * 40
        // canEmit=false isolates already born particles. Colors are unused for old identities.
        pool.update(.05, 4, false, table, ...future, e.points.material.color, e.points.material.color, e.light)
        for (const i of identities) {
          const age = snapshot.age[i] + .05, k = i * 3
          for (let j = 0; j < 3; j++) {
            const expected = snapshot.birthPosition[k + j] + snapshot.birthVelocity[k + j] * age + .5 * (snapshot.birthAcceleration?.[k + j] || 0) * age * age
            maxError = Math.max(maxError, Math.abs(pool.positions[k + j] - expected))
            if (pool.birthPosition[k + j] !== snapshot.birthPosition[k + j] || pool.birthVelocity[k + j] !== snapshot.birthVelocity[k + j] || pool.birthAcceleration && pool.birthAcceleration[k + j] !== snapshot.birthAcceleration[k + j]) alteredBirths++
          }
          checked++
        }
      }
    } finally {
      for (const [k, v] of Object.entries(snapshot)) ArrayBuffer.isView(v) ? pool[k].set(v) : pool[k] = v
      ;[state.headX, state.headY, state.headZ] = originalHead
      e.camera.position.copy(cam); e.camera.updateMatrixWorld(true)
      for (const k of Object.keys(tableCopy)) table[k].set(tableCopy[k])
      e.upload(); e.renderer.render(e.scene, e.camera)
    }
    return { status: identities.length && checked === identities.length * 8 ? maxError <= 1e-4 && !alteredBirths ? 'pass' : 'fail' : 'instrument-invalid', seed: '0x61f7b291', trials: 8, identities: identities.length, checked, maxError, alteredBirths, observedBirths: observed }
  }
  return { observe, take, offset, counterfactual }
}

export function referenceSpaceInstallerSource() {
  let source = installSpaceProbe.toString()
  const replace = (old, next) => {
    if (!source.includes(old) || source.indexOf(old) !== source.lastIndexOf(old)) throw Error('instrument-invalid: old adapter shape changed: ' + old.slice(0, 60))
    source = source.replace(old, next)
  }
  replace('const position = body.geometry', `const shape = (${installShapeAdapter.toString()})(e)\n  const position = body.geometry`)
  replace('point.material=stock; scene.add(point)', 'point.material=stock; point.frustumCulled=false; point.visible=true; scene.add(point)')
  replace('e.upload(); e.advanceCamera(); observeTail()', 'e.upload(); e.advanceCamera(); shape.observe()')
  replace('v-offsets[i*3+j]', 'v-shape.offset(i)[j]')
  replace('births:{count:birthCount,examples:births,errors:birthErrors.slice(0,12),inertiaErrors}', 'births:shape.take()')
  replace('window.__SPACE_PROBE={meta,sample,advance,audit,stop:()=>e.stop(),engine:e}', 'window.__SPACE_PROBE={meta,sample,advance,audit,counterfactual:shape.counterfactual,stop:()=>e.stop(),engine:e}')
  return '(' + source + ')()'
}
