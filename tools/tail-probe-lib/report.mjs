/**
 * Console report + JSON artifact + exit code.
 *
 * The exit code reflects the result: 0 only when every criterion of every run passed
 * AND every mutant was rejected. A run that errored counts as a failure, because a
 * probe that could not measure has not established anything.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function printRun(run) {
  const out = []
  const push = (s) => out.push(s)
  push('')
  push('--- ' + run.tag + (run.error ? '   [run error: ' + run.error + ']' : ''))
  const b = run.metrics.boot
  if (b) {
    push('    boot: viewport ' + b.inner.join('x') + '  dpr ' + b.dpr + '  particles ' + b.particleCount +
      '  reducedMotion ' + b.reducedMotion + '  pointSize ' + b.pointSize)
    if (b.quality) push('    quality: ' + JSON.stringify(b.quality))
  }
  const g = run.metrics.geom
  if (g) {
    push('    plume: ' + g.nTail + ' tail particles  axis (' + g.axis.join(', ') + ')  nucleus (' +
      g.nucleus.join(', ') + ')  head exclusion ' + g.headPx + ' px')
    push('    along-axis px: p50 ' + g.projP50 + '  p97(TMAX) ' + g.projP97 + '  max ' + g.projMax +
      '   cross-axis px: p50 ' + g.perpP50 + '  p90 ' + g.perpP90 + '  p97 ' + g.perpP97)
    push('    age/life quantiles: ' + JSON.stringify(g.ageU))
  }
  if (run.metrics.fade) push('    tailFade: ' + JSON.stringify(run.metrics.fade))
  if (run.metrics.reach) push('    position law: ' + JSON.stringify(run.metrics.reach))
  if (run.metrics.table) push('    emission table: ' + JSON.stringify(run.metrics.table))
  const p = run.metrics.pixel
  if (p) {
    push('    pixel: peak ' + p.peak + ' (z ' + p.peakZ + ') at bin ' + p.peakBin + ' (' + p.peakAtFrac +
      ' of axis)  end ' + p.endExcess + ' (' +
      (p.endShare === null ? 'n/a' : (100 * p.endShare).toFixed(2) + '%') + ' of peak)  far-quarter ' +
      (p.farShare === null ? 'n/a' : (100 * p.farShare).toFixed(2) + '%') +
      '  monoViol ' + p.monoViol + '  rotated ' + p.rotatedPeak + ' (' +
      (p.rotatedShare === null ? 'n/a' : (100 * p.rotatedShare).toFixed(1) + '%') + ')')
    push('           excess: ' + p.profile.join(', '))
    push('           z     : ' + p.zProfile.join(', '))
  }
  const c = run.artifacts.controls
  if (c) {
    push('    control rigid cone:  peak ' + c.rigidCone.peak.toFixed(2) + ' peakAt ' + c.rigidCone.peakAtFrac.toFixed(3) +
      ' endShare ' + (100 * c.rigidCone.endShare).toFixed(1) + '% farShare ' + (100 * c.rigidCone.farShare).toFixed(1) + '%')
    push('    control emission:    peak ' + c.emission.peak.toFixed(2) + ' peakAt ' + c.emission.peakAtFrac.toFixed(3) +
      ' endShare ' + (100 * c.emission.endShare).toFixed(1) + '% farShare ' + (100 * c.emission.farShare).toFixed(1) + '%')
  }
  if (run.metrics.recording) push('    recording: ' + JSON.stringify(run.metrics.recording))
  if (run.metrics.transition) push('    transition: ' + JSON.stringify(run.metrics.transition))
  if (run.metrics.hold) push('    hold: ' + JSON.stringify(run.metrics.hold))
  for (const ck of run.checks) {
    push('    ' + (ck.ok ? 'PASS' : 'FAIL') + '  ' + ck.name + (ck.detail ? '   [' + ck.detail + ']' : ''))
  }
  return out.join('\n')
}

/** Print the discrimination section and return whether every mutant was rejected. */
export function printMutants(mutants) {
  const out = ['', '=== §5 discrimination proof — every injected fault must be REJECTED ===']
  for (const m of mutants) {
    out.push('  ' + (m.rejected ? 'REJECTED' : 'ACCEPTED !!!') + '  ' + m.name)
    out.push('      injected fault: ' + m.injectedFault)
    out.push('      caught by:      ' + m.checker)
    out.push('      evidence:       ' + m.evidence)
  }
  const allRejected = mutants.length >= 8 && mutants.every((m) => m.rejected)
  out.push('')
  out.push('  mutants injected: ' + mutants.length + ', rejected: ' +
    mutants.filter((m) => m.rejected).length + ' -> ' +
    (allRejected ? 'discrimination PROVEN' : 'DISCRIMINATION BROKEN'))
  return { text: out.join('\n'), allRejected }
}

export function finish(cfg, runs, mutants, mutantsAllRejected, startedAt) {
  const lines = []
  const runPass = runs.length > 0 && runs.every((r) => !r.error && r.checks.length > 0 && r.checks.every((c) => c.ok))
  lines.push('')
  lines.push('=== totals ===')
  for (const r of runs) {
    const f = r.checks.filter((c) => !c.ok).length
    lines.push('  ' + (r.checks.every((c) => c.ok) && !r.error ? 'PASS' : 'FAIL') + '  ' +
      r.tag.padEnd(30) + String(r.checks.length).padStart(3) + ' checks, ' + f + ' failed')
  }
  lines.push('  ' + (mutantsAllRejected ? 'PASS' : 'FAIL') + '  ' + 'discrimination'.padEnd(30) +
    String(mutants.length).padStart(3) + ' mutants, ' +
    mutants.filter((m) => m.rejected).length + ' rejected')
  const allPass = runPass && mutantsAllRejected
  const secs = ((Date.now() - startedAt) / 1000).toFixed(0)
  lines.push('')
  lines.push('  VERDICT: ' + (allPass ? 'PASS' : 'FAIL') + '   (' + secs + ' s)')
  lines.push('  artifact: ' + join(cfg.out, 'tail-probe-report.json'))

  const slim = runs.map((r) => ({
    tag: r.tag, viewport: r.viewport, inner: r.inner, reducedMotion: r.reducedMotion,
    error: r.error, metrics: r.metrics, checks: r.checks,
    checksFailed: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
  }))
  writeFileSync(join(cfg.out, 'tail-probe-report.json'), JSON.stringify({
    probe: 'tools/tail-physics-probe.mjs',
    url: cfg.url,
    startedAt: new Date(startedAt).toISOString(),
    durationSeconds: Number(secs),
    thresholds: cfg.thresholds,
    runs: slim,
    mutants,
    discriminationProven: mutantsAllRejected,
    allPass,
  }, null, 2))
  return { text: lines.join('\n'), allPass }
}
