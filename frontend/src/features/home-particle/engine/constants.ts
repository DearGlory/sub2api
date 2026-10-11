/**
 * Sub2API particle home — FROZEN CONSTANTS.
 *
 * Do not edit. Every number here is either the user's own requirement (flagged
 * `[user]`) or derived from it; changing one without changing the spec breaks the
 * budget in HOME-PARTICLE-DESIGN.md §6.
 */
import type { BrandDescriptor } from './types'

// --- Choreography clock -----------------------------------------------------

/** [user] the glyph holds its shape for exactly 3 seconds. */
export const HOLD_SECONDS = 3.0
/** Comet -> glyph. */
export const GATHER_SECONDS = 1.4
/** Glyph -> comet. */
export const SCATTER_SECONDS = 1.1
/** One extreme of the S-curve to the other. */
export const LEG_SECONDS = 6.5
/** One full brand beat: 6.5 + 1.4 + 3.0 + 1.1. */
export const CYCLE_SECONDS =
  LEG_SECONDS + GATHER_SECONDS + HOLD_SECONDS + SCATTER_SECONDS

// --- Subject space ----------------------------------------------------------

/**
 * Half-width of the S-curve, in world units.
 *
 * [user] 图案不要太宽 — the patrol used to swing +/-9, which parks the widest
 * roster brand (16.479 world units wide) at x = +/-9 and pushes its far edge to
 * x = 17.24 while the V6 frame only reaches 10.51. 2.56 is the user's number and
 * it is what makes the widest brand fit the frame at all: 2.56 + 8.24 = 10.80
 * against a 10.51 half-width, the residual 0.29 being covered by the per-brand
 * uniform shrink in `brandTargets`/`glyphSize` rather than by moving the camera
 * further back (see `updateCameraFit` for why the margin cannot be spent here).
 */
export const AMPLITUDE_X = 2.56
/**
 * The `AMPLITUDE_X` the two sway amplitudes below were authored against.
 *
 * They were tuned as absolute lengths (1.6 and 2.2) for a 9.0 patrol, which is the
 * only setting for which they are right — see `SWAY_Y`.
 */
const SWAY_REFERENCE_AMPLITUDE_X = 9.0

/**
 * The S-curve's vertical sway, as a FRACTION of the patrol amplitude.
 *
 * `AMPLITUDE_X` was narrowed to 2.56 to satisfy V6 (the user's number, and the only
 * value that fits the widest roster brand into the frame). Leaving the sway at its
 * absolute 1.6/2.2 broke the tail: the emission axis is the head's *unit* velocity
 * (`axis = -v/|v|`, `fillEmissionTable`), so what aims the plume is the RATIO of the
 * along-path speed to the sway speed, not either one alone. Compressing x by 3.5x
 * while the sway held still turned the velocity from x-dominated into sway-dominated
 * — measured `mean |axis.z|` 0.212 -> 0.4455 (`frac |axis.z| > 0.5`: 0.000 -> 0.438),
 * cone half-angle 22.6 -> 35.3 deg, and 3D thickness/length 0.346 -> 0.633. On screen
 * the plume stopped reading as a slim jet and became a wide fan.
 *
 * Making both sways proportional keeps the S self-similar at every patrol width, and
 * that restores the axis direction EXACTLY rather than approximately: the whole
 * velocity vector scales by one constant, and a unit vector does not care. The tail's
 * own length is untouched either way — it comes from `V * life * (1 - TAIL_ENTRAIN)`
 * and never reads the head's speed.
 *
 * A happy side effect: the sweep is now more nearly lateral, which is what the user
 * described ("达到最左或最右点散开组成图案") — the glyph assembles at the horizontal
 * extremes, not at a diagonal corner.
 */
export const SWAY_Y = 1.6 * (AMPLITUDE_X / SWAY_REFERENCE_AMPLITUDE_X)
/**
 * Depth sway so the S is not flat. Proportional to `AMPLITUDE_X` for the reason
 * spelled out on `SWAY_Y` — an absolute depth here is what tilted the emission axis
 * out of the screen plane.
 */
export const SWAY_Z = 2.2 * (AMPLITUDE_X / SWAY_REFERENCE_AMPLITUDE_X)
/** The particle slab sits this far behind the origin, giving the starfield room. */
export const SUBJECT_Z = -6.0

// --- Camera dolly -----------------------------------------------------------

export const CAMERA_FOV = 44
export const DOLLY_FROM_Z = 15.0
export const DOLLY_TO_Z = 34.0
/** Seconds to travel from `DOLLY_FROM_Z` to `DOLLY_TO_Z`. */
export const DOLLY_PERIOD_SECONDS = 150
/** Eased wrap back to the start; the starfield recycles stars to hide the reset. */
export const DOLLY_WRAP_SECONDS = 2.2
export const CAMERA_NEAR = 0.1
export const CAMERA_FAR = 900

// --- Comet tail -------------------------------------------------------------

/**
 * How far back in time the tail may look for material.
 *
 * This is a *search window*, not the tail's length. Under V2 it is the depth of the
 * emission lookup table: `writeEmissionLut()` walks this much of the head's past and
 * bakes one (position, velocity) pair per probe. It has to exceed the longest
 * particle life (2.75 s) or a particle old enough to be nearly faded out would index
 * past the end of the table and have its birth frame clamped onto a fresher point,
 * which would snap its whole column of the plume sideways.
 *
 * The 0.45 s of headroom over the 2.75 s maximum life is 16% of the window, which
 * costs `TAIL_PROBE_COUNT` probes' worth of nothing (they are already allocated) and
 * buys the clamp being unreachable in normal travel.
 */
export const TAIL_SECONDS = 3.2
/**
 * The plume's nominal length, in world units.
 *
 * Under V2 this is no longer the length of anything the engine measures — the tail is
 * a spray of particles, and its visible extent emerges from `TAIL_DUST_REACH_*` times
 * how the fade eats the far end. It survives as the **reference length** that the
 * cone's taper and the test suite's aspect check are expressed against, and its value
 * is still the right one for the job: 13 units against the leg's 18 puts the plume at
 * about three quarters of a leg, long enough to lead the eye and short enough to
 * leave the glyph its own space.
 *
 * What the arc-length machinery used to buy with this number is now bought
 * physically. The old tail had to be laid out by arc length because the head eases
 * into each extreme (`(1 - cos(pi*p))/2`), so a time-keyed tail stretched to ~14
 * units mid-leg and collapsed at the ends — exactly backwards, and it read as rings
 * of concentric ellipses. A particle that inherits its birth-time head velocity gets
 * the same immunity for free, and gets a plume that is *emitted* rather than
 * translated, which is what the user asked for.
 */
export const TAIL_LENGTH = 13.0
/**
 * Base radius of the plume at the nucleus, in world units.
 *
 * Unchanged by the V2 emission rewrite, and deliberately so: the nucleus is the one
 * part of the comet the user has never asked to be smaller.
 */
export const TAIL_RADIUS = 0.42
/**
 * `sin(theta_max)` of the DUST ejection cone — how wide the spray opens.
 *
 * This is no longer a taper rate. Under V2 the tail is not a ribbon of fixed arc
 * length that widens with distance along it; it is a spray of particles each flying
 * its own straight line, so the tip radius now falls out of how far a particle
 * actually gets:
 *
 *     r_tip = TAIL_RADIUS + TAIL_SPREAD * TAIL_DUST_REACH_MAX
 *           = 0.42 + 0.215 * 13.0
 *           = 3.21 world units
 *
 * which the numeric model measures as a 90th-percentile cross-section half-width that
 * rises from 0.56 units at the nucleus to 3.55 at the point where 98% of the tail's
 * light has been passed — so the cone visibly opens across its whole length and its
 * tip lands inside the required 2.5-4.0 window. The median half-width over the same
 * span runs 0.39 to 1.93, so the plume keeps a dense spine rather than becoming a
 * cylinder: a cone with a core, which is the whole visual brief.
 *
 * Both ends of this value's history are wrong and worth not repeating. At `1.15` the
 * cone was so wide it read as a fog bank with no axis; at `0.123` the tail was
 * legible but the comet was a needle, which is the complaint this rewrite answers —
 * "你知道我喜欢大直径的，你怎么变小了？". 0.215 is the middle: a cone you can
 * watch open, on a comet with mass.
 */
export const TAIL_SPREAD = 0.215
/** Share of particles packed into the bright head core. */
export const HEAD_CORE_SHARE = 0.18
/**
 * Radius of the ball the head-core particles fill, in world units.
 *
 * Core particles all sit at zero arc length, which is one exact point on the
 * path. Left as a point they draw a flat disc, and the comet's leading face reads
 * as a machined cut instead of a nose; this spreads them through a ball around
 * that point. Kept above `TAIL_RADIUS` so the head is the widest part of the
 * cloud, which is what makes it read as a coma the tail streams out of.
 */
export const HEAD_CORE_RADIUS = 0.62
/**
 * How far forward of the path point the core ball's centre sits, as a fraction of
 * `HEAD_CORE_RADIUS`.
 *
 * Without this the ball is centred exactly on the newest point on the path, so its
 * forward half is the only thing ahead of the tail and the boundary between them
 * lands on a plane through that centre — which reads as a blunt, sliced face. Bias
 * forward and the leading surface becomes convex, i.e. a nose.
 */
export const HEAD_CORE_LEAD = 0.45
/**
 * How many points along the past path are sampled before the tail is resampled.
 *
 * The tail is built by walking the path at uniform time and then redistributing
 * those samples to uniform arc length, so this is the resolution of that first
 * walk, not the number of particles or of tail segments. It only has to be dense
 * enough that the arc-length integral is accurate; `QualityProfile.tailSampleCount`
 * is the count that actually reaches the particles.
 */
export const TAIL_PROBE_COUNT = 192

// --- Interaction ------------------------------------------------------------

/** [user] pointer interaction, matched to GloryCode's feel. */
export const POINTER_RADIUS = 1.25
export const FRICTION = 0.872

// --- Quality ladder ---------------------------------------------------------

export const BASE_PARTICLE_COUNT = 18000
export const ADAPTIVE_PARTICLE_COUNT = 11000
export const MIN_PARTICLE_COUNT = 5000
export const LOW_DPR = 1.0
export const MAX_DPR = 1.5
export const BASE_STAR_COUNT = 2600

/** Identity of the frozen vendor sampler, restated for the data lane. */
export const VENDOR_ICON_WORLD_SIZE = 12.6
export const VENDOR_ICON_CANVAS_SIZE = 760

// --- Brand roster -----------------------------------------------------------

/**
 * [user] the 12 named vendors first (in the order asked for), then 16 more by
 * API share and recognition. `slug` must match `assets/brands/<slug>.svg`.
 * Order here is the on-screen order.
 */
export const BRANDS: BrandDescriptor[] = [
  // asked for by name
  { slug: 'openai', label: 'OpenAI' },
  // [user] Claude's own mark, not Anthropic's "A" wordmark. The vendor behind the
  // model is Anthropic, but the logo the user asked to see is Claude's, so the
  // asset is `claude.svg` and the label reads "Claude" — the same distinction
  // GloryCode's own front end draws.
  { slug: 'claude', label: 'Claude' },
  { slug: 'gemini', label: 'Gemini' },
  { slug: 'grok', label: 'Grok' },
  { slug: 'deepseek', label: 'DeepSeek' },
  { slug: 'zai', label: 'Z.ai' },
  { slug: 'kimi', label: 'Kimi' },
  { slug: 'minimax', label: 'MiniMax' },
  { slug: 'xiaomimimo', label: 'Xiaomi MiMo' },
  { slug: 'qwen', label: 'Qwen' },
  { slug: 'bytedance', label: 'ByteDance' },
  { slug: 'meta', label: 'Meta' },
  // added by reach
  { slug: 'mistral', label: 'Mistral' },
  { slug: 'perplexity', label: 'Perplexity' },
  { slug: 'cohere', label: 'Cohere' },
  { slug: 'nvidia', label: 'NVIDIA' },
  { slug: 'groq', label: 'Groq' },
  { slug: 'openrouter', label: 'OpenRouter' },
  { slug: 'hunyuan', label: 'Hunyuan' },
  { slug: 'spark', label: 'Spark' },
  { slug: 'stepfun', label: 'StepFun' },
  { slug: 'baichuan', label: 'Baichuan' },
  { slug: 'yi', label: 'Yi' },
  { slug: 'kling', label: 'Kling' },
  { slug: 'midjourney', label: 'Midjourney' },
  { slug: 'stability', label: 'Stability AI' },
  { slug: 'luma', label: 'Luma AI' },
  { slug: 'suno', label: 'Suno' },
]

// --- Tail emission (V2) -----------------------------------------------------
//
// The tail is no longer a ribbon of particles pinned to fixed arc-length slots on a
// rigid lookup table. That model was rejected: because every particle took a *fixed*
// position along the past path, the whole tail was one rigid body translated through
// the scene, and the user read it as a cloud, not as a comet — "彗星和彗尾看不出来
// 是什么东西…完全没有彗星的真实感".
//
// V2 emits. A particle is born inside the nucleus, is given a velocity, lives for a
// while, and fades to nothing as its life runs out. Its position is a closed form
// that the engine evaluates every frame with no accumulation drift:
//
//     p(age) = head(t_birth) + headVelocity(t_birth) * age * ENTAIN
//            + backwardCone(theta, phi) * reach * (age / life)
//
// The `headVelocity * ENTAIN` term is the load-bearing one and is easy to get
// backwards. Without it, a particle is left behind by a head that is still moving, so
// the plume's visible length becomes (head travel during `life`) + reach — it
// stretches to ~15 units mid-leg and collapses to ~7 at the extremes, which is the
// same defect the old arc-length pass existed to patch, back again in new clothes.
// Inheriting part of the birth velocity makes the two cancel, and the visible length
// settles to 12.5-14.5 units across the whole leg.
//
// ENTAIN is 0.25 rather than 1.0 on purpose. Full inheritance is what a comet's dust
// physically does, but the head here swings at up to 5.0 u/s through an S-curve, and a
// fully-entrained plume smears tangent to that curve until it loses the cone. A
// quarter keeps the length stable while leaving the cone readable; the numbers below
// are the measured consequence, not a guess.

/**
 * Longest a tail particle may live, in seconds.
 *
 * The fade is written against the *fraction* of life elapsed, so life is what decides
 * how far a particle can get and how much of the plume is mid-fade at any instant.
 * 2.75 s at the reach below is what puts the 1%-of-mass contour at 12.5-14.5 units.
 *
 * Lives are drawn per particle from [TAIL_DUST_LIFE_MIN, TAIL_DUST_LIFE_MAX] (or the
 * ion pair). Uniform, not constant: with one shared lifetime every particle would be
 * the same age and the plume would pulse as a whole — a single slab of cloud breathing
 * in and out. Uniform lifetimes decorrelate birth from death so there is always a
 * mixture of newborn, mid-life and dying particles, which is what the age histogram in
 * the acceptance data shows.
 *
 * Range chosen against the beat: the shortest life is 1.3 s, comfortably inside the
 * 6.5 s travel leg, so the plume reaches its steady-state mixture long before the head
 * arrives at an extreme and the gather begins.
 */
export const TAIL_DUST_LIFE_MIN = 1.3
export const TAIL_DUST_LIFE_MAX = 2.55
/** Ion lives. Longer than dust, so the straight blue tail outlives the curving one. */
export const TAIL_ION_LIFE_MIN = 1.4
export const TAIL_ION_LIFE_MAX = 2.75

/**
 * How far, in world units, a dust particle travels along its own birth axis over its
 * own lifetime — the plume's effective length, independent of `life`.
 *
 * Stated as a reach rather than as a speed because a speed would silently re-couple
 * length to lifetime: a particle that happens to draw a long life would also fly
 * further, and the far end of the plume would be built only out of long-lived
 * particles, which is a visible stratification. The engine divides reach by life to
 * recover the speed, so every particle covers its own reach and the fade edge stays
 * statistically sharp.
 *
 * The spread across [min, max] is what gives the taper its softness. If every particle
 * reached exactly the same distance, the end of the tail would be a flat wall that
 * pops out of existence; a 7.5-13.0 spread means the near edge of the fade is built
 * from short-reach particles while long ones still reach further out.
 */
export const TAIL_DUST_REACH_MIN = 7.5
export const TAIL_DUST_REACH_MAX = 13.0
/** Ion reach. Further than dust, so the straight tail overhangs the curved one. */
export const TAIL_ION_REACH_MIN = 9.6
export const TAIL_ION_REACH_MAX = 15.1

/**
 * The share of tail particles that are ion (straight, narrow) rather than dust
 * (curved, wide). One constant rather than a colour split, because at this particle
 * size and point count the two populations read only as *geometry* — the blue/yellow
 * distinction the brief mentions needs per-particle hue, which `integrate()` does not
 * currently carry.
 */
export const TAIL_ION_SHARE = 0.34

/**
 * A tail particle's ejection angle, as `sin(theta) = TAIL_SPREAD * u ^ TAIL_FILL`,
 * where `u` is a decorrelated 0..1 roll.
 *
 * `TAIL_FILL` is what decides whether the cone has a spine. A uniform roll in
 * `sin(theta)` shells the cone: most particles land at large angles and the tail reads
 * as a stack of concentric outlines. An exponent above 1 crowds the angles toward the
 * axis, which is where a comet is dense, and a handful of wide-angle particles keep the
 * envelope visible — a bright core inside a thinning plume, which is the shape the
 * brief asks for.
 *
 * 1.45 is measured, not stylistic: it holds the median cross-section half-width at
 * 0.39-1.93 units along the tail while the 90th percentile reaches 3.55, and it keeps
 * that relationship at every point along the leg.
 */
export const TAIL_FILL = 1.45

/**
 * How much of the ion particles' cone width the dust cone gets, as a multiplier.
 *
 * Real comets have two tails for one reason: dust is heavy and curves, ions are light
 * and follow the field. At this resolution the honest way to show that without a second
 * physics term is width alone, so the ion population gets a narrower cone (0.55x) than
 * the dust one and the dust population's own spread carries the plume's envelope.
 */
export const TAIL_ION_NARROW = 0.55

/**
 * Per-particle speed jitter, as a fraction of the nominal speed.
 *
 * Without it every particle of one class reaches exactly the same distance at the same
 * age, and the fade edge draws a mathematically perfect disc — the eye catches that
 * immediately as artificial. 10% breaks the coincidence without changing the envelope.
 */
export const TAIL_SPEED_JITTER = 0.1

/**
 * Fraction of the birth-time head velocity a particle keeps, in [0, 1].
 *
 * `TAIL_ENTRAIN` is what decouples the plume's visible length from the head's speed.
 * Measured across the leg: at `0.0` the 1%-of-light contour swings 7.0-15.0 units as
 * the head accelerates out of each extreme; at the shipped `0.25` it holds at
 * 11.0-15.0 with the cone intact. It is deliberately not `1.0` — full inheritance is
 * what a comet's dust physically does, but the head here swings at up to 5.0 u/s
 * through an S-curve and a fully-entrained plume smears tangent to that curve until it
 * loses the cone.
 */
export const TAIL_ENTRAIN = 0.25

/**
 * Lifetime falloff exponent: brightness is `(1 - u) ^ TAIL_FADE_POWER`.
 *
 * The user's requirement is explicit — "达到一定距离后渐变消失", fade out after a
 * distance, not vanish. This is that fade, and it is *exactly* zero at `u = 1` by
 * construction rather than approximately zero, so a recycled particle cannot pop.
 *
 * Below 1 the profile starts decaying immediately and steeply near birth, which reads
 * as material that is already cooling as it leaves; at 1.0 it holds brightness and then
 * drops late, which reads as a hard-edged band. 0.6 measures to a smooth monotone
 * decline from 4.7% of the tail's light per unit at the nucleus down to 0.03% at 18
 * units, which is the profile the acceptance data reports.
 */
export const TAIL_FADE_POWER = 0.6
