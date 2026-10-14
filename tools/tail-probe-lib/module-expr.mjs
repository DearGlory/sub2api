/**
 * The one-shot expressions the runner evaluates in the page: the module import plus
 * the synthetic inputs whose right answer is known in closed form.
 *
 * Everything here RETURNS NUMBERS. The verdicts happen in Node.
 */

/**
 * Import the emission kernel and build the synthetic tables.
 *
 * The tables are chosen so that each §1b claim has an exact expected value:
 *   `still`   head parked at (4,-2,1)          -> death distance IS the reach
 *   `moving`  head at -V*d along x, V = 3 u/s  -> closed form |reach + V*life*(1-ENTRAIN)|
 *   `uniform` a diagonal path                  -> a second, differently-angled basis
 *   `divergent` a path that grows 10^3 in 3.2 s -> the table gates must reject it
 */
export const MODULE_SETUP = `(async () => {
  const M = await import('/src/features/home-particle/engine/ParticleEngine.ts');
  const C = await import('/src/features/home-particle/engine/constants.ts');
  window.__TPM = { M: M, C: C };
  window.__TP.fadePow = C.TAIL_FADE_POWER;
  window.__TABLES = (function () {
    const probePoint = { x: 0, y: 0, z: 0 };
    const sHx = 4, sHy = -2, sHz = 1;
    const still = M.createEmissionTable(96);
    M.fillEmissionTable(still, { sampleTrail: function (d, o) { o.x = sHx; o.y = sHy; o.z = sHz; } }, probePoint);
    const V = 3.0;
    const moving = M.createEmissionTable(96);
    M.fillEmissionTable(moving, { sampleTrail: function (d, o) { o.x = -V * d; o.y = 0; o.z = 0; } }, probePoint);
    const reaches = [7.5, 8.75, 10.0, 11.25, 12.5, 13.0];
    const lives = [1.3, 1.7, 2.1, 2.55];
    const cases = [];
    for (let i = 0; i < reaches.length; i++) {
      cases.push({ reach: reaches[i], life: lives[i % lives.length] });
    }
    const uniform = M.createEmissionTable(96);
    M.fillEmissionTable(uniform, { sampleTrail: function (d, o) { o.x = -3.0 * d; o.y = 0.5 * d; o.z = 0; } }, probePoint);
    const divergent = M.createEmissionTable(96);
    M.fillEmissionTable(divergent, { sampleTrail: function (d, o) { const q = Math.pow(10, d / 3.2 * 3); o.x = q; o.y = 0; o.z = 0; } }, probePoint);
    return { still: still, moving: moving, uniform: uniform, divergent: divergent, cases: cases, V: V, stillHead: [sHx, sHy, sHz] };
  })();
  return {
    keys: Object.keys(M).filter(function (k) { return typeof M[k] === 'function'; }),
    HOLD_SECONDS: C.HOLD_SECONDS, HEAD_CORE_RADIUS: C.HEAD_CORE_RADIUS,
    TAIL_DUST_REACH_MIN: C.TAIL_DUST_REACH_MIN, TAIL_DUST_REACH_MAX: C.TAIL_DUST_REACH_MAX,
    TAIL_SECONDS: C.TAIL_SECONDS, TAIL_ENTRAIN: C.TAIL_ENTRAIN, TAIL_FADE_POWER: C.TAIL_FADE_POWER,
    TAIL_RADIUS: C.TAIL_RADIUS,
    imports: { tailFade: typeof M.tailFade, createEmissionTable: typeof M.createEmissionTable,
      fillEmissionTable: typeof M.fillEmissionTable, writeTailParticlePosition: typeof M.writeTailParticlePosition }
  };
})()`

/** Raw tailFade samples plus the special inputs. */
export const FADE_SAMPLES = `(() => {
  const F = window.__TPM.M.tailFade;
  const s = [];
  for (let i = 0; i <= 1000; i++) s.push(F(i / 1000));
  return { samples: s, f0: F(0), f1: F(1), nan: F(NaN), inf: F(Infinity), ninf: F(-Infinity), neg: F(-1), over: F(1.5) };
})()`

/**
 * Measure the position law. `impl` is 'real' (call the shipped function) or 'mutant'
 * (re-derive the same measurement from the OLD static-cone law), so both go through
 * identical arithmetic downstream.
 */
export const MEASURE_TAIL = (impl) => `(() => {
  const M = window.__TPM.M, T = window.__TABLES;
  const out = new Float32Array(3);
  const headDist = function (p, h) { return Math.hypot(p[0] - h[0], p[1] - h[1], p[2] - h[2]); };
  const h0 = T.stillHead;
  const still = [], moving = [];
  for (const cs of T.cases) {
    ${impl === 'real' ? `
    M.writeTailParticlePosition(T.still, 0, cs.life, cs.reach, 0.5, 0.5, Math.SQRT1_2, 0, 0, 0, out);
    const d0 = headDist([out[0], out[1], out[2]], h0);
    M.writeTailParticlePosition(T.still, cs.life, cs.life, cs.reach, 0.5, 0.5, Math.SQRT1_2, 0, 0, 0, out);
    const dEnd = headDist([out[0], out[1], out[2]], h0);
    still.push({ reach: cs.reach, life: cs.life, d0: d0, dEnd: dEnd });
    M.writeTailParticlePosition(T.moving, cs.life, cs.life, cs.reach, 1, 0, 0, 0, 0, 0, out);
    const mEnd = Math.hypot(out[0], out[1], out[2]);
    const seq = [];
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      M.writeTailParticlePosition(T.moving, f * cs.life, cs.life, cs.reach, 1, 0, 0, 0, 0, 0, out);
      seq.push(Math.hypot(out[0], out[1], out[2]));
    }
    moving.push({ reach: cs.reach, life: cs.life, dEnd: mEnd, seq: seq });` : `
    // MUTANT: the V1 static cone. The particle sits at its final slot from frame one,
    // so the distance at age 0 is the full reach instead of ~0 -- nothing is emitted
    // from the comet, which is precisely the user's complaint.
    M.writeTailParticlePosition(T.still, 0, cs.life, cs.reach, 0.5, 0.5, Math.SQRT1_2, 0, 0, 0, out);
    const d0 = cs.reach;
    M.writeTailParticlePosition(T.still, cs.life, cs.life, cs.reach, 0.5, 0.5, Math.SQRT1_2, 0, 0, 0, out);
    const dEnd = headDist([out[0], out[1], out[2]], h0);
    still.push({ reach: cs.reach, life: cs.life, d0: d0, dEnd: dEnd });
    M.writeTailParticlePosition(T.moving, cs.life, cs.life, cs.reach, 1, 0, 0, 0, 0, 0, out);
    const mEnd = Math.hypot(out[0], out[1], out[2]);
    const seq = [];
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      M.writeTailParticlePosition(T.moving, f * cs.life, cs.life, cs.reach, 1, 0, 0, 0, 0, 0, out);
      seq.push(Math.hypot(out[0], out[1], out[2]));
    }
    moving.push({ reach: cs.reach, life: cs.life, dEnd: mEnd, seq: seq });`}
  }
  return { still: still, moving: moving, V: T.V };
})()`

/** Table arithmetic, as plain arrays Node can threshold. */
export const TABLE_STATS = (which) => `(() => {
  const T = window.__TABLES;
  const table = ${which === 'live' ? 'window.__TP.eng().scratch.tailTable' : 'T.' + which};
  const n = table.probeCount, step = table.spanSeconds / Math.max(1, n - 1);
  const arrays = { xyz: table.xyz, vel: table.vel, axis: table.axis, side1: table.side1, side2: table.side2 };
  let nonFinite = 0, maxVelErr = 0, maxSpeed = 0, maxUnitErr = 0, maxStep = 0;
  for (const key in arrays) {
    const a = arrays[key];
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) nonFinite++;
  }
  for (let k = 0; k < n; k++) {
    const hi = (k === 0 ? 0 : k - 1) * 3, lo = (k === n - 1 ? n - 1 : k + 1) * 3;
    const elapsed = (k === 0 || k === n - 1 ? 1 : 2) * step;
    const dx = table.xyz[hi] - table.xyz[lo], dy = table.xyz[hi + 1] - table.xyz[lo + 1], dz = table.xyz[hi + 2] - table.xyz[lo + 2];
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz) / elapsed;
    if (mag > maxStep) maxStep = mag;
    const vx = table.vel[k * 3], vy = table.vel[k * 3 + 1], vz = table.vel[k * 3 + 2];
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (sp > maxSpeed) maxSpeed = sp;
    maxVelErr = Math.max(maxVelErr, Math.abs(sp - mag));
    const ax = table.axis[k * 3], ay = table.axis[k * 3 + 1], az = table.axis[k * 3 + 2];
    if (sp > 1e-4) maxUnitErr = Math.max(maxUnitErr, Math.abs(Math.sqrt(ax * ax + ay * ay + az * az) - 1));
  }
  return { probeCount: n, spanSeconds: table.spanSeconds, step: step, nonFinite: nonFinite,
    maxVelErr: maxVelErr, maxSpeed: maxSpeed, maxStep: maxStep, maxUnitErr: maxUnitErr };
})()`
