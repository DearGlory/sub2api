/**
 * The judge's own self-check, kept in the repo so its evidence is reproducible.
 *
 * `--discriminate` inside framing-probe.mjs falsifies the V6 size measurement. It does
 * NOT cover the two criteria repaired in 6f3911e61, and those two are exactly the ones
 * that needed it: both are gated on quantities drawn from the sample (which brands the
 * sweep happened to draw, whether the tolerance still binds), so "they pass on the
 * correct build" is not evidence they can still fail.
 *
 * This script proves the remaining question by mutation. It copies the probe into a
 * scratch dir, injects one defect per arm, and runs each arm with `--only=` pinned to
 * the criterion family under test. The committed probe is never modified.
 *
 * The arms and what each one proves:
 *
 *   A  the two measurement routes genuinely disagree (`dfw + 0.3`)
 *      -> the V6 cross-check MUST FAIL. Proves the cross-check still discriminates.
 *
 *   B  the tolerance stops binding (both shares forced to 0.30, over the 0.25 cap)
 *      -> MUST report not-answered and produce ZERO FAILs. This is the arm that pins
 *         the repair's direction: before 6f3911e61 a blown tolerance came out as a
 *         page FAIL, and an arm asserting "no FAILs" is the only way to show it no
 *         longer does. A single FAIL here means the defect is back.
 *
 *   C  the confound cannot be removed (deconfounding forced false)
 *      -> the V3 brand-effect criterion MUST FAIL. This is the informative failure the
 *         repair deliberately preserved, and it is the control for arm B's SKIP: the
 *         same criterion must still be able to say FAIL when it really cannot decide.
 *
 * The asset probe runs first in every arm. Skipping it attaches an unrelated
 * `V7/V8 asset probe results present` FAIL to every arm — which is merely noise for the
 * arms expected to fail, but inverts the reading of arm B, whose expected result is
 * no-FAIL-at-all. (Learned the hard way; see the HANDOFF for that episode.)
 *
 * Usage:
 *   node tools/probe-judge-selfcheck.mjs --repo=E:/path/to/checkout \
 *        --url=http://127.0.0.1:5210/ [--out=DIR] [--port-base=9971]
 *
 * Exit code: 0 when every arm landed on its expected outcome, 1 otherwise. A non-zero
 * exit means the repair's discriminating power is in doubt — do not read the probe's
 * verdicts as acceptance evidence until it is understood.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, 'framing-probe.mjs')
const ASSETS = join(HERE, 'framing-probe-assets.mjs')

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const REPO = resolve(arg('repo', process.cwd()))
const URL_ = arg('url', 'http://127.0.0.1:5210/')
const OUT = resolve(arg('out', join(REPO, '.probe-selfcheck')))
const PORT_BASE = Number(arg('port-base', '9971'))

/**
 * Each arm names the criterion family to run and asserts on the FAIL set. `expectFails`
 * is a predicate over the list of `criterion / name` strings rather than a count, so an
 * arm cannot pass by coincidence on an unrelated failure.
 */
const ARMS = [
  {
    id: 'A-routes-disagree',
    only: 'v6',
    desc: 'the two measurement routes genuinely disagree -> the cross-check must still FAIL',
    edits: [[
      'const dfw = th && th.lit ? Math.abs(th.fw - live.fw) : NaN',
      'const dfw = (th && th.lit ? Math.abs(th.fw - live.fw) : NaN) + 0.3',
    ]],
    expectFails: (f) => f.length > 0 && f.every((s) => s.startsWith('V6 / ') && s.includes('cross-check')),
    expect: '>=1 FAIL, all of them V6 cross-check',
  },
  {
    id: 'B-tolerance-stops-binding',
    only: 'v6',
    desc: 'the tolerance stops binding -> not-answered, and NOT a page failure',
    edits: [
      ['    fh: round(Math.max(0.005, shareH + rasterH), 4),', '    fh: 0.30,'],
      ['    fw: round(Math.max(0.005, shareW + rasterW), 4),', '    fw: 0.30,'],
    ],
    expectFails: (f) => f.length === 0,
    expect: '0 FAILs (a SKIP, not a FAIL)',
  },
  {
    id: 'C-confounded',
    only: 'v3',
    desc: 'de-confounding is impossible -> the brand-effect criterion must still FAIL',
    edits: [[
      '  const brandSpreadVerdict = !deconfounded ? false : fhVaries ? true : null',
      '  const brandSpreadVerdict = (!deconfounded || true) ? false : fhVaries ? true : null',
    ]],
    expectFails: (f) => f.some((s) => s.startsWith('V3 / ') && s.includes('brand effect')),
    expect: '>=1 FAIL naming the V3 brand-effect criterion',
  },
]

const src = readFileSync(PROBE, 'utf8')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const results = []
for (const [i, arm] of ARMS.entries()) {
  const label = `[${arm.id}]`
  // Inject into the copy, never the committed file.
  let mutated = src
  let injectOk = true
  for (const [from, to] of arm.edits) {
    if (!mutated.includes(from)) { injectOk = false; break }
    mutated = mutated.replace(from, to)
  }
  if (!injectOk) {
    console.log(`${label} INJECTION FAILED — an anchor moved; re-read the probe before trusting this suite`)
    results.push({ arm, status: 'injection-failed' })
    continue
  }

  const armDir = join(OUT, arm.id)
  rmSync(armDir, { recursive: true, force: true })
  mkdirSync(armDir, { recursive: true })
  const probeCopy = join(armDir, 'probe.mjs')
  writeFileSync(probeCopy, mutated)

  const port = PORT_BASE + i
  const profile = join(OUT, `.chrome-${port}`)
  const common = [`--repo=${REPO}`, `--url=${URL_}`, `--only=${arm.only}`, `--out=${armDir}`]

  // Assets FIRST — see the header. Without it every arm wears an unrelated FAIL.
  const a = spawnSync(process.execPath, [ASSETS, ...common], { encoding: 'utf8' })
  if (a.status !== 0) {
    console.log(`${label} asset probe failed (exit ${a.status}) — cannot run this arm cleanly`)
    console.log(String(a.stderr || a.stdout).split('\n').slice(-4).join('\n'))
    results.push({ arm, status: 'assets-failed' })
    continue
  }

  const p = spawnSync(process.execPath, [probeCopy, ...common, `--port=${port}`, `--profile=${profile}`],
    { encoding: 'utf8' })
  const jsonPath = join(armDir, 'framing-probe.json')
  if (!existsSync(jsonPath)) {
    console.log(`${label} produced no json (exit ${p.status}) — instrument invalid or the page did not mount`)
    results.push({ arm, status: 'no-result' })
    continue
  }
  const d = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const fails = d.verdicts.filter((v) => v.status === 'fail').map((v) => `${v.criterion} / ${v.name}`)
  const ok = arm.expectFails(fails)
  results.push({ arm, status: ok ? 'ok' : 'WRONG-OUTCOME', fails, counts: d.counts, exit: d.exitCode })

  console.log(`${label} ${ok ? 'OK  ' : 'WRONG OUTCOME'}  exit=${d.exitCode} ` +
    `pass=${d.counts.pass} fail=${d.counts.fail} skip=${d.counts.skip}`)
  console.log(`${' '.repeat(label.length)}  expected: ${arm.expect}`)
  console.log(`${' '.repeat(label.length)}  actual FAILs (${fails.length}): ${fails.join(' ;; ') || 'none'}`)
}

const bad = results.filter((r) => r.status !== 'ok')
console.log('')
console.log(`=== JUDGE SELF-CHECK: ${results.length - bad.length}/${results.length} arms as expected ===`)
if (bad.length) {
  for (const b of bad) console.log(`  ${b.arm.id}: ${b.status}`)
  console.log('  The repair cannot be trusted as acceptance evidence until every arm lands.')
}
writeFileSync(join(OUT, 'selfcheck.json'), JSON.stringify({
  url: URL_, ranAt: new Date().toISOString(),
  arms: results.map((r) => ({ id: r.arm.id, status: r.status, expect: r.arm.expect, fails: r.fails || null })),
  verdict: bad.length === 0 ? 'all arms as expected' : `${bad.length} arm(s) did not land`,
}, null, 2))
process.exit(bad.length === 0 ? 0 : 1)
