/**
 * Independent acceptance probe for the HOME-PARTICLE v2 comet tail.
 *
 * Spec: HOME-PARTICLE-V2-SPEC.md §4 — V1 (a tail EMITTED from the comet and fading
 * out with distance), V2 (a natural comet<->pattern transition), V4 (a 3 s hold in
 * which the pattern stands still).
 *
 * HOW TO RUN
 *   node tools/tail-physics-probe.mjs --url=http://127.0.0.1:5210/
 *   node tools/tail-physics-probe.mjs --url=... --viewports=1440x900
 *   node tools/tail-physics-probe.mjs --url=... --no-reduced
 *   node tools/tail-physics-probe.mjs --url=... --seconds=27 --port=9521
 *
 * Exit code is 0 only when every criterion of every run passed AND every injected
 * mutant was rejected.
 *
 * WHY IT IS SHAPED THIS WAY
 *
 * The claim under test — "the tail is emitted matter with a lifetime, not a rigid
 * cone parked on a path" — is not settled by a screenshot, nor by the word of
 * whoever wrote the engine. Each requirement is therefore checked at two levels:
 *
 *   MODULE   The emission kernel (tailFade, createEmissionTable, fillEmissionTable,
 *            writeTailParticlePosition) is imported into the live page and called
 *            with synthetic input whose right answer is known in closed form. If the
 *            old arc-length rig came back, these fail on arithmetic, not on taste.
 *
 *   PIXELS   Screenshots come from Page.captureScreenshot — the compositor's own
 *            image — never from a canvas readback. Without `preserveDrawingBuffer` a
 *            WebGL canvas reads back black after the frame, which is the classic
 *            "everything green, nothing rendered" false pass.
 *
 * The page only produces NUMBERS. Every threshold and every verdict lives in Node,
 * which is what lets one checker serve both the real data and the mutants below.
 *
 * DISCRIMINATION IS ITSELF A TEST
 *
 * A probe that always passes is worse than no probe: it manufactures confidence. So
 * the same checkers are also handed deliberately WRONG inputs, and the probe only
 * reports PASS if every one of them is REJECTED. The mutants include real controls on
 * the live page — the same pixels sampled on an axis rotated 90 degrees off the
 * plume, an independently drawn rigid non-fading cone, and a whole-cloud single-frame
 * displacement field — not just spoofs of the checker's own input.
 *
 * Pure logic lives in tools/tail-probe-lib/. `tools/tail-probe-lib/self-test.mjs`
 * re-runs the pixel gates offline against known frames to justify their values.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TH } from './tail-probe-lib/index.mjs'
import { runViewport } from './tail-probe-lib/run-viewport.mjs'
import { printRun, printMutants, finish } from './tail-probe-lib/report.mjs'
import {
  fadeMutants, reachMutant, birthMutant, tableMutant, pixelMutants, transitionMutant, holdMutants,
} from './tail-probe-lib/discrimination.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/)
    return m ? [m[1], m[2] === '' ? 'true' : m[2]] : [a, 'true']
  })
)

const cfg = {
  url: args.url || 'http://127.0.0.1:5210/',
  out: resolve(args.out || join(HERE, '..', 'shots', 'tail-probe')),
  port: Number(args.port || 9521),
  chrome: args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  profile: resolve(args.profile || join(HERE, '..', '.chrome-probe-9521')),
  bootMs: Number(args.boot || 12000),
  recordSeconds: Number(args.seconds || 27),
  thresholds: TH,
  viewports: (args.viewports || '1440x900,1920x1080,390x844,900x1400')
    .split(',').map((s) => s.trim()).filter(Boolean),
  wantReduced: args.no_reduced === undefined,
}

mkdirSync(cfg.out, { recursive: true })
mkdirSync(cfg.profile, { recursive: true })

function planRuns() {
  const plans = []
  for (const v of cfg.viewports) {
    const m = v.match(/^(\d+)x(\d+)$/)
    if (!m) continue
    plans.push({ label: v, w: Number(m[1]), h: Number(m[2]), reduced: false })
  }
  if (cfg.wantReduced && plans.length) {
    const f = plans[0]
    plans.push({ label: f.label, w: f.w, h: f.h, reduced: true })
  }
  return plans
}

/** Assemble the mutant list from one run's own artifacts. */
function buildMutants(ref) {
  const mutants = []
  const C = ref ? ref.metrics.constants : null
  fadeMutants(mutants)
  if (ref) {
    const a = ref.artifacts
    reachMutant(mutants, a.reachData && a.reachData.real, C)
    birthMutant(mutants, a.reachData && a.reachData.real, C)
    tableMutant(mutants, a.tables && a.tables.divergentTable)
    if (a.controls && a.controls.rotated && ref.metrics.pixel) {
      pixelMutants(mutants, a.controls.rigidCone, a.controls.rotated, ref.metrics.pixel.peak)
    }
    transitionMutant(mutants, a.blockRows, a.idleP99)
    holdMutants(mutants, a.holdRuns, C ? C.HOLD_SECONDS : 3.0)
  }
  return mutants
}

const slug = (p) => p.label + (p.reduced ? '-rm' : '')
const runFile = (p) => join(cfg.out, 'run-' + slug(p) + '.json')

/*
 * Each viewport's full result is persisted to its own file, and `--resume` reuses a
 * complete one instead of driving Chrome again. A five-viewport pass takes about
 * seven minutes — longer than a shell's foreground limit on this host — so being able
 * to run it in chunks, and to keep the evidence when a later chunk dies, is the
 * difference between a probe that finishes and one that does not.
 */
function loadPrior(p) {
  if (args.resume === undefined) return null
  try {
    const j = JSON.parse(readFileSync(runFile(p), 'utf8'))
    if (!j || !j.checks || !j.checks.length || !j.metrics || !j.metrics.constants) return null
    return j
  } catch (e) {
    return null
  }
}

async function main() {
  const t0 = Date.now()
  const plans = planRuns()
  console.log('=== tail-physics-probe ===')
  console.log('  url          ' + cfg.url)
  console.log('  viewports    ' + plans.map((p) => p.label + (p.reduced ? '(rm)' : '')).join(', '))
  console.log('  record       ' + cfg.recordSeconds + ' s per run (~2.2 beats)')
  console.log('  gates        peakZ>=' + TH.pixelPeakZMin + '  peakAt<=' + TH.pixelPeakAtMax +
    '  endShare<=' + TH.pixelEndShareMax + '  farShare<=' + TH.pixelFarShareMax +
    '  P99<=' + TH.transitionP99Max + '  rigid<=' + TH.transitionRigidMax)
  console.log('  out          ' + cfg.out)
  console.log('')

  const runs = []
  for (const p of plans) {
    const prior = loadPrior(p)
    if (prior) {
      console.log('  reused  ' + p.label + (p.reduced ? ' reduced-motion' : '') + '  (' +
        prior.checks.length + ' checks, from run-' + slug(p) + '.json)')
      runs.push(prior)
      continue
    }
    process.stdout.write('  running ' + p.label + (p.reduced ? ' reduced-motion' : '') + ' ... ')
    const r = await runViewport(p, cfg)
    process.stdout.write((r.error ? 'ERROR' : (r.checks.every((c) => c.ok) ? 'all pass' : 'FAIL')) + '\n')
    runs.push(r)
    // Persist after every viewport, so a later stall cannot lose the earlier evidence.
    writeFileSync(runFile(p), JSON.stringify(r, (k, v) => (k === 'img' ? undefined : v), 2))
    writeFileSync(join(cfg.out, 'partial-runs.json'), JSON.stringify(
      runs.map((x) => ({ tag: x.tag, error: x.error, metrics: x.metrics, checks: x.checks })), null, 2))
  }

  console.log('\n=== per-run results ===')
  for (const r of runs) console.log(printRun(r))

  // The first run that produced a full set of artifacts is the discrimination
  // reference; the mutants are derived from its own pixels and frames.
  const ref = runs.find((r) => r.artifacts && r.artifacts.reachData) || runs[0]
  const mutants = buildMutants(ref)
  const dm = printMutants(mutants)
  console.log(dm.text)

  const fin = finish(cfg, runs, mutants, dm.allRejected, t0)
  console.log(fin.text)
  process.exitCode = fin.allPass ? 0 : 1
}

main().catch((e) => {
  console.error('probe failed: ' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
})
