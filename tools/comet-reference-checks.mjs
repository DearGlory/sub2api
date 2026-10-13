import { quantile } from './comet-reference-image.mjs'
import { decodePng } from './tail-probe-lib/png.mjs'
export const LIMITS = Object.freeze({ drawCalls: 10, geometryBytes: 3500000, fpsTarget: 55, numericalEpsilon: 1e-5 })
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]))
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null
export function deltaPixels(a, b) {
  a = decodePng(a); b = decodePng(b)
  if (a.w !== b.w || a.h !== b.h) throw Error('image dimension mismatch')
  let changed = 0, max = 0, sum = 0
  for (let i = 0; i < a.w * a.h; i++) { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * a.chans + c] - b.data[i * b.chans + c])); if (d > 0) changed++; max = Math.max(max, d); sum += d }
  return { changed, max, absoluteSum: sum, tolerance: 0, meaning: 'exact composited pixel difference; presence only, no perceptual quality threshold' }
}
export function depthMetric(positions) {
  if (positions.length < 4) return { status: 'instrument-invalid', reason: 'insufficient live samples' }
  const center = [0, 1, 2].map(j => mean(positions.map(p => p[j]))), a = Array.from({ length: 3 }, () => [0, 0, 0])
  for (const p of positions) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) a[j][k] += (p[j] - center[j]) * (p[k] - center[k]) / positions.length
  for (let n = 0; n < 32; n++) {
    let p = 0, q = 1
    for (const [j, k] of [[0, 2], [1, 2]]) if (Math.abs(a[j][k]) > Math.abs(a[p][q])) { p = j; q = k }
    if (Math.abs(a[p][q]) < 1e-14) break
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle)
    const pp = a[p][p], qq = a[q][q], pq = a[p][q]
    a[p][p] = c*c*pp - 2*s*c*pq + s*s*qq; a[q][q] = s*s*pp + 2*s*c*pq + c*c*qq; a[p][q] = a[q][p] = 0
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) { const x = a[k][p], y = a[k][q]; a[k][p] = a[p][k] = c*x - s*y; a[k][q] = a[q][k] = s*x + c*y }
  }
  const eigenvalues = [a[0][0], a[1][1], a[2][2]].sort((x, y) => x - y), ratio = eigenvalues[2] > 0 ? eigenvalues[0] / eigenvalues[2] : 0
  return { status: ratio <= 1e-10 ? 'fail' : 'pass', eigenvalues, rankRatio: ratio, criterion: 'reject numerical rank<=2, 1e-10 covariance ratio tolerance; nonzero thickness is NOT proof of sufficient visual depth' }
}
export function visibility(row, pixels = null) {
  const t = row.tail, gpu = t.gpu
  if (gpu?.status !== 'observed' || !gpu.attributes?.color?.exact || !gpu.attributes?.position?.exact) return { status: 'instrument-invalid', reason: 'actual GPU position/color mapping unavailable' }
  const opacity = gpu.uniforms.opacity
  if (typeof opacity !== 'number') return { status: 'instrument-invalid', reason: 'unmapped GPU opacity uniform' }
  let positive = 0, sum = 0, live = 0
  const colors = gpu.attributes.color.values
  for (let i = 0; i < t.active.length; i++) if (t.active[i] === 1) { live++; const a = colors[i * 4 + 3] * opacity; if (a > 0) positive++; sum += a }
  const invisible = !t.visible || t.material.opacity <= 0 || opacity <= 0 || positive === 0 || pixels?.changed === 0
  return { status: invisible ? 'fail' : pixels ? 'pass' : 'instrument-invalid', live, positiveGPUAlpha: positive, effectiveAlphaSum: sum, cpuOpacity: t.material.opacity, gpuOpacity: opacity, pixels, criterion: 'necessary visibility only; stock shader GPU alpha*opacity plus real compositor contribution, not likeness' }
}
export function tailMetrics(row) {
  const t = row.tail, indices = t.active.map((v, i) => v === 1 && t.color4[i * 4 + 3] > 0 ? i : -1).filter(i => i >= 0), pts = indices.map(i => t.positions[i]), proj = indices.map(i => t.projected[i]), h = row.headPixel
  let tip = h, far = 0
  for (const p of proj) { const d = distance(p.slice(0, 2), h.slice(0, 2)); if (d > far) { far = d; tip = p } }
  const axis = tip.slice(0, 2).map((v, j) => (v - h[j]) / (far || 1)), along = [], across = [], bins = Array.from({ length: 12 }, () => ({ count: 0, alpha: 0 }))
  for (const i of indices) { const p = t.projected[i], dx = p[0] - h[0], dy = p[1] - h[1], a = dx * axis[0] + dy * axis[1], b = -dx * axis[1] + dy * axis[0]; along.push(a); across.push(b); const bin = bins[Math.max(0, Math.min(11, Math.floor(a / (far || 1) * 12)))]; bin.count++; bin.alpha += t.color4[i * 4 + 3] }
  return { liveWithCPUAlpha: indices.length, depth: depthMetric(pts), head: h.slice(0,2), tip: tip.slice(0,2), projectionLength98: quantile(along, .98), projectionWidth96: indices.length ? quantile(across,.98)-quantile(across,.02) : null, bins, interpretation: 'CPU/GPU positions only; a hidden tail still has geometry. See visibility check and screenshots for actual appearance.' }
}
export function motionCheck(a, b) {
  const deltas = [], speeds = []
  for (let i = 0; i < a.tail.active.length; i++) if (a.tail.active[i] === 1 && b.tail.active[i] === 1 && a.tail.birthTime[i] === b.tail.birthTime[i]) { deltas.push(distance(a.tail.positions[i], b.tail.positions[i])); speeds.push(Math.hypot(...b.tail.birthVelocity.slice(i*3,i*3+3))) }
  const expected = mean(speeds) * (b.t - a.t), moved = deltas.filter(d => d > LIMITS.numericalEpsilon).length
  return { status: !deltas.length || b.t <= a.t || expected <= LIMITS.numericalEpsilon ? 'instrument-invalid' : moved === 0 ? 'fail' : 'pass', matchedBirths: deltas.length, moved, meanDisplacement: mean(deltas), expectedInertialMean: expected, criterion: 'same pool index AND birthTime; reject completely static tail despite nonzero birth velocity' }
}
export function lifecycle(history) {
  const births = new Map(history.births.map(b => [b.i + ':' + b.stamp, b])), drift = [], offsets = [], series = [], bins = new Map()
  for (const b of history.births) offsets.push(distance(b.source, b.head))
  for (const p of history.trajectories) { const b = births.get(p.i + ':' + p.stamp); if (b) drift.push(distance(p.position, b.source.map((v,j) => v+b.velocity[j]*p.age+.5*(b.acceleration?.[j]||0)*p.age*p.age))) }
  for (const b of history.bins.filter(b => b.phase === 'travel')) { const key = Math.floor(b.t * 10); const bin = bins.get(key) || { t: key / 10, births: 0, speedSum: 0, alpha: 0, frames: 0 }; bin.births += b.births; bin.speedSum += b.speedSum; bin.alpha += b.alpha; bin.frames++; bins.set(key, bin) }
  for (const b of bins.values()) series.push({ t: b.t, births: b.births, meanBirthSpeed: b.births ? b.speedSum/b.births : null, meanTailAlpha: b.alpha/b.frames })
  const birthSpeeds = series.filter(b => b.meanBirthSpeed !== null).map(b => b.meanBirthSpeed), retiredVisible = history.retirements.filter(r => r.alpha !== 0).length
  const result = { birthCount: history.births.length, trackedSamples: history.trajectories.length, retirements: history.retirements.length, birthOffset: { min: Math.min(...offsets), p50: quantile(offsets,.5), p98: quantile(offsets,.98), max: Math.max(...offsets) }, inertiaErrorMax: drift.length ? Math.max(...drift) : null, retiredVisible, birthSpeedRange: [Math.min(...birthSpeeds),Math.max(...birthSpeeds)], series,
    retirement: { status: !history.retirements.length ? 'skip' : retiredVisible ? 'fail' : 'pass', criterion: 'observed transparent retirement frames' },
    convection: { status: 'skip', reason: 'Birth speed/count series and identity-linked trajectories measured. This does not by itself prove visible pulse strength advects rather than whole-tail synchronous flicker; manual temporal review / normal-clock sequence still required.' } }
  return result
}
export function scatterMetrics(rows) {
  if (rows.length < 5) return { status: 'skip', reason: 'need 5 scatter snapshots' }
  const centers = rows.map(r => [0,1,2].map(j => mean(r.body.positions.map(p => p[j])))), headDrift = Math.max(...rows.map(r => distance(r.head,rows[0].head))), intervals=[]
  for (let k=1;k<rows.length;k++) { const a=rows[k-1],b=rows[k], speeds=[],inward=[],tangent=[]
    for(let i=0;i<a.body.positions.length;i++){const p=a.body.positions[i],q=b.body.positions[i],r=distance(p,a.head),r2=distance(q,b.head),v=q.map((x,j)=>x-p[j]),len=Math.hypot(...v),radial=v.reduce((s,x,j)=>s+x*(p[j]-a.head[j])/(r||1),0);speeds.push((r-r2)/(b.t-a.t));inward.push(r2<r?1:0);tangent.push(len ? Math.sqrt(Math.max(0,len*len-radial*radial))/len : 0)}
    intervals.push({from:a.q,to:b.q,inwardFraction:mean(inward),meanInwardSpeed:mean(speeds),meanTangentialShare:mean(tangent)}) }
  const early=mean(intervals.slice(0,2).map(i=>i.meanInwardSpeed)),late=mean(intervals.slice(-2).map(i=>i.meanInwardSpeed))
  return { status: headDrift>LIMITS.numericalEpsilon || intervals.some(i=>i.inwardFraction<.5) || !(late>early) ? 'fail':'pass',headDrift,centers,intervals,earlySpeed:early,lateSpeed:late,criterion:'head stationary within inherited 1e-5 world tolerance; majority moves inward in every interval; average later half radial speed strictly exceeds earlier half. Visual disc absence separate; this is not a full motion-contract pass.' }
}
export function resourceBudget(rows) {
  if (!rows.length || rows.some(r => !Number.isFinite(r.drawCalls) || !Number.isFinite(r.geometryBytes) || r.drawCalls < 0 || r.geometryBytes < 0)) return { status: 'instrument-invalid', reason: 'missing full-scene drawCalls/geometryBytes samples' }
  const maxDrawCalls = Math.max(...rows.map(r => r.drawCalls)), maxGeometryBytes = Math.max(...rows.map(r => r.geometryBytes))
  return { status: maxDrawCalls <= LIMITS.drawCalls && maxGeometryBytes <= LIMITS.geometryBytes ? 'pass' : 'fail', maxDrawCalls, maxGeometryBytes, samples: rows, limits: { drawCalls: LIMITS.drawCalls, geometryBytes: LIMITS.geometryBytes }, criterion: 'actual full-scene samples before isolation/GPU audit; short capture budget only, not steady-state FPS' }
}
export function discCheck(mesh, delta) {
  if (!mesh) return { status: 'instrument-invalid', reason: 'missing actual mesh inventory' }
  return { status: delta?.changed>0 ? 'fail' : delta ? 'pass':'instrument-invalid', uuid:mesh.uuid,pixels:delta,criterion:'candidate disc was independently identified / injected; actual compositor contribution must be zero. Unknown mesh appearance requires manual review.' }
}
