# Space pursuit acceptance

Reads the live dev engine; does not import the space-motion algorithm. Use native Windows paths and `command node` under this MSYS shell. Launches its own headless Chrome with a dedicated profile and closes it in finally. An occupied CDP port is rejected.

Run from the judge worktree:

    command node tools/space-pursuit-probe.mjs --url http://127.0.0.1:5210/ --out E:/Global-session/xiao-20261012-231246/evidence/judge/new-target --port 10231 --record-seconds 38

Mixed integration steps:

    command node tools/space-pursuit-probe.mjs --url http://127.0.0.1:5210/ --out E:/Global-session/xiao-20261012-231246/evidence/judge/new-target-mixed --port 10232 --dt 0.013,0.021,0.009,0.033 --record-seconds 38

Checker controls (round baseline must exist):

    command node tools/space-pursuit-selfcheck.mjs E:/Global-session/xiao-20261012-231246/evidence/judge/controls.json

Options: --url, --out, --port, --profile, --chrome, --width, --height, --dt (comma-separated seconds, <=.1), --record-seconds. Use a new --out per run; files in that directory are overwritten. Defaults are 1440x900 and the round's evidence/judge/chrome/<port> profile.

Status/exit: pass=0, fail=1, instrument-invalid=2, skip=3. Missing recording is a required skip; a measured failure remains fail. Instrument failure takes precedence, while individual checks preserve their status. Missing production dev handle returns instrument-invalid; no inferred geometry fallback.

Sources: state.headX/Y/Z transformed by points.matrixWorld; actual glyphTargets and geometry.position transformed by the same matrix; camera.matrixWorld. Actual WebGL buffers are compared with position3/color4/cometScale CPU arrays, and linked shader source is compared with a stock PointsMaterial clone. Point-size customization cannot be described as vertex-center displacement. Every flight particle position minus its actual body offset is checked against the measured head, with 1e-4 Float32 allowance. This is a geometry cross-check, not a substitute curve.

Gather/hold/early scatter world anchors freeze at 1e-5. Hold is 3 seconds. Four consecutive flights, matching X/Z movement support, alternating departure direction, +Z camera, fitGap ±.08, and the old 150/152.2 boundary are checked. World glyph bbox size is fixed and both projected dimensions must shrink >=10%. No old constant-gap framing gate is inherited. Nonweighted final geometry bbox is a secondary check; internal particle flow does not define the reference center.

The numerical run stops native ticking in this disposable browser and calls the real update methods in their normal order. It samples at .1s, adds phase-boundary checkpoints, advances all intervening integration steps, and uses clock-only steps for the late camera boundary. Screenshots use frozen same-phase, same-brand hold endpoints; green crosses are glyph anchors, magenta crosses are actual final geometry. Original PNGs remain unmodified.

Tail evidence observes actual births (age zero), birthTime, birthPosition, final position, world velocity, actual emission-table axis and surviving world inertia. Source snapshots before/after and actual loaded Network response bodies bind the run to the served implementation.

--record-seconds 38 reloads the page, records native rAF/longtasks, captures the isolated canvas stream and full-page compositor video. It needs ffmpeg on PATH. Recordings include capture overhead; encoded 30fps is not the display refresh rate. The parent owns light/dark/mobile matrix, production visual review and implementation test/build gates.

selfcheck uses clearly labeled synthetic checker fixtures and the actual old baseline. It rejects model-only source, head/geometry mismatch, constant gap, each single-axis escape, short hold, camera rollback, mid-leg reversal, different-logo pairing, 9% shrink, .081 capture overshoot and GPU mismatch. These controls are not browser acceptance or proof that production can pass. No production code is modified for a positive control.
