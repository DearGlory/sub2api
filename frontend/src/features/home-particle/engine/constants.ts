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

/** Half-width of the S-curve, in world units. */
export const AMPLITUDE_X = 9.0
/** Vertical sway amplitude, which is what makes the sweep read as an S. */
export const SWAY_Y = 1.6
/** Depth sway so the S is not flat. */
export const SWAY_Z = 2.2
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
 * This is a *search window*, not the tail's length. The tail's length is
 * `TAIL_LENGTH`, in world units; see the note on it for why the two are not the
 * same number.
 */
export const TAIL_SECONDS = 3.2
/**
 * The tail's actual length, in world units of arc along the flight path.
 *
 * Distance, not time, and that distinction is the whole reason the comet reads as
 * a comet. The head's speed is not constant: `sampleHeadPosition` eases the sweep
 * with `(1 - cos(pi*p))/2` so the comet decelerates into each extreme and
 * accelerates back out. Laying the tail out at uniform *time* steps therefore ties
 * its length to the head's speed — the tail stretched to ~14 units mid-leg and
 * collapsed to nothing as the comet arrived, which is exactly backwards from a
 * comet and made the cloud read as a ring of concentric ellipses at the ends. A
 * fixed arc length keeps the streak the same size all the way down the leg.
 *
 * 13 units against the leg's 18 puts the tail at about three quarters of a leg,
 * long enough to lead the eye and short enough to leave the glyph its own space.
 */
export const TAIL_LENGTH = 13.0
/** Base radius of the tail cone at zero delay. */
export const TAIL_RADIUS = 0.42
/**
 * Radius at the tip, as a fraction of `TAIL_LENGTH`.
 *
 * Together with `TAIL_LENGTH` this sets the cone's aspect ratio, which is the
 * other half of "does this look like a comet". The tip radius works out to
 * `TAIL_RADIUS + TAIL_SPREAD * TAIL_LENGTH` ≈ 2.0, i.e. 4 units across against 13
 * long — a 3.3:1 streak. The earlier time-keyed value gave under 2:1 at the
 * fastest point of the leg and far worse at the ends, which is a blob.
 */
export const TAIL_SPREAD = 0.123
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
