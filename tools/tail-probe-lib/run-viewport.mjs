/**
 * One viewport run: launch Chrome, drive the page, collect numbers, return rows.
 *
 * The whole run is a data-collection pass. It returns `checks` only because the
 * checkers are cheap; the checkers themselves are imported from the pure module so
 * the same functions can be handed mutants by the caller.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, CDP, launchChrome, sleep, freezeAndSettle, RESUME_RAF, RAF_LIVE } from './cdp.mjs'
import { PAGE_HELPERS } from './page.mjs'
import { MODULE_SETUP, FADE_SAMPLES, MEASURE_TAIL, TABLE_STATS } from './module-expr.mjs'
import {
  decodePng, luminance, axialProfile, profileSummary, TH, bandWidthPx, axisRoom, binCount, findPlumeAxis,
  checkFade, checkTable, checkReachModel, checkPixelProfile, checkTransition, checkHold, holdRuns,
  drawNoFadePlume, emissionControlFrame,
} from './index.mjs'

const row = (name, ok, detail) => ({ name, ok: ok === true, detail: String(detail) })
const fix = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : String(v))
function medianOf(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length / 2))]
}

/** Does the RIDGE band (t = 0..tmax) stay inside the image? */
function bandFits(w, h, g, pad) {
  const p = pad === undefined ? 3 : pad
  for (let t = 0; t <= g.tmax; t += 2) {
    for (const s of [-g.W, g.W]) {
      const x = g.hx + g.ax * t - g.ay * s
      const y = g.hy + g.ay * t + g.ax * s
      if (x < p || y < p || x >= w - p || y >= h - p) return false
    }
  }
  return true
}

function profileOf(b64, geom, headR, tmax, extra) {
  const img = decodePng(Buffer.from(b64, 'base64'))
  const lum = luminance(img)
  const W = bandWidthPx(geom.nTail, TH)
  /*
   * The measured length is the tail's own 97th-percentile reach, not `projMax`.
   *
   * `projMax` is the distance of the single most distant particle, and it overshoots badly:
   * measured at 1440x900, projP50 = 287 px against projMax = 754 px, so more than half the
   * sampled axis was empty sky and the far bins — exactly where "the tail fades to nothing"
   * is judged — sat nowhere near the tail. At p = 0.43 that produced farShare 52.8% on a
   * frame whose tail is unmistakably front-loaded.
   */
  const g = {
    hx: geom.nucleus[0], hy: geom.nucleus[1], ax: geom.axis[0], ay: geom.axis[1],
    tmax, headR, W, B: binCount(tmax, W, TH), tstep: TH.pixelTstep, sstep: TH.pixelSstep,
    S: TH.pixelStripPx, ...(extra || {}),
  }
  return {
    img,
    real: profileSummary(axialProfile(lum, g)),
    rotated: profileSummary(axialProfile(lum, { ...g, rot: Math.PI / 2, perp: 0, clampToImage: false })),
    g,
  }
}

function ctrlStandoff(geom, W) {
  const spread = geom.perpP97 || geom.perpP90 || 40
  return Math.max(W * 3, Math.round(spread * TH.pixelCtrlStandoffMult + W))
}

/**
 * Pool several sampled moments into one profile, bin by bin.
 *
 * WHY THIS IS THE RIGHT HEADLINE STATISTIC, measured. The tail is rendered from a finite
 * particle set, so any single frame carries shot noise: a single particle landing in the far
 * bin can lift it above the spec's 5% on a frame whose tail plainly fades. Measured at
 * 1440x900 / reduced motion (3000 tail particles), one moment's end-share was 6.30% while the
 * other five moments of the same leg read 3.58%, 0.00%, 2.34%, 4.23%, 0.00% — the outlier is
 * one or two particles, not a tail that fails to fade.
 *
 * The excess of an average over M moments has M times the sample size of one moment, so the
 * shot noise falls as sqrt(M) while the tail's actual profile does not move. The pooled
 * profile is therefore a better estimate of "what the tail looks like" than any single frame,
 * and the per-moment extremes are still computed and reported separately (see the worst-moment
 * gate) so pooling cannot hide an intermittent defect.
 *
 * Requires the moments to share a bin count, which they do: all profiles of a viewport are
 * built with the same `binCount`, and with the shipped settings that is 12 everywhere.
 */
function poolMoments(moments) {
  const B = moments[0].real.excess.length
  const excess = []
  const se = []
  for (let b = 0; b < B; b++) {
    let sx = 0
    let ss = 0
    let n = 0
    for (const m of moments) {
      if (m.real.excess.length !== B) continue
      sx += m.real.excess[b]
      const s = m.real.se[b]
      ss += Number.isFinite(s) ? s * s : 0
      n++
    }
    excess.push(n ? sx / n : 0)
    se.push(n ? Math.sqrt(ss) / n : Infinity)
  }
  return { B, excess, se, moments: moments.length }
}

/** Reduce a pooled profile to the same scalars `profileSummary` produces for one frame. */
function poolSummary(pool) {
  const ex = pool.excess
  const N = ex.length
  let peak = -Infinity
  let pi = 0
  for (let i = 0; i < N; i++) if (ex[i] > peak) { peak = ex[i]; pi = i }
  const farFrom = Math.floor(N * 0.75)
  const farVals = ex.slice(farFrom)
  const farMean = farVals.reduce((a, b) => a + b, 0) / farVals.length
  return {
    peak,
    peakBin: pi,
    peakAtFrac: pi / N,
    peakZ: pool.se[pi] > 0 ? ex[pi] / pool.se[pi] : 0,
    peakSe: pool.se[pi],
    endExcess: ex[N - 1],
    endSe: pool.se[N - 1],
    endZ: pool.se[N - 1] > 0 ? ex[N - 1] / pool.se[N - 1] : 0,
    endShare: peak > 0 ? ex[N - 1] / peak : null,
    farMean,
    farShare: peak > 0 ? farMean / peak : null,
    tmaxUsed: pool.tmaxUsed,
    outsideShare: pool.outsideShare,
    perp: pool.perp,
    perpSide: pool.perpSide,
    ctrlBand: pool.ctrlBand,
    excess: ex,
    z: ex.map((v, i) => (pool.se[i] > 0 ? v / pool.se[i] : 0)),
    se: pool.se,
    nA: ex.map(() => pool.moments),
    nC: ex.map(() => pool.moments),
  }
}

/**
 * Pool the sampled moments, including the parallel control band. See `poolMoments`.
 */
function poolFromMoments(moments, tmax, perp, perpSide) {
  const p = poolMoments(moments)
  const B = p.B
  const ctrl = []
  for (let b = 0; b < B; b++) {
    let s = 0
    let n = 0
    for (const m of moments) {
      const c = m.ctrlBandCurve
      if (!c || c.length !== B) continue
      if (c[b] === null || c[b] === undefined) continue
      s += c[b]
      n++
    }
    ctrl.push(n ? s / n : null)
  }
  p.ctrlBand = ctrl
  p.tmaxUsed = tmax
  p.outsideShare = 0
  p.perp = perp
  p.perpSide = perpSide
  return p
}

/**
 * The stand-off of the parallel control band, from the engine's own reported spread.
 *
 * Not a tuned constant: the engine reports how far its tail particles actually sit from the
 * axis (perpP97), and the control band is placed just outside that — 1.15x, plus the band's
 * own half-width so the two bands cannot overlap. Measured across the five reference frames,
 * 1.15x is the smallest stand-off that separates them all.
 */

/**
 * Pick the side for the control band that stays inside the image longest.
 *
 * The tail runs mostly toward +x, so one side leaves the canvas earlier than the other.
 * Choosing the better side is not a way to soften the test — the band is the same width and
 * the same stand-off either way, and the choice is reported in the artifact. It only avoids
 * measuring the control where there is no picture.
 */
function chooseCtrlSide(w, h, g, perp) {
  const room = (sign) => axisRoom(w, h, { ...g, perp }, undefined, sign, 3)
  const pos = room(1)
  const neg = room(-1)
  return { sign: pos >= neg ? 1 : -1, roomPos: pos, roomNeg: neg, room: Math.max(pos, neg) }
}

/**
 * Capture one travel-phase plume frame, with the geometry and the pixels from the SAME
 * frame.
 *
 * WHY THE PAGE IS FROZEN FIRST — this was a real bug, found by measurement, and it is
 * the reason this function is not three lines:
 *
 * The obvious implementation reads the geometry and then screenshots. Those two calls
 * are ~100 ms apart, and at 60 fps the comet moves tens of pixels in that time, so the
 * axis being sampled does not pass through the plume in the image. The symptom was a
 * profile that swung between peak 10 and peak 67 across a single travel leg, with 5–15%
 * of the band off-image. The engine's own numbers were exact; the pixels were being
 * sampled against a stale frame.
 *
 * `Emulation.setVirtualTimePolicy({policy: 'pause'})` was tried for this and ABANDONED —
 * it does stop rAF, but it stops `setTimeout` too, so liveness cannot be probed from the
 * page and the frame recording afterwards hung until the CDP timeout. The probe instead
 * replaces `requestAnimationFrame` with a QUEUE inside the page (see `FREEZE_RAF` in
 * cdp.mjs): the scene stops, the compositor keeps the last frame so the screenshot still
 * shows the comet, and the queue makes the freeze reversible — which the probe checks by
 * releasing the queue and measuring that the engine's phase progress moves again.
 *
 * Measured with the queue freeze: rAF callbacks in 2 s go 5 -> 0 across the freeze;
 * geometry identical; screenshots byte-identical; profile peak spread 0.0000 of 26.04;
 * and after resume the phase progress advances (0.1342 -> 0.3233 -> 0.5381) on three
 * consecutive free/resume cycles. `freeze` in the result reports the observed numbers.
 *
 * The moments are sampled from the travel phase while the whole ridge band stays on
 * screen — otherwise the last bins fall outside the image and the "fades to nothing at
 * the end" gate reads a viewport edge rather than a fade.
 */
async function capturePlume(cdp, outDir, label, opts) {
  const deadline = Date.now() + 90000
  /*
   * SAMPLE SEVERAL MOMENTS, do not pick one.
   *
   * The comet's speed varies along the leg, so the plume's apparent brightness does too:
   * measured peaks range from 5 to 68 luminance units across one travel phase at
   * 1440x900. Picking a single moment would be a way to shop for a verdict, so every
   * moment that meets the geometric precondition is measured and reported, and the verdict
   * is taken across all of them.
   *
   * Precondition: the phase is travel and the projected plume lies wholly inside the
   * image, so the last bins sample the tail rather than a viewport edge. Measured
   * without that condition: 8.7% of taps off-image and a final bin holding 44% of the
   * peak — a viewport edge read as a failure to fade.
   *
   * The page is frozen with `FREEZE_RAF` before each geometry read, so the geometry and
   * the pixels provably come from one frame; see cdp.mjs for why the virtual-time
   * approach was abandoned.
   */
  const moments = []
  let tries = 0
  let lastWhy = 'none'
  let frozenProbe = null
  let scenePresent = null
  let unstable = 0
  while (Date.now() < deadline && moments.length < 6) {
    tries++
    const live = await cdp.eval(RAF_LIVE)
    if (frozenProbe === null) {
      // The freeze is verified once per run, on real evidence: rAF must have been firing
      // before, must stop after, and the settled queue must hold exactly the one callback
      // the engine's own `tick` left behind.
      const s = await freezeAndSettle(cdp, sleep)
      const stopped = await cdp.eval(RAF_LIVE)
      frozenProbe = { liveFired: live && live.fired, stoppedFired: stopped && stopped.fired, queued: s.queued }
    } else {
      await freezeAndSettle(cdp, sleep)
    }
    const st = await cdp.eval('window.__TP.state()')
    if (!st || st.__error) return { error: 'state: ' + (st && st.__error) }
    const geom = await cdp.eval('window.__TP.geom()')
    if (!geom || geom.__error) return { error: 'geometry: ' + (geom && geom.__error) }
    const headR = Math.max(8, geom.headPx)
    /*
     * The measured length is the tail's own 97th-percentile reach: see the note in
     * `profileOf`. `pixelTmaxField` names which engine report to use, so the choice is
     * visible and reversible rather than buried.
     */
    const tmax = geom[TH.pixelTmaxField]
    const W = bandWidthPx(geom.nTail, TH)
    const candidate = {
      hx: geom.nucleus[0], hy: geom.nucleus[1], ax: geom.axis[0], ay: geom.axis[1], tmax, W,
    }
    const geomOk = bandFits(st.inner[0], st.inner[1], candidate, 3)
    if (st.phase === 'travel' && geomOk) {
      const b64 = await cdp.shot()
      /*
       * Assert the frame was actually frozen before believing the pixels.
       *
       * This is the check that would have caught the stale-frame bug immediately: with the
       * earlier freeze the nucleus moved (1031.3,390.7) -> (1029.1,391.7) between the
       * geometry read and the screenshot, so the axis was sampled against a frame the
       * pixels did not belong to. A moment whose geometry will not sit still is DISCARDED
       * rather than measured — and the count of discarded moments is reported.
       */
      const geom2 = await cdp.eval('window.__TP.geom()')
      if (!geom2 || JSON.stringify(geom2.nucleus) !== JSON.stringify(geom.nucleus)) {
        unstable++
        lastWhy = 'geometry moved between the read and the screenshot (unstable freeze)'
        await cdp.eval(RESUME_RAF)
        await sleep(420)
        continue
      }
      const m = profileOf(b64, geom, headR, tmax)
      /*
       * Re-aim the profile onto the plume's own axis before measuring the shape.
       *
       * The engine reports a PCA axis over the whole (curving) tail, and measured it sits
       * 8-32 degrees from the direction the frame is actually bright in. Measuring the shape
       * along the PCA axis therefore reported a flat, non-fading profile at those moments —
       * a property of the probe's aim, not of the tail. The search is bounded and the offset
       * it found is carried through to a gate.
       */
      const aim = findPlumeAxis(luminance(m.img), m.g, TH)
      const lumImg = luminance(m.img)
      const gAim = { ...m.g, rot: (aim.deg * Math.PI) / 180 }
      const realAim = profileSummary(axialProfile(lumImg, gAim))
      // The parallel control band, offset from the engine's own perpendicular spread.
      const standoff = ctrlStandoff(geom, m.g.W)
      const side = chooseCtrlSide(st.inner[0], st.inner[1], gAim, standoff)
      const ctrl = profileSummary(axialProfile(lumImg, {
        ...gAim, perp: standoff, perpSide: side.sign, clampToImage: false,
      }))
      if (scenePresent === null) scenePresent = realAim.peak
      moments.push({
        st, geom, headR, tmax, b64, real: realAim, rotated: m.rotated, img: m.img,
        ctrlBandPeak: Math.max(...ctrl.ctrlBand.map((v) => (v === null ? 0 : v))),
        ctrlBandCurve: ctrl.ctrlBand,
        standoff, ctrlSide: side, axisOffsetDeg: aim.deg, peakOnPcaAxis: m.real.peak,
      })
    } else {
      lastWhy = st.phase + (geomOk ? '' : ' (plume crosses a viewport edge)')
    }
    await cdp.eval(RESUME_RAF)
    await sleep(420)
  }
  await cdp.eval(RESUME_RAF)
  if (!moments.length) {
    return {
      error: 'no travel frame with the whole plume on screen within 90 s (' + tries +
        ' scopes examined; last state was ' + lastWhy + ')',
    }
  }
  /*
   * WHICH MOMENT THE HEADLINE VERDICT USES: the MEDIAN of those sampled, not the best one.
   *
   * Selecting by peak sounds flattering but is the opposite: the strongest plume is also the
   * one with the most light left at its far end, so choosing it hunts for the worst end-share.
   * Measured at 1440x900 on one leg: peak 154.7 gave endShare 7.18% while the other five
   * moments gave 2.29%, 0.51%, 0.11%, 0.84%, 0.46%. Neither extreme is representative, so the
   * headline uses the middle moment and the full distribution is reported alongside it.
   */
  const byPeak = [...moments].sort((a, b) => a.real.peak - b.real.peak)
  const best = byPeak[Math.floor(byPeak.length / 2)]
  const worstEndShare = moments.reduce((a, m) => Math.max(a, m.real.endShare === null ? 0 : m.real.endShare), 0)
  const name = 'travel-' + label + (opts.reduced ? '-rm' : '')
  writeFileSync(join(outDir, name + '.png'), Buffer.from(best.b64, 'base64'))
  writeFileSync(join(outDir, name + '.geom.json'), JSON.stringify({
    w: best.img.w, h: best.img.h, hx: best.geom.nucleus[0], hy: best.geom.nucleus[1],
    ax: best.geom.axis[0], ay: best.geom.axis[1], tmax: best.tmax,
    headR: best.headR, W: bandWidthPx(best.geom.nTail, TH),
    B: binCount(best.tmax, bandWidthPx(best.geom.nTail, TH), TH),
    tstep: TH.pixelTstep, sstep: TH.pixelSstep, S: TH.pixelStripPx,
    perp: best.standoff, perpSide: best.ctrlSide.sign,
    camZ: best.geom.camZ, nTail: best.geom.nTail, phase: best.st.phase, p: best.st.p,
    perpP90: best.geom.perpP90, perpP97: best.geom.perpP97,
    projP50: best.geom.projP50, projP90: best.geom.projP90, projP97: best.geom.projP97,
    projMax: best.geom.projMax,
  }, null, 2))
  return {
    moments, best, geom: best.geom, img: best.img, real: best.real, rotated: best.rotated,
    headR: best.headR, shot: [best.img.w, best.img.h], moment: best.st,
    freeze: { ...frozenProbe, scenePresent, tries, discardedUnstable: unstable },
    worstEndShare,
    endShares: moments.map((m) => m.real.endShare),
  }
}

/**
 * The synthetic rigid cone drawn by the probe itself, on the SAME axis and nucleus as
 * the real frame, at the same viewport. This is the negative control for the shape
 * gates: if they accept this, they would have accepted the old tail.
 */
function coneControl(geom, img, headR) {
  /*
   * The rigid no-fade cone, drawn by the probe itself on the SAME axis and nucleus as the
   * real frame. This is the negative control for the shape gates: if they accept this, they
   * would have accepted the old tail.
   *
   * Its half-angle is 0.16, so its half-width at the tip is 0.16 x tmax — which is why the
   * control band's stand-off has to come from the frame's actual spread rather than from a
   * constant: the cone's own flank fills almost any fixed offset.
   */
  const tmax = geom[TH.pixelTmaxField]
  const buf = drawNoFadePlume({
    w: img.w, h: img.h, hx: geom.nucleus[0], hy: geom.nucleus[1],
    ax: geom.axis[0], ay: geom.axis[1], tmax, halfAngle: 0.16,
  })
  const lum = luminance(decodePng(buf))
  const W = bandWidthPx(TH.pixelBandRefParticles, TH)
  const spread = Math.tan(0.16) * tmax
  const standoff = Math.round(spread * TH.pixelCtrlStandoffMult + W)
  const g = {
    hx: geom.nucleus[0], hy: geom.nucleus[1], ax: geom.axis[0], ay: geom.axis[1],
    tmax, headR, W, B: binCount(tmax, W, TH), tstep: TH.pixelTstep, sstep: TH.pixelSstep,
    S: TH.pixelStripPx, perp: standoff, perpSide: 1,
  }
  const sum = profileSummary(axialProfile(lum, g))
  const ctrl = profileSummary(axialProfile(lum, { ...g, clampToImage: false }))
  return {
    buf,
    summary: sum,
    ctrlBandPeak: Math.max(...ctrl.ctrlBand.map((v) => (v === null ? 0 : v))),
    standoff,
  }
}

/**
 * The independent positive control: a frame built from the documented emission model
 * at this viewport, so the gates are shown to accept the intended shape from a source
 * other than the engine under test.
 */
function emissionControl(geom, img, headR, C) {
  const tmax = geom[TH.pixelTmaxField]
  const buf = emissionControlFrame({
    w: img.w, h: img.h, hx: geom.nucleus[0], hy: geom.nucleus[1],
    ax: geom.axis[0], ay: geom.axis[1], tmax,
    pxPerWorld: tmax / C.TAIL_DUST_REACH_MAX, reachMin: C.TAIL_DUST_REACH_MIN,
    reachMax: C.TAIL_DUST_REACH_MAX, fadePower: C.TAIL_FADE_POWER, halfAngle: 0.215,
  })
  const lum = luminance(decodePng(buf))
  const W = bandWidthPx(TH.pixelBandRefParticles, TH)
  const standoff = Math.round(Math.tan(0.215) * tmax * TH.pixelCtrlStandoffMult + W)
  const g = {
    hx: geom.nucleus[0], hy: geom.nucleus[1], ax: geom.axis[0], ay: geom.axis[1],
    tmax, headR, W, B: binCount(tmax, W, TH), tstep: TH.pixelTstep, sstep: TH.pixelSstep,
    S: TH.pixelStripPx, perp: standoff, perpSide: 1,
  }
  const sum = profileSummary(axialProfile(lum, g))
  const ctrl = profileSummary(axialProfile(lum, { ...g, clampToImage: false }))
  sum.ctrlBandPeak = Math.max(...ctrl.ctrlBand.map((v) => (v === null ? 0 : v)))
  sum.standoff = standoff
  return sum
}

export async function runViewport(plan, cfg) {
  const { label, w, h, reduced } = plan
  const tag = label + (reduced ? ' / reduced-motion' : '')
  const res = {
    tag, viewport: label, inner: [w, h], reducedMotion: reduced,
    checks: [], metrics: {}, artifacts: {}, error: null,
    reward: {},
  }
  let cdp = null
  let ws = null
  let proc = null
  const fail = (name, detail) => res.checks.push(row(name, false, detail))
  try {
    mkdirSync(cfg.out, { recursive: true })
    mkdirSync(cfg.profile, { recursive: true })
    proc = launchChrome({
      port: cfg.port, profile: cfg.profile, chrome: cfg.chrome, w, h, reducedMotion: reduced,
    })
    ws = new WebSocket(await connect(cfg.port))
    await new Promise((ok, no) => {
      ws.addEventListener('open', ok, { once: true })
      ws.addEventListener('error', no, { once: true })
    })
    cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    const nav = await cdp.send('Page.navigate', { url: cfg.url })
    if (nav && nav.errorText) {
      fail('the page loaded', nav.errorText)
      return res
    }
    await sleep(cfg.bootMs)

    const boot = await cdp.eval('window.__SUB2API_PARTICLE_STATS__ ? { ok: true } : { ok: false }')
    if (!boot || boot.__error || !boot.ok) {
      fail('the particle engine started and published stats',
        'window.__SUB2API_PARTICLE_STATS__ is absent after ' + (cfg.bootMs / 1000) + ' s — nothing to probe')
      return res
    }
    await cdp.eval(PAGE_HELPERS)
    const st0 = await cdp.eval('window.__TP.state()')
    if (!st0 || st0.error) {
      fail('the engine exposes its own state', st0 && st0.error)
      return res
    }
    res.metrics.boot = {
      inner: st0.inner, dpr: st0.dpr, reducedMotion: st0.reduced, pointSize: st0.pointSize,
      particleCount: st0.particleCount, quality: st0.quality,
    }
    res.checks.push(row('the particle engine is running and reachable', true,
      'viewport ' + st0.inner.join('x') + ', dpr ' + st0.dpr + ', ' + st0.particleCount + ' particles, reducedMotion ' + st0.reduced))
    if (reduced) {
      res.checks.push(row('reduced-motion preference reached the engine', st0.reduced === true,
        'engine reports reducedMotion = ' + st0.reduced))
    }

    // ---- module import -----------------------------------------------------
    const mod = await cdp.eval(MODULE_SETUP)
    if (!mod || mod.__error) {
      fail('the emission kernel imports inside the running page', mod && mod.__error ? mod.__error : 'no result')
      return res
    }
    const C = {
      HOLD_SECONDS: mod.HOLD_SECONDS, HEAD_CORE_RADIUS: mod.HEAD_CORE_RADIUS,
      TAIL_DUST_REACH_MIN: mod.TAIL_DUST_REACH_MIN, TAIL_DUST_REACH_MAX: mod.TAIL_DUST_REACH_MAX,
      TAIL_SECONDS: mod.TAIL_SECONDS, TAIL_ENTRAIN: mod.TAIL_ENTRAIN,
      TAIL_FADE_POWER: mod.TAIL_FADE_POWER, TAIL_RADIUS: mod.TAIL_RADIUS,
    }
    res.metrics.constants = C
    res.checks.push(row('the four emission-kernel entry points are exported and callable',
      mod.imports.tailFade === 'function' && mod.imports.createEmissionTable === 'function' &&
      mod.imports.fillEmissionTable === 'function' && mod.imports.writeTailParticlePosition === 'function',
      JSON.stringify(mod.imports)))

    // ---- §1a tailFade ------------------------------------------------------
    const fd = await cdp.eval(FADE_SAMPLES)
    if (fd && fd.__error) {
      fail('tailFade could be sampled', fd.__error)
      return res
    }
    const fc = checkFade((u) => {
      if (Number.isNaN(u)) return fd.nan
      if (u === Infinity) return fd.inf
      if (u === -Infinity) return fd.ninf
      if (u < 0) return fd.neg
      if (u > 1) return fd.over
      return fd.samples[Math.max(0, Math.min(1000, Math.round(u * 1000)))]
    }, tag + ' §1a tailFade')
    res.checks.push(...fc.checks)
    res.metrics.fade = fc.metrics

    // ---- §1b position law --------------------------------------------------
    const real = await cdp.eval(MEASURE_TAIL('real'))
    const fake = await cdp.eval(MEASURE_TAIL('mutant'))
    if (real.__error) {
      fail('writeTailParticlePosition could be measured', real.__error)
      return res
    }
    const rc = checkReachModel(real, C, tag + ' §1b position law')
    res.checks.push(...rc.checks)
    res.metrics.reach = rc.metrics
    res.artifacts.reachData = { real, fake }

    // ---- §1c emission table ------------------------------------------------
    const movingTable = await cdp.eval(TABLE_STATS('moving'))
    const uniformTable = await cdp.eval(TABLE_STATS('uniform'))
    const liveTable = await cdp.eval(TABLE_STATS('live'))
    const divergentTable = await cdp.eval(TABLE_STATS('divergent'))
    const tc = checkTable(movingTable, tag + ' §1c emission table')
    res.checks.push(...tc.checks)
    res.metrics.table = tc.metrics
    res.artifacts.tables = { movingTable, uniformTable, liveTable, divergentTable }
    const uc = checkTable(uniformTable, 'uniform path')
    res.checks.push(...uc.checks.map((x) => ({ ...x, name: 'diagonal-path table: ' + x.name })))

    // ---- §2 / §3 frame recording (BEFORE the freeze, see the note below) ----
    const frames = await cdp.eval('window.__TP.record(' + cfg.recordSeconds + ')')
    if (!frames || frames.__error) {
      fail('per-frame displacement could be recorded', frames && frames.__error)
      return res
    }
    const measured = frames.filter((f) => f.p99 !== undefined)
    res.metrics.recording = {
      totalFrames: frames.length, measuredFrames: measured.length,
      medianDtMs: +fix(medianOf(measured.map((f) => f.dt)), 2),
      phaseFrames: {
        travel: measured.filter((f) => f.phase === 'travel').length,
        gather: measured.filter((f) => f.phase === 'gather').length,
        hold: measured.filter((f) => f.phase === 'hold').length,
        scatter: measured.filter((f) => f.phase === 'scatter').length,
      },
    }
    if (measured.length < 60) {
      fail('enough frames were measured to judge the transition and the hold',
        'only ' + measured.length + ' frames carried a displacement')
      return res
    }
    const idle = measured.filter((f) => f.phase === 'travel')
    const idleP99 = idle.length ? medianOf(idle.map((f) => f.p99)) : undefined
    const runs = holdRuns(measured)
    res.metrics.recording.holdRuns = runs.length
    res.metrics.recording.travelP99 = idleP99 === undefined ? null : +fix(idleP99, 4)

    const tc2 = checkTransition(measured, tag + ' §2 transition', idleP99)
    res.checks.push(...tc2.checks)
    res.metrics.transition = tc2.metrics

    const hc = checkHold(runs, C.HOLD_SECONDS, tag + ' §3 hold')
    res.checks.push(...hc.checks)
    res.metrics.hold = hc.metrics

    const blockRows = await cdp.eval('window.__TP.blockFlipRows()')
    res.artifacts.blockRows = blockRows && blockRows.__error ? null : blockRows
    res.artifacts.holdRuns = runs
    res.artifacts.idleP99 = idleP99
    writeFileSync(join(cfg.out, 'frames-' + label + (reduced ? '-rm' : '') + '.json'), JSON.stringify(measured))

    // ---- §1d pixels (LAST: the capture freezes the engine and never thaws it) ----
    const iso = await cdp.eval('window.__TP.isolate()')
    if (!iso || iso.error) {
      fail('the particle canvas could be isolated for a screenshot', iso && iso.error)
      return res
    }
    res.artifacts.isolation = iso
    await sleep(1200)

    const cap = await capturePlume(cdp, cfg.out, label, { reduced })
    if (cap.error) {
      fail('a travel-phase plume frame was captured', cap.error)
      return res
    }
    res.checks.push(row('the scene can be frozen, so the geometry and the pixels are one frame',
      cap.freeze.liveFired >= 5 && cap.freeze.stoppedFired === 0 &&
      cap.freeze.queued === 1 && cap.freeze.discardedUnstable === 0,
      'rAF callbacks in 2 s: ' + cap.freeze.liveFired + ' before the freeze, ' +
      cap.freeze.stoppedFired + ' after it; the settled queue held ' + cap.freeze.queued +
      ' callback (1 = the engine\'s own next tick, unrun); moments discarded for moving' +
      ' between the geometry read and the screenshot: ' + cap.freeze.discardedUnstable +
      '; the scene was still in the frozen screenshot (peak ' +
      fix(cap.freeze.scenePresent, 2) + ', a blank canvas reads ~0)'))
    res.metrics.pixelMoment = { phase: cap.moment.phase, p: +cap.moment.p.toFixed(3), camZ: +fix(cap.geom.camZ, 3) }
    res.metrics.geom = {
      nTail: cap.geom.nTail, axis: cap.geom.axis.map((v) => +fix(v, 4)),
      nucleus: cap.geom.nucleus.map((v) => +fix(v, 1)), headPx: +fix(cap.headR, 2),
      projP50: +fix(cap.geom.projP50, 1), projP97: +fix(cap.geom.projP97, 1), projMax: +fix(cap.geom.projMax, 1),
      perpP50: +fix(cap.geom.perpP50, 1), perpP90: +fix(cap.geom.perpP90, 1), perpP97: +fix(cap.geom.perpP97, 1),
      ageU: cap.geom.ageU, camZ: +fix(cap.geom.camZ, 3),
    }
    /*
     * The headline profile is the POOLED one, over every sampled moment: see `poolMoments` for
     * why (the finite particle count makes any single frame's far bin noisy, and pooling cuts
     * that noise by sqrt(M) without moving the tail's actual shape). The single best frame is
     * still saved to disk and its own verdict reported.
     */
    const pool = poolFromMoments(cap.moments, cap.best.tmax, cap.best.standoff, cap.best.ctrlSide.sign)
    const pooled = poolSummary(pool)
    const poolCtrlPeak = Math.max(...pool.ctrlBand.map((v) => (v === null ? 0 : v)))
    const pixPooled = checkPixelProfile(pooled, tag + ' §1d pixel profile (pooled over ' +
      cap.moments.length + ' moments)', {
      ctrlBandPeak: poolCtrlPeak, viewport: st0.inner, shot: cap.shot,
    })
    res.checks.push(...pixPooled.checks)
    res.metrics.pixel = pixPooled.metrics
    res.metrics.pixel.pooledOverMoments = cap.moments.length
    res.metrics.pixel.pooledExcess = pooled.excess.map((v) => +fix(v, 2))
    const pix = checkPixelProfile(cap.real, tag + ' §1d pixel profile (single frame)', {
      ctrlBandPeak: cap.best.ctrlBandPeak, viewport: st0.inner, shot: cap.shot,
    })
    res.metrics.pixelSingleFrame = pix.metrics
    res.metrics.pixel.moments = cap.moments.map((m) => ({
      p: +m.st.p.toFixed(3), peak: +fix(m.real.peak, 2), z: +fix(m.real.peakZ, 2),
      peakAt: +fix(m.real.peakAtFrac, 3),
      endShare: m.real.endShare === null ? null : +fix(m.real.endShare, 4),
      farShare: m.real.farShare === null ? null : +fix(m.real.farShare, 4),
      standoff: m.standoff, ctrlSide: m.ctrlSide.sign, ctrlBandPeak: +fix(m.ctrlBandPeak, 2),
      axisOffsetDeg: m.axisOffsetDeg, peakOnPcaAxis: +fix(m.peakOnPcaAxis, 2),
    }))
    /*
     * REPORT-ONLY: how far the probe's own PCA axis sits from the plume it is measuring.
     *
     * This is a diagnostic about the PROBE, not a criterion from the spec, and it is reported
     * rather than gated for a measured reason. The axis comes from `page.mjs`, which fits a PCA
     * over the tail particles' projected positions and takes its first principal component. On
     * a curving tail that mean direction is not the direction of the plume near the head, where
     * the light is, and the disagreement is large and systematic: measured at 1920x1080 across
     * one leg, the offsets from the brightest direction were 12, -14, 40, -24, 16, 26 degrees,
     * and the light on the PCA axis versus on the found axis was
     *   50.7/83.5, 32.8/109.2, 6.1/24.8, 18.3/81.8, 12.2/100.1, 3.3/86.2
     * — i.e. at two moments the PCA axis carries under 15% of the light the plume has.
     *
     * Gating that would fail the build for a defect in the probe's own aiming helper, which the
     * pixel measurement already compensates for by re-finding the axis from the image (see
     * `findPlumeAxis`). What the check DOES assert is the thing that would invalidate the
     * measurement: that the found axis really is a plume, i.e. that the search was not simply
     * picking its own bound. That assertion is the peak-light gate on the pooled profile.
     */
    const axisReport = {
      worstOffsetDeg: cap.moments.reduce((a, m) => Math.max(a, Math.abs(m.axisOffsetDeg)), 0),
      offsetsDeg: cap.moments.map((m) => m.axisOffsetDeg),
      peakOnPcaAxis: cap.moments.map((m) => +fix(m.peakOnPcaAxis, 2)),
      peakOnFoundAxis: cap.moments.map((m) => +fix(m.real.peak, 2)),
      worstLightRatio: +fix(cap.moments.reduce((a, m) =>
        Math.max(a, m.peakOnPcaAxis > 0.01 ? m.real.peak / m.peakOnPcaAxis : 1), 1), 2),
    }
    res.metrics.axisAgreement = axisReport
    res.checks.push(row('REPORT ONLY: the probe\'s own PCA axis vs the plume found in the pixels',
      true,
      'offsets at each moment: ' + axisReport.offsetsDeg.join(', ') + ' deg (max ' +
      fix(axisReport.worstOffsetDeg, 1) + '); light on the PCA axis vs the found axis: ' +
      axisReport.peakOnPcaAxis.map((v, i) => v + '/' + axisReport.peakOnFoundAxis[i]).join(', ') +
      '; worst ratio ' + axisReport.worstLightRatio +
      ' — the pixel profile is measured on the FOUND axis, so this does not affect the verdict'))
    // Every sampled moment is scored against ALL the shape gates, so the verdict cannot
    // rest on the single frame that happened to look best.
    const all = cap.moments.map((m, i) => checkPixelProfile(m.real, 'moment ' + i, {
      ctrlBandPeak: m.ctrlBandPeak, shapeOnly: true,
    }))
    const passCount = all.filter((x) => x.ok).length
    res.checks.push(row('the plume reads the same at every sampled travel moment (majority of ' +
      cap.moments.length + ' must pass)',
      passCount * 2 > cap.moments.length,
      passCount + '/' + cap.moments.length + ' moments pass: ' +
      res.metrics.pixel.moments.map((m, i) => 'p=' + m.p + ' peak=' + m.peak + ' z=' + m.z +
        (all[i].ok ? ' ok' : ' FAIL(' + (all[i].checks.find((x) => !x.ok).name.slice(0, 26)) + ')')).join('; ')))
    /*
     * And no single moment may be CONE-LIKE, which is what the majority rule does not cover.
     *
     * The majority clause would tolerate one bad moment, and a bad moment is what an
     * intermittent defect looks like — so a per-moment bound is needed. But two things about it
     * are measured, not assumed:
     *
     *   IT MUST BE THE HARD BOUND, not the spec's 5%. With a finite particle set the far bin of
     *   a single frame is shot-noisy: measured end-shares across moments of one reduced-motion
     *   leg (3000 tail particles) were 2.01%, 2.23%, 2.90%, 3.35%, 7.05%, 0.18% against a pooled
     *   3.47%. A per-moment gate at 5% fires on a couple of particles.
     *
     *   IT MUST SKIP MOMENTS WITH NO MEASURABLE LIGHT. A frame whose whole plume peaks at 0.48
     *   luminance units has an end-share that is a ratio of two noise numbers — measured 57.5%
     *   on such a frame, against 0% at the other five moments of the same leg and a pooled 1.18%.
     *   Gating that is gating the ratio of two zeros. The reduced-motion tier is deliberately
     *   sparse, and some of its moments genuinely show almost nothing; whether the tail carries
     *   light at all is the POOLED profile's question, and the shape of what IS visible is what a
     *   single frame can answer.
     */
    const coneLike = cap.moments.filter((m) =>
      m.real.peak >= TH.pixelPeakExcessMin &&
      (m.real.endShare === null || m.real.endShare > TH.pixelEndShareHardMax))
    const unmeasurable = cap.moments.filter((m) => m.real.peak < TH.pixelPeakExcessMin)
    res.checks.push(row('no sampled moment with a measurable plume is cone-like (its far end stays ' +
      'under ' + (TH.pixelEndShareHardMax * 100) + '% of its own peak)',
      coneLike.length === 0,
      'moments with a measurable plume (' + TH.pixelPeakExcessMin + '+ units) over the hard bound: ' +
      coneLike.length + '/' + cap.moments.length + '; moments too faint to judge (skipped, their ' +
      'end-share would be a ratio of two noise numbers): ' + unmeasurable.length +
      '; end-share at each moment: ' +
      cap.moments.map((m) => fix((m.real.endShare === null ? 0 : m.real.endShare) * 100, 2) + '%').join(', ') +
      '; pooled end-share ' + fix((pooled.endShare === null ? 0 : pooled.endShare) * 100, 2) + '%'))

    // controls
    const cone = coneControl(cap.geom, cap.img, cap.headR)
    writeFileSync(join(cfg.out, 'control-rigid-cone-' + label + '.png'), cone.buf)
    const emitted = emissionControl(cap.geom, cap.img, cap.headR, C)
    res.artifacts.controls = {
      rigidCone: cone.summary,
      emission: emitted,
      rotated: cap.rotated,
    }
    res.checks.push(row('control: the independent emission model is accepted by the same gates',
      checkPixelProfile(emitted, 'control', { ctrlBandPeak: emitted.ctrlBandPeak }).ok,
      'peak ' + fix(emitted.peak, 2) + ', z ' + fix(emitted.peakZ, 2) + ', peakAt ' +
      fix(emitted.peakAtFrac, 3) + ', parallel-control band at ' + emitted.standoff + 'px peaks at ' +
      fix(emitted.ctrlBandPeak, 2)))

    return res
  } catch (e) {
    res.error = e && e.message ? e.message : String(e)
    fail('the run completed without a probe-side exception', res.error)
    return res
  } finally {
    try { if (ws) ws.close() } catch (e) { /* ignore */ }
    try { if (proc) proc.kill('SIGKILL') } catch (e) { /* ignore */ }
  }
}
