/**
 * framing-probe-assets — the file-level half of criteria V7 and V8.
 *
 * Split from `framing-probe.mjs` because none of this needs a browser: it reads the
 * repository, the installed icon package and the shipped binaries. Keeping it
 * separate means the asset verdicts are reproducible without a Chrome session, and
 * the pixel half can stay focused on the pixels.
 *
 * V7  assets/brands/claude.svg must equal the lobehub `claude.svg` (normalised), must
 *     differ from `anthropic.svg` in silhouette, and no shipped source may reference
 *     an anthropic logo asset.
 *
 * V8  the background images must decode, be at least 2048 px wide, and carry the
 *     pixel statistics of a real photograph rather than a procedural field; the
 *     CREDITS file must state a checkable source and licence.
 *
 * Usage: node tools/framing-probe-assets.mjs [--repo=PATH] [--out=DIR]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/)
    return m ? [m[1], m[2] === '' ? 'true' : m[2]] : [a, 'true']
  })
)

const REPO = resolve(args.repo || join(HERE, '..'))
const FRONTEND = join(REPO, 'frontend')
const OUT = resolve(args.out || 'E:/Global-session/xiao-ui-redesign-20261009-194449/shots/framing-probe')
mkdirSync(OUT, { recursive: true })

const results = []
function record(criterion, name, pass, detail, evidence) {
  results.push({ criterion, name, pass, detail, evidence })
  const tag = pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${criterion} ${name} — ${detail}`)
  return pass
}

// ---------------------------------------------------------------------------
// V7 — the Claude mark, not the Anthropic one
// ---------------------------------------------------------------------------

/**
 * Normalise SVG text before comparing.
 *
 * A byte-for-byte comparison of two checkouts of the same asset is fragile in a way
 * that has nothing to do with the artwork: XML declaration, attribute order,
 * trailing newline and indentation are all free choices. What must match is the
 * drawing — the geometry, the fill rule, the viewBox — so those are what is compared.
 */
function normaliseSvg(text) {
  return text
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/>/g, '/>')
    .trim()
    .toLowerCase()
}

/** The drawing itself: every `d=` and the viewBox and fill-rule, sorted for order-independence. */
function geometryOf(text) {
  const dAttrs = [...text.matchAll(/\bd\s*=\s*"([^"]*)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
  const viewBox = (text.match(/viewBox\s*=\s*"([^"]*)"/) || [])[1] || ''
  const fillRule = (text.match(/fill-rule\s*=\s*"([^"]*)"/) || [])[1] || ''
  const ellipses = [...text.matchAll(/<ellipse[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' '))
  return { paths: dAttrs.slice().sort(), viewBox: viewBox.replace(/\s+/g, ' ').trim(), fillRule, ellipses: ellipses.sort() }
}

function checkV7() {
  console.log('\n=== CRITERION 5 — V7 the Claude logo, not Anthropic\'s ===')

  const brandDir = join(FRONTEND, 'src', 'features', 'home-particle', 'assets', 'brands')
  const claudePath = join(brandDir, 'claude.svg')
  const lobehubDir = join(FRONTEND, 'node_modules', '@lobehub', 'icons-static-svg', 'icons')
  const lobehubClaude = join(lobehubDir, 'claude.svg')
  const lobehubAnthropic = join(lobehubDir, 'anthropic.svg')

  if (!existsSync(claudePath)) {
    record('V7', 'claude.svg exists', false, `missing ${claudePath}`)
    return
  }
  record('V7', 'claude.svg exists', true, `${claudePath} (${statSync(claudePath).size} bytes)`)

  if (!existsSync(lobehubClaude)) {
    record('V7', 'lobehub reference present', false, `missing ${lobehubClaude} — cannot compare`)
    return
  }

  const shipped = readFileSync(claudePath, 'utf8')
  const reference = readFileSync(lobehubClaude, 'utf8')
  const bytesEqual = Buffer.compare(readFileSync(claudePath), readFileSync(lobehubClaude)) === 0
  const normEqual = normaliseSvg(shipped) === normaliseSvg(reference)
  const gShipped = geometryOf(shipped)
  const gRef = geometryOf(reference)
  const geometryEqual = JSON.stringify(gShipped) === JSON.stringify(gRef)

  record('V7', 'claude.svg == lobehub claude.svg (byte-identical)', bytesEqual,
    bytesEqual ? 'the raw bytes are identical' : 'bytes differ (normalised comparison still applies)',
    { shippedBytes: readFileSync(claudePath).length, referenceBytes: readFileSync(lobehubClaude).length })
  record('V7', 'claude.svg == lobehub claude.svg (normalised)', normEqual,
    normEqual ? 'normalised text is identical (whitespace/XML-declaration differences only)'
              : 'normalised text differs — this is a different drawing',
    { shippedLen: shipped.length, referenceLen: reference.length })
  record('V7', 'claude.svg == lobehub claude.svg (geometry)', geometryEqual,
    geometryEqual ? `${gShipped.paths.length} path(s), viewBox "${gShipped.viewBox}", fill-rule "${gShipped.fillRule}" identical`
                  : `geometry differs: shipped ${gShipped.paths.length} path(s) vs reference ${gRef.paths.length}`,
    { shipped: gShipped, reference: gRef })

  // The mark must be Claude's, not Anthropic's "A". Compared on geometry, and on the
  // viewBox region the paths actually occupy, which is what a silhouette test needs.
  if (existsSync(lobehubAnthropic)) {
    const anthropic = readFileSync(lobehubAnthropic, 'utf8')
    const gAnthropic = geometryOf(anthropic)
    const distinct = JSON.stringify(gShipped) !== JSON.stringify(gAnthropic)
    record('V7', 'silhouette differs from anthropic.svg', distinct,
      distinct
        ? `shipped paths != anthropic paths (shipped ${gShipped.paths[0].length} chars vs anthropic ${gAnthropic.paths.length} path(s))`
        : 'the shipped claude.svg is geometrically identical to anthropic.svg — wrong logo',
      { shippedPathPrefix: gShipped.paths.map((p) => p.slice(0, 60)), anthropicPathPrefix: gAnthropic.paths.map((p) => p.slice(0, 60)) })

    // A rasterised-silhouette comparison is done in the browser half, where a canvas
    // exists; here the geometric difference is confirmed and its magnitude noted.
    const shared = gShipped.paths.filter((p) => gAnthropic.paths.includes(p)).length
    record('V7', 'no shared path data with anthropic.svg', shared === 0,
      `${shared} shared path(s) of ${gShipped.paths.length} shipped and ${gAnthropic.paths.length} anthropic`)
  } else {
    record('V7', 'anthropic reference present for comparison', null,
      `no ${lobehubAnthropic} in the installed package — silhouette difference not checked here`)
  }

  // No shipped source may reference an anthropic LOGO asset. The search is over
  // explicit source directories rather than a recursive walk of the repo, which both
  // keeps it bounded and avoids descending into node_modules.
  const searchRoots = [
    join(FRONTEND, 'src', 'features', 'home-particle'),
    join(FRONTEND, 'src', 'views'),
    join(FRONTEND, 'src', 'components'),
    join(FRONTEND, 'public'),
  ]
  const hits = []
  const advisory = []
  const offLimits = ['node_modules', '.git', 'dist', 'coverage', '__tests__', '__mocks__']
  // A reference only matters when it could actually LOAD the asset: a quoted string,
  // an import, or a CSS `url()`. A bare mention inside a prose comment (the test suite
  // explains at length why `anthropic` is not in the roster) is not a reference, and
  // counting it would be a false positive that buries the real one.
  const refPattern = /(['"`])[^'"`]*anthropic[a-z0-9._/-]*\.svg[^'"`]*\1|url\(\s*['"]?[^)'"]*anthropic[^)'"]*['"]?\s*\)|from\s+['"][^'"]*anthropic[^'"]*['"]/gi
  function scan(dir, depth) {
    if (depth > 8 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (offLimits.includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { scan(p, depth + 1); continue }
      if (!/\.(svg|ts|tsx|vue|js|mjs|css|json|html)$/.test(e.name)) continue
      let text
      try { text = readFileSync(p, 'utf8') } catch { continue }
      const refs = [...text.matchAll(refPattern)].map((m) => m[0].trim())
      const assetRefs = [...text.matchAll(/assets\/(brands\/)?anthropic\b/gi)].map((m) => m[0])
      const all = [...new Set([...refs, ...assetRefs])]
      // `assets/brands/anthropic` is a path, not a comment, so it always counts.
      const real = all.filter((r) => !/^(?!.*\/).*anthropic\.svg$/i.test(r) || assetRefs.some((a) => r.includes(a)))
      if (real.length) hits.push({ file: p.replace(REPO, '<repo>'), refs: real })
      else if (all.length) advisory.push({ file: p.replace(REPO, '<repo>'), refs: all })
    }
  }
  for (const r of searchRoots) scan(r, 0)

  record('V7', 'no source references an anthropic logo asset', hits.length === 0,
    hits.length === 0
      ? `searched ${searchRoots.length} source roots (node_modules and test dirs excluded); no loadable anthropic logo reference`
      : `${hits.length} file(s) reference an anthropic logo asset`,
    { hits, advisory, searchedRoots: searchRoots })

  // The roster must actually list claude, and the brand dir must contain no
  // anthropic.svg that could be picked up by the `import.meta.glob`.
  const hasAnthropicAsset = existsSync(join(brandDir, 'anthropic.svg'))
  record('V7', 'no anthropic.svg in the brand roster directory', !hasAnthropicAsset,
    hasAnthropicAsset ? 'assets/brands/anthropic.svg exists and would be globbed into the roster'
                      : 'assets/brands/ holds no anthropic.svg')

  try {
    const constants = readFileSync(join(FRONTEND, 'src', 'features', 'home-particle', 'engine', 'constants.ts'), 'utf8')
    const hasClaude = /slug:\s*'claude'/.test(constants)
    const hasAnthropicSlug = /slug:\s*'anthropic'/.test(constants)
    record('V7', 'roster lists claude and not anthropic', hasClaude && !hasAnthropicSlug,
      `slug 'claude' present: ${hasClaude}; slug 'anthropic' present: ${hasAnthropicSlug}`)
  } catch (e) {
    record('V7', 'roster readable', false, String(e).slice(0, 120))
  }
}

// ---------------------------------------------------------------------------
// V8 — a real photograph of the sky
// ---------------------------------------------------------------------------

/**
 * Minimal WebP header read.
 *
 * Only the dimensions are needed here, and they live in the VP8/VP8L/VP8X chunk
 * header, so a full decode is unnecessary. The browser half decodes the pixels; this
 * half confirms the file is a real image of the required size, which is what makes a
 * 3 KB HTML error page (the dev server's SPA fallback for a bad asset URL) fail
 * loudly instead of silently.
 */
function readWebpSize(buf) {
  if (buf.length < 30) return { error: 'too short' }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return { error: 'not a RIFF/WEBP container' }
  }
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8 ') {
    // Lossy: a 3-byte frame tag at offset 20, then the 3-byte sync code 0x9d012a,
    // then the 14-bit width and height as little-endian 16-bit words.
    const off = 23
    if (buf[off] !== 0x9d || buf[off + 1] !== 0x01 || buf[off + 2] !== 0x2a) {
      return { error: `VP8 sync code missing (got ${buf.subarray(off, off + 3).toString('hex')})` }
    }
    const w = buf.readUInt16LE(off + 3) & 0x3fff
    const h = buf.readUInt16LE(off + 5) & 0x3fff
    return { fourcc, w, h }
  }
  if (fourcc === 'VP8L') {
    const b = buf.readUInt32LE(21)
    const w = (b & 0x3fff) + 1
    const h = ((b >> 14) & 0x3fff) + 1
    return { fourcc, w, h }
  }
  if (fourcc === 'VP8X') {
    const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
    const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
    return { fourcc, w, h }
  }
  return { error: 'unknown fourcc ' + fourcc }
}

function checkV8() {
  console.log('\n=== CRITERION 6 — V8 real photographic space background ===')

  const spaceDir = join(FRONTEND, 'src', 'features', 'home-particle', 'assets', 'space')
  const master = join(spaceDir, 'stars-milkyway.webp')
  const lite = join(spaceDir, 'stars-milkyway-lite.webp')
  const credits = join(spaceDir, 'CREDITS.md')

  for (const [name, p, minWidth] of [['master', master, 2048], ['lite', lite, 2048]]) {
    if (!existsSync(p)) {
      record('V8', `${name} exists`, false, `missing ${p}`)
      continue
    }
    const buf = readFileSync(p)
    const dim = readWebpSize(buf)
    const sizeOk = !dim.error && dim.w >= minWidth
    record('V8', `${name} decodes and is >= ${minWidth}px wide`, sizeOk,
      dim.error ? `header unreadable: ${dim.error}`
                : `${dim.fourcc} ${dim.w}x${dim.h}, ${buf.length} bytes` +
                  (dim.w < minWidth ? ` — below the ${minWidth}px floor` : ''),
      { path: p, bytes: buf.length, ...dim })
  }

  if (!existsSync(credits)) {
    record('V8', 'CREDITS.md exists', false, `missing ${credits}`)
    return
  }
  const text = readFileSync(credits, 'utf8')
  record('V8', 'CREDITS.md exists', true, `${credits} (${text.length} chars)`)

  // The credit must name a checkable source and a licence. Each field is asserted
  // separately so a missing licence cannot hide behind a present URL.
  const checks = [
    ['source URL present', /https?:\/\/\S+/.test(text), (text.match(/https?:\/\/\S+/) || ['none'])[0]],
    ['ESO source page cited', /eso\.org|eso\d{4}[a-z]/i.test(text), (text.match(/https?:\/\/\S*eso\S*/i) || ['none'])[0]],
    ['author credited', /S\.\s*Brunier|Serge Brunier/i.test(text), (text.match(/Brunier[^|\n]*/) || ['none'])[0]],
    ['CC BY 4.0 licence named', /CC BY 4\.0|Creative Commons Attribution 4\.0/i.test(text), 'CC BY 4.0'],
    ['licence URL present', /creativecommons\.org\/licenses\/by\/4\.0/.test(text), 'https://creativecommons.org/licenses/by/4.0/'],
    ['no procedurally generated claim', /procedural(ly)? generated|not.*procedural|Nothing here is\n?procedurally/i.test(text), 'text addresses provenance'],
  ]
  for (const [name, ok, ev] of checks) record('V8', `CREDITS ${name}`, ok, ok ? String(ev) : `not found in CREDITS.md`)

  // The claim in the credit file must match the file that actually shipped: the
  // processed resolution stated there is 4096x2048, and the header is authoritative.
  const buf = readFileSync(master)
  const dim = readWebpSize(buf)
  const stated = text.match(/(\d{3,5})\s*[×x]\s*(\d{3,5})/g) || []
  const match = !!dim.w && stated.some((s) => {
    const [a, b] = s.split(/[×x]/).map((v) => Number(v.trim()))
    return a === dim.w && b === dim.h
  })
  record('V8', 'CREDITS resolution matches the shipped file', match,
    `file is ${dim.w}x${dim.h}; CREDITS states ${stated.slice(0, 4).join(', ')}`,
    { file: { w: dim.w, h: dim.h }, stated })
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('framing-probe-assets')
console.log(`repo: ${REPO}`)
checkV7()
checkV8()

console.log('\n=== ASSET RESULTS ===')
const byCriterion = {}
for (const r of results) {
  byCriterion[r.criterion] = byCriterion[r.criterion] || []
  byCriterion[r.criterion].push(r)
}
for (const [k, rs] of Object.entries(byCriterion)) {
  const failed = rs.filter((r) => r.pass === false).length
  const passed = rs.filter((r) => r.pass === true).length
  console.log(`  ${k}: ${passed} pass, ${failed} fail`)
}
const totalFail = results.filter((r) => r.pass === false).length
console.log(`\n  ${totalFail === 0 ? 'ALL ASSET CHECKS PASSED' : totalFail + ' ASSET CHECK(S) FAILED'}`)
const jsonPath = join(OUT, 'framing-probe-assets.json')
writeFileSync(jsonPath, JSON.stringify({ repo: REPO, verdicts: results, exitCode: totalFail === 0 ? 0 : 1 }, null, 2))
console.log(`  json: ${jsonPath}`)
process.exit(totalFail === 0 ? 0 : 1)
