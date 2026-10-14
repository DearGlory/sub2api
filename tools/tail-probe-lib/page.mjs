/**
 * The code injected into the running page. A DATA PROVIDER ONLY: it reads state and
 * returns numbers. Every threshold and every verdict lives in Node, so one checker
 * serves both the real data and the mutants.
 *
 * Written without template literals, backticks or `${` so it can live inside one in
 * the caller, and without arrow functions in the hot loops.
 *
 * It exports one string, `PAGE_HELPERS`, plus the one-shot expressions the runner
 * evaluates separately.
 */

export const PAGE_HELPERS = `
window.__TP = {};
window.__TP.eng = function () { return window.__SUB2API_PARTICLE_ENGINE__ || null; };
window.__TP.ready = function () {
  var e = window.__TP.eng();
  return !!(e && e.scratch && e.scratch.tailTable && e.debugScene && e.choreography);
};
window.__TP.state = function () {
  var e = window.__TP.eng();
  if (!window.__TP.ready()) return { error: 'engine handle __SUB2API_PARTICLE_ENGINE__ is not on the page' };
  var c = e.choreography.state;
  var q = e.quality || {};
  return {
    phase: c.phase, p: c.phaseProgress, brand: e.getStats().brandSlug,
    camZ: e.debugScene.camera.position.z, holdFade: e.holdFade,
    reduced: e.reducedMotion === true, particleCount: e.particleCount,
    quality: { particleCount: q.particleCount, tailSampleCount: q.tailSampleCount, maxDpr: q.maxDpr },
    pointSize: e.material ? e.material.size : null,
    inner: [innerWidth, innerHeight], dpr: devicePixelRatio
  };
};
/** Hide everything except the particle canvas, and paint the page black behind it. */
window.__TP.isolate = function () {
  var host = document.querySelector('[data-testid="home-particle-background"]') ||
             document.querySelector('[data-testid="home-particle"]');
  var canvas = host ? (host.tagName === 'CANVAS' ? host : host.querySelector('canvas'))
                    : document.querySelector('canvas');
  if (!canvas) return { error: 'no particle canvas in the DOM' };
  document.documentElement.classList.add('dark');
  var keep = new Set();
  var n;
  for (n = canvas; n; n = n.parentElement) keep.add(n);
  var hidden = 0;
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    if (!keep.has(all[i])) { all[i].style.visibility = 'hidden'; hidden++; }
  }
  document.documentElement.style.background = '#000';
  document.body.style.background = '#000';
  var r = canvas.getBoundingClientRect();
  return { ok: true, hidden: hidden, rect: { w: r.width, h: r.height, x: r.x, y: r.y },
           buffer: { w: canvas.width, h: canvas.height }, dpr: devicePixelRatio };
};
/**
 * Project the tail population to screenshot pixels and return its own principal axis.
 *
 * The weight is the SAME fade the engine bakes into the colour buffer, read from the
 * engine's own TAIL_FADE_POWER, so the axis is the axis of what is actually lit
 * rather than of where the particles happen to be.
 */
window.__TP.geom = function () {
  var e = window.__TP.eng();
  var s = e.scratch;
  var sc = e.debugScene;
  var cam = sc.camera;
  cam.updateMatrixWorld(true);
  var V3 = s.vecA.constructor;
  var v = new V3();
  var off = sc.points.position;
  var PW = innerWidth;
  var PH = innerHeight;
  var pj = function (x, y, z) {
    v.set(x + off.x, y + off.y, z + off.z).project(cam);
    return [(v.x + 1) / 2 * PW, (1 - v.y) / 2 * PH];
  };
  var n = e.particleCount;
  var core = Math.floor(n * 0.18);
  var pow = window.__TP.fadePow === undefined ? 0.6 : window.__TP.fadePow;
  var P = [];
  var W = [];
  var ages = [];
  for (var i = core; i < n; i++) {
    var k = i * 3;
    var life = s.tailLife[i];
    var u = life > 1e-6 ? s.tailAge[i] / life : 1;
    ages.push(u);
    var w = u >= 1 ? 0 : Math.pow(1 - u, pow);
    P.push(pj(s.positions[k], s.positions[k + 1], s.positions[k + 2]));
    W.push(w);
  }
  var hx = 0, hy = 0, hz = 0, hc = 0;
  for (var j = 0; j < core; j++) {
    var kk = j * 3;
    hx += s.positions[kk]; hy += s.positions[kk + 1]; hz += s.positions[kk + 2];
    hc++;
  }
  hx /= hc; hy /= hc; hz /= hc;
  var head = pj(hx, hy, hz);
  var mx = 0, my = 0, tw = 0;
  for (var a = 0; a < P.length; a++) { mx += P[a][0] * W[a]; my += P[a][1] * W[a]; tw += W[a]; }
  mx /= tw; my /= tw;
  var sxx = 0, syy = 0, sxy = 0;
  for (var b = 0; b < P.length; b++) {
    var dx = P[b][0] - mx, dy = P[b][1] - my;
    sxx += W[b] * dx * dx; syy += W[b] * dy * dy; sxy += W[b] * dx * dy;
  }
  var th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  var ax = Math.cos(th), ay = Math.sin(th);
  if ((mx - head[0]) * ax + (my - head[1]) * ay < 0) { ax = -ax; ay = -ay; }
  var proj = [], perp = [];
  for (var c2 = 0; c2 < P.length; c2++) {
    proj.push((P[c2][0] - head[0]) * ax + (P[c2][1] - head[1]) * ay);
    perp.push(Math.abs(-(P[c2][0] - head[0]) * ay + (P[c2][1] - head[1]) * ax));
  }
  var srt = Float32Array.from(proj).sort();
  var spp = Float32Array.from(perp).sort();
  var qp = function (f) { return srt[Math.min(srt.length - 1, Math.floor(f * srt.length))]; };
  var qq = function (f) { return spp[Math.min(spp.length - 1, Math.floor(f * spp.length))]; };
  ages.sort(function (x, y) { return x - y; });
  var qa = function (f) { return ages[Math.min(ages.length - 1, Math.floor(f * ages.length))]; };
  // The projected radius of HEAD_CORE_RADIUS world units: measured by projecting a
  // point that far to the camera's right of the nucleus, so it tracks the viewport
  // and the dolly instead of being a hard-coded pixel count.
  var p1 = pj(hx, hy, hz);
  var p2 = pj(hx + 0.62, hy, hz);
  var headPx = Math.sqrt((p2[0] - p1[0]) * (p2[0] - p1[0]) + (p2[1] - p1[1]) * (p2[1] - p1[1]));
  return {
    PW: PW, PH: PH, nTail: P.length, nucleus: head, axis: [ax, ay], headPx: headPx,
    projP50: qp(0.5), projP90: qp(0.9), projP97: qp(0.97), projMax: srt[srt.length - 1],
    perpP50: qq(0.5), perpP90: qq(0.9), perpP97: qq(0.97), perpMax: spp[spp.length - 1],
    ageU: { p01: qa(0.01), p10: qa(0.1), p50: qa(0.5), p90: qa(0.9), p99: qa(0.99),
            min: ages[0], max: ages[ages.length - 1] },
    camZ: cam.position.z, pointSize: e.material ? e.material.size : null
  };
};
/**
 * Per-frame displacement statistics over a whole number of beats.
 *
 * Returns rows, not verdicts. The centring is done in world space on the full cloud,
 * which is what makes the rigidity index meaningful: |mean displacement vector|
 * divided by the rms displacement magnitude is exactly 1 for a rigid translation.
 */
window.__TP.record = function (seconds) {
  return new Promise(function (resolve) {
    var e = window.__TP.eng();
    var s = e.scratch;
    var n = e.particleCount;
    var prev = null;
    var rows = [];
    var t0 = performance.now();
    var lastT = t0;
    var snap = function () { return Float32Array.from(s.positions.subarray(0, n * 3)); };
    var step = function () {
      var now = performance.now();
      if (now - t0 > seconds * 1000) { resolve(rows); return; }
      var c = e.choreography.state;
      var cur = snap();
      var rec = { t: now - t0, dt: now - lastT, phase: c.phase, p: c.phaseProgress,
                  camZ: e.debugScene.camera.position.z, brand: e.getStats().brandSlug };
      if (prev) {
        var d = new Float32Array(n);
        var mx = 0, sum = 0, sx = 0, sy = 0, sz = 0, m1 = 0;
        var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9, cx = 0, cy = 0, cz = 0;
        for (var i = 0; i < n; i++) {
          var k = i * 3;
          var dx = cur[k] - prev[k], dy = cur[k + 1] - prev[k + 1], dz = cur[k + 2] - prev[k + 2];
          var m = Math.sqrt(dx * dx + dy * dy + dz * dz);
          d[i] = m;
          if (m > mx) mx = m;
          sum += m * m; sx += dx; sy += dy; sz += dz; m1 += m;
          var X = cur[k], Y = cur[k + 1], Z = cur[k + 2];
          if (X < x0) x0 = X; if (X > x1) x1 = X;
          if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
          if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
          cx += X; cy += Y; cz += Z;
        }
        m1 /= n;
        var rms = Math.sqrt(sum / n);
        var mu = Math.sqrt(sx * sx + sy * sy + sz * sz) / n;
        var ds = Float32Array.from(d).sort();
        var qf = function (f) { return ds[Math.min(n - 1, Math.floor(f * n))]; };
        rec.p50 = qf(0.5); rec.p90 = qf(0.9); rec.p99 = qf(0.99); rec.max = mx;
        rec.rigid = mu / (rms || 1e-9);
        rec.cx = cx / n; rec.cy = cy / n; rec.cz = cz / n;
        rec.diag = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + (z1 - z0) * (z1 - z0));
      }
      rows.push(rec);
      prev = cur;
      lastT = now;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
};
/** Row statistics for one supplied displacement field. */
window.__TP.rowOf = function (disp, prevPos, n, phase) {
  var mx = 0, sum = 0, sx = 0, sy = 0, sz = 0, m1 = 0, cx = 0, cy = 0, cz = 0;
  var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  var d = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var k = i * 3;
    var dx = disp[k], dy = disp[k + 1], dz = disp[k + 2];
    var m = Math.sqrt(dx * dx + dy * dy + dz * dz);
    d[i] = m;
    if (m > mx) mx = m;
    sum += m * m; sx += dx; sy += dy; sz += dz; m1 += m;
    var X = prevPos[k] + dx, Y = prevPos[k + 1] + dy, Z = prevPos[k + 2] + dz;
    if (X < x0) x0 = X; if (X > x1) x1 = X;
    if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    cx += X; cy += Y; cz += Z;
  }
  m1 /= n;
  var rms = Math.sqrt(sum / n);
  var mu = Math.sqrt(sx * sx + sy * sy + sz * sz) / n;
  var ds = Float32Array.from(d).sort();
  var qf = function (f) { return ds[Math.min(n - 1, Math.floor(f * n))]; };
  return { t: 0, dt: 20, phase: phase || 'gather', p: 0.5, camZ: 0, brand: 'MUTANT',
    p50: qf(0.5), p90: qf(0.9), p99: qf(0.99), max: mx, rigid: mu / (rms || 1e-9),
    cx: cx / n, cy: cy / n, cz: cz / n,
    diag: Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + (z1 - z0) * (z1 - z0)) };
};
/**
 * The whole-cloud single-frame displacement field: every particle moved straight to
 * its glyph target in one frame. This is the block flip the V2 requirement forbids.
 */
window.__TP.blockFlipRows = function () {
  var e = window.__TP.eng();
  var s = e.scratch;
  var n = e.particleCount;
  var prev = Float32Array.from(s.positions.subarray(0, n * 3));
  var disp = new Float32Array(n * 3);
  for (var j = 0; j < n * 3; j++) {
    var g = (s.glyphTargets[j] || 0) + (s.iconOrbitOffsets[j] || 0);
    disp[j] = g - prev[j];
  }
  var out = [];
  out.push(window.__TP.rowOf(disp, prev, n, 'gather'));
  var zero = new Float32Array(n * 3);
  for (var q = 0; q < 3; q++) out.push(window.__TP.rowOf(zero, prev, n, 'scatter'));
  return out;
};
true;
`
