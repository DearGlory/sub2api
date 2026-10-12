// Fixed before baseline measurement. No CLI threshold overrides.
export const LIMITS = Object.freeze({ alpha: 0.01, p95: 1.5, far: 3, zeroSpeed: 1e-6, fps: 55,
  coalesce: 0.62, leg: 6.5, gather: 1.4, hold: 3, scatter: 1.1, dt: 1 / 120 })
export function distribution(values) {
  if (!values.length) return { n: 0, min: null, p50: null, p95: null, max: null }
  const a = [...values].sort((x, y) => x - y)
  return { n: a.length, min: a[0], p50: a[Math.floor((a.length - 1) * .5)],
    p95: a[Math.floor((a.length - 1) * .95)], max: a.at(-1) }
}
export function compactVerdict(d) {
  return d.n > 0 && d.p95 <= LIMITS.p95 && d.far3 === 0
}
export function motionVerdict(m) {
  if (m.preSpeed <= LIMITS.zeroSpeed) return 'fail:scatter-departure-stationary'
  if (m.postSpeed <= LIMITS.zeroSpeed || m.minimumAfterSpeed <= LIMITS.zeroSpeed) return 'fail:travel-speed-reset-zero'
  return 'manual-review:nonzero-continuity'
}
const norm = (a) => Math.hypot(...a)
const sub = (a, b) => a.map((v, i) => v - b[i])
export function analyzeMotion(rows, boundary, dt) {
  const around = rows.filter(r => r.clock >= boundary - .21 && r.clock <= boundary + .21)
  const segments = around.slice(1).map((r, i) => {
    const p = around[i], span = r.clock - p.clock
    const velocity = sub(r.headSource, p.headSource).map(v => v / span)
    return { clock: r.clock, phase: r.phase, progress: r.progress, span,
      velocity, speed: norm(velocity), displacement: norm(sub(r.headSource, p.headSource)),
      corePositionOnlySpeed: r.corePositionOnlyStep ? norm(r.corePositionOnlyStep) / span : null,
      coreWeightedCentroid: r.coreWeightedCentroid, coreUnweightedCentroid: r.coreUnweightedCentroid }
  })
  segments.forEach((s, i) => { s.acceleration = i ? sub(s.velocity, segments[i - 1].velocity).map(v => v / s.span) : null })
  const pre = segments.filter(r => r.clock < boundary - 1e-8)
  const post = segments.filter(r => r.clock >= boundary - 1e-8)
  if (pre.length < 2 || post.length < 2) return { status: 'instrument-invalid', boundary }
  const m = { boundary, sampleStep: dt, preSpeed: pre.at(-1).speed, postSpeed: post[0].speed,
    minimumAfterSpeed: Math.min(...post.map(r => r.speed)),
    lastScatterToFirstTravelDisplacement: post[0].displacement,
    velocityVectorJump: norm(sub(post[0].velocity, pre.at(-1).velocity)),
    maxHeadStep: Math.max(...segments.map(r => r.displacement)),
    maxCorePositionOnlySpeed: Math.max(...segments.map(r => r.corePositionOnlySpeed ?? 0)), segments }
  m.status = motionVerdict(m)
  return m
}
export function analyzePerf(data) {
  const buckets = {}
  for (const f of data.frames) (buckets[f.window] ||= []).push(f)
  const windows = Object.fromEntries(Object.entries(buckets).map(([key, rows]) => {
    const ds = rows.map(r => r.dt).filter(d => d > 0)
    const sum = ds.reduce((a, b) => a + b, 0)
    return [key, { ...distribution(ds), fps: sum ? ds.length * 1000 / sum : null,
      over55Budget: ds.filter(d => d > 1000 / LIMITS.fps).length,
      longTaskOverlapFrames: rows.filter(r => data.longtasks.some(t => t.start < r.now && t.start + t.duration > r.now - r.dt)).length,
      networkOverlapFrames: rows.filter(r => data.resources.some(t => t.start < r.now && t.start + t.duration > r.now - r.dt)).length,
      observerCost: distribution(rows.map(r => r.observerCost)) }]
  }))
  const low = Object.entries(windows).filter(([, v]) => v.fps < LIMITS.fps).map(([k]) => k)
  return { windows, lowFpsWindows: low, status: low.length ? 'review:measured-below-55fps' : 'measured-at-least-55fps',
    cause: '未归因：longtask/resource重叠仅是相关性；若所有phase同频下降，只报告原始数值。正常run不做geometry批量读回/截图/录屏。',
    coverage: { legs: [...new Set(data.frames.map(r => r.leg))], phases: [...new Set(data.frames.map(r => r.phase))] } }
}
export function selfCheck() {
  const compact = { ...distribution([.1, .3, .8, 1.1]), far3: 0 }
  const tail = { ...distribution([.1, 4, 8, 13]), far3: 3 }
  const checks = [
    { name: 'compact-control', ok: compactVerdict(compact) },
    { name: 'intentional-13u-tail-detected', ok: !compactVerdict(tail) },
    { name: 'scatter-stall-detected', ok: motionVerdict({ preSpeed: 0, postSpeed: .002, minimumAfterSpeed: .002 }).startsWith('fail:') },
    { name: 'second-start-zero-detected', ok: motionVerdict({ preSpeed: .8, postSpeed: 0, minimumAfterSpeed: 0 }).startsWith('fail:') },
    { name: 'nonzero-not-falsely-certified-C2', ok: motionVerdict({ preSpeed: .8, postSpeed: .81, minimumAfterSpeed: .81 }).startsWith('manual-review:') },
  ]
  return { pass: checks.every(c => c.ok), checks, scope: '判据单元负控；不改被测实现。实际读回负控另在浏览器中对副本注入13u长尾。' }
}
