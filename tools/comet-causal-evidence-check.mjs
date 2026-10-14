// Audit saved real evidence. Recomputes distances from read-back xyz, never an ideal curve.
import { readFileSync, existsSync, createReadStream } from 'node:fs'
import { resolve, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { LIMITS, distribution } from './comet-causal-verdicts.mjs'
const root = resolve(process.argv[2] || 'E:/Global-session/xiao-20261012-184927/evidence/judge/baseline-verified')
const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))
assert.equal(result.exitCode, Number(readFileSync(join(root, 'exit-code.txt'), 'utf8')))
assert.notEqual(result.status, 'instrument-invalid')
const targets = ['scatter-0', 'scatter-0.25', 'scatter-0.5', 'scatter-0.62', 'scatter-0.8', 'scatter-0.95', 'scatter-1',
  'travel-0', 'travel-0.03', 'travel-0.1', 'departure+0', 'departure+0.1', 'departure+0.3', 'departure+0.8']
const perLeg = new Map(), ageByLeg = new Map(), frozen = []
for (const o of result.observations) {
  assert.ok(existsSync(join(root, o.imageFile)))
  const raw = JSON.parse(gunzipSync(readFileSync(join(root, o.rawFile))))
  const distances = []
  for (const p of raw.raw) {
    const count = p.end - p.start
    assert.equal(p.actualPositionsMainLocal.length, count * 3)
    assert.equal(p.actualColorsRGBA.length, count * 4)
    const opacity = o.pools.find(s => s.id === p.id).materialOpacity
    for (let i = 0; i < count; i++) {
      const a = p.actualColorsRGBA[i * 4 + 3] * opacity
      if (a >= LIMITS.alpha) distances.push(Math.hypot(...o.headSource.map((v, j) => p.actualPositionsMainLocal[i * 3 + j] - v)))
    }
  }
  const d = distribution(distances)
  assert.equal(d.n, o.allVisible.n)
  assert.ok(Math.abs(d.p95 - o.allVisible.p95) < 1e-10)
  assert.equal(distances.filter(d => d > LIMITS.far).length, o.allVisible.far3)
  for (const target of o.labels) {
    const labels = perLeg.get(target.leg) || new Set(); labels.add(target.label); perLeg.set(target.leg, labels)
    assert.ok(Math.abs(o.clock - target.clock) <= LIMITS.dt + 1e-7, target.label + ' timing error')
    if (target.label.startsWith('scatter-')) assert.equal(o.phase, 'scatter', target.label)
    if (target.label.startsWith('travel-')) assert.equal(o.phase, 'travel', target.label)
    if (target.label === 'scatter-0') ageByLeg.set(target.leg, raw.raw[0].tailAge)
    if (target.label === 'scatter-1' && result.instrument.poolSeparation === 'legacy-unpartitioned') {
      const initial = ageByLeg.get(target.leg), final = raw.raw[0].tailAge
      const changed = final.filter((v, i) => v !== initial[i]).length
      assert.equal(changed, 0)
      frozen.push({ leg: target.leg, count: final.length, changed, distribution: distribution(final) })
    }
  }
}
assert.equal(perLeg.size, 2)
for (const labels of perLeg.values()) for (const target of targets) assert.ok(labels.has(target), 'missing ' + target)
assert.deepEqual([...new Set(result.observations.map(o => o.direction))].sort(), ['left', 'right'])
let previous = null, motionRows = 0
for await (const line of createInterface({ input: createReadStream(join(root, 'motion.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line)
  if (previous !== null) assert.ok(Math.abs(row.clock - previous - LIMITS.dt) < 1e-7, 'nonuniform integration')
  assert.ok(row.stateHead && row.headSource && row.coreWeightedCentroid && row.coreWorldPositionOnlyStep)
  previous = row.clock; motionRows++
}
const eventCounts = {}, birthDistances = []; let nullBirthRelatches = 0
for await (const line of createInterface({ input: createReadStream(join(root, 'birth-events.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line); eventCounts[row.type] = (eventCounts[row.type] || 0) + 1
  if (row.type === 'birth') {
    assert.ok(row.actualPosition.length === 3 && Number.isFinite(row.actualAlpha) && Number.isFinite(row.inferredBirthClock))
    assert.ok(row.inferredBirthClock >= row.observedBirthInterval[0] - 1e-5 && row.inferredBirthClock <= row.observedBirthInterval[1] + 1e-5)
    birthDistances.push(row.distanceToHead)
  }
  if (row.type === 'legacy-relatch-NOT-birth' && row.inferredBirthClock === null) nullBirthRelatches++
}
assert.equal(eventCounts.birth, result.deterministic.final.lifecycle.births)
assert.equal(nullBirthRelatches, result.deterministic.final.lifecycle.legacyRelatches)
const failures = result.verdicts.filter(v => v.status === 'fail')
console.log(JSON.stringify({ pass: true, scope: '保存证据完整性复算；无理想轨迹替代',
  snapshots: result.observations.length, motionRows, targetCoverage: [...perLeg].map(([leg, labels]) => ({ leg, labels: [...labels] })),
  frozenAges: frozen, eventCounts, realBirthDistances: distribution(birthDistances),
  resultStatus: result.status, resultExit: result.exitCode, failureCount: failures.length,
  coalesce: failures.filter(v => v.criterion === 'C1-coalesce').map(v => v.evidence),
  motion: result.motion.map(m => ({ boundary: m.boundary, preSpeed: m.preSpeed, postSpeed: m.postSpeed,
    seamHeadStep: m.lastScatterToFirstTravelDisplacement, maxCorePositionOnlySpeed: m.maxCorePositionOnlySpeed,
    seam: m.segments.find(s => s.phase === 'travel') })) }, null, 2))
