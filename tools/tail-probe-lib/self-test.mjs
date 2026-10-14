/**
 * Offline regression test for the pixel gates, run without Chrome.
 *
 * It reads frozen FIXTURES — real screenshots plus the geometry sidecar each one was
 * captured with — so these verdicts cannot drift when a later live run overwrites
 * `travel-*.png`. Run it after changing any gate:
 *
 *     node tools/tail-probe-lib/self-test.mjs
 *
 * Expected verdicts, and why each one matters:
 *   fixture-plume-1440x900     real plume, 18000 particles            -> PASS
 *   fixture-plume-1440x900-rm  real plume,  3000 particles (reduced)  -> PASS
 *   fixture-noplume-glyph-hold a settled glyph: no plume at all       -> FAIL
 *   synthetic rigid cone, NO fade  the V1 shape the user rejected     -> FAIL
 *   synthetic EMISSION plume   the shape the requirement describes    -> PASS
 *
 * The last two are the crux: the same gates must reject one and accept the other, or
 * they are not encoding the requirement at all.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodePng, luminance, axialProfile, profileSummary, checkPixelProfile, TH, bandWidthPx, binCount, findPlumeAxis,
  drawNoFadePlume, drawEmissionPlume,
} from './index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/*
 * The fixtures live under the workspace's `shots/tail-probe/fixtures`, two levels up from a
 * probe at `<workspace>/tools/tail-probe-lib/`. The probe is also committed inside the lane's
 * worktree at `<worktree>/tools/tail-probe-lib/`, where that relative path does not resolve —
 * so an explicit override is honoured, and otherwise the first existing candidate is used.
 * Without this the self-test silently reported every fixture "absent" when run from the
 * worktree copy, which is a pass-by-skipping failure mode.
 */
const FIX_CANDIDATES = [
  process.env.TAIL_PROBE_FIXTURES,
  join(HERE, '..', '..', 'shots', 'tail-probe', 'fixtures'),
  join(HERE, '..', '..', '..', '..', '..', 'shots', 'tail-probe', 'fixtures'),
  /* The copy committed beside the probe, so the self-test runs from a bare worktree too. */
  join(HERE, '..', 'tail-probe-fixtures'),
].filter(Boolean)
const FIX = FIX_CANDIDATES.find((p) => existsSync(p)) || FIX_CANDIDATES[0]

/**
 * Build the sampling geometry exactly as run-viewport.mjs does.
 *
 * This matters: a self-test that samples differently from the live probe proves nothing
 * about the live probe. It previously hardcoded a 40 px band while the live probe used 6,
 * which is exactly the kind of drift this file exists to catch. The band width now comes
 * from the same shared rule, driven by the frame's own tail-particle count.
 */
function geometryFor(img, g) {
  const W = bandWidthPx(g.nTail, TH)
  /*
   * The stand-off is always RECOMPUTED from the engine's reported spread, never read from a
   * stored value. A stored one goes stale the moment the rule changes, and a stale stand-off
   * silently moves the control band inside the plume — measured: a stored 61 px against the
   * recomputed 152 px made the control read 71.6% of the real peak and failed a correct frame.
   */
  const spread = g.perpP97 || g.perpP90 || Math.tan(g.halfAngle || 0.215) * g.tmax || 40
  const standoff = Math.max(W * 3, Math.round(spread * TH.pixelCtrlStandoffMult + W))
  return {
    ...g, W, B: binCount(g.tmax, W, TH), tstep: TH.pixelTstep, sstep: TH.pixelSstep,
    S: TH.pixelStripPx, perp: standoff, perpSide: 1,
  }
}

/*
 * Fallback geometry for a fixture whose sidecar is absent, so the test still runs on a
 * bare checkout instead of silently skipping. These are the values the project's 1440x900
 * frame was measured at, including `tmax` = projMax, the true tail end.
 */
const FALLBACK = {
  hx: 931.0, hy: 455.7, ax: 0.9557, ay: -0.2943, tmax: 605.0, headR: 26,
  nTail: 18000, perpP90: 60, perpP97: 70,
}

function loadFixture(name) {
  const png = join(FIX, name + '.png')
  if (!existsSync(png)) return null
  const img = decodePng(readFileSync(png))
  const side = join(FIX, name + '.geom.json')
  let g = { ...FALLBACK, nTail: TH.pixelBandRefParticles }
  if (existsSync(side)) {
    const s = JSON.parse(readFileSync(side, 'utf8'))
    g = {
      hx: s.hx, hy: s.hy, ax: s.ax, ay: s.ay, tmax: s.tmax, headR: s.headR,
      nTail: s.nTail || TH.pixelBandRefParticles,
      /*
       * The engine's reported spreads and percentile reaches are carried through. Dropping
       * them was a real bug: the control band's stand-off is derived from `perpP97`, so
       * without it the fallback took over and put the control band in a different place from
       * the live probe (measured 107 px here against the live 152 px), which then failed a
       * frame the live probe accepts.
       */
      perpP90: s.perpP90, perpP97: s.perpP97,
      projP50: s.projP50, projP90: s.projP90, projP97: s.projP97, projMax: s.projMax,
    }
  }
  return { img, g }
}

let bad = 0
let missing = 0
function run(label, img, gIn, want) {
  const gBase = geometryFor(img, gIn)
  const lum = luminance(img)
  /*
   * Re-aim onto the plume's own axis, exactly as the live probe does. Without this the
   * self-test samples along the engine's PCA axis and disagrees with the live probe on the
   * same frame — which is how this omission was found.
   */
  const aim = findPlumeAxis(lum, gBase, TH)
  const g = { ...gBase, rot: (aim.deg * Math.PI) / 180 }
  const real = aim.summary
  const ctrl = profileSummary(axialProfile(lum, { ...g, clampToImage: false }))
  const ctrlBandPeak = Math.max(...ctrl.ctrlBand.map((v) => (v === null ? 0 : v)))
  const res = checkPixelProfile(real, label, {
    ctrlBandPeak, viewport: [img.w, img.h], shot: [img.w, img.h],
  })
  const got = res.ok ? 'PASS' : 'FAIL'
  if (got !== want) bad++
  console.log((got === want ? 'ok  ' : 'WRONG') + '  ' + label.padEnd(26) + ' want ' + want + ' got ' + got)
  const pct = (v) => (v === null || v === undefined ? 'n/a' : (100 * v).toFixed(2) + '%')
  console.log('        peak ' + real.peak.toFixed(2) + ' z ' + real.peakZ.toFixed(2) +
    ' peakAt ' + real.peakAtFrac.toFixed(3) + ' end ' + pct(real.endShare) +
    ' far ' + pct(real.farShare) + ' ctrlBand ' + ctrlBandPeak.toFixed(2) +
    ' (standoff ' + real.perp + 'px) tmaxUsed ' + real.tmaxUsed.toFixed(0) + 'px W ' + g.W +
    ' B ' + g.B + ' aim ' + aim.deg + 'deg')
  for (const c of res.checks) {
    if (!c.ok) console.log('        FAIL: ' + c.name + '  [' + c.detail + ']')
  }
  if (!(real.tmaxUsed > 0)) {
    bad++
    console.log('        WRONG: nothing was measured (tmaxUsed = 0)')
  }
  return { res, real, ctrl }
}

for (const [name, want] of [
  ['fixture-plume-1440x900', 'PASS'],
  ['fixture-plume-1440x900-rm', 'PASS'],
  ['fixture-noplume-glyph-hold', 'FAIL'],
]) {
  const f = loadFixture(name)
  if (!f) {
    console.log('  skip   ' + name + ' (fixture not present)')
    missing++
    continue
  }
  run(name, f.img, f.g, want)
}

// Synthetic controls, at the geometry of the 1440x900 fixture.
const gSYN = { hx: 931.0, hy: 455.7, ax: 0.9557, ay: -0.2943, tmax: 486.7, w: 1424, h: 805, halfAngle: 0.16 }
for (const [label, buf, want, spread] of [
  ['synthetic rigid cone, NO fade', drawNoFadePlume(gSYN), 'FAIL',
    Math.tan(gSYN.halfAngle) * gSYN.tmax],
  ['synthetic EMISSION plume', drawEmissionPlume({
    ...gSYN, pxPerWorld: 486.7 / 13.0, reachMin: 7.5, reachMax: 13.0, fadePower: 0.6,
    count: 40000, halfAngle: 0.215,
  }), 'PASS', Math.tan(0.215) * gSYN.tmax],
]) {
  const img = decodePng(buf)
  /*
   * The synthetic frames have no engine geometry, so the perpendicular spread is derived from
   * the half-angle they were drawn with — the same quantity the engine would report, computed
   * from the geometry instead of measured.
   */
  run(label, img, { ...gSYN, headR: FALLBACK.headR, nTail: 40000, perpP97: spread }, want)
}

console.log('')
if (bad === 0 && missing) {
  console.log('RESULT: ' + missing + ' fixture(s) absent; every present frame matched its expected verdict')
} else if (bad === 0) {
  console.log('RESULT: ALL EXPECTED VERDICTS MATCHED')
} else {
  console.log('RESULT: ' + bad + ' MISMATCH — a gate no longer separates the frames it was fitted on')
}
process.exitCode = bad === 0 ? 0 : 1
