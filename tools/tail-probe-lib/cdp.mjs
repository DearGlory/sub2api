/**
 * Chrome launch + CDP plumbing. Lifted in shape from tools/sky-bg-probe.mjs and
 * tools/beat-probe.mjs, which are known to work on this machine.
 *
 * Two things about this host that the code below depends on:
 *   - Chrome's screenshot is taken from the compositor, NOT from canvas.readPixels.
 *     Without `preserveDrawingBuffer` a WebGL canvas reads back black after the
 *     frame, so a probe that inspects the canvas directly reports "everything green,
 *     nothing rendered". Page.captureScreenshot contains what the user sees.
 *   - The default `--headless=new` profile needs a unique user-data-dir per debug
 *     port, or two probes fight over the same one.
 */
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function connect(port, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension'))
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch (e) { /* not up yet */ }
    await sleep(400)
  }
  throw new Error('no page target on port ' + port + ' after ' + (tries * 400 / 1000).toFixed(0) + ' s')
}

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) rej(new Error(JSON.stringify(m.error)))
        else res(m.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error('CDP timeout: ' + method))
        }
      }, 240000)
      if (timer.unref) timer.unref()
    })
  }

  async eval(expression, timeoutMs = 240000) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description
      return { __error: String(d || r.exceptionDetails.text || 'evaluate threw').slice(0, 2000) }
    }
    return r.result && r.result.value
  }

  /** A PNG screenshot, base64, straight from the compositor. */
  async shot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return data
  }
}

/**
 * Freeze / resume the scene from inside the page, and probe liveness.
 *
 * WHY NOT CDP VIRTUAL TIME — measured, not assumed:
 *
 * `Emulation.setVirtualTimePolicy({policy: 'pause'})` does stop the scene, and the probe
 * used it first. But it also stops `setTimeout`, so no liveness probe written in the page
 * can ever return: a "do five rAF callbacks fire?" expression hangs and the CDP call times
 * out. Worse, the clock could not reliably be restarted, so the frame-recording stage hung
 * too and the run died on a timeout instead of reporting a result.
 *
 * `requestAnimationFrame` is replaced with a QUEUE that records callbacks instead of
 * running them. The engine's whole animation hangs off rAF, so this stops it with no
 * protocol involvement, and the compositor keeps the last frame — so the screenshot taken
 * while frozen still shows the comet. `freezeAndSettle` below is the settled version;
 * read its comment for the two broken attempts that preceded it.
 *
 * The claims above are checked by the probe on every run rather than asserted here: rAF
 * fires 5 times in 2 s normally and 0 times while frozen, and the queue is released in
 * order on resume so the engine's own `tick` chain continues.
 */
/** Install the freeze stub. Keep any queue already there. */
export const FREEZE_RAF = `(() => {
  if (!window.__TP_RAF_ORIG) window.__TP_RAF_ORIG = window.requestAnimationFrame;
  if (!window.__TP_RAF_QUEUE) window.__TP_RAF_QUEUE = [];
  window.requestAnimationFrame = function (cb) { window.__TP_RAF_QUEUE.push(cb); return 0; };
  window.__TP_FROZEN = true;
  return true;
})()`

/** How many callbacks the stub is holding. One is expected: the engine's next tick. */
export const RAF_QUEUED = `(() => (window.__TP_RAF_QUEUE || []).length)()`

/**
 * Freeze the scene and WAIT for it to settle, then hand it back ready to measure.
 *
 * Three attempts, and the two failures are the reason this is a wait rather than a pump:
 *
 *   DRAIN IMMEDIATELY. Measured 0 callbacks drained, every time. The engine's next frame is
 *   a NATIVE rAF callback already in flight when the stub is installed; it fires a few
 *   milliseconds later, runs one more update and repaint, and only then does its
 *   re-schedule land in the queue. So the geometry read from frame N and the screenshot
 *   from frame N+1 disagreed by ~3 px of comet travel — measured nucleus (1031.3,390.7) ->
 *   (1029.1,391.7) — and the plume peak swung from 1.7 to 88 across moments that were
 *   supposed to be the same measurement.
 *
 *   DRAIN REPEATEDLY UNTIL QUIET. Stable, but it never converged: 64 drains in 2 s with the
 *   loop still going, because DRAINING RUNS THE ENGINE and the engine's tick re-queues
 *   itself. Quiet could never arrive.
 *
 *   WAIT (this one). Install the stub, wait ~200 ms of real time. The in-flight native
 *   callback fires on its own and leaves the engine's next tick sitting unrun in the queue,
 *   so the scene stops WITHOUT anything being executed. Measured over 12 frozen frames
 *   spanning travel, gather and hold: geometry identical, phase progress identical, and the
 *   two screenshots byte-identical, 12/12.
 *
 * Returns the queue depth, which the caller reports: exactly one pending callback is the
 * signature of a correctly settled freeze.
 */
export async function freezeAndSettle(cdp, sleep, quietMs) {
  await cdp.eval(FREEZE_RAF)
  const wait = quietMs === undefined ? 220 : quietMs
  await sleep(wait)
  const queued = await cdp.eval(RAF_QUEUED)
  return { queued, waitedMs: wait }
}

/**
 * Release the queued callbacks in order. Two earlier stubs are recorded here because both
 * failed and the reason is the same: the engine's `tick` schedules the next frame at its
 * TOP, so whatever it hands over is the ONLY thing keeping the loop alive.
 *
 *   - a plain no-op          -> on resume nothing is pending and the loop never restarts
 *   - a single-slot stub     -> the engine's pending callback is displaced by whoever
 *                               schedules next (the probe's own liveness check does), so
 *                               the loop dies the same way; measured as a phase progress
 *                               frozen at 0.0938 across 30 consecutive scopes
 *
 * A QUEUE fixes it: nothing can be displaced, and resume hands every callback back in the
 * order it arrived.
 */
export const RESUME_RAF = `(() => {
  if (!window.__TP_RAF_ORIG) return false;
  var orig = window.__TP_RAF_ORIG;
  var q = window.__TP_RAF_QUEUE || [];
  window.__TP_RAF_QUEUE = [];
  window.requestAnimationFrame = orig;
  window.__TP_FROZEN = false;
  for (var i = 0; i < q.length; i++) {
    (function (cb) { orig(function (t) { cb(t); }); })(q[i]);
  }
  return true;
})()`

/**
 * Ask the page whether rAF fires. Resolves EITHER WAY within ~2 s of real time, so it
 * cannot hang the probe the way the virtual-time version did.
 */
export const RAF_LIVE = `new Promise(function (res) {
  var n = 0, done = false;
  var fin = function (v) { if (!done) { done = true; res(v); } };
  var tick = function () {
    n++;
    if (n >= 5) return fin({ fired: n, stalled: false });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(function () { fin({ fired: n, stalled: true }); }, 2000);
})`

export function launchChrome({ port, profile, chrome, w, h, reducedMotion, extra = [] }) {
  const argv = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--disable-gpu-sandbox',
    '--window-size=' + w + ',' + h,
    ...extra,
  ]
  if (reducedMotion) argv.unshift('--force-prefers-reduced-motion')
  argv.push('about:blank')
  return spawn(chrome, argv, { stdio: 'ignore' })
}

export { sleep }
