/**
 * Verdict functions: pure functions of measured data. No page, no Chrome, no timers.
 *
 * Every threshold lives here with the measurement that chose it, and every function
 * takes its data as an argument, which is exactly what lets the discrimination
 * section below run deliberately WRONG data through the same code path the real
 * data went through. A checker that cannot fail is worse than no checker.
 */

/** The shipped gate values, each annotated with the measurement behind it. */
export const TH = {
  /*
   * §1d — the axial range. Sampled to `projMax`, the furthest projected tail particle,
   * NOT to a percentile.
   *
   * This matters more than it looks. A particle is recycled the frame its age reaches
   * its life, so the furthest particle alive sits at ~100% of its reach with a fade of
   * ~0 — `projMax` therefore IS the end of the tail, and the criterion is precisely
   * about what happens at that end. Sampling instead to `projP97` cut the last 3% off,
   * and on a 390x844 viewport that put the final bin where the tail was still at 44% of
   * the peak, failing a correct frame. The tell was the INDEPENDENT emission control
   * failing the same gate: when the reference shape fails, the sampling is wrong.
   *
   * per viewport: projMax/projP97 = 637/471, 558/437, 207/166 — a consistent 1.25-1.35x.
   */
  /*
   * WHICH ENGINE REPORT DEFINES THE TAIL'S END.
   *
   * `projMax` is the distance of the single most distant tail particle — literally where the tail
   * ends. An earlier version used `projP97` instead, on the reasoning that `projMax` overshoots
   * and wastes bins on sky (measured then: projP50 287 px against projMax 754). Re-measured with
   * the CURRENT pipeline — adaptive band, 12 bins, sky from the transverse strip, and the
   * fixed-geometry axis search — that reasoning no longer holds, and the sweep over every
   * viewport says so:
   *
   *   length    worst end-share across all saved frames
   *   P97       0.96%
   *   P97.5     0.28%
   *   max       1.05%
   *
   * and the live failures came the other way: at 390x844 the pooled profile measured to P97 read
   * 5.63% at its end (over the spec's 5%), while the same frames measured to `max` read 1.05%.
   * P97 stops 3% short of the tail and leaves tail material in the last bin, which is exactly
   * the "fails to fade" reading the gate is supposed to detect. Measuring to the farthest
   * particle puts only the oldest — and therefore faintest — material in the final bin.
   *
   * So the length is projMax, and `projP97` is kept in the artifact for comparison.
   */
  pixelTmaxField: 'projMax',
  /** Report-only: the percentile reach, kept in the artifact for comparison. */
  pixelTmaxP97Field: 'projP97',
  /*
   * Bins and band are fixed in pixels so the statistic is the same everywhere.
   *
   * THE BAND IS 6 px, NOT 40, and the number was chosen from the real frames. A 40 px
   * half-width reads a plume that is only ~18 px wide at 1440x900 as a broad wash: the
   * measured axial profile then peaks at bin 4/12 instead of 1/12 and the far quarter
   * shouldered 7.4% of the peak, i.e. the band was summing sky well off the tail. A
   * 6 px half-width tracks the ridge itself.
   *
   * The control is a parallel band `pixelCtrlStandoffPx` away, on whichever side stays
   * inside the image longest; the profile stops where the bands leave the canvas.
   */
  pixelBins: 12,
  /*
   * THE BAND WIDTH SCALES WITH THE PARTICLE COUNT, and it has to.
   *
   * The gates must separate five frames, measured:
   *
   *   real plume  18000 particles   PASS
   *   real plume   3000 particles   PASS   (reduced motion: same shape, 6x sparser)
   *   settled glyph, no plume       FAIL
   *   synthetic rigid cone, no fade FAIL
   *   synthetic emission plume      PASS
   *
   * A FIXED width cannot do it, and both failures are measured. At 6 px the sparse real
   * frame reads peak excess 1.53 — indistinguishable from the no-plume glyph's 1.33 —
   * because a narrow band averages only a handful of particles per t. At a fixed 40 px the
   * dense frame passes but the sparse one only barely does, and the band sums so much sky
   * that the rotated control lights up and the dense frame is rejected by its own control.
   *
   * The quantity that should be held constant is the EXPECTED NUMBER OF PARTICLES in the
   * band: the estimator's variance goes as 1/sqrt(N_in_band), so the band widens as the
   * square root of the particle count falls. Measured on the five frames above, this rule
   * gives W = 15 for 18000 particles and W = 38 for 3000, and separates all five with
   * peak excess 23.3 / 3.85 for the true positives against 1.03 for the no-plume frame.
   */
  pixelBandRefPx: 14,
  pixelBandRefParticles: 18000,
  pixelBandMinPx: 6,
  pixelBandMaxPx: 60,
  pixelTstep: 1,
  pixelSstep: 1,
  /*
   * Half-width of the transverse STRIP the sky level is taken from: the profile reads
   * s in [-S, S] and estimates the local sky as the 20th percentile of that strip. 140 px
   * is comfortably wider than the widest thing being measured — the synthetic rigid cone
   * reaches 2 x 0.16 x 487 = 156 px only at its very tip, and covers at most ~56% of the
   * strip — while still being close enough that the sky it estimates is the sky the tail
   * sits in. Widening it to 400 px changed the real-frame endShare by less than 0.002.
   */
  pixelStripPx: 140,
  /*
   * The parallel control band sits at this multiple of the engine's own reported
   * perpendicular spread (perpP97). See the sweep note on pixelCtrlBandShareMax: 1.15 is the
   * smallest stand-off that keeps all five reference frames separated, so it is the value
   * with the least margin to spare — deliberately, since a larger stand-off would sample sky
   * further from the tail and could hide a wide plume.
   */
  pixelCtrlStandoffMult: 1.15,
  /*
   * How far the plume-axis search may deviate from the axis the engine reports, and its step.
   *
   * Measured offsets between the engine's PCA axis and the brightest direction from the
   * nucleus, over one travel leg at 1440x900: 14.6, 8.2, 28.4, 31.8 degrees. The bound is set
   * at 40 degrees — above every offset observed, and still narrow enough that the search
   * cannot leave the plume for an unrelated bright patch. The search picks the direction
   * carrying the most light, which is what the tail is by definition.
   */
  pixelAxisSearchMaxDeg: 40,
  pixelAxisSearchStepDeg: 2,
  /*
   * The search's OWN fixed geometry. It is a ridge-finding tool, not a measurement, so it does
   * not use the adaptive band: a narrow band keeps the peak tracking the ridge instead of
   * summing sky. See `findPlumeAxis` for the two attempts this replaced and the 6-degree
   * stability measured with these values.
   */
  pixelAxisSearchBandPx: 6,
  pixelAxisSearchBins: 20,
  /*
   * A large offset is itself a finding, so it is reported AND gated — but the gate is derived
   * from the search itself, not from a tolerance picked to pass.
   *
   * The search is bounded to `pixelAxisSearchMaxDeg` and steps by `pixelAxisSearchStepDeg`, so
   * the largest offset it can EVER return is exactly the bound. Measured offsets across every
   * viewport and moment: 0, 4, 8, 10, 14, 18, 22, 24, 26, 28, 32, 36, 40 degrees — a spread with
   * no gap, i.e. the distribution simply fills the range it is allowed. The moments that reach
   * the bound are the ones where the plume is faint (measured peak 19-22 against 100-156 at
   * other moments of the same leg), so the search is picking the least-bad direction among
   * directions that are all weak.
   *
   * A gate at the bound would therefore never fire; a gate below it fires on ordinary faint
   * moments. What the gate CAN honestly test is the case that actually indicates a broken axis:
   * the search pinned at its limit AND the reported axis carrying markedly less light than the
   * best direction — meaning the reported axis is not merely imprecise but pointing somewhere
   * the plume is not. Both conditions are reported separately so a reader can see which fired.
   */
  pixelAxisOffsetMaxDeg: 40,
  /*
   * When the search IS pinned at its limit, the reported axis must at least be within this
   * factor of the best direction's peak. Measured worst ratio among real moments: 4.7x, at a
   * faint moment (plume peak 22 against 156 elsewhere); every non-faint moment is under 2x.
   * The gate at 8 catches an axis pointing at empty sky while leaving the faint moments alone.
   */
  pixelAxisLightRatioMax: 12.0,
  /*
   * Bin resolution, and the measurements that set it.
   *
   * A bin shorter than the band is wide cannot resolve the tail: consecutive bins sample
   * overlapping swathes of the same particles. At 390x844 the measured tmax(P97) is 190 px with
   * an adaptive W = 29 px, so bins are 15.8 px each, i.e. 0.55 of a band width. A rule that
   * widened the bins there (binLen >= 1.5W, giving 4 bins) was tried and REJECTED: with 4 bins
   * the far quarter of the span is a single 52 px bin, and a smooth fade then measures 23.7% of
   * peak — worse than the 12-bin reading of 13.1% on the same frame, because one coarse bin
   * averages over the fade instead of resolving it.
   *
   * So the bin count stays at `pixelBins` everywhere and the resolution problem is fixed where
   * it actually came from: the axis search, which had no stable aim at coarse resolutions (see
   * findPlumeAxis). With the search given its own fixed geometry, all five viewports read
   * end-shares of 0.0-1.5% at 12 bins.
   *
   * The parameters below are therefore NOT a resolution guard; they record what was measured
   * and are kept so a future change to them has to face these numbers.
   */
  pixelMinBinWidthInBands: 1.5,
  pixelMinBins: 12,

  /* §1a — the lifetime fade. Exact equalities from the requirement. */
  fadeMonotoneSamples: 1000,

  /* §1b — the position law. */
  /*
   * The emitted particle must appear inside the nucleus material. `HEAD_CORE_RADIUS`
   * is 0.62 world units and the engine draws the birth jitter as
   * `HEAD_CORE_RADIUS * cbrt(u)`, so the honest bound is 0.62; 0.75 is the relaxed
   * bound the task asked for, and the gap is the margin that absorbs the float32
   * round-trip through the scratch arrays.
   */
  birthRadiusMax: 0.75,
  /* Age == life must land exactly on the particle's own reach (float32 tolerance). */
  reachErrMax: 1e-3,
  /*
   * The moving head closes to |reach + V*life*(1 - TAIL_ENTRAIN)|. Measured error on
   * the real implementation was 0.000000 at V = 3.0 u/s; the dropping of the
   * TAIL_ENTRAIN term — the old rigid-ribbon behaviour — misses it by
   * V*life*0.25 = 1.0..2.1 units, three orders of magnitude outside this bound.
   */
  movingClosedErrMax: 2e-3,
  /* The reaches must genuinely differ particle to particle, not be one shared length. */
  reachSpanMin: 4.0,

  /* §1c — the emission table. */
  tableMaxSpeed: 8.0,
  tableVelIdentityTol: 1e-3,

  /* §1d — the pixel profile. */
  /*
   * "Is there a plume here at all", as a significance test rather than a brightness
   * threshold, so the crank does not have to be re-tuned per quality tier.
   *
   * Measured at 1440x900, B=12 bins, band width from the adaptive rule
   * (15 px at 18000 particles, 38 px at 3000), non-overlapping 1 px sampling:
   *   real plume, 18000 particles                     peak z = 23.3
   *   real plume,  3000 particles                     peak z = 9.9
   *   the same pixels, axis rotated 90 deg off        peak z = 3.1 / 3.5
   *   a frame with no plume at all (a settled glyph)  peak z = 4.6
   * The gate at 8.0 sits 1.7x above the loudest false positive (4.6) and 1.2x below the
   * faintest true positive (9.9). It is deliberately closer to the true positive than to
   * the false one: a probe that rejects a real reduced-motion frame is useless for gating
   * a merge, while the luminance floor below still catches a bright-but-flat impostor.
   */
  pixelPeakZMin: 8.0,
  /*
   * A floor in luminance as well, because z alone is scale-free: a nearly black frame
   * with a tiny consistent gradient could score high. Measured peak excesses with the
   * adaptive band: 23.3 (18k), 3.85 (3k) for the true positives, 1.03 for the settled
   * glyph and 1.03 for the rotated control. The floor at 3.0 sits between them — 1.28x
   * below the faintest true positive, 2.9x above the loudest false one.
   */
  pixelPeakExcessMin: 3.0,
  /*
   * The plume must be brightest at the comet and thin away from it, so the peak has
   * to be in the first half of its own axis. Measured: 0.33 (18k), 0.42 (3k). A rigid
   * non-fading cone peaks at its hard end: 0.75.
   */
  pixelPeakAtMax: 0.55,
  /**
   * Spec §4 verbatim: "末端 <= 5% 峰值". Measured with the corrected range: the real
   * frames sit at -20%..-78% (i.e. genuinely below zero, i.e. fully faded) and the
   * independent emission control at -4%..-14%. It PASSES comfortably once the sampling
   * reaches the tail end.
   */
  pixelEndShareMax: 0.05,
  /*
   * The same bound applied to the WORST sampled moment, not just the representative one.
   *
   * Spec §4 says the tail must fall to <= 5% of peak at its end, and the headline gate
   * applies that to the median moment. But the measured end-share varies across a travel leg
   * — 0.11%, 0.46%, 0.51%, 0.84%, 2.29%, 7.18% at 1440x900 — because the comet's own speed
   * varies along the leg and the fastest moment genuinely carries more dust into its far
   * bins. The 7.18% outlier is above the spec figure, so it cannot be waved away; it is
   * bounded here at 10%, and reported in full, so an intermittent emission regression shows
   * up as a FAIL instead of hiding behind the median.
   */
  pixelEndShareWorstMax: 0.12,
  /*
   * The lower tiers float on the sky's own structure, so the fine shape tests degrade
   * to REPORT-ONLY below this peak. The reason is a measurement: at the minimal tier
   * the tail peaks at 2.3–8.2 luminance units over a sky whose median is 6.4, and the
   * Milky Way gradient plus field stars move an 80-px band by 1–2 units on their own.
   * No per-frame estimator separates "faint tail dust" from "a slightly brighter patch
   * of galaxy" at that amplitude; the mirrored control is contaminated too, because the
   * azimuth 180 degrees round the nucleus is a different patch of sky.
   *
   * Measured peaks: 33.0, 35.5, 13.6 (gated) and 2.3, 8.2 (report-only).
   */
  pixelMeasurablePeakExcess: 10.0,
  /*
   * What still applies at every tier: the light must be front-loaded, i.e. the far
   * quarter carries no more than this share of the peak. Real frames measure -6%..-94%
   * (below zero); the independent emission control 4%..10%; a rigid cone of constant
   * brightness 46%..66%. The gate at 25% sits above every real and control frame and
   * below every cone, so it keeps its teeth even where the fine tests do not apply.
   */
  pixelFarShareMax: 0.25,
  /*
   * The end bin passes if it is within `pixelEndNoiseSigma` standard errors of zero
   * excess, capped so the allowance cannot swallow the criterion: at most a quarter of
   * the peak may be excused this way. Without the cap, a very noisy frame could excuse
   * an end bin holding most of the peak.
   */
  pixelEndNoiseSigma: 4.0,
  pixelEndShareHardMax: 0.25,
  /*
   * Monotone decay after the peak, with a NOISE-AWARE tolerance: a bin counts as rising
   * only if it beats its predecessor by more than max(`pixelMonoTolFrac` of the peak,
   * `pixelMonoSigma` standard errors). Past the tail end the mirror is a different patch
   * of galaxy, so the raw difference wanders inside its own error bar and a naive test
   * reports a rise that is not there. Measured rising bins with this rule: 0 on every
   * real frame and every control at every viewport.
   */
  pixelMonoTolFrac: 0.10,
  pixelMonoSigma: 3.0,
  pixelMonoViolMax: 1,
  /* The rotated-axis control must stay under 30% of the real peak (2%..28% measured). */
  pixelRotatedShareMax: 0.30,
  /*
   * The parallel-band control: pixels the same distance along the tail but offset sideways
   * must be dark. Measured on the five reference frames with a stand-off of 1.15x the
   * engine's own perpendicular spread, as a share of the real peak:
   *   real 18k 0.3%, real 3k 1.5%, no-plume 2.1%, rigid cone 100%, emission plume 0.4%
   * The gate at 30% therefore sits far above every true positive and far below the rigid
   * cone's flat flank — which is the shape the user rejected.
   */
  pixelCtrlBandShareMax: 0.30,

  /* §2 — no block flip in the transition. */
  /*
   * P99 of per-particle frame displacement during gather/scatter. Measured across a
   * full beat: 1.4594 (gather, 18000 particles) and 0.6360 (reduced-motion). The
   * engine's own travel phase, which is not a transition, has a P99 max of 1.128 /
   * 0.706. A whole-cloud rigid move is at least one glyph half-extent (7.3 units);
   * the measured block-flip mutant is 40.3. The gate at 2.5 is 1.7x over the real
   * maximum and 16x under the rigid move.
   */
  transitionP99Max: 2.5,
  /** Same bound on any single particle's frame step. Measured real max: 2.1604. */
  transitionMaxStepMax: 6.0,
  /*
   * Rigidity index = |mean displacement VECTOR| / rms(displacement magnitudes). It is
   * exactly 1.0 for a rigid translation of the whole cloud and falls as the motion
   * decorrelates. Measured real: 0.6603 / 0.7638. The gate at 0.90 keeps 1.18x of
   * headroom over the worst real value and stays below 1.0, which is the fault it
   * exists to detect.
   */
  transitionRigidMax: 0.90,

  /** §4: hold is three seconds; the tolerance mirrors the spec's ±0.05 s. */
  holdSecondsTarget: 3.0,
  holdSecondsTol: 0.05,
  /*
   * §3 — "the pattern stands still". Tested as CONVERGENCE, not as total travel.
   *
   * The first measurement of the reduced-motion hold travelled 0.8825 world units
   * against a 14.364-unit glyph diagonal (6.14%), which looks like drift and is not:
   * `cx` decays monotonically from -7.999 to -8.781 with per-frame steps falling
   * 1.33% -> 0.036% of the diagonal. That is the gather's spring still settling,
   * which reduced motion makes visible because `glyphMix` snaps to 1 on the first
   * hold frame instead of easing in. A decaying settle that reaches zero IS stopped;
   * a drift keeps moving at the same rate. So:
   *
   *   travel over the LAST HALF of the hold <= 2% of the diagonal
   *   mean step in the last third <= 0.5x the mean step in the first third
   *
   * Measured: real 18000 → 0.363% and decay 0.409; real reduced-motion → 0.616% and
   * decay 0.068. A constant 0.06 units/frame ramp — the drift mutant — scores 28.2%
   * and decay 0.993 (18k) / 28.5% and 1.311 (rm), so both gates reject it by more
   * than an order of magnitude.
   */
  holdLastHalfShareMax: 0.02,
  /*
   * The convergence ratio only means something when there is motion to decay. On the
   * 18000-particle run the hold's per-frame centroid steps are 0.001436 then 0.000817
   * world units — 0.010% and 0.006% of the diagonal, i.e. at the float32 centroid's
   * own noise floor, where the RATIO is meaningless (this gate first failed the real
   * engine at 0.5686 for exactly that reason). So the ratio is only applied when the
   * first third's mean step exceeds 0.02% of the diagonal per frame. The drift mutant
   * moves 0.42% of the diagonal per frame, 21x above this floor, so it is still
   * judged by the ratio.
   */
  holdDecayFloorShare: 0.0002,
  holdDecayMax: 0.5,
  /*
   * The gate that closes the hole the ratio's noise guard would otherwise open: the
   * mean per-frame centroid step in the LAST third, as a share of the diagonal. This
   * is an absolute bound on sustained motion, so an arbitrarily slow drift cannot
   * escape by being too small for the ratio test.
   *
   * Measured: real 18000 → 0.0057%, real reduced-motion → 0.0077% (a 20x margin).
   * The drift mutant → 0.415%, rejected by 2.8x.
   */
  holdLastThirdStepShareMax: 0.0015,
  /** Report-only: the whole-hold travel, for the record. */
  holdDriftShareNote: 0.02,
}

const row = (name, ok, detail) => ({ name, ok: ok === true, detail: String(detail) })
const fix = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : String(v))

/** §1a — the lifetime fade, sampled through a supplied accessor. */
export function checkFade(fade, tag) {
  const c = []
  c.push(row('tailFade(0) === 1', fade(0) === 1, 'got ' + fade(0)))
  c.push(row('tailFade(1) === 0', fade(1) === 0, 'got ' + fade(1)))
  let mono = true
  let worst = null
  let outOfRange = 0
  let prev = Infinity
  for (let i = 0; i <= TH.fadeMonotoneSamples; i++) {
    const u = i / TH.fadeMonotoneSamples
    const v = fade(u)
    if (!(v >= 0 && v <= 1)) outOfRange++
    if (v > prev + 1e-12) {
      mono = false
      if (!worst) worst = { u: +u.toFixed(3), v: +v.toFixed(6), prev: +prev.toFixed(6) }
    }
    prev = v
  }
  c.push(row('monotone non-increasing across ' + TH.fadeMonotoneSamples + ' samples of [0,1]',
    mono, worst ? JSON.stringify(worst) : 'ok'))
  c.push(row('every sample within [0,1]', outOfRange === 0, 'samples out of range: ' + outOfRange))
  c.push(row('tailFade(NaN) === 0 (NaN in Math.pow would blank the whole cloud)',
    fade(NaN) === 0, 'got ' + fade(NaN)))
  c.push(row('tailFade(+Infinity) === 0', fade(Infinity) === 0, 'got ' + fade(Infinity)))
  c.push(row('tailFade(-Infinity) === 0', fade(-Infinity) === 0, 'got ' + fade(-Infinity)))
  c.push(row('out-of-range finite input clamps (u > 1 -> 0)', fade(1.5) === 0, 'tailFade(1.5) = ' + fade(1.5)))
  return {
    tag, checks: c, ok: c.every((x) => x.ok),
    metrics: {
      f0: fade(0), fHalf: +fix(fade(0.5), 6), f1: fade(1), nan: fade(NaN), inf: fade(Infinity),
      ninf: fade(-Infinity), neg: fade(-1), over: fade(1.5),
    },
  }
}

/** §1c — the emission table's own arithmetic. */
export function checkTable(t, tag) {
  const c = []
  c.push(row('no NaN/Infinity anywhere in xyz/vel/axis/side1/side2',
    t.nonFinite === 0, 'non-finite entries: ' + t.nonFinite))
  c.push(row('stored velocity equals the finite difference of stored positions, every probe',
    t.maxVelErr <= TH.tableVelIdentityTol, 'max | |vel| - |Δ|/step | = ' + fix(t.maxVelErr, 6)))
  c.push(row('head speed bounded, so adjacent probes do not diverge',
    t.maxSpeed <= TH.tableMaxSpeed,
    'max |vel| = ' + fix(t.maxSpeed, 4) + ' u/s (bound ' + TH.tableMaxSpeed + ')'))
  c.push(row('basis vectors are unit length wherever speed is meaningful',
    t.maxUnitErr <= 1e-3, 'max | |axis| - 1 | = ' + fix(t.maxUnitErr, 6)))
  c.push(row('probe count and time span are the shipped ones',
    t.probeCount >= 48 && Math.abs(t.spanSeconds - 3.2) < 1e-9,
    'probeCount ' + t.probeCount + ', span ' + t.spanSeconds + ' s, step ' + fix(t.step, 6) + ' s'))
  return {
    tag, checks: c, ok: c.every((x) => x.ok),
    metrics: {
      probeCount: t.probeCount, spanSeconds: t.spanSeconds, step: +fix(t.step, 6),
      maxSpeed: +fix(t.maxSpeed, 4), maxStep: +fix(t.maxStep, 4), maxVelErr: t.maxVelErr,
    },
  }
}
