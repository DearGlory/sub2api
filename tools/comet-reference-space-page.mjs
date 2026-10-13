import { installSpaceProbe } from './space-pursuit-lib/page.mjs'

// Adapts shape/dynamics only. The kernel40 and two entry checks retain their gates.
export function installShapeAdapter(e) {
  const pool = e.scratch.emittedTail, table = e.scratch.tailTable
  const xyz = (a, i) => Array.from(a.subarray(i * 3, i * 3 + 3))
  const shaped = !!(pool.flowBasis || pool.birthAcceleration)
  if (shaped && (pool.flowBasis?.length !== 9 || pool.aperture?.length !== pool.count * 3)) throw Error('instrument-invalid: missing flowBasis/aperture shape mapping')
  const basisProof = b => {
    const axes = [0, 1, 2].map(i => xyz(b, i))
    const gram = axes.map(a => axes.map(c => a.reduce((sum, v, j) => sum + v * c[j], 0)))
    const orthogonalError = Math.max(...gram.flatMap((row, i) => row.map((v, j) => Math.abs(v - Number(i === j)))))
    const axisZ = axes[0][2]
    return { status: Number.isFinite(orthogonalError) && orthogonalError <= 1e-5 && Math.abs(axisZ) > 1e-5 ? 'pass' : 'fail', orthogonalError, axisZ, gram }
  }
  const apertureProof = () => {
    if (!shaped) return { status: 'skip', reason: 'd85 uses an unrotated spherical aperture, no flowBasis' }
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, octants = new Set(), mean = [0, 0, 0]
    let finite = true
    for (let i = 0; i < pool.count; i++) {
      const p = xyz(pool.aperture, i)
      finite &&= p.every(Number.isFinite)
      octants.add(p.reduce((mask, x, j) => mask | (Number(x > 0) << j), 0))
      for (let j = 0; j < 3; j++) { bounds.min[j] = Math.min(bounds.min[j], p[j]); bounds.max[j] = Math.max(bounds.max[j], p[j]); mean[j] += p[j] / pool.count }
    }
    const covariance = Array.from({ length: 3 }, () => [0, 0, 0])
    for (let i = 0; i < pool.count; i++) {
      const p = xyz(pool.aperture, i).map((x, j) => x - mean[j])
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) covariance[j][k] += p[j] * p[k] / pool.count
    }
    const [a, b, c] = covariance, det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    const rankRatio = det / Math.pow(a[0] + b[1] + c[2], 3)
    return { status: finite && octants.size === 8 && bounds.min.every(x => x < -1e-5) && bounds.max.every(x => x > 1e-5) && rankRatio > 1e-10 ? 'pass' : 'fail', count: pool.count, bounds, octants: [...octants].sort(), covariance, rankRatio, criterion: 'finite full-rank aperture spans both signs of every local axis and all eight octants around head; no product shape constants' }
  }
  const aperture = apertureProof(), basis = { samples: 0, failures: 0, maxOrthogonalError: 0, minAbsAxisZ: Infinity, examples: [] }
  function checkBasis(name, value) {
    const proof = basisProof(value)
    basis.samples++; basis.maxOrthogonalError = Math.max(basis.maxOrthogonalError, proof.orthogonalError); basis.minAbsAxisZ = Math.min(basis.minAbsAxisZ, Math.abs(proof.axisZ))
    if (proof.status !== 'pass') basis.failures++
    if (basis.examples.length < 4 || proof.status !== 'pass' && basis.examples.length < 12) basis.examples.push({ name, t: e.dollySeconds, ...proof })
    return proof
  }
  const acceleration = i => pool.birthAcceleration ? xyz(pool.birthAcceleration, i) : [0, 0, 0]
  const stamps = new Float64Array(pool.count).fill(NaN), tracked = new Map()
  const transform = p => e.scratch.vecA.clone().set(...p).applyMatrix4(e.tailPoints.matrixWorld).toArray()
  const direction = p => { const origin = transform([0, 0, 0]); return transform(p).map((v, j) => v - origin[j]) }
  let batch = { count: 0, examples: [], errors: [], inertiaErrors: [] }, observed = 0
  function observe() {
    e.scene.updateMatrixWorld(true)
    const s = e.choreography.state, head = [s.headX, s.headY, s.headZ]
    let flowProof = null
    for (let i = 0; i < pool.count; i++) {
      if (pool.active[i] !== 1) { tracked.delete(i); continue }
      const stamp = pool.birthTime[i], age = pool.age[i]
      if (stamps[i] !== stamp) {
        stamps[i] = stamp
        if (age > 1e-8) continue
        const b = xyz(pool.birthPosition, i), p = xyz(pool.positions, i), v = xyz(pool.birthVelocity, i), a = acceleration(i)
        const displacement = b.map((x, j) => x - head[j])
        const frame = shaped ? pool.flowBasis : new Float64Array([...xyz(table.axis, 0), ...xyz(table.side1, 0), ...xyz(table.side2, 0)])
        const local = [0, 1, 2].map(i => displacement.reduce((sum, x, j) => sum + x * frame[i * 3 + j], 0))
        let wedge, reconstruction = null
        if (shaped) {
          flowProof ??= checkBasis('pool.flowBasis', frame)
          const apertureLocal = xyz(pool.aperture, i)
          const expected = head.map((x, j) => x + frame[j] * apertureLocal[0] + frame[j + 3] * apertureLocal[1] + frame[j + 6] * apertureLocal[2])
          const error = Math.hypot(...b.map((x, j) => x - expected[j]))
          reconstruction = { expected, apertureLocal, flowBasis: Array.from(frame), error, tolerance: 1e-5 }
          wedge = error <= 1e-5 && flowProof.status === 'pass' && aperture.status === 'pass'
        } else wedge = Math.hypot(...displacement) <= .191 // d85 compatibility only
        const event = { i, bornAt: stamp, clock: e.dollySeconds, phase: s.phase, progress: s.phaseProgress, head: transform(head), world: transform(b), actual: transform(p), velocity: direction(v), acceleration: direction(a), local, wedge, reconstruction, axis: direction(xyz(frame, 0)), emitterVelocity: direction(xyz(table.vel, 0)) }
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
    const assignment = e.scratch.coreAssignment, count = e.scratch.body.offsets.length / 3
    const mapped = assignment ? assignment[i] : i
    if (!Number.isInteger(mapped) || mapped < 0 || mapped >= count) throw Error('instrument-invalid: invalid coreAssignment index')
    if (i === 0 && assignment && (assignment.length !== count || new Set(assignment).size !== count)) throw Error('instrument-invalid: coreAssignment is not a permutation')
    const p = xyz(e.scratch.body.offsets, mapped), b = e.scratch.bodyBasis
    if (i === 0 && shaped && b) checkBasis('scratch.bodyBasis', b)
    return b ? [0, 1, 2].map(j => b[j] * p[0] + b[j + 3] * p[1] + b[j + 6] * p[2]) : p
  }
  function proof() {
    return { status: !shaped ? 'skip' : !basis.samples ? 'instrument-invalid' : aperture.status === 'pass' && !basis.failures ? 'pass' : 'fail', aperture, basis, criterion: 'orthonormal flow/body frame with nonzero axial Z; full-rank aperture surrounds head; birth reconstruction separately gates kernel at 1e-5' }
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
  return { observe, take, offset, proof, counterfactual }
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
  replace('window.__SPACE_PROBE={meta,sample,advance,audit,stop:()=>e.stop(),engine:e}', 'window.__SPACE_PROBE={meta,sample,advance,audit,shapeProof:shape.proof,counterfactual:shape.counterfactual,stop:()=>e.stop(),engine:e}')
  return '(' + source + ')()'
}
