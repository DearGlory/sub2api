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

/** How far back in time the tail reaches. */
export const TAIL_SECONDS = 2.6
/** Lateral spread per second of delay. */
export const TAIL_SPREAD = 1.15
/** Base radius of the tail cone at zero delay. */
export const TAIL_RADIUS = 0.42
/** Share of particles packed into the bright head core. */
export const HEAD_CORE_SHARE = 0.18

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
  { slug: 'anthropic', label: 'Anthropic' },
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
