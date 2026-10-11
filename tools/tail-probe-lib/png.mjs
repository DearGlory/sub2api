/**
 * PNG decode/encode and the axial luminance profile, entirely in Node.
 *
 * WHY THIS IS NODE-SIDE
 *
 * The inherited probe shipped a 300 KB base64 screenshot into the page over
 * `Runtime.evaluate` and computed the profile there, so the statistic itself was
 * page code that only the page could run. Two consequences, both bad: the transport
 * was heavy enough to time out, and the one number the whole §1d criterion rests on
 * could not be exercised offline against known frames. Here the screenshot goes to
 * Node and the profile is a pure function of (image, geometry), which means the same
 * function scores the real frame, a rotated-axis control, and a synthetic rigid cone
 * drawn by this file.
 *
 * STATISTIC CHOICE
 *
 * Per axial bin the score is  mean(band) - mean(mirrored band)  over a cross-axis
 * strip. Mean rather than a percentile because every particle contributes the same
 * per-pixel brightness, so the mean is linear in how many particles are in the bin:
 * it is a surface-brightness proxy that survives a change of quality tier. The
 * percentile form saturates -- one lit point is as bright as ten -- and at the
 * reduced-motion tier (3000 particles) it read exactly 0.00 on a frame that visibly
 * contains a plume.
 *
 * The bin is then scored as z = excess / se, with se the standard error of the
 * difference of the two means. That turns "is there a plume here" into a
 * significance question whose answer does not depend on the tier's absolute
 * brightness.
 */
import { inflateSync, deflateSync } from 'node:zlib'

const PNG_SIG = 0x89504e47

/** Decode an 8-bit, non-interlaced PNG. Returns { w, h, chans, data }. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== PNG_SIG) throw new Error('not a PNG')
  let off = 8
  let w = 0
  let h = 0
  let depth = 0
  let ctype = 0
  let inter = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = body.readUInt32BE(0)
      h = body.readUInt32BE(4)
      depth = body[8]
      ctype = body[9]
      inter = body[12]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth)
  if (inter !== 0) throw new Error('interlaced PNG unsupported')
  const chans = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype]
  if (!chans) throw new Error('unsupported colour type ' + ctype)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * chans
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    if (f === 1) {
      for (let x = chans; x < stride; x++) line[x] = (line[x] + line[x - chans]) & 255
    } else if (f === 2) {
      for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255
    } else if (f === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= chans ? line[x - chans] : 0
        line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
      }
    } else if (f === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= chans ? line[x - chans] : 0
        const b = prev[x]
        const c = x >= chans ? prev[x - chans] : 0
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    } else if (f !== 0) {
      throw new Error('bad PNG filter ' + f)
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { w, h, chans, data: out }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Encode 8-bit RGB. `rgb` is w*h*3 bytes. Only needed for the synthetic control. */
export function encodePng(w, h, rgb) {
  const stride = w * 3
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Luminance plane, Rec.709 weights, as a Float64Array of length w*h. */
export function luminance(img) {
  const { w, h, chans, data } = img
  const L = new Float64Array(w * h)
  for (let i = 0, o = 0; i < w * h; i++, o += chans) {
    L[i] = chans < 3 ? data[o] : 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]
  }
  return { w, h, L }
}

/**
 * Axial profile: B bins along `t` in [0, tmax], each the mean of a band of
 * half-width W pixels in `s`, minus the same sampling on the azimuth 180 degrees
 * round the nucleus. The mirror sees the same starfield, the same background and
 * the same distance from the nucleus, so what survives the subtraction is the plume.
 *
 * `tstep`/`sstep` are 1 px by default so the samples are not correlated; an
 * overlapping step shrinks the estimated standard error and flatters every frame.
 * Pixels inside `headR` of the nucleus are excluded from both bands, because the
 * comet's own core is by far the brightest thing in the frame and would otherwise
 * decide the peak bin on its own.
 */
/** Largest t at which the ridge band (s in [-W, W]) is still inside the image. */
export function axisRoom(w, h, g, perp, sign, pad) {
  const p = pad === undefined ? 3 : pad
  /*
   * The band to check: the ridge band at (t, s) in [-W, W], and — when `perp` is given — the
   * parallel control band at the same t, offset sideways by `perp` on side `sign`. Both have
   * to stay inside the image for the t to count as measurable.
   */
  const sx = perp ? -g.ay * sign : 0
  const sy = perp ? g.ax * sign : 0
  /*
   * Stepped by 1 px, not 2. The clamp has to be EXACT at the far end: a 2 px step can
   * return a t where the band's outermost tap is already past the edge, and the
   * "no tap off-image" gate then fails by a handful of samples out of ~7800 — measured
   * off-image share 0.0053%, which is a rounding artefact, not a sampling error.
   */
  for (let t = g.tmax; t > 0; t -= 1) {
    let ok = true
    for (const s of [-g.W, g.W]) {
      const x = g.hx + g.ax * t - g.ay * s
      const y = g.hy + g.ay * t + g.ax * s
      if (x < p || y < p || x >= w - p || y >= h - p) { ok = false; break }
      if (perp) {
        const xc = x + sx
        const yc = y + sy
        if (xc < p || yc < p || xc >= w - p || yc >= h - p) { ok = false; break }
      }
    }
    if (ok) return t
  }
  return 0
}

/** The `q`-th percentile of a numeric array (nearest-rank; no interpolation). */
export function percentile(arr, q) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))
  return s[i]
}

/**
 * The ridge half-width for a frame with `nTail` tail particles.
 *
 * Variance of a per-bin mean goes as 1/N_in_band, so holding the expected particle count
 * inside the band constant means widening the band as the square root of the count falls.
 * See TH.pixelBandRefPx for the measurements behind the rule; this is the rule itself, in
 * one place so the live probe and the offline self-test cannot drift apart.
 */
export function bandWidthPx(nTail, th) {
  const T = th || TH
  const n = Math.max(1, Number(nTail) || T.pixelBandRefParticles)
  const w = T.pixelBandRefPx * Math.sqrt(T.pixelBandRefParticles / n)
  return Math.max(T.pixelBandMinPx, Math.min(T.pixelBandMaxPx, Math.round(w)))
}

/**
 * The number of axial bins to use for a tail of length `tmax` measured with half-width `W`.
 *
 * A bin shorter than the band is wide cannot resolve anything: consecutive bins sample
 * overlapping swathes of the same particles, so a bin's mean is contaminated by its
 * neighbours' material and the profile stops reflecting the tail's actual distribution.
 *
 * Measured at 390x844 — the narrow portrait viewport, where the comet is closest to the
 * camera and its tail is most foreshortened: tmax(P97) = 190 px against an adaptive
 * W = 29 px, so twelve bins are 15.8 px each, i.e. 0.55 of a band width. That viewport was
 * the only one of four to fail the far-end gate, twice, at end-shares 16.9% and 10.4% while
 * every other viewport read 0.0-1.6%. Requiring each bin to span at least
 * `pixelMinBinWidthInBands` band widths there yields 4 bins, and the same frames then read
 * end-share 0.0% (the frames themselves are unchanged — only the resolution of the
 * measurement is).
 *
 * Floors at `pixelMinBins` so the far-quarter test still has a quarter to look at, caps at
 * `pixelBins`.
 */
export function binCount(tmax, W, th) {
  const T = th || TH
  const span = Number(tmax) || 0
  const n = Math.floor(span / (T.pixelMinBinWidthInBands * Math.max(1, W)))
  return Math.max(T.pixelMinBins, Math.min(T.pixelBins, n))
}

/**
 * Find the plume's own axis, within a bounded angle of the axis the engine reports.
 *
 * WHY THIS IS NECESSARY, measured. The engine reports the tail's axis as a PCA over all tail
 * particles. The tail curves, so that average direction is not the direction of the plume
 * near the head, where the light actually is. Scanning the peak excess over angles about the
 * reported axis, at 1440x900 across one travel leg:
 *
 *   p=0.145  engine 171.4 deg, brightest -174 deg   (14.6 deg apart)
 *   p=0.318  engine -17.8 deg, brightest  -26 deg   ( 8.2 deg apart)
 *   p=0.495  engine -18.4 deg, brightest   10 deg   ( 28.4 deg apart)
 *   p=0.843  engine  23.8 deg, brightest   -8 deg   ( 31.8 deg apart)
 *
 * and the measured profile changes from a textbook decay (peak 83.5 in bin 4, falling to 0.8%
 * of peak by the last bin) to a flat, non-fading one purely as a function of that offset.
 * Sampling along the PCA axis therefore measured the probe's own aim, not the tail.
 *
 * WHY IT USES ITS OWN GEOMETRY — two attempts, both measured, both wrong:
 *
 *   AT THE MEASUREMENT'S BIN COUNT. The search maximises a PEAK, i.e. a max over a handful of
 *   noisy bins, so its argmax is not resolution-stable: on the 390x844 frame the chosen aim was
 *   -6 deg at 8 bins, -26 deg at 20, -6 deg at 40, and those aims give end-shares of 23.2%,
 *   0.9% and 23.2% on the same frame. A criterion whose answer depends on its own resolution
 *   cannot pick a geometry.
 *
 *   AT A FIXED BIN COUNT BUT THE ADAPTIVE BAND. Better, still unstable, because the adaptive
 *   band is deliberately wide where the tail is sparse (W = 29-38 px at the narrow viewports)
 *   and a wide band sums enough sky that the peak stops tracking the ridge.
 *
 * A search is not a measurement. What it needs is the sharpest ridge discriminator, which is a
 * NARROW band. With the fixed geometry below (`pixelAxisSearchBandPx`,
 * `pixelAxisSearchBins`), measured across the five viewports the probe runs, the chosen aim
 * moves by at most 6 degrees as the search's own bin count goes from 12 to 30, and all five
 * frames pass at the median aim.
 *
 * The search stays BOUNDED to `pixelAxisSearchMaxDeg` and picks the direction carrying the most
 * light — the tail is by definition the brightest thing emanating from the comet — so it cannot
 * wander off to an unrelated part of the frame. The offset is returned so the caller can gate
 * and report it: a large offset is itself a finding about the engine.
 *
 * This lives here, not in the runner, so the live probe and the offline self-test re-aim
 * identically. They previously did not, and the self-test then disagreed with the live probe on
 * the same frame.
 */
export function findPlumeAxis(lum, g, th) {
  const T = th || TH
  const sg = {
    ...g, W: T.pixelAxisSearchBandPx, B: T.pixelAxisSearchBins,
  }
  const at = (deg) => profileSummary(axialProfile(lum, { ...sg, rot: (deg * Math.PI) / 180 }))
  let best = { deg: 0, summary: at(0) }
  for (let d = -T.pixelAxisSearchMaxDeg; d <= T.pixelAxisSearchMaxDeg; d += T.pixelAxisSearchStepDeg) {
    if (d === 0) continue
    const s = at(d)
    if (s.peak > best.summary.peak) best = { deg: d, summary: s }
  }
  return best
}

export function axialProfile(lum, g) {
  const { w, h, L } = lum
  const W = g.W === undefined ? 6 : g.W
  const B = g.B === undefined ? 12 : g.B
  const tstep = g.tstep === undefined ? 1 : g.tstep
  const sstep = g.sstep === undefined ? 1 : g.sstep
  const rot = g.rot === undefined ? 0 : g.rot
  const S = g.S === undefined ? 140 : g.S
  const ca = Math.cos(rot)
  const sa = Math.sin(rot)
  const ax = g.ax * ca - g.ay * sa
  const ay = g.ax * sa + g.ay * ca
  const hr2 = g.headR * g.headR
  /*
   * HOW THE PROFILE IS MEASURED, and what was tried first.
   *
   * The quantity is "brightness at distance t along the tail's axis, minus the local sky
   * at the same t". Two earlier versions of that subtraction failed on real frames, and
   * both failures are worth recording because each one silently flattered the build:
   *
   *   THE MIRROR BAND (sample at -t on the same line). Geometrically tidy, but the mirror
   *   position runs off the image as t grows, so at the far end — exactly where the
   *   "fades to nothing" gate looks — there were no control pixels and the excess
   *   degenerated into raw sky. Measured end excess 6.52 = 41.8% of peak with nC = 0 on a
   *   frame whose tail genuinely fades (endShare 0.13 when measured properly).
   *
   *   A PARALLEL BAND at a fixed perpendicular stand-off. Fixed is the problem: the plume
   *   is only ~18 px wide at 1440x900 but the synthetic rigid cone is 2 x 0.16 x t = 156 px
   *   wide at its tip, so any stand-off that clears the real plume still lands INSIDE the
   *   cone. Measured with a 60 px stand-off: the rigid no-fade cone scored endShare 0.00%
   *   and PASSED the gates it is supposed to fail, because the control was reading the
   *   cone itself.
   *
   * The local sky is therefore taken from the LATERAL FLANKS of the same t: samples with
   * |s| between the outer edge and a low percentile of the whole strip. This adapts to the
   * plume's width automatically, stays at the same radius from the nucleus, and needs no
   * off-image stand-off at all. On the rigid cone the flanks are still sky (the cone covers
   * at most ~56% of the strip), so the excess stays constant along the axis and the cone
   * fails the fade gate for the right reason; on the emission plume the far bins are sky on
   * both bands, so the excess goes to zero.
   */
  /*
   * OPTIONAL PARALLEL CONTROL BAND, at the same t but offset perpendicular by `perp`.
   *
   * The rotated-axis control (used elsewhere) is measured over the WHOLE band, and it has a
   * blind spot: rotating about the nucleus leaves t = 0 exactly where it was, and near the
   * nucleus the emission is a roughly spherical coma, equally bright in every direction. So
   * the rotated control picks up the coma glow and can read brighter than the tail's own
   * peak. The parallel band avoids this because it starts at the same t and is offset
   * sideways — it is coma-free by construction, and how far sideways decides whether it
   * clears the plume.
   */
  const perp = typeof g.perp === 'number' && g.perp > 0 ? g.perp : 0
  const side = g.perpSide === -1 ? -1 : 1
  let tUsed = g.tmax
  if (g.clampToImage !== false) {
    const room = axisRoom(w, h, { hx: g.hx, hy: g.hy, ax, ay, tmax: g.tmax, W }, perp, side, 3)
    if (room > 0 && room < tUsed) tUsed = room
  }
  const rows = []
  let offRidge = 0
  let nRidgeTap = 0
  let offStrip = 0
  let nStripTap = 0
  for (let b = 0; b < B; b++) {
    const t0 = b * (tUsed / B)
    const t1 = (b + 1) * (tUsed / B)
    const exT = []
    const seT = []
    const ctrlT = []
    let sumRidge = 0
    let nRidge = 0
    let sumSky = 0
    let nSky = 0
    for (let t = t0; t < t1; t += tstep) {
      const ridge = []
      const strip = []
      for (let s = -S; s <= S; s += sstep) {
        const x = g.hx + ax * t - ay * s
        const y = g.hy + ay * t + ax * s
        const inRidge = s >= -W && s <= W
        if (inRidge) nRidgeTap++
        else nStripTap++
        if (x < 0 || y < 0 || x >= w || y >= h) {
          if (inRidge) offRidge++
          else offStrip++
          continue
        }
        const dx = x - g.hx
        const dy = y - g.hy
        if (dx * dx + dy * dy <= hr2) continue
        const v = L[(y | 0) * w + (x | 0)]
        strip.push(v)
        if (inRidge) ridge.push(v)
      }
      if (perp) {
        let sum = 0
        let n = 0
        for (let d = -W; d <= W; d += sstep) {
          const xc = g.hx + ax * t - ay * (side * perp + d)
          const yc = g.hy + ay * t + ax * (side * perp + d)
          if (xc < 0 || yc < 0 || xc >= w || yc >= h) continue
          const dx = xc - g.hx
          const dy = yc - g.hy
          if (dx * dx + dy * dy <= hr2) continue
          sum += L[(yc | 0) * w + (xc | 0)]
          n++
        }
        if (n) ctrlT.push(sum / n)
      }
      if (ridge.length < 4 || strip.length < 40) continue
      const rMean = ridge.reduce((a, v) => a + v, 0) / ridge.length
      // 20th percentile: the sky level of this strip, robust to the plume occupying part
      // of it (measured: the plume covers at most ~56% of the strip even for the widest
      // synthetic cone at its tip).
      const sky = percentile(strip, 0.20)
      let vR = 0
      for (const v of ridge) vR += (v - rMean) * (v - rMean)
      vR /= Math.max(1, ridge.length - 1)
      exT.push(rMean - sky)
      /*
       * The sampling error is the ridge band's own spread, with an 8-bit quantisation
       * floor. The floor is not cosmetic: a synthetic frame whose band is a single flat
       * value has zero variance, and without the floor its z would collapse to 0 and the
       * "this axis carries real light" gate would reject a plume that is unmistakably
       * there (measured: the uniform rigid cone gave z = 0.00 with excess 218.8).
       */
      seT.push(Math.sqrt(vR / ridge.length + 0.25))
      sumRidge += rMean
      nRidge++
      sumSky += sky
      nSky++
    }
    const n = exT.length
    const ex = n ? exT.reduce((a, v) => a + v, 0) / n : 0
    let se = Infinity
    if (n) {
      let acc = 0
      for (const v of seT) acc += v * v
      se = Math.sqrt(acc) / n
    }
    const skyMean = nSky ? sumSky / nSky : 0
    const ctrlMeanRaw = ctrlT.length ? ctrlT.reduce((a, v) => a + v, 0) / ctrlT.length : null
    /*
     * The control band is reported as an EXCESS over the same local sky the ridge band is
     * measured against — not as its raw mean.
     *
     * Raw would be meaningless here, and the measurement says so: the background is a Milky
     * Way photograph whose brightness varies across the frame, so a band offset 60 px into
     * genuine sky still reads a raw mean well above zero. Measured on the real 18k frame:
     * the raw control mean was 39.7% of the tail's own peak, purely from background
     * structure, which would have failed a correct frame. As an excess over the sky the
     * same band reads ~0, while on the rigid cone the offset band is INSIDE the cone and
     * its excess stays near the full peak — which is exactly the discrimination wanted.
     */
    const ctrlBand = ctrlMeanRaw === null ? null : ctrlMeanRaw - skyMean
    rows.push({
      b, t0, ex, se, bandMean: n ? sumRidge / n : 0, ctrlMean: skyMean,
      ctrlBand, nA: n, nC: n, nStrip: n,
      z: Number.isFinite(se) && se > 0 ? ex / se : 0,
    })
  }
  /*
   * `outsideShare` counts the RIDGE band only. The transverse strip deliberately reaches
   * 140 px either side, so it runs off the canvas near an edge on almost every frame; that
   * is harmless — the sky estimate simply uses the samples it has — but counting those
   * taps would make the "no tap off-image" gate fail for a reason that is not about the
   * measured axis.
   */
  return {
    rows, B, W, S, perp, perpSide: perp ? side : 0, tmaxUsed: tUsed,
    outsideShare: nRidgeTap ? offRidge / nRidgeTap : 0,
    stripOutsideShare: nStripTap ? offStrip / nStripTap : 0,
    offRidge, offStrip, rot,
  }
}

/*
 * A note on `se`: the profiles are built from three per-t runs. The run level takes the
 * std-error of the RIDGE band's taps, averaged in quadrature, and the sky level is a
 * percentile rather than a mean, so no sampling variance enters from the control side.
 * The z of a bin therefore answers "is this bin's ridge brightness above the sky at the
 * same t by more than the ridge's own spread?" — the honest question for a gate that has
 * to work on a structured Milky Way background.
 */
export function profileSummary(prof) {
  const ex = prof.rows.map((r) => r.ex)
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
    peakZ: prof.rows[pi].z,
    peakSe: prof.rows[pi].se,
    endExcess: ex[N - 1],
    endSe: prof.rows[N - 1].se,
    endZ: prof.rows[N - 1].z,
    endShare: peak > 0 ? ex[N - 1] / peak : null,
    farMean,
    farShare: peak > 0 ? farMean / peak : null,
    tmaxUsed: prof.tmaxUsed,
    outsideShare: prof.outsideShare,
    perp: prof.perp,
    perpSide: prof.perpSide,
    ctrlBand: prof.rows.map((r) => r.ctrlBand),
    excess: ex,
    z: prof.rows.map((r) => r.z),
    se: prof.rows.map((r) => r.se),
    nA: prof.rows.map((r) => r.nA),
    nC: prof.rows.map((r) => r.nC),
  }
}
