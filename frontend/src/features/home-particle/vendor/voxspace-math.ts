/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

export type VoxSpacePhase = 'explode' | 'collapse' | 'hold'

export const VOXSPACE_INITIAL_MODEL_INDEX = 0

const INITIAL_CORE_HOLD_PHASE_SHARE = 0.06
const INITIAL_EXPLOSION_PHASE_SHARE = 0.25
const INITIAL_ROUND_CORE_RADIUS = 2.18
export const INITIAL_ROUNDING_PHASE_SHARE = 0.42
const INITIAL_COLLAPSED_DOT_RADIUS = 0.006
const EXPLOSION_PHASE_SHARE = 0.34
export const ICON_CENTER_X = 5.8
const INITIAL_SCATTER_X_RADIUS = 7.35
const INITIAL_SCATTER_Y_RADIUS = 7.35
const INITIAL_SCATTER_Z_RADIUS = 3.1

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function smootherStep(value: number) {
  const x = clamp01(value)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

// The animation timeline is the renderer's elapsed time minus the seconds the
// tab spent hidden. requestAnimationFrame is frozen while a tab is hidden, so the
// first frame after the tab comes back carries the whole hidden duration and
// would otherwise jump the animation into a later phase. Subtracting that gap is
// the only thing the hidden time changes: while the tab is visible the timeline
// is exactly the renderer's elapsed time, so the normal foreground clock (its
// trajectory and its initial phase) is left untouched.
export function voxSpaceAnimationTime(
  rawElapsedSeconds: number,
  hiddenSeconds: number
): number {
  return rawElapsedSeconds - hiddenSeconds
}

// Tracks how much of the renderer clock belongs to hidden periods. The first
// frame after a hidden period carries the whole gap, so that frame's delta is the
// gap and nothing else: it is added here and then subtracted again by
// voxSpaceAnimationTime, which keeps the hidden period out of the timeline. Every
// other frame leaves the total untouched.
export function nextVoxSpaceHiddenSeconds(
  hiddenSeconds: number,
  rawElapsedSeconds: number,
  previousRawElapsedSeconds: number | null,
  resumedFromHidden: boolean
): number {
  if (!resumedFromHidden || previousRawElapsedSeconds === null) {
    return hiddenSeconds
  }

  return (
    hiddenSeconds + Math.max(0, rawElapsedSeconds - previousRawElapsedSeconds)
  )
}

export function voxSpaceEaseExplosion(value: number) {
  const x = clamp01(value)
  return 1 - Math.pow(1 - x, 4)
}

export function voxSpaceEaseTransitionExplosion(value: number) {
  const x = smootherStep(value)
  return 1 - Math.pow(1 - x, 4)
}

function seededFraction(value: number) {
  const seeded = Math.sin(value) * 43758.5453123
  return seeded - Math.floor(seeded)
}

function getSeededSphereVector(x: number, y: number, z: number) {
  const sourceX = (x - ICON_CENTER_X) / INITIAL_SCATTER_X_RADIUS
  const sourceY = y / INITIAL_SCATTER_Y_RADIUS
  const sourceZ = z / INITIAL_SCATTER_Z_RADIUS
  const sourceLength = Math.sqrt(
    sourceX * sourceX + sourceY * sourceY + sourceZ * sourceZ
  )
  const seedBase = x * 12.9898 + y * 78.233 + z * 37.719
  const randA = seededFraction(seedBase + 11.17)
  const randB = seededFraction(seedBase * 1.731 + 47.39)
  const randC = seededFraction(seedBase * 2.173 + 91.71)
  const theta = randA * Math.PI * 2
  const phi = Math.acos(2 * randB - 1)
  const shell = Math.sin(phi)
  const turbulence = 0.08
  const baseX = sourceLength > 0.001 ? sourceX / sourceLength : 0
  const baseY = sourceLength > 0.001 ? sourceY / sourceLength : 0
  const baseZ = sourceLength > 0.001 ? sourceZ / sourceLength : 0
  const noiseX = Math.cos(theta) * shell
  const noiseY = Math.sin(theta) * shell
  const noiseZ = Math.cos(phi)
  const mixedX = baseX * (1 - turbulence) + noiseX * turbulence
  const mixedY = baseY * (1 - turbulence) + noiseY * turbulence
  const mixedZ = baseZ * (1 - turbulence) + noiseZ * turbulence
  const mixedLength = Math.max(
    0.001,
    Math.sqrt(mixedX * mixedX + mixedY * mixedY + mixedZ * mixedZ)
  )

  return {
    x: mixedX / mixedLength,
    y: mixedY / mixedLength,
    z: mixedZ / mixedLength,
    radiusSeed: Math.min(1, sourceLength * 0.72 + randC * 0.28),
  }
}

export function getVoxSpaceCollapsedCorePoint(
  x: number,
  y: number,
  z: number,
  implosion: number
) {
  const gravity = clamp01(implosion)
  const roundProgress = smootherStep(gravity / INITIAL_ROUNDING_PHASE_SHARE)
  const dotProgress = smootherStep(gravity)
  const sphereVector = getSeededSphereVector(x, y, z)
  const roundRadius =
    INITIAL_ROUND_CORE_RADIUS * (0.16 + sphereVector.radiusSeed * 0.84)
  const dotRadius =
    INITIAL_COLLAPSED_DOT_RADIUS * (0.18 + sphereVector.radiusSeed * 0.82)
  const sphericalRadius = roundRadius + (dotRadius - roundRadius) * dotProgress
  const sourceX = x - ICON_CENTER_X
  const sourceY = y
  const sourceZ = z
  const roundedX = sphereVector.x * sphericalRadius
  const roundedY = sphereVector.y * sphericalRadius
  const roundedZ = sphereVector.z * sphericalRadius

  return [
    ICON_CENTER_X + sourceX * (1 - roundProgress) + roundedX * roundProgress,
    sourceY * (1 - roundProgress) + roundedY * roundProgress,
    sourceZ * (1 - roundProgress) + roundedZ * roundProgress,
  ] as const
}

export function voxSpaceEaseCollapse(value: number) {
  const x = clamp01(value)
  return 1 - Math.pow(1 - x, 3)
}

export function voxSpaceEaseTransitionCollapse(value: number) {
  const x = smootherStep(value)
  return 1 - Math.pow(1 - x, 3)
}

export function getVoxSpaceTransitionMotion(progress: number) {
  const explosionWindow = progress / EXPLOSION_PHASE_SHARE
  const collapseWindow =
    (progress - EXPLOSION_PHASE_SHARE) / (1 - EXPLOSION_PHASE_SHARE)

  return {
    explosion: voxSpaceEaseTransitionExplosion(explosionWindow),
    collapse: voxSpaceEaseTransitionCollapse(collapseWindow),
    explosionPulse: Math.sin(smootherStep(explosionWindow) * Math.PI),
    releaseProgress: smootherStep(progress),
  }
}

export function getVoxSpaceInitialMotion(progress: number) {
  const explosionWindow =
    (progress - INITIAL_CORE_HOLD_PHASE_SHARE) /
    (INITIAL_EXPLOSION_PHASE_SHARE - INITIAL_CORE_HOLD_PHASE_SHARE)
  const collapseWindow =
    (progress - INITIAL_EXPLOSION_PHASE_SHARE) /
    (1 - INITIAL_EXPLOSION_PHASE_SHARE)
  const releaseWindow =
    (progress - INITIAL_CORE_HOLD_PHASE_SHARE) /
    (1 - INITIAL_CORE_HOLD_PHASE_SHARE)

  return {
    implosion: 1,
    explosion: voxSpaceEaseTransitionExplosion(explosionWindow),
    collapse: voxSpaceEaseTransitionCollapse(collapseWindow),
    implosionPulse: 0,
    explosionPulse: Math.sin(smootherStep(explosionWindow) * Math.PI),
    releaseProgress: smootherStep(releaseWindow),
  }
}

export function nextVoxSpacePhase(phase: VoxSpacePhase): VoxSpacePhase {
  if (phase === 'explode') return 'collapse'
  if (phase === 'collapse') return 'hold'
  return 'explode'
}

function hueToRgb(p: number, q: number, t: number) {
  let value = t
  if (value < 0) value += 1
  if (value > 1) value -= 1
  if (value < 1 / 6) return p + (q - p) * 6 * value
  if (value < 1 / 2) return q
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
  return p
}

// Writes into `out` instead of returning a new tuple: this runs for every
// particle of every frame, so the per-particle array allocation is avoided.
export function hslToRgb(
  h: number,
  s: number,
  l: number,
  out: Float64Array
): void {
  if (s === 0) {
    out[0] = l
    out[1] = l
    out[2] = l
    return
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  out[0] = hueToRgb(p, q, h + 1 / 3)
  out[1] = hueToRgb(p, q, h)
  out[2] = hueToRgb(p, q, h - 1 / 3)
}

export function createInitialSphereTargets(count: number) {
  const data = new Float32Array(count * 3)
  const boundaryRadius = 2.42
  const denominator = Math.max(1, count - 1)

  for (let i = 0; i < count; i++) {
    const order = i / denominator
    const seededA = Math.sin((i + 1) * 12.9898) * 43758.5453
    const seededB = Math.sin((i + 1) * 78.233) * 19341.3187
    const seededC = Math.sin((i + 1) * 37.719) * 95731.4751
    const seededD = Math.sin((i + 1) * 91.173) * 24634.6345
    const seededE = Math.sin((i + 1) * 144.317) * 56412.3157
    const randA = seededA - Math.floor(seededA)
    const randB = seededB - Math.floor(seededB)
    const randC = seededC - Math.floor(seededC)
    const randD = seededD - Math.floor(seededD)
    const randE = seededE - Math.floor(seededE)

    const y = randA * 2 - 1 + (randD - 0.5) * 0.16
    const clampedY = Math.max(-1, Math.min(1, y))
    const ring = Math.sqrt(Math.max(0, 1 - clampedY * clampedY))
    const theta =
      randB * Math.PI * 2 +
      Math.sin(order * Math.PI * 11.0 + randE * Math.PI * 2) * 0.55
    const coreBand = randE < 0.36
    const mantleBand = !coreBand && randE < 0.82
    let radialBias: number
    if (coreBand) {
      radialBias = 0.13 + Math.pow(randC, 1.75) * 0.27
    } else if (mantleBand) {
      radialBias = 0.38 + Math.pow(randC, 1.1) * 0.42
    } else {
      radialBias = 0.76 + Math.pow(randC, 0.72) * 0.22
    }
    const turbulence =
      Math.sin(order * Math.PI * 29.0 + randA * Math.PI * 2) * 0.095 +
      Math.cos(order * Math.PI * 13.0 + randB * Math.PI * 2) * 0.07 +
      Math.sin((randD - 0.5) * Math.PI * 7.0) * 0.045
    const gravityBoundRadius = Math.min(
      boundaryRadius,
      Math.max(0.12, boundaryRadius * radialBias + turbulence)
    )
    const squashedZ = 0.78 + randD * 0.12
    const coreShear = coreBand ? 0.16 : 0.07
    const x = Math.cos(theta) * ring
    const z = Math.sin(theta) * ring

    data[i * 3] =
      ICON_CENTER_X +
      x * gravityBoundRadius +
      Math.sin(theta * 2.7 + order * Math.PI * 6) * coreShear
    data[i * 3 + 1] =
      clampedY * gravityBoundRadius +
      Math.cos(theta * 2.1 - order * Math.PI * 5) * coreShear * 0.62
    data[i * 3 + 2] =
      (z * gravityBoundRadius +
        Math.sin(theta * 1.9 + randA * Math.PI * 2) * coreShear * 0.72) *
      squashedZ
  }

  return data
}

export function createInitialScatterTargets(count: number) {
  const data = new Float32Array(count * 3)
  const denominator = Math.max(1, count - 1)

  for (let i = 0; i < count; i++) {
    const order = i / denominator
    const seededA = Math.sin((i + 1) * 17.219) * 72341.731
    const seededB = Math.sin((i + 1) * 43.853) * 51987.123
    const seededC = Math.sin((i + 1) * 91.117) * 31829.733
    const seededD = Math.sin((i + 1) * 128.731) * 92713.553
    const seededE = Math.sin((i + 1) * 211.913) * 41731.337
    const seededF = Math.sin((i + 1) * 19.371 + 0.37) * 73913.917
    const randA = seededA - Math.floor(seededA)
    const randB = seededB - Math.floor(seededB)
    const randC = seededC - Math.floor(seededC)
    const randD = seededD - Math.floor(seededD)
    const randE = seededE - Math.floor(seededE)
    const randF = seededF - Math.floor(seededF)

    const horizontalWave =
      Math.sin(order * Math.PI * 17.0 + randE * Math.PI * 2) * 0.7 +
      Math.cos(order * Math.PI * 5.0 + randF * Math.PI * 2) * 0.38
    const verticalWave =
      Math.cos(order * Math.PI * 13.0 + randA * Math.PI * 2) * 0.48 +
      Math.sin(order * Math.PI * 7.0 + randD * Math.PI * 2) * 0.22
    const depthWave =
      Math.sin(order * Math.PI * 19.0 + randB * Math.PI * 2) * 0.34 +
      Math.cos(order * Math.PI * 11.0 + randE * Math.PI * 2) * 0.2
    const angle =
      randA * Math.PI * 2 +
      Math.sin(order * Math.PI * 9.0 + randF * Math.PI * 2) * 0.42
    const radialShell = Math.min(
      1.06,
      Math.pow(randB, 0.42) * (0.76 + randD * 0.34)
    )
    const breathingEdge =
      radialShell +
      Math.sin(order * Math.PI * 23.0 + randE * Math.PI * 2) * 0.045
    const xUnit = Math.cos(angle) * breathingEdge
    const yUnit = Math.sin(angle) * breathingEdge

    data[i * 3] =
      ICON_CENTER_X + xUnit * INITIAL_SCATTER_X_RADIUS + horizontalWave * 0.58
    data[i * 3 + 1] = yUnit * INITIAL_SCATTER_Y_RADIUS + verticalWave * 0.58
    data[i * 3 + 2] =
      (randC * 2 - 1) * INITIAL_SCATTER_Z_RADIUS * (0.46 + radialShell * 0.54) +
      depthWave
  }

  return data
}

export function fillVoxSpaceCollapsedCorePoints<
  T extends Float32Array | Float64Array,
>(target: T, source: Float32Array, implosion: number): T {
  for (let i = 0; i < source.length; i += 3) {
    const [x, y, z] = getVoxSpaceCollapsedCorePoint(
      source[i],
      source[i + 1],
      source[i + 2],
      implosion
    )
    target[i] = x
    target[i + 1] = y
    target[i + 2] = z
  }

  return target
}

export function createInitialCollapsedDotTargets(count: number) {
  return fillVoxSpaceCollapsedCorePoints(
    new Float32Array(count * 3),
    createInitialScatterTargets(count),
    1
  )
}

export function fillScatterFlowTargets(
  flowed: Float32Array,
  scatterTargets: Float32Array,
  time: number
) {
  for (let i = 0; i < scatterTargets.length; i += 3) {
    const order = i / Math.max(3, scatterTargets.length - 3)
    const x = scatterTargets[i]
    const y = scatterTargets[i + 1]
    const z = scatterTargets[i + 2]
    const drift =
      Math.sin(time * 0.76 + order * 71.0 + y * 0.31) * 0.16 +
      Math.cos(time * 0.48 - order * 43.0 + z * 0.42) * 0.08
    const cross =
      Math.cos(time * 0.62 + order * 37.0 + x * 0.18) * 0.13 +
      Math.sin(time * 0.35 + order * 19.0 - z * 0.37) * 0.06
    const depth =
      Math.sin(time * 0.54 + order * 29.0 + (x - ICON_CENTER_X) * 0.22) * 0.11

    flowed[i] = x + drift
    flowed[i + 1] = y + cross
    flowed[i + 2] = z + depth
  }
}

export function createInitialScatterFlowTargets(
  scatterTargets: Float32Array,
  time: number
) {
  const flowed = new Float32Array(scatterTargets.length)
  fillScatterFlowTargets(flowed, scatterTargets, time)

  return flowed
}

function fillSphereFlowTargets(
  flowed: Float32Array,
  sphereTargets: Float32Array,
  time: number
) {
  const gravityRadius = 2.62

  for (let i = 0; i < sphereTargets.length; i += 3) {
    const order = i / Math.max(3, sphereTargets.length - 3)
    const x = sphereTargets[i] - ICON_CENTER_X
    const y = sphereTargets[i + 1]
    const z = sphereTargets[i + 2] / 0.84
    const radius = Math.max(0.001, Math.sqrt(x * x + y * y + z * z))
    const normalized = Math.min(1, radius / gravityRadius)
    const angle = Math.atan2(y, x)
    const depthAngle = Math.atan2(z, Math.hypot(x, y))
    const coreEnergy = 1 - normalized
    const swirl =
      Math.sin(time * 1.55 + order * 67.0 + radius * 3.4) *
        (0.16 + coreEnergy * 0.18) +
      Math.cos(time * 0.93 - order * 43.0 + z * 0.8) * (0.08 + coreEnergy * 0.1)
    const depthSwirl =
      Math.cos(time * 1.18 + order * 31.0 + x * 0.42) *
      (0.07 + coreEnergy * 0.12)
    const churn =
      Math.sin(time * 1.9 + x * 1.15 - y * 0.82 + z * 0.55 + order * 12.0) *
      (0.035 + coreEnergy * 0.105)
    const gravityPull = Math.pow(normalized, 2.4) * 0.095
    const breathe =
      Math.sin(time * 0.82 + order * 23.0) * (0.045 + coreEnergy * 0.035)
    const nextRadius = Math.min(
      gravityRadius,
      Math.max(0.1, radius + breathe + churn - gravityPull)
    )
    const nextAngle = angle + swirl
    const nextDepthAngle = depthAngle + depthSwirl
    const ring = Math.cos(nextDepthAngle) * nextRadius

    flowed[i] = ICON_CENTER_X + Math.cos(nextAngle) * ring
    flowed[i + 1] =
      Math.sin(nextAngle) * ring + Math.sin(time + order * 19.0) * churn
    flowed[i + 2] = Math.sin(nextDepthAngle) * nextRadius * 0.84
  }
}

export function createSphereFlowTargets(
  sphereTargets: Float32Array,
  time: number
) {
  const flowed = new Float32Array(sphereTargets.length)
  fillSphereFlowTargets(flowed, sphereTargets, time)

  return flowed
}

export interface VoxSpacePhaseTargets {
  fromTarget: Float32Array
  toTarget: Float32Array
  burstTarget: Float32Array
  particleCount: number
}

export interface VoxSpacePhaseTargetOptions {
  particleCount: number
  phase: VoxSpacePhase
  activeModelIndex: number
  nextModelIndex: number
  targetSets: Float32Array[]
  currentPositions: Float32Array
  initialTargets: Float32Array
  burstTargets: Float32Array
}

export function getVoxSpacePhaseTargets(
  options: VoxSpacePhaseTargetOptions
): VoxSpacePhaseTargets {
  const activeTarget =
    options.targetSets[options.activeModelIndex] ?? options.initialTargets
  const nextTarget = options.targetSets[options.nextModelIndex] ?? activeTarget
  const isInitialExplosion =
    options.phase === 'explode' &&
    options.activeModelIndex === VOXSPACE_INITIAL_MODEL_INDEX &&
    options.nextModelIndex === VOXSPACE_INITIAL_MODEL_INDEX
  let fromTarget = activeTarget
  if (isInitialExplosion) {
    fromTarget = options.initialTargets
  } else if (options.phase === 'collapse') {
    fromTarget = options.burstTargets
  }
  const isTransitioning =
    options.phase === 'explode' || options.phase === 'collapse'
  const toTarget = isTransitioning ? nextTarget : activeTarget

  return {
    fromTarget,
    toTarget,
    burstTarget: options.burstTargets,
    particleCount: options.particleCount,
  }
}

// Only the transition snapshot may be projected once per capture: it is written
// once and then read unchanged for the whole initial explosion. The scatter-flow
// buffer is rewritten in place on every frame it is used, so its projection has
// to be recomputed every frame, otherwise the cached projection would freeze the
// flow instead of following it.
export function isCacheableCollapsedCoreSource(
  source: Float32Array,
  transitionSource: Float32Array
): boolean {
  return source === transitionSource
}

// Depth of a single icon anchor: a smooth wave across the glyph instead of a
// flat plane, so the collapsed icon is a slab. The wave stays inside
// VOXSPACE_ICON_DEPTH - VOXSPACE_ICON_ANCHOR_THICKNESS, which leaves room for
// the per-particle depth the sampler adds on top.
export function getVoxSpaceIconAnchorDepth(angle: number, radius: number) {
  return Math.sin(angle * 2.0) * 0.5 + Math.cos(radius * 26) * 0.32
}

// The collapsed icon is no longer a still picture: every particle drifts around
// its own anchor like an electron. The drift is a closed-form function of the
// animation clock over pre-baked orbit constants, so it is continuous, it cannot
// accumulate drift, it allocates nothing per frame, and it needs no trigonometry
// per particle per frame: sixteen cosines/sines are evaluated once per frame (a
// cosine and a sine for the primary and for the secondary rate of each of the
// four bands), and every particle rebuilds cos(phase + rate * time) from its
// baked phase.
//
// The offset of one particle is the sum of two harmonic orbits whose radii add
// up to VOXSPACE_ICON_ORBIT_RADIUS, and each harmonic is a unit circle in its own
// plane (`|A * cos(u) + B * sin(u)| === 1` for orthonormal A and B). The whole
// field is therefore bounded by that radius by construction.
//
// The radius is what the flow may spend in the plane of the glyph, and a particle
// that sits close to a stroke edge cannot spend all of it without smearing the
// outline: its in-plane orbit is scaled down to its own stroke depth plus a fixed
// softening allowance (VOXSPACE_ICON_ORBIT_EDGE_SOFTEN), while its depth flow
// keeps the full radius. The outline is allowed to soften by that allowance; it
// is not allowed to grow by the whole orbit radius.
export const VOXSPACE_ICON_ORBIT_RADIUS = 0.26
// How much the outline may soften where the flow crosses it: about one point
// sprite radius, so the drift reads as the icon breathing instead of as a halo.
export const VOXSPACE_ICON_ORBIT_EDGE_SOFTEN = 0.06
const ICON_ORBIT_PRIMARY_SHARE = 0.62
const ICON_ORBIT_SECONDARY_SHARE = 0.38
// Distinct angular rates per band: particles never move in step, so the field
// reads as disordered instead of as one rotating shell.
const ICON_ORBIT_PRIMARY_RATES = [0.58, 0.79, 1.06, 1.42]
const ICON_ORBIT_SECONDARY_RATES = [0.41, 0.63, 0.88, 1.19]
const ICON_ORBIT_BAND_COUNT = ICON_ORBIT_PRIMARY_RATES.length
// The flow only exists once the glyph has actually formed: it fades in over the
// last part of a transition, so the collapse still ends on a still icon.
const ICON_ORBIT_HOLD_START_SHARE = 0.72

// Total half depth of the collapsed icon slab, and the per-particle depth the
// sampler adds inside it. Exported because the depth shading normalises against
// the first and the sampler writes the second.
export const VOXSPACE_ICON_DEPTH = 1.4
export const VOXSPACE_ICON_ANCHOR_THICKNESS = 0.25

export interface VoxSpaceIconOrbitField {
  // Per particle: the two basis vectors of each harmonic plane, already scaled
  // by the harmonic radius.
  basis: Float32Array
  // Per particle: cos/sin of the two baked harmonic phases.
  phase: Float32Array
  // Per particle: the rate band each harmonic belongs to.
  band: Uint8Array
  // Per particle: how much of the in-plane orbit its own stroke can absorb.
  spread: Float32Array
  // Per frame: cos/sin of every band angle, shared by all particles in the band.
  bands: Float64Array
}

export function createVoxSpaceIconOrbitField(
  particleCount: number
): VoxSpaceIconOrbitField {
  return {
    basis: new Float32Array(particleCount * 12),
    phase: new Float32Array(particleCount * 4),
    band: new Uint8Array(particleCount * 2),
    spread: new Float32Array(particleCount),
    bands: new Float64Array(ICON_ORBIT_BAND_COUNT * 4),
  }
}

// Writes the two orthonormal basis vectors of an orbit plane that is tilted
// about x and then yawed about y. Both keep the harmonic radius, so a point on
// the orbit can never be further from the anchor than that radius.
function writeVoxSpaceOrbitBasis(
  basis: Float32Array,
  offset: number,
  radius: number,
  tilt: number,
  yaw: number
) {
  const sinTilt = Math.sin(tilt)
  const cosTilt = Math.cos(tilt)
  const sinYaw = Math.sin(yaw)
  const cosYaw = Math.cos(yaw)

  basis[offset] = radius * cosYaw
  basis[offset + 1] = 0
  basis[offset + 2] = -radius * sinYaw
  basis[offset + 3] = radius * sinTilt * sinYaw
  basis[offset + 4] = radius * cosTilt
  basis[offset + 5] = radius * sinTilt * cosYaw
}

// Bakes the orbit of every particle for the icon it is about to land on. Runs
// once per icon switch, never per frame.
//
// `strokeDepth` is the per-particle distance out to the nearest stroke edge of
// that same icon. A particle whose anchor is further from the edge than the orbit
// radius keeps the whole in-plane orbit; a particle on a hairline keeps only what
// its own stroke can absorb, so the glyph reads as the same glyph while it moves.
export function fillVoxSpaceIconOrbitField(
  field: VoxSpaceIconOrbitField,
  anchors: Float32Array,
  strokeDepth: Float32Array
): void {
  const particleCount = field.band.length / 2

  for (let i = 0; i < particleCount; i++) {
    const idx = i * 3
    const x = anchors[idx] - ICON_CENTER_X
    const y = anchors[idx + 1]
    const z = anchors[idx + 2]
    field.spread[i] = Math.min(
      1,
      (strokeDepth[i] + VOXSPACE_ICON_ORBIT_EDGE_SOFTEN) /
        VOXSPACE_ICON_ORBIT_RADIUS
    )
    const seedBase = x * 12.9898 + y * 78.233 + z * 37.719
    const seedA = seededFraction(seedBase + 11.17)
    const seedB = seededFraction(seedBase * 1.731 + 47.39)
    const seedC = seededFraction(seedBase * 2.173 + 91.71)
    const seedD = seededFraction(seedBase * 3.517 + 13.57)
    // A slow wave over the anchor position keeps neighbouring particles roughly
    // in step, so the field moves like a current across the glyph instead of
    // like independent per-particle noise.
    const wave =
      Math.sin(x * 0.42 + y * 0.31) * 0.5 + Math.cos(y * 0.37 - x * 0.55) * 0.5
    const basis = i * 12
    const phase = i * 4

    writeVoxSpaceOrbitBasis(
      field.basis,
      basis,
      VOXSPACE_ICON_ORBIT_RADIUS * ICON_ORBIT_PRIMARY_SHARE,
      0.5 + seedB * 0.62 + wave * 0.3,
      (seedA + wave * 0.18) * Math.PI * 2
    )
    writeVoxSpaceOrbitBasis(
      field.basis,
      basis + 6,
      VOXSPACE_ICON_ORBIT_RADIUS * ICON_ORBIT_SECONDARY_SHARE,
      1.05 + seedD * 0.58 - wave * 0.26,
      (seedC + wave * 0.22) * Math.PI * 2
    )

    const primaryPhase = (seedA * 0.7 + seedB * 0.3 + wave * 0.4) * Math.PI * 2
    const secondaryPhase =
      (seedC * 0.7 + seedD * 0.3 - wave * 0.35) * Math.PI * 2
    field.phase[phase] = Math.cos(primaryPhase)
    field.phase[phase + 1] = Math.sin(primaryPhase)
    field.phase[phase + 2] = Math.cos(secondaryPhase)
    field.phase[phase + 3] = Math.sin(secondaryPhase)

    field.band[i * 2] = Math.floor(seedB * ICON_ORBIT_BAND_COUNT)
    field.band[i * 2 + 1] = Math.floor(seedD * ICON_ORBIT_BAND_COUNT)
  }
}

// Writes the flow offset of every particle for one frame, scaled by `mix` so the
// whole field fades in with the collapse and is exactly zero before it. The
// in-plane axes are additionally scaled by the particle's own stroke depth, so the
// depth flow always runs at the full radius while the drift across the glyph is
// limited by the stroke the particle belongs to. The offset only describes the
// motion around the anchor; the caller adds the icon anchor itself.
export function fillVoxSpaceIconOrbitOffsets(
  offsets: Float32Array,
  field: VoxSpaceIconOrbitField,
  time: number,
  mix: number
): void {
  const bands = field.bands
  const basis = field.basis
  const phase = field.phase
  const particleBand = field.band
  const spread = field.spread

  for (let band = 0; band < ICON_ORBIT_BAND_COUNT; band++) {
    const base = band * 4
    const primaryAngle = ICON_ORBIT_PRIMARY_RATES[band] * time
    const secondaryAngle = ICON_ORBIT_SECONDARY_RATES[band] * time
    // Sixteen trig calls per frame for the whole field: four bands, each with a
    // cos and a sin for its primary plane and for its secondary plane. Every
    // particle then only multiplies (angle addition, not a fresh trig call).
    bands[base] = Math.cos(primaryAngle)
    bands[base + 1] = Math.sin(primaryAngle)
    bands[base + 2] = Math.cos(secondaryAngle)
    bands[base + 3] = Math.sin(secondaryAngle)
  }

  const particleCount = particleBand.length / 2

  for (let i = 0; i < particleCount; i++) {
    const idx = i * 3
    const basisOffset = i * 12
    const phaseOffset = i * 4
    const planeMix = mix * spread[i]
    const primaryBand = particleBand[i * 2] * 4
    const secondaryBand = particleBand[i * 2 + 1] * 4
    const primaryCos = bands[primaryBand]
    const primarySin = bands[primaryBand + 1]
    const secondaryCos = bands[secondaryBand + 2]
    const secondarySin = bands[secondaryBand + 3]
    const cosPrimary =
      phase[phaseOffset] * primaryCos - phase[phaseOffset + 1] * primarySin
    const sinPrimary =
      phase[phaseOffset + 1] * primaryCos + phase[phaseOffset] * primarySin
    const cosSecondary =
      phase[phaseOffset + 2] * secondaryCos -
      phase[phaseOffset + 3] * secondarySin
    const sinSecondary =
      phase[phaseOffset + 3] * secondaryCos +
      phase[phaseOffset + 2] * secondarySin

    offsets[idx] =
      (basis[basisOffset] * cosPrimary +
        basis[basisOffset + 3] * sinPrimary +
        basis[basisOffset + 6] * cosSecondary +
        basis[basisOffset + 9] * sinSecondary) *
      planeMix
    offsets[idx + 1] =
      (basis[basisOffset + 1] * cosPrimary +
        basis[basisOffset + 4] * sinPrimary +
        basis[basisOffset + 7] * cosSecondary +
        basis[basisOffset + 10] * sinSecondary) *
      planeMix
    offsets[idx + 2] =
      (basis[basisOffset + 2] * cosPrimary +
        basis[basisOffset + 5] * sinPrimary +
        basis[basisOffset + 8] * cosSecondary +
        basis[basisOffset + 11] * sinSecondary) *
      mix
  }
}

// Amplitude gate of the icon flow. A transition starts by re-anchoring the
// targets to the particles' current positions, so the gate dropping back to zero
// on the next explosion cannot snap anything: there is no force to spike.
export function voxSpaceIconHoldMix(transitionProgress: number): number {
  return smootherStep(
    (clamp01(transitionProgress) - ICON_ORBIT_HOLD_START_SHARE) /
      (1 - ICON_ORBIT_HOLD_START_SHARE)
  )
}

// Bakes the drift of the icon the particles are landing on. The orbit is centred
// on the target of the collapse (the glyph being assembled), never on the glyph
// being left behind: drifting around the previous icon's anchors would drag the
// outline of the new one along the shape of the old one.
export function bakeVoxSpaceIconOrbit(
  field: VoxSpaceIconOrbitField,
  phaseTargets: VoxSpacePhaseTargets,
  strokeDepth: Float32Array
): void {
  fillVoxSpaceIconOrbitField(field, phaseTargets.toTarget, strokeDepth)
}

// The settled hold spring, as the frame loop applies it once a transition has
// completed: velocity memory, the pull towards the particle's (anchor + flow)
// target, and the frame friction. Exported because these are the numbers that
// decide whether a held particle stays inside its own stroke, and a test that
// re-typed them would be validating its own copy instead of the renderer.
export const VOXSPACE_HOLD_RETURN_SPEED = 0.058
export const VOXSPACE_HOLD_VELOCITY_MEMORY = 0.26
export const VOXSPACE_HOLD_FRICTION = 0.78
// The two shares of the follow speed that survive a completed transition: the
// frame loop keeps the first one always and adds the second one as the collapse
// reaches its end, so the settled hold is exactly their sum.
export const VOXSPACE_HOLD_FOLLOW_BASE = 1.22
export const VOXSPACE_HOLD_COLLAPSE_FOLLOW = 0.24
export const VOXSPACE_HOLD_FOLLOW_SPEED =
  VOXSPACE_HOLD_RETURN_SPEED *
  (VOXSPACE_HOLD_FOLLOW_BASE + VOXSPACE_HOLD_COLLAPSE_FOLLOW)

export function getVoxSpaceHoldFrameFriction(frameStep: number): number {
  return Math.pow(VOXSPACE_HOLD_FRICTION, frameStep)
}

// One particle's velocity update against its target: the spring, without the
// extra forces (stellar core, pointer) and without the friction and position
// integration the frame loop applies afterwards.
export function stepVoxSpaceHoldParticle(
  velocities: Float32Array,
  idx: number,
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  followSpeed: number,
  frameStep: number
): void {
  velocities[idx] =
    velocities[idx] * VOXSPACE_HOLD_VELOCITY_MEMORY +
    (tx - px) * followSpeed * frameStep
  velocities[idx + 1] =
    velocities[idx + 1] * VOXSPACE_HOLD_VELOCITY_MEMORY +
    (ty - py) * followSpeed * frameStep
  velocities[idx + 2] =
    velocities[idx + 2] * VOXSPACE_HOLD_VELOCITY_MEMORY +
    (tz - pz) * followSpeed * frameStep
}

// Switching icons drops the flow gate from one to zero in a single frame. That is
// safe for the motion (the targets are re-anchored to the particles' positions,
// so the gate has no force to release) but not for the pose and the shading the
// same gate carries: the slab's tilt and its front-to-back brightness would jump
// on that frame. They follow this decay instead, which is independent of the gate
// and only ever eases down, so the hold still snaps off while what it looks like
// stays continuous.
export const VOXSPACE_ICON_HOLD_FADE_STEP = 0.25

export function nextVoxSpaceIconHoldFade(
  current: number,
  mix: number,
  frameStep: number
): number {
  if (mix >= current) return mix
  return Math.max(mix, current - VOXSPACE_ICON_HOLD_FADE_STEP * frameStep)
}

const ICON_HOLD_TILT_X = 0.024
const ICON_HOLD_YAW_Y = 0.032
const ICON_HOLD_ROLL_Z = 0.012

export interface VoxSpaceIconHoldPose {
  rotationX: number
  rotationY: number
  rotationZ: number
  // Multiplier of the depth shading, so the caller does not have to know how the
  // pose and the tone fade relate.
  toneScale: number
}

// Written in place: the frame loop reuses one pose object, so the hold adds no
// per-frame allocation. The roll is not gated (it never depended on the hold),
// the tilt and the yaw are, and both follow the fade rather than the raw gate.
export function writeVoxSpaceIconHoldPose(
  pose: VoxSpaceIconHoldPose,
  time: number,
  fade: number
): void {
  pose.rotationX = Math.sin(time * 0.083 + 1.7) * ICON_HOLD_TILT_X * fade
  pose.rotationY = Math.cos(time * 0.061 + 0.4) * ICON_HOLD_YAW_Y * fade
  pose.rotationZ = Math.sin(time * 0.045) * ICON_HOLD_ROLL_Z
  pose.toneScale = fade
}

export const VOXSPACE_POINTER_ACTIVE_MS = 1400

// A pointer that has left the canvas, or has not moved for a while, must stop
// pushing: the particles it displaced decay back through the frame friction
// instead of the field staying energised forever.
export function isVoxSpacePointerActive(
  active: boolean,
  lastMoveMs: number,
  nowMs: number
): boolean {
  return active && nowMs - lastMoveMs < VOXSPACE_POINTER_ACTIVE_MS
}

export interface VoxSpacePointerField {
  localX: number
  localY: number
  localZ: number
  radius: number
  radiusSq: number
  time: number
}

// The pointer push, in the particles' own frame (the caller maps the pointer back
// into it). Outward along the pointer distance plus a tangential swirl, so the
// field parts around the cursor instead of collapsing onto it.
export function applyVoxSpacePointerPush(
  velocities: Float32Array,
  idx: number,
  px: number,
  py: number,
  pz: number,
  order: number,
  pointer: VoxSpacePointerField
): void {
  const dx = px - pointer.localX
  const dy = py - pointer.localY
  const dz = pz - pointer.localZ
  const distSq = dx * dx + dy * dy + dz * dz * 0.25
  if (distSq >= pointer.radiusSq || distSq <= 0.0001) return
  const dist = Math.sqrt(distSq)
  const force = (1 - dist / pointer.radius) * 0.06
  const swirl = (1 - dist / pointer.radius) * 0.026
  velocities[idx] += (dx / dist) * force - dy * swirl
  velocities[idx + 1] += (dy / dist) * force + dx * swirl
  velocities[idx + 2] += Math.sin(pointer.time * 2 + order * 28) * force * 1.6
}
