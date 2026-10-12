import.meta.env = {"BASE_URL": "/", "DEV": true, "MODE": "development", "PROD": false, "SSR": false, "VITE_DEV_PROXY_TARGET": "http://127.0.0.1:8080"};import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  NormalBlending,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer
} from "/node_modules/.vite/deps/three.js?v=b7dcf682";
import {
  applyVoxSpacePointerPush,
  clamp01,
  createInitialScatterTargets,
  createVoxSpaceIconOrbitField,
  fillVoxSpaceIconOrbitField,
  fillVoxSpaceIconOrbitOffsets,
  getVoxSpaceHoldFrameFriction,
  isVoxSpacePointerActive,
  nextVoxSpaceIconHoldFade,
  smootherStep,
  stepVoxSpaceHoldParticle,
  writeVoxSpaceIconHoldPose
} from "/src/features/home-particle/vendor/voxspace-math.ts";
import { createBrandTargetSource } from "/src/features/home-particle/engine/brandTargets.ts?t=1791812203950";
import { EmittedTail, createCometBody } from "/src/features/home-particle/engine/emittedTail.ts?t=1791820681387";
import { createChoreography, staggeredGlyphMix } from "/src/features/home-particle/engine/choreography.ts?t=1791820681190";
import {
  AMPLITUDE_X,
  BRANDS,
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  DOLLY_FROM_Z,
  FRICTION,
  GATHER_SECONDS,
  HEAD_CORE_RADIUS,
  HEAD_CORE_SHARE,
  HOLD_SECONDS,
  LEG_SECONDS,
  POINTER_RADIUS,
  SCATTER_SECONDS,
  SUBJECT_Z,
  TAIL_DUST_LIFE_MAX,
  TAIL_DUST_LIFE_MIN,
  TAIL_DUST_REACH_MAX,
  TAIL_DUST_REACH_MIN,
  TAIL_ENTRAIN,
  TAIL_FADE_POWER,
  TAIL_FILL,
  TAIL_ION_LIFE_MAX,
  TAIL_ION_LIFE_MIN,
  TAIL_ION_NARROW,
  TAIL_ION_REACH_MAX,
  TAIL_ION_REACH_MIN,
  TAIL_ION_SHARE,
  TAIL_SECONDS,
  TAIL_SPEED_JITTER,
  TAIL_SPREAD
} from "/src/features/home-particle/engine/constants.ts";
import { COALESCE_END, departureSeconds } from "/src/features/home-particle/engine/flightTiming.ts";
import { cameraTravelAt, glyphStopZ } from "/src/features/home-particle/engine/spaceMotion.ts?t=1791820681196";
import { createQualityProfile, probeQualityProfile } from "/src/features/home-particle/engine/quality.ts";
import { GLYPH_MIN_BBOX_ASPECT, fitDistanceForRoster, requiredGlyphWorldSize } from "/src/features/home-particle/engine/glyphSize.ts";
import { createStarfield } from "/src/features/home-particle/engine/starfield.ts";
const SPACE_TIMING = {
  legSeconds: LEG_SECONDS,
  gatherSeconds: GATHER_SECONDS,
  holdSeconds: HOLD_SECONDS,
  scatterSeconds: SCATTER_SECONDS
};
const GLYPH_CENTER_X = 5.8;
const FRAME_MARGIN = 1.12;
const MAX_CLOCK_STEP = 0.1;
const COMET_VELOCITY_MEMORY = 0.26;
const FOLLOW_TRAVEL = 0.055;
const FOLLOW_GATHER = 0.1;
const FOLLOW_HOLD = 0.105;
const FOLLOW_SCATTER = 0.085;
let sharedGlow = null;
let glowRefs = 0;
function acquireGlowTexture() {
  if (sharedGlow) {
    glowRefs += 1;
    return sharedGlow;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.16, "rgba(255,255,255,.98)");
  gradient.addColorStop(0.42, "rgba(255,255,255,.58)");
  gradient.addColorStop(0.72, "rgba(255,255,255,.20)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  sharedGlow = texture;
  glowRefs += 1;
  return texture;
}
function releaseGlowTexture() {
  glowRefs = Math.max(0, glowRefs - 1);
  if (glowRefs === 0 && sharedGlow) {
    sharedGlow.dispose();
    sharedGlow = null;
  }
}
export function paletteFor(isLightTheme) {
  return isLightTheme ? {
    // Additive blending washes out to white on a pale page, so the light theme
    // is dark ink on a bright sky and must blend normally.
    //
    // Normal blending does not accumulate the way additive does: the glow sprite
    // is a soft radial falloff, so overlapping translucent points converge on a
    // haze rather than on the sprite's centre colour. Measured with the earlier
    // values (opacity 0.8, size 0.082) the comet rendered at 2.85:1 against the
    // page while the starfield managed 6.78:1 — the background out-shouted the
    // subject, even though the comet's own vertex colour was a dark 98/255.
    //
    // So on the light theme each particle has to be individually more solid:
    // full opacity, a larger sprite, and a darker core. The point size is
    // deliberately *larger* than the dark theme's, which looks backwards but is
    // the consequence of normal blending — ink needs coverage, light does not.
    core: new Color(0.06, 0.075, 0.115),
    accent: new Color(0.62, 0.2, 0),
    gain: 0.72,
    blending: NormalBlending,
    background: new Color(0.976, 0.98, 0.984),
    opacity: 1,
    pointSize: 0.125
  } : {
    // Deep space: cool-white stardust with the site's single warm accent used
    // only at the head. A saturated head would fight the glyph it forms.
    core: new Color(0.88, 0.92, 1),
    accent: new Color(1, 0.42, 0.05),
    gain: 1.22,
    blending: AdditiveBlending,
    background: new Color(0.012, 0.016, 0.039),
    opacity: 1,
    pointSize: 0.098
  };
}
function hash01(index, salt) {
  let h = Math.imul(index ^ salt, 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function createEngineScratch(count, tailSampleCount) {
  const tailLife = new Float32Array(count);
  const tailAge = new Float32Array(count);
  const tailReach = new Float32Array(count);
  const tailCone = new Float32Array(count * 3);
  const tailIon = new Uint8Array(count);
  const tailSeed = new Float32Array(count);
  const headOffset = new Float32Array(count * 3);
  const golden = 0.6180339887498949;
  const coreCount = Math.floor(count * HEAD_CORE_SHARE);
  const LIFE_SALT = 2146121005;
  const REACH_SALT = 2769414579;
  const THETA_SALT = 458671337;
  const PHI_SALT = 668265263;
  const ION_SALT = 1759714724;
  const JITTER_SALT = 2221713035;
  const SEED_SALT = 2654435769;
  const CORE_X_SALT = 625341585;
  const CORE_Y_SALT = 2654435761;
  const CORE_Z_SALT = 2246822507;
  for (let i = 0; i < count; i++) {
    tailSeed[i] = hash01(i, SEED_SALT);
    if (i < coreCount) {
      const r2 = HEAD_CORE_RADIUS * Math.pow(hash01(i, CORE_X_SALT), 0.72);
      const cosTheta2 = hash01(i, CORE_Y_SALT) * 2 - 1;
      const phi2 = hash01(i, CORE_Z_SALT) * Math.PI * 2;
      const sinTheta2 = Math.sqrt(Math.max(0, 1 - cosTheta2 * cosTheta2));
      headOffset[i * 3] = r2 * sinTheta2 * Math.cos(phi2);
      headOffset[i * 3 + 1] = r2 * sinTheta2 * Math.sin(phi2);
      headOffset[i * 3 + 2] = r2 * cosTheta2;
      tailLife[i] = 0;
      tailReach[i] = 0;
      continue;
    }
    const ion = hash01(i, ION_SALT) < TAIL_ION_SHARE;
    tailIon[i] = ion ? 1 : 0;
    const lifeMin = ion ? TAIL_ION_LIFE_MIN : TAIL_DUST_LIFE_MIN;
    const lifeMax = ion ? TAIL_ION_LIFE_MAX : TAIL_DUST_LIFE_MAX;
    const life = lifeMin + hash01(i, LIFE_SALT) * (lifeMax - lifeMin);
    tailLife[i] = life;
    const reachMin = ion ? TAIL_ION_REACH_MIN : TAIL_DUST_REACH_MIN;
    const reachMax = ion ? TAIL_ION_REACH_MAX : TAIL_DUST_REACH_MAX;
    const reach = reachMin + hash01(i, REACH_SALT) * (reachMax - reachMin);
    tailReach[i] = reach * (1 + (hash01(i, JITTER_SALT) - 0.5) * 2 * TAIL_SPEED_JITTER);
    tailAge[i] = ((i - coreCount) * golden + 0.5) % 1 * life;
    const spread = TAIL_SPREAD * (ion ? TAIL_ION_NARROW : 1);
    const sinTheta = spread * Math.pow(hash01(i, THETA_SALT), TAIL_FILL);
    const cosTheta = Math.sqrt(Math.max(0, 1 - sinTheta * sinTheta));
    const phi = hash01(i, PHI_SALT) * Math.PI * 2;
    tailCone[i * 3] = cosTheta;
    tailCone[i * 3 + 1] = sinTheta * Math.cos(phi);
    tailCone[i * 3 + 2] = sinTheta * Math.sin(phi);
    const r = HEAD_CORE_RADIUS * Math.cbrt(hash01(i, CORE_X_SALT));
    const cosY = hash01(i, CORE_Y_SALT) * 2 - 1;
    const phiY = hash01(i, CORE_Z_SALT) * Math.PI * 2;
    const sinY = Math.sqrt(Math.max(0, 1 - cosY * cosY));
    headOffset[i * 3] = r * sinY * Math.cos(phiY);
    headOffset[i * 3 + 1] = r * sinY * Math.sin(phiY);
    headOffset[i * 3 + 2] = r * cosY;
  }
  return {
    emittedTail: new EmittedTail(Math.max(1, Math.floor(count * (1 - HEAD_CORE_SHARE)))),
    body: createCometBody(count),
    // The opening frame is a wide scatter that the spring pulls into the first
    // comet, so the background assembles itself instead of popping into being.
    positions: createInitialScatterTargets(count),
    velocities: new Float32Array(count * 3),
    colors: new Float32Array(count * 4),
    tailBirthPosition: new Float32Array(count * 3),
    tailBirthVelocity: new Float32Array(count * 3),
    tailReady: new Uint8Array(count),
    shapeFrom: new Float32Array(count * 3),
    shapeAlpha: new Float32Array(count),
    pointerOffset: new Float32Array(count * 3),
    tailLife,
    tailAge,
    tailReach,
    tailCone,
    tailIon,
    tailSeed,
    headOffset,
    glyphTargets: new Float32Array(count * 3),
    glyphStrokeDepth: new Float32Array(count),
    tailTable: createEmissionTable(tailSampleCount),
    iconOrbitOffsets: new Float32Array(count * 3),
    iconOrbitField: createVoxSpaceIconOrbitField(count),
    iconHoldPose: { rotationX: 0, rotationY: 0, rotationZ: 0, toneScale: 0 },
    pointerField: {
      localX: 0,
      localY: 0,
      localZ: 0,
      radius: POINTER_RADIUS,
      radiusSq: POINTER_RADIUS * POINTER_RADIUS,
      time: 0
    },
    vecA: new Vector3(),
    vecB: new Vector3(),
    probePoint: { x: 0, y: 0, z: 0 },
    inverseRotation: new Quaternion()
  };
}
export function createEmissionTable(probeCount) {
  const n = Math.max(2, Math.floor(probeCount));
  return {
    xyz: new Float32Array(n * 3),
    vel: new Float32Array(n * 3),
    axis: new Float32Array(n * 3),
    side1: new Float32Array(n * 3),
    side2: new Float32Array(n * 3),
    probeCount: n,
    spanSeconds: TAIL_SECONDS
  };
}
export function glyphMixFor(phase, progress) {
  switch (phase) {
    case "travel":
      return 0;
    case "gather":
      return smootherStep(clamp01(progress));
    case "hold":
      return 1;
    default:
      return 1 - smootherStep(clamp01(progress));
  }
}
export function followSpeedFor(phase) {
  switch (phase) {
    case "hold":
      return FOLLOW_HOLD;
    case "gather":
      return FOLLOW_GATHER;
    case "scatter":
      return FOLLOW_SCATTER;
    default:
      return FOLLOW_TRAVEL;
  }
}
export function fillEmissionTable(table, source, probePoint) {
  const n = table.probeCount;
  const { xyz, vel, axis, side1, side2 } = table;
  const span = table.spanSeconds;
  const step = span / Math.max(1, n - 1);
  for (let k = 0; k < n; k++) {
    source.sampleTrail(k * step, probePoint);
    xyz[k * 3] = probePoint.x;
    xyz[k * 3 + 1] = probePoint.y;
    xyz[k * 3 + 2] = probePoint.z;
  }
  for (let k = 0; k < n; k++) {
    const hi = (k === 0 ? 0 : k - 1) * 3;
    const lo = (k === n - 1 ? n - 1 : k + 1) * 3;
    const elapsed = (k === 0 || k === n - 1 ? 1 : 2) * step;
    const vx = (xyz[hi] - xyz[lo]) / elapsed;
    const vy = (xyz[hi + 1] - xyz[lo + 1]) / elapsed;
    const vz = (xyz[hi + 2] - xyz[lo + 2]) / elapsed;
    vel[k * 3] = vx;
    vel[k * 3 + 1] = vy;
    vel[k * 3 + 2] = vz;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    let ax;
    let ay;
    let az;
    if (speed > 1e-6) {
      ax = -vx / speed;
      ay = -vy / speed;
      az = -vz / speed;
    } else {
      ax = -1;
      ay = 0;
      az = 0;
    }
    axis[k * 3] = ax;
    axis[k * 3 + 1] = ay;
    axis[k * 3 + 2] = az;
    const rx = Math.abs(ay) < 0.9 ? 0 : 1;
    const ry = Math.abs(ay) < 0.9 ? 1 : 0;
    const rz = 0;
    let s1x = ry * az - rz * ay;
    let s1y = rz * ax - rx * az;
    let s1z = rx * ay - ry * ax;
    const s1Len = Math.sqrt(s1x * s1x + s1y * s1y + s1z * s1z);
    if (s1Len > 1e-6) {
      s1x /= s1Len;
      s1y /= s1Len;
      s1z /= s1Len;
    } else {
      s1x = 1;
      s1y = 0;
      s1z = 0;
    }
    side1[k * 3] = s1x;
    side1[k * 3 + 1] = s1y;
    side1[k * 3 + 2] = s1z;
    side2[k * 3] = ay * s1z - az * s1y;
    side2[k * 3 + 1] = az * s1x - ax * s1z;
    side2[k * 3 + 2] = ax * s1y - ay * s1x;
  }
}
export function tailFade(u) {
  if (!Number.isFinite(u)) return 0;
  const w = 1 - clamp01(u);
  return w <= 0 ? 0 : Math.pow(w, TAIL_FADE_POWER);
}
export function writeTailParticlePosition(table, age, life, reach, coneX, coneY, coneZ, jitterX, jitterY, jitterZ, out) {
  const n = table.probeCount;
  const { xyz, vel, axis, side1, side2 } = table;
  const span = table.spanSeconds;
  const step = span / Math.max(1, n - 1);
  const safeAge = Number.isFinite(age) ? clampTo(age, span) : 0;
  const safeLife = Number.isFinite(life) ? life : 0;
  const safeReach = Number.isFinite(reach) ? reach : 0;
  const f = safeAge / step;
  const k = Math.min(n - 2, Math.floor(f));
  const t = f - k;
  const a = k * 3;
  const b = (k + 1) * 3;
  const px = xyz[a] + (xyz[b] - xyz[a]) * t;
  const py = xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * t;
  const pz = xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * t;
  const vx = vel[a] + (vel[b] - vel[a]) * t;
  const vy = vel[a + 1] + (vel[b + 1] - vel[a + 1]) * t;
  const vz = vel[a + 2] + (vel[b + 2] - vel[a + 2]) * t;
  const drift = safeAge * TAIL_ENTRAIN;
  const sx = axis[a] + (axis[b] - axis[a]) * t;
  const sy = axis[a + 1] + (axis[b + 1] - axis[a + 1]) * t;
  const sz = axis[a + 2] + (axis[b + 2] - axis[a + 2]) * t;
  const ux = side1[a] + (side1[b] - side1[a]) * t;
  const uy = side1[a + 1] + (side1[b + 1] - side1[a + 1]) * t;
  const uz = side1[a + 2] + (side1[b + 2] - side1[a + 2]) * t;
  const wx = side2[a] + (side2[b] - side2[a]) * t;
  const wy = side2[a + 1] + (side2[b + 1] - side2[a + 1]) * t;
  const wz = side2[a + 2] + (side2[b + 2] - side2[a + 2]) * t;
  const travelled = safeLife > 1e-6 ? safeReach * clamp01(safeAge / safeLife) : 0;
  out[0] = px + vx * drift + jitterX + (sx * coneX + ux * coneY + wx * coneZ) * travelled;
  out[1] = py + vy * drift + jitterY + (sy * coneX + uy * coneY + wy * coneZ) * travelled;
  out[2] = pz + vz * drift + jitterZ + (sz * coneX + uz * coneY + wz * coneZ) * travelled;
}
export function advanceEmittedTail(s, i, delta, out) {
  const life = s.tailLife[i];
  if (!(life > 0)) return 0;
  const idx = i * 3;
  let age = s.tailAge[i] + Math.max(0, delta);
  const recycled = age >= life;
  if (recycled) age %= life;
  s.tailAge[i] = age;
  if (!s.tailReady[i] || recycled) {
    const table = s.tailTable;
    const f = Math.min(table.probeCount - 1, age / table.spanSeconds * (table.probeCount - 1));
    const a = Math.min(table.probeCount - 2, Math.floor(f)) * 3;
    const t = f - a / 3;
    const speed = s.tailReach[i] / life;
    for (let j = 0; j < 3; j++) {
      const k = a + j;
      const b = k + 3;
      const origin = table.xyz[k] + (table.xyz[b] - table.xyz[k]) * t;
      const velocity = table.vel[k] + (table.vel[b] - table.vel[k]) * t;
      const axis = table.axis[k] + (table.axis[b] - table.axis[k]) * t;
      const side1 = table.side1[k] + (table.side1[b] - table.side1[k]) * t;
      const side2 = table.side2[k] + (table.side2[b] - table.side2[k]) * t;
      s.tailBirthPosition[idx + j] = origin + s.headOffset[idx + j];
      s.tailBirthVelocity[idx + j] = velocity * TAIL_ENTRAIN + speed * (axis * s.tailCone[idx] + side1 * s.tailCone[idx + 1] + side2 * s.tailCone[idx + 2]);
      s.pointerOffset[idx + j] = 0;
      s.velocities[idx + j] = 0;
    }
    s.tailReady[i] = 1;
  }
  for (let j = 0; j < 3; j++) {
    out[j] = s.tailBirthPosition[idx + j] + s.tailBirthVelocity[idx + j] * age;
  }
  return tailFade(age / life);
}
function clampTo(v, hi) {
  if (!(v > 0)) return 0;
  return v < hi ? v : hi;
}
export class ParticleEngine {
  options;
  quality;
  roster;
  container;
  renderer;
  scene = new Scene();
  camera;
  points;
  geometry;
  material;
  /** Dev-observable: independent final GPU buffers, never glyph targets. */
  tailPoints;
  tailGeometry;
  tailMaterial;
  choreography;
  starfield;
  brandSource;
  ownsBrandSource;
  scratch;
  /** One object, mutated in place and republished every frame (see §6 item 2). */
  stats;
  running = false;
  rafId = 0;
  disposed = false;
  lastFrameMs = 0;
  dollySeconds = 0;
  reducedMotion;
  light;
  palette;
  width = 1;
  height = 1;
  fitGap = DOLLY_FROM_Z;
  fitDistance = DOLLY_FROM_Z;
  particleCount;
  tailSampleCount;
  frameTimes = new Float64Array(30);
  frameCount = 0;
  frameCursor = 0;
  pointer = { clientX: 0, clientY: 0, active: false, lastMove: 0 };
  pointerBound = false;
  currentBrandSlug = null;
  currentGlyphLeg = -1;
  /** Centre represented by the previous geometry upload, before internal offsets. */
  renderedHead = new Vector3();
  lastPhase = "travel";
  holdFade = 0;
  renderedPhase = "travel";
  constructor(options) {
    this.options = options;
    this.container = options.container;
    this.light = options.isLightTheme ?? false;
    this.reducedMotion = options.reducedMotion ?? false;
    this.palette = paletteFor(this.light);
    this.roster = options.brands.length > 0 ? options.brands : BRANDS;
    const probed = probeQualityProfile(
      typeof window === "undefined" ? 1280 : window.innerWidth
    );
    this.quality = createQualityProfile({ ...probed, ...options.quality });
    this.particleCount = Math.max(1, Math.floor(this.quality.particleCount));
    this.tailSampleCount = Math.max(8, Math.floor(this.quality.tailSampleCount));
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width || this.container.clientWidth || 1));
    this.height = Math.max(1, Math.floor(rect.height || this.container.clientHeight || 1));
    this.renderer = new WebGLRenderer({
      antialias: this.quality.antialias,
      alpha: true,
      powerPreference: "high-performance"
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxDpr));
    this.renderer.setSize(this.width, this.height, true);
    this.renderer.setClearColor(this.palette.background, this.light ? 1 : 0);
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.setAttribute("aria-hidden", "true");
    this.container.appendChild(canvas);
    this.camera = new PerspectiveCamera(
      CAMERA_FOV,
      this.width / this.height,
      CAMERA_NEAR,
      CAMERA_FAR
    );
    this.camera.position.set(0, 0, DOLLY_FROM_Z);
    this.scratch = createEngineScratch(this.particleCount, this.tailSampleCount);
    this.geometry = new BufferGeometry();
    const posAttr = new BufferAttribute(this.scratch.positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    const colAttr = new BufferAttribute(this.scratch.colors, 4);
    colAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("position", posAttr);
    this.geometry.setAttribute("color", colAttr);
    this.geometry.setAttribute("cometScale", new BufferAttribute(this.scratch.body.spriteScale, 1).setUsage(DynamicDrawUsage));
    this.geometry.boundingSphere = null;
    this.material = new PointsMaterial({
      map: acquireGlowTexture() ?? void 0,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: this.palette.blending,
      size: this.palette.pointSize,
      sizeAttenuation: true,
      opacity: this.palette.opacity
    });
    this.points = new Points(this.geometry, this.material);
    this.points.position.set(0, 0, SUBJECT_Z);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.tailGeometry = new BufferGeometry();
    this.tailGeometry.setAttribute("position", new BufferAttribute(this.scratch.emittedTail.positions, 3).setUsage(DynamicDrawUsage));
    this.tailGeometry.setAttribute("color", new BufferAttribute(this.scratch.emittedTail.colors, 4).setUsage(DynamicDrawUsage));
    this.tailMaterial = this.material.clone();
    this.tailMaterial.size = this.palette.pointSize * (this.light ? 1.05 : 3.6);
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute float cometScale;
${shader.vertexShader}`.replace(
        "gl_PointSize = size;",
        "gl_PointSize = size * cometScale;"
      );
    };
    this.material.customProgramCacheKey = () => "comet-body-coverage-v1";
    this.tailPoints = new Points(this.tailGeometry, this.tailMaterial);
    this.tailPoints.name = "causal-emitted-tail";
    this.tailPoints.frustumCulled = false;
    this.tailPoints.position.copy(this.points.position);
    this.scene.add(this.tailPoints);
    this.starfield = createStarfield({
      count: this.quality.starCount,
      reducedMotion: this.reducedMotion,
      isLightTheme: this.light
    });
    this.scene.add(this.starfield.object);
    this.choreography = createChoreography({
      brandCount: this.roster.length,
      amplitudeX: AMPLITUDE_X,
      // Space motion keeps the centre on Y=0 in every viewport.
      swayY: 0,
      swayZ: 0,
      legSeconds: LEG_SECONDS,
      gatherSeconds: GATHER_SECONDS,
      holdSeconds: HOLD_SECONDS,
      scatterSeconds: SCATTER_SECONDS
    });
    this.ownsBrandSource = !options.targetSource;
    this.brandSource = options.targetSource ?? createBrandTargetSource();
    this.stats = {
      fps: 0,
      particleCount: this.particleCount,
      phase: "travel",
      brandSlug: null,
      drawCalls: 0,
      triangles: 0,
      geometryBytes: 0
    };
    this.updateCameraFit();
    this.advanceCamera();
    const head = this.choreography.state;
    this.renderedHead.set(head.headX, head.headY, head.headZ);
    this.applyViewportSway();
    this.bindPointer();
    this.bindContextLoss();
    this.syncGlyph();
    this.prefetchAhead();
    if (import.meta.env.DEV) {
      const holder = window;
      holder.__SUB2API_PARTICLE_ENGINE__ = this;
    }
  }
  /** Dev-only: the live three.js objects, for the acceptance scripts. */
  get debugScene() {
    return { camera: this.camera, scene: this.scene, points: this.points };
  }
  /**
   * Dev-only: the renderer's current clear colour as a hex string.
   *
   * Read off the renderer rather than re-deriving it from the palette, so a
   * mismatch between what the theme set and what was actually applied is visible
   * to the acceptance probes. This is the colour that decides whether the canvas
   * sits *behind* the page or paints over it, which is a light-theme-only failure
   * that nothing else would catch.
   */
  debugRendererClearHex() {
    const out = new Color();
    this.renderer.getClearColor(out);
    return "#" + out.getHexString();
  }
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  start() {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastFrameMs = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }
  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
  setTheme(isLightTheme) {
    if (this.disposed || this.light === isLightTheme) return;
    this.light = isLightTheme;
    this.palette = paletteFor(isLightTheme);
    this.material.blending = this.palette.blending;
    this.material.size = this.palette.pointSize;
    this.material.opacity = this.palette.opacity;
    this.material.needsUpdate = true;
    this.tailMaterial.blending = this.palette.blending;
    this.tailMaterial.size = this.palette.pointSize * (this.light ? 1.05 : 3.6);
    this.tailMaterial.opacity = this.palette.opacity;
    this.tailMaterial.needsUpdate = true;
    this.renderer.setClearColor(this.palette.background, isLightTheme ? 1 : 0);
    this.starfield.setTheme(isLightTheme);
  }
  setReducedMotion(value) {
    if (this.disposed || this.reducedMotion === value) return;
    this.reducedMotion = value;
    this.starfield.setReducedMotion(value);
    this.updateCameraFit();
  }
  resize() {
    if (this.disposed) return;
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width || this.container.clientWidth || 1));
    const h = Math.max(1, Math.floor(rect.height || this.container.clientHeight || 1));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxDpr));
    this.renderer.setSize(w, h, true);
    this.updateCameraFit();
    this.applyViewportSway();
  }
  /** Resize changes camera framing, never the world route or its historical tail. */
  applyViewportSway() {
    this.choreography.setSwayY(0);
    fillEmissionTable(this.scratch.tailTable, this.choreography, this.scratch.probePoint);
  }
  getStats() {
    return this.stats;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.unbindPointer();
    this.unbindContextLoss();
    this.scene.remove(this.points);
    this.scene.remove(this.tailPoints);
    this.tailGeometry.dispose();
    this.tailMaterial.dispose();
    this.scene.remove(this.starfield.object);
    this.starfield.dispose();
    this.geometry.dispose();
    this.material.dispose();
    releaseGlowTexture();
    if (this.ownsBrandSource) this.brandSource.dispose();
    const canvas = this.renderer.domElement;
    canvas.parentNode?.removeChild(canvas);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (typeof window !== "undefined") {
      const holder = window;
      if (holder.__SUB2API_PARTICLE_STATS__ === this.stats) {
        holder.__SUB2API_PARTICLE_STATS__ = null;
      }
    }
  }
  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  bindPointer() {
    if (this.pointerBound) return;
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerleave", this.onPointerLeave);
    this.pointerBound = true;
  }
  unbindPointer() {
    if (!this.pointerBound) return;
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerleave", this.onPointerLeave);
    this.pointerBound = false;
  }
  onPointerMove = (event) => {
    this.pointer.clientX = event.clientX;
    this.pointer.clientY = event.clientY;
    this.pointer.active = true;
    this.pointer.lastMove = performance.now();
  };
  onPointerLeave = () => {
    this.pointer.active = false;
  };
  onContextLost = (event) => {
    event.preventDefault();
    this.stop();
    this.options.onError?.(new Error("ParticleEngine: WebGL context lost"));
  };
  bindContextLoss() {
    this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost, false);
  }
  unbindContextLoss() {
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost, false);
  }
  /**
   * How far the camera must sit from the CONTENT PLANE for the formed glyph to
   * clear both of the user's floors (V6): at least 2/3 of the viewport height and
   * at least 1/3 of its width.
   *
   * This used to be computed here from `GLYPH_HALF_EXTENT = 6.3`, which is a
   * pre-normalisation number (it describes the vendor's 12.6-unit icon square, and
   * 6.3 was only ever correct while the widest thing on screen was that square).
   * After the glyphs are levelled in `brandTargets.ts` the roster's real extents are
   * 7.006 (groq) to 16.479 (xiaomimimo) world units wide, so that constant was
   * describing a shape that no longer exists. It is `glyphSize.ts` that owns this
   * question now, and it answers it against the levelled `GLYPH_WORLD_HEIGHT` and
   * the roster's narrowest bbox aspect, which is the worst case over all 28 brands.
   *
   * The two constraints pull in OPPOSITE directions, which is the whole tension
   * here and worth stating plainly:
   *
   *   - the old `fitDistance` was a LOWER bound on the distance, because it was
   *     solving "the widest content must not overflow the frame" — a further camera
   *     draws everything smaller, so any distance at or beyond it was safe;
   *   - `fitDistanceForRoster` is an UPPER bound, because it is solving "the glyph
   *     must be at least 2/3 as tall as the viewport" — a further camera draws the
   *     glyph smaller, so the distance must be at or INSIDE it.
   *
   * A layout that satisfied the first by shoving the camera back therefore made the
   * second worse, and that is exactly the 0.28 height share the probe measured. The
   * fix is not a bigger margin, it is a nearer camera, and to keep the glyph inside
   * the frame at that nearer distance the patrol amplitude comes down (see
   * `AMPLITUDE_X`).
   *
   * On the one horizontal cost this leaves behind, stated rather than smoothed over:
   *
   *   - on a landscape viewport at the roster distance the frame is 21.168 world
   *     units wide, i.e. +/-10.584 across;
   *   - the widest brand, xiaomimimo, levels to 16.479 wide (half-width 8.24) and
   *     forms at x = +/-2.56, so its far edge reaches 10.800 — about 0.22 units, or
   *     1% of the frame width, past the edge. Every other brand fits.
   *
   * The brief's answer to that was a per-brand uniform shrink of about 3.5% for this
   * one glyph. That is deliberately NOT done here, because it would break a stronger
   * invariant than it repairs: `brandTargets` levels every mark to
   * `GLYPH_WORLD_HEIGHT` precisely so that ONE distance serves all 28 brands, and
   * both the unit spec and the acceptance probe assert the buffer's world height is
   * `GLYPH_WORLD_HEIGHT` within 0.005 / 0.05. A 3.5% shrink puts that readback at
   * 9.816 — a 0.264 miss on both. Paying 1% of overhang with an assertion about the
   * levelling contract would trade a cosmetic edge clip for a broken guarantee, so
   * the overhang is reported to the reviewer instead of being hidden.
   *
   * The `Math.max(0.2, ...)` floor stays because a zero or negative aspect would
   * otherwise divide the fit away and blank the canvas.
   */
  updateCameraFit() {
    const aspect = Math.max(0.2, this.width / this.height);
    const roster = fitDistanceForRoster(aspect, CAMERA_FOV);
    const binding = requiredGlyphWorldSize(aspect, CAMERA_FOV, roster, GLYPH_MIN_BBOX_ASPECT);
    this.fitGap = binding.binding === "height" ? roster / FRAME_MARGIN : roster;
    this.fitDistance = this.fitGap + SUBJECT_Z;
  }
  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------
  tick = () => {
    if (!this.running || this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);
    const now = performance.now();
    const delta = this.lastFrameMs === 0 ? 1 / 60 : (now - this.lastFrameMs) / 1e3;
    this.lastFrameMs = now;
    const frameStep = Math.min(Math.max(delta * 60, 1e-4), 2);
    const clockStep = Math.min(Math.max(delta, 0), MAX_CLOCK_STEP);
    try {
      this.advanceClock(clockStep);
      this.advanceCamera();
      this.writeEmissionTable();
      this.integrate(frameStep, now / 1e3, clockStep);
      this.upload();
      this.starfield.update(clockStep, this.camera.position.z, now / 1e3);
      this.renderer.render(this.scene, this.camera);
      this.publishStats(now);
    } catch (error) {
      this.stop();
      this.options.onError?.(error);
    }
  };
  advanceClock(delta) {
    if (!this.reducedMotion) this.choreography.update(delta);
    const state = this.choreography.state;
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase;
      this.options.onPhaseChange?.(state.phase);
    }
    const brand = this.roster[state.brandIndex % this.roster.length];
    if (brand && brand.slug !== this.currentBrandSlug) {
      this.currentBrandSlug = brand.slug;
      this.syncGlyph();
      this.options.onBrandChange?.(brand.slug, state.brandIndex);
    } else if (this.currentGlyphLeg !== state.legIndex) {
      this.syncGlyph();
    }
    this.prefetchAhead();
    if (!this.reducedMotion) this.dollySeconds += delta;
  }
  /** Queue the glyph after the current one, off the critical path. */
  prefetchAhead() {
    const state = this.choreography.state;
    if (state.phase !== "hold") return;
    const next = this.roster[(state.brandIndex + 1) % this.roster.length];
    if (next) {
      this.brandSource.prefetch(next.slug, this.particleCount, this.quality.iconCanvasSize);
    }
  }
  /**
   * Load the glyph for the current brand into scratch and bake its orbit field.
   *
   * The sampler works in its own glyph space, centred on `GLYPH_CENTER_X`; the
   * engine works in subject space, centred on the extreme the comet arrived at.
   * The shift happens here so every later stage (spring, orbit flow, colouring)
   * sees a single frame of reference.
   */
  syncGlyph() {
    const brand = this.roster[this.choreography.state.brandIndex % this.roster.length];
    if (!brand) return;
    const targets = this.brandSource.ensure(
      brand.slug,
      this.particleCount,
      this.quality.iconCanvasSize
    );
    if (!targets) return;
    const state = this.choreography.state;
    const amplitude = state.toX;
    const anchorZ = glyphStopZ(state.legIndex, SPACE_TIMING);
    const glyph = this.scratch.glyphTargets;
    const n = Math.min(this.particleCount, Math.floor(targets.targets.length / 3));
    for (let i = 0; i < n; i++) {
      glyph[i * 3] = targets.targets[i * 3] - GLYPH_CENTER_X + amplitude;
      glyph[i * 3 + 1] = targets.targets[i * 3 + 1];
      glyph[i * 3 + 2] = targets.targets[i * 3 + 2] + anchorZ;
    }
    for (let i = n; i < this.particleCount; i++) {
      glyph[i * 3] = amplitude;
      glyph[i * 3 + 1] = 0;
      glyph[i * 3 + 2] = anchorZ;
    }
    this.currentGlyphLeg = state.legIndex;
    this.scratch.glyphStrokeDepth.fill(0);
    this.scratch.glyphStrokeDepth.set(targets.strokeDepth.subarray(0, n));
    fillVoxSpaceIconOrbitField(
      this.scratch.iconOrbitField,
      targets.targets,
      targets.strokeDepth
    );
  }
  /**
   * Refill the emission table from the head's recent past.
   *
   * The whole method is the call to {@link fillEmissionTable}, which is a free
   * function so that it can be exercised against a synthetic path in a unit test —
   * this class cannot be constructed under jsdom, and the table's *sign conventions*
   * are the part of the new tail most likely to be got subtly wrong. Everything it
   * needs is preallocated in `scratch`, so the frame allocates nothing.
   */
  writeEmissionTable() {
    fillEmissionTable(this.scratch.tailTable, this.choreography, this.scratch.probePoint);
  }
  integrate(frameStep, time, delta = frameStep / 60) {
    const s = this.scratch;
    const positions = s.positions;
    const velocities = s.velocities;
    const colors = s.colors;
    const glyph = s.glyphTargets;
    const count = this.particleCount;
    const state = this.choreography.state;
    const palette = this.palette;
    const phase = state.phase;
    if (phase !== this.renderedPhase) {
      if (phase === "gather" || phase === "scatter") {
        s.shapeFrom.set(positions);
        if (phase === "gather") {
          for (let i = 0; i < count; i++) {
            s.shapeFrom[i * 3] += state.headX - this.renderedHead.x;
            s.shapeFrom[i * 3 + 1] += state.headY - this.renderedHead.y;
            s.shapeFrom[i * 3 + 2] += state.headZ - this.renderedHead.z;
          }
        }
        for (let i = 0; i < count; i++) {
          const spriteScale = s.body.spriteScale[i];
          s.shapeAlpha[i] = colors[i * 4 + 3] * spriteScale * spriteScale;
        }
        s.pointerOffset.fill(0);
        velocities.fill(0);
      }
      this.renderedPhase = phase;
    }
    const shapeProgress = phase === "scatter" ? clamp01(state.phaseProgress / COALESCE_END) : state.phaseProgress;
    let glyphMix = glyphMixFor(phase, shapeProgress);
    if (this.reducedMotion) glyphMix = glyphMix > 0.5 ? 1 : 0;
    if (glyphMix > 1e-3) {
      fillVoxSpaceIconOrbitOffsets(s.iconOrbitOffsets, s.iconOrbitField, time, glyphMix);
    }
    const followSpeed = this.reducedMotion ? FOLLOW_TRAVEL * 0.6 : followSpeedFor(phase);
    const friction = phase === "hold" ? getVoxSpaceHoldFrameFriction(frameStep) : Math.pow(FRICTION, frameStep);
    this.holdFade = nextVoxSpaceIconHoldFade(this.holdFade, glyphMix, frameStep);
    writeVoxSpaceIconHoldPose(s.iconHoldPose, time, this.holdFade);
    this.points.rotation.set(0, 0, 0);
    let pointerActive = isVoxSpacePointerActive(
      this.pointer.active,
      this.pointer.lastMove,
      performance.now()
    );
    if (pointerActive) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const ndc = s.vecA.set(
          (this.pointer.clientX - rect.left) / rect.width * 2 - 1,
          -((this.pointer.clientY - rect.top) / rect.height * 2 - 1),
          0.5
        );
        ndc.unproject(this.camera);
        const dir = s.vecB.copy(ndc).sub(this.camera.position);
        const dirZ = dir.z;
        dir.normalize();
        const planeZ = this.points.position.z + state.headZ;
        const distance = dirZ === 0 ? -1 : (planeZ - this.camera.position.z) / dir.z;
        if (Number.isFinite(distance) && distance > 0) {
          const world = s.vecA.copy(this.camera.position).addScaledVector(dir, distance).sub(this.points.position);
          s.inverseRotation.copy(this.points.quaternion).invert();
          world.applyQuaternion(s.inverseRotation);
          s.pointerField.localX = world.x;
          s.pointerField.localY = world.y;
          s.pointerField.localZ = world.z;
          s.pointerField.time = time;
        } else {
          pointerActive = false;
        }
      } else {
        pointerActive = false;
      }
    }
    const useHoldStep = phase === "hold" && glyphMix > 0.5;
    const cometMix = 1 - glyphMix;
    const bodyMaterial = this.points.material;
    bodyMaterial.size = palette.pointSize;
    const table = s.tailTable;
    const departure = departureSeconds(phase, state.phaseProgress, LEG_SECONDS, SCATTER_SECONDS);
    const moving = Math.hypot(table.vel[0], table.vel[1], table.vel[2]) > 1e-6;
    s.emittedTail.update(
      delta,
      departure,
      departure > 0 && moving && !this.reducedMotion,
      table,
      state.headX,
      state.headY,
      state.headZ,
      palette.core,
      palette.accent,
      this.light
    );
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const px = positions[idx];
      const py = positions[idx + 1];
      const pz = positions[idx + 2];
      const cometX = state.headX + s.body.offsets[idx];
      const cometY = state.headY + s.body.offsets[idx + 1];
      const cometZ = state.headZ + s.body.offsets[idx + 2];
      const emit = s.body.alpha[i] * (this.light ? 1.7 : 1);
      let tx = cometX;
      let ty = cometY;
      let tz = cometZ;
      const mix = this.reducedMotion ? glyphMix : staggeredGlyphMix(phase, shapeProgress, i);
      let alpha = emit;
      if (phase === "gather") {
        tx = s.shapeFrom[idx] + (glyph[idx] + s.iconOrbitOffsets[idx] - s.shapeFrom[idx]) * mix;
        ty = s.shapeFrom[idx + 1] + (glyph[idx + 1] + s.iconOrbitOffsets[idx + 1] - s.shapeFrom[idx + 1]) * mix;
        tz = s.shapeFrom[idx + 2] + (glyph[idx + 2] + s.iconOrbitOffsets[idx + 2] - s.shapeFrom[idx + 2]) * mix;
        alpha = s.shapeAlpha[i] + (1 - s.shapeAlpha[i]) * mix;
      } else if (phase === "scatter") {
        const bend = Math.sin(Math.PI * mix) * (s.tailSeed[i] - 0.5) * 0.16;
        tx += (s.shapeFrom[idx] - cometX) * mix - (s.shapeFrom[idx + 1] - cometY) * bend;
        ty += (s.shapeFrom[idx + 1] - cometY) * mix + (s.shapeFrom[idx] - cometX) * bend;
        tz += (s.shapeFrom[idx + 2] - cometZ) * mix + Math.sin(Math.PI * mix) * (s.tailSeed[i] - 0.5) * 0.22;
        alpha = emit + (s.shapeAlpha[i] - emit) * mix * mix;
      } else if (phase === "hold") {
        tx = glyph[idx] + s.iconOrbitOffsets[idx];
        ty = glyph[idx + 1] + s.iconOrbitOffsets[idx + 1];
        tz = glyph[idx + 2] + s.iconOrbitOffsets[idx + 2];
        alpha = 1;
      }
      let vx = velocities[idx];
      let vy = velocities[idx + 1];
      let vz = velocities[idx + 2];
      if (useHoldStep) {
        stepVoxSpaceHoldParticle(velocities, idx, px, py, pz, tx, ty, tz, followSpeed, frameStep);
        vx = velocities[idx];
        vy = velocities[idx + 1];
        vz = velocities[idx + 2];
      } else {
        vx = vx * COMET_VELOCITY_MEMORY - s.pointerOffset[idx] * followSpeed * frameStep;
        vy = vy * COMET_VELOCITY_MEMORY - s.pointerOffset[idx + 1] * followSpeed * frameStep;
        vz = vz * COMET_VELOCITY_MEMORY - s.pointerOffset[idx + 2] * followSpeed * frameStep;
        velocities[idx] = vx;
        velocities[idx + 1] = vy;
        velocities[idx + 2] = vz;
      }
      if (pointerActive) {
        applyVoxSpacePointerPush(velocities, idx, px, py, pz, i / count, s.pointerField);
        vx = velocities[idx];
        vy = velocities[idx + 1];
        vz = velocities[idx + 2];
      }
      vx *= friction;
      vy *= friction;
      vz *= friction;
      velocities[idx] = vx;
      velocities[idx + 1] = vy;
      velocities[idx + 2] = vz;
      if (!useHoldStep) {
        s.pointerOffset[idx] += vx;
        s.pointerOffset[idx + 1] += vy;
        s.pointerOffset[idx + 2] += vz;
      }
      const nx = useHoldStep ? px + vx : tx + s.pointerOffset[idx];
      const ny = useHoldStep ? py + vy : ty + s.pointerOffset[idx + 1];
      const nz = useHoldStep ? pz + vz : tz + s.pointerOffset[idx + 2];
      positions[idx] = nx;
      positions[idx + 1] = ny;
      positions[idx + 2] = nz;
      const warm = glyphMix * 0.26 + cometMix * 0.045;
      const depth = Math.max(-1, Math.min(1, (nz - state.headZ) / 1.4)) * this.holdFade;
      const shimmer = 0.86 + Math.sin(time * 2.1 + s.tailSeed[i] * 43) * 0.05 + depth * 0.08;
      const w = warm;
      const lum = (glyphMix * 1.14 + cometMix * s.body.tone[i] + Math.abs(depth) * 0.06) * shimmer * palette.gain;
      let cr = (palette.core.r + (palette.accent.r - palette.core.r) * w) * lum;
      let cg = (palette.core.g + (palette.accent.g - palette.core.g) * w) * lum;
      let cb = (palette.core.b + (palette.accent.b - palette.core.b) * w) * lum;
      const nucleus = s.body.spriteSize[i] < 3;
      if (this.light) {
        const ink = nucleus ? 1 - cometMix * 0.72 : 1;
        cr *= ink;
        cg *= ink;
        cb *= ink;
      } else {
        cr *= 1 + cometMix * (nucleus ? 0.04 : -0.72);
        cg *= 1 + cometMix * (nucleus ? 0 : -0.18);
        cb *= 1 + cometMix * (nucleus ? -0.12 : 0.18);
      }
      const cap = this.light ? 0.82 : 1.4;
      const colorIndex = i * 4;
      colors[colorIndex] = cr > cap ? cap : cr;
      colors[colorIndex + 1] = cg > cap ? cap : cg;
      colors[colorIndex + 2] = cb > cap ? cap : cb;
      const spriteScale = 1 + cometMix * (this.light ? 0.35 : s.body.spriteSize[i] - 1);
      s.body.spriteScale[i] = spriteScale;
      colors[colorIndex + 3] = alpha / (spriteScale * spriteScale);
    }
    this.renderedHead.set(state.headX, state.headY, state.headZ);
  }
  upload() {
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.getAttribute("color").needsUpdate = true;
    this.geometry.getAttribute("cometScale").needsUpdate = true;
    this.tailGeometry.getAttribute("position").needsUpdate = true;
    this.tailGeometry.getAttribute("color").needsUpdate = true;
  }
  /** Camera retreats indefinitely while both particle pools keep a fixed origin. */
  advanceCamera() {
    const cameraZ = this.fitDistance + cameraTravelAt(this.dollySeconds);
    this.camera.position.set(0, 0, cameraZ);
    this.camera.quaternion.identity();
    this.camera.updateMatrixWorld();
  }
  publishStats(now) {
    this.frameTimes[this.frameCursor] = now;
    this.frameCursor = (this.frameCursor + 1) % this.frameTimes.length;
    if (this.frameCount < this.frameTimes.length) this.frameCount += 1;
    if (this.frameCount > 1) {
      const oldest = this.frameCount < this.frameTimes.length ? this.frameTimes[0] : this.frameTimes[this.frameCursor];
      const span = now - oldest;
      if (span > 0) this.stats.fps = (this.frameCount - 1) * 1e3 / span;
    }
    const info = this.renderer.info;
    this.stats.particleCount = this.particleCount;
    this.stats.phase = this.choreography.state.phase;
    this.stats.brandSlug = this.currentBrandSlug;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.geometryBytes = this.geometry.getAttribute("position").array.byteLength + this.geometry.getAttribute("color").array.byteLength + this.geometry.getAttribute("cometScale").array.byteLength + this.tailGeometry.getAttribute("position").array.byteLength + this.tailGeometry.getAttribute("color").array.byteLength;
    if (typeof window !== "undefined") {
      const holder = window;
      holder.__SUB2API_PARTICLE_STATS__ = this.stats;
    }
  }
}

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIlBhcnRpY2xlRW5naW5lLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTEFORSBMMSDigJQgdGhlIHJlbmRlciBlbmdpbmUuXG4gKlxuICogUG9ydHMgR2xvcnlDb2RlJ3MgUmVhY3QvUjNGIHBhcnRpY2xlIHJlbmRlciBsb29wIHRvIGEgZnJhbWV3b3JrLWFnbm9zdGljXG4gKiB0aHJlZS5qcyBjbGFzcy4gVGhlIFIzRiBzaGVsbCBpcyBnb25lOyB0aGUgbWF0aCBpcyBub3Qg4oCUIGV2ZXJ5IHBlci1wYXJ0aWNsZVxuICogcnVsZSAoYm91bmRlZCBvcmJpdCBmbG93IHdoaWxlIGhvbGRpbmcsIHBvaW50ZXIgcHVzaCwgaG9sZCBzcHJpbmcsIGhvbGQgcG9zZSlcbiAqIGNvbWVzIGZyb20gYHZlbmRvci92b3hzcGFjZS1tYXRoLnRzYCwgdGhlIHNhbWUgY29kZSB0aGUgcmVmZXJlbmNlIGRyaXZlcy5cbiAqXG4gKiBXaGF0IHRoZSByZWZlcmVuY2UgZG9lcyBOT1QgaGF2ZSwgYW5kIHdoYXQgdGhpcyBmaWxlIGFkZHMsIGlzIHRoZSBjaG9yZW9ncmFwaHlcbiAqIHRoZSB1c2VyIGFza2VkIGZvcjogYSBjb21ldCB3aXRoIGEgdGFpbCBzd2VlcGluZyBhbiBTLWN1cnZlLCBnYXRoZXJpbmcgaW50byBhXG4gKiBicmFuZCBnbHlwaCBhdCBlYWNoIGV4dHJlbWUsIGhvbGRpbmcgdGhhdCBnbHlwaCBmb3IgdGhyZWUgc2Vjb25kcyB3aGlsZSB0aGVcbiAqIHBhcnRpY2xlcyBrZWVwIGZsb3dpbmcgaW5zaWRlIHRoZSBzaGFwZSwgdGhlbiBzY2F0dGVyaW5nIGJhY2sgaW50byBhIGNvbWV0IOKAlFxuICogdW5kZXIgYSBjYW1lcmEgdGhhdCBrZWVwcyBwdWxsaW5nIGJhY2sgdGhyb3VnaCBhIGRlZXAgc3RhcmZpZWxkLlxuICpcbiAqIFRoZSB0YWlsIGlzICoqZW1pdHRlZCoqLCBub3QgZHJhZ2dlZC4gRXZlcnkgdGFpbCBwYXJ0aWNsZSBpcyBib3JuIGluc2lkZSB0aGUgbnVjbGV1cyxcbiAqIGhhbmRlZCBhIHZlbG9jaXR5LCBnaXZlbiBhIGxpZmV0aW1lLCBhbmQgZmFkZXMgdG8gbm90aGluZyBhcyB0aGF0IGxpZmV0aW1lIHJ1bnMgb3V0O1xuICogaXRzIHBvc2l0aW9uIGlzIGEgY2xvc2VkIGZvcm0gZXZhbHVhdGVkIGVhY2ggZnJhbWUgZnJvbSB0aGUgZW1pc3Npb24gdGFibGUuIEl0c1xuICogcHJlZGVjZXNzb3Igd2FzIGEgcmlnaWQgcmliYm9uIG9mIHBhcnRpY2xlcyBwaW5uZWQgdG8gZml4ZWQgYXJjLWxlbmd0aCBzbG90cyBvbiB0aGVcbiAqIGhlYWQncyBwYXN0IHBhdGgsIHdoaWNoIHRoZSB1c2VyIHJlamVjdGVkIGFzIHVucmVhZGFibGUgKFwi5b2X5pif5ZKM5b2X5bC+55yL5LiN5Ye65p2l5piv5LuA5LmIXG4gKiDkuJzopb/igKblrozlhajmsqHmnInlvZfmmJ/nmoTnnJ/lrp7mhJ9cIikgYmVjYXVzZSBhIGZpeGVkIHNsb3QgaXMgYSBmaXhlZCAqZ2VvbWV0cnkqIOKAlCB0aGUgd2hvbGVcbiAqIHRhaWwgdHJhbnNsYXRlZCBhcyBvbmUgYm9keS4gU2VlIHRoZSBgLy8gLS0tIFRhaWwgZW1pc3Npb24gKFYyKSAtLS1gIHNlY3Rpb24gb2ZcbiAqIGBjb25zdGFudHMudHNgIGZvciB0aGUgbW9kZWwgYW5kIHRoZSBtZWFzdXJlZCBudW1iZXJzIGJlaGluZCBpdC5cbiAqXG4gKiBQZXJmb3JtYW5jZSBydWxlcyB0aGF0IGxpdmUgaGVyZSAoSE9NRS1QQVJUSUNMRS1ERVNJR04ubWQgwqc2KTpcbiAqICAgLSBvbmUgQnVmZmVyR2VvbWV0cnksIHBvc2l0aW9ucy9jb2xvcnMgdXBkYXRlZCBpbiBwbGFjZSwgb25lIGRyYXcgY2FsbFxuICogICAtIHplcm8gcGVyLWZyYW1lIGFsbG9jYXRpb246IGV2ZXJ5IGJ1ZmZlciBpcyBwcmVhbGxvY2F0ZWQgaW4gYHNjcmF0Y2hgLCBpbmNsdWRpbmdcbiAqICAgICB0aGUgcGVyLXBhcnRpY2xlIGFnZS9saWZlL3JlYWNoL2NvbmUgYXJyYXlzIHRoZSBlbWlzc2lvbiBtb2RlbCBuZWVkcywgYW5kXG4gKiAgICAgYHNhbXBsZVRyYWlsYCBpcyBldmFsdWF0ZWQgYHRhaWxTYW1wbGVDb3VudGAgdGltZXMgcGVyIGZyYW1lIGludG8gdGhlIGVtaXNzaW9uXG4gKiAgICAgdGFibGUgdGhlIHBhcnRpY2xlcyBpbmRleCDigJQgbm90IG9uY2UgcGVyIHBhcnRpY2xlXG4gKiAgIC0gYGZyYW1lU3RlcCA9IG1pbihkdCAqIDYwLCAyKWAgc28gYmVoYXZpb3VyIGlzIGZyYW1lcmF0ZSBpbmRlcGVuZGVudFxuICogICAtIGBzdG9wKClgIGNhbmNlbHMgdGhlIHJBRiwgaXQgZG9lcyBub3QgbWVyZWx5IHNraXAgdGhlIHJlbmRlclxuICogICAtIGBkaXNwb3NlKClgIHJlbGVhc2VzIGdlb21ldHJ5LCBtYXRlcmlhbCwgdGV4dHVyZSwgcmVuZGVyZXIgYW5kIGV2ZXJ5IGxpc3RlbmVyXG4gKlxuICogV2l0aG91dCBhIFdlYkdMIGNvbnRleHQgKGpzZG9tLCBhbiBvbGQgYnJvd3NlciwgYSBkcml2ZXIgdGhhdCByZWZ1c2VzKSB0aGVcbiAqIGNvbnN0cnVjdG9yIHRocm93cyBhbmQgdGhlIGNhbGxlciBzaG93cyBpdHMgZmxhdCBmYWxsYmFjay4gVGhhdCBpcyBkZWxpYmVyYXRlOlxuICogYSBoYWxmLWJ1aWx0IGVuZ2luZSB0aGF0IHNpbGVudGx5IHJlbmRlcnMgbm90aGluZyBpcyB3b3JzZSB0aGFuIGFuIGVycm9yIHRoZVxuICogc2hlbGwgY2FuIHJlYWN0IHRvLlxuICovXG5pbXBvcnQge1xuICBBZGRpdGl2ZUJsZW5kaW5nLFxuICBCdWZmZXJBdHRyaWJ1dGUsXG4gIEJ1ZmZlckdlb21ldHJ5LFxuICBDYW52YXNUZXh0dXJlLFxuICBDb2xvcixcbiAgRHluYW1pY0RyYXdVc2FnZSxcbiAgTm9ybWFsQmxlbmRpbmcsXG4gIFBlcnNwZWN0aXZlQ2FtZXJhLFxuICBQb2ludHMsXG4gIFBvaW50c01hdGVyaWFsLFxuICBRdWF0ZXJuaW9uLFxuICBTY2VuZSxcbiAgVmVjdG9yMyxcbiAgV2ViR0xSZW5kZXJlcixcbn0gZnJvbSAndGhyZWUnXG5cbmltcG9ydCB7XG4gIGFwcGx5Vm94U3BhY2VQb2ludGVyUHVzaCxcbiAgY2xhbXAwMSxcbiAgY3JlYXRlSW5pdGlhbFNjYXR0ZXJUYXJnZXRzLFxuICBjcmVhdGVWb3hTcGFjZUljb25PcmJpdEZpZWxkLFxuICBmaWxsVm94U3BhY2VJY29uT3JiaXRGaWVsZCxcbiAgZmlsbFZveFNwYWNlSWNvbk9yYml0T2Zmc2V0cyxcbiAgZ2V0Vm94U3BhY2VIb2xkRnJhbWVGcmljdGlvbixcbiAgaXNWb3hTcGFjZVBvaW50ZXJBY3RpdmUsXG4gIG5leHRWb3hTcGFjZUljb25Ib2xkRmFkZSxcbiAgc21vb3RoZXJTdGVwLFxuICBzdGVwVm94U3BhY2VIb2xkUGFydGljbGUsXG4gIHdyaXRlVm94U3BhY2VJY29uSG9sZFBvc2UsXG4gIHR5cGUgVm94U3BhY2VJY29uSG9sZFBvc2UsXG4gIHR5cGUgVm94U3BhY2VJY29uT3JiaXRGaWVsZCxcbiAgdHlwZSBWb3hTcGFjZVBvaW50ZXJGaWVsZCxcbn0gZnJvbSAnLi4vdmVuZG9yL3ZveHNwYWNlLW1hdGgnXG5cbmltcG9ydCB7IGNyZWF0ZUJyYW5kVGFyZ2V0U291cmNlIH0gZnJvbSAnLi9icmFuZFRhcmdldHMnXG5pbXBvcnQgeyBFbWl0dGVkVGFpbCwgY3JlYXRlQ29tZXRCb2R5IH0gZnJvbSAnLi9lbWl0dGVkVGFpbCdcbmltcG9ydCB7IGNyZWF0ZUNob3Jlb2dyYXBoeSwgc3RhZ2dlcmVkR2x5cGhNaXgsIHR5cGUgUG9pbnQzIH0gZnJvbSAnLi9jaG9yZW9ncmFwaHknXG5pbXBvcnQge1xuICBBTVBMSVRVREVfWCxcbiAgQlJBTkRTLFxuICBDQU1FUkFfRkFSLFxuICBDQU1FUkFfRk9WLFxuICBDQU1FUkFfTkVBUixcbiAgRE9MTFlfRlJPTV9aLFxuICBGUklDVElPTixcbiAgR0FUSEVSX1NFQ09ORFMsXG4gIEhFQURfQ09SRV9SQURJVVMsXG4gIEhFQURfQ09SRV9TSEFSRSxcbiAgSE9MRF9TRUNPTkRTLFxuICBMRUdfU0VDT05EUyxcbiAgUE9JTlRFUl9SQURJVVMsXG4gIFNDQVRURVJfU0VDT05EUyxcbiAgU1VCSkVDVF9aLFxuICBUQUlMX0RVU1RfTElGRV9NQVgsXG4gIFRBSUxfRFVTVF9MSUZFX01JTixcbiAgVEFJTF9EVVNUX1JFQUNIX01BWCxcbiAgVEFJTF9EVVNUX1JFQUNIX01JTixcbiAgVEFJTF9FTlRSQUlOLFxuICBUQUlMX0ZBREVfUE9XRVIsXG4gIFRBSUxfRklMTCxcbiAgVEFJTF9JT05fTElGRV9NQVgsXG4gIFRBSUxfSU9OX0xJRkVfTUlOLFxuICBUQUlMX0lPTl9OQVJST1csXG4gIFRBSUxfSU9OX1JFQUNIX01BWCxcbiAgVEFJTF9JT05fUkVBQ0hfTUlOLFxuICBUQUlMX0lPTl9TSEFSRSxcbiAgVEFJTF9TRUNPTkRTLFxuICBUQUlMX1NQRUVEX0pJVFRFUixcbiAgVEFJTF9TUFJFQUQsXG59IGZyb20gJy4vY29uc3RhbnRzJ1xuaW1wb3J0IHsgQ09BTEVTQ0VfRU5ELCBkZXBhcnR1cmVTZWNvbmRzIH0gZnJvbSAnLi9mbGlnaHRUaW1pbmcnXG5pbXBvcnQgeyBjYW1lcmFUcmF2ZWxBdCwgZ2x5cGhTdG9wWiB9IGZyb20gJy4vc3BhY2VNb3Rpb24nXG5pbXBvcnQgeyBjcmVhdGVRdWFsaXR5UHJvZmlsZSwgcHJvYmVRdWFsaXR5UHJvZmlsZSB9IGZyb20gJy4vcXVhbGl0eSdcbmltcG9ydCB7IEdMWVBIX01JTl9CQk9YX0FTUEVDVCwgZml0RGlzdGFuY2VGb3JSb3N0ZXIsIHJlcXVpcmVkR2x5cGhXb3JsZFNpemUgfSBmcm9tICcuL2dseXBoU2l6ZSdcbmltcG9ydCB7IGNyZWF0ZVN0YXJmaWVsZCB9IGZyb20gJy4vc3RhcmZpZWxkJ1xuaW1wb3J0IHR5cGUge1xuICBCcmFuZFRhcmdldFNvdXJjZSxcbiAgQ2hvcmVvZ3JhcGh5LFxuICBDb21ldFBoYXNlLFxuICBFbmdpbmVTdGF0cyxcbiAgUGFydGljbGVFbmdpbmVDb250cmFjdCxcbiAgUGFydGljbGVFbmdpbmVPcHRpb25zLFxuICBRdWFsaXR5UHJvZmlsZSxcbiAgU3RhcmZpZWxkLFxufSBmcm9tICcuL3R5cGVzJ1xuXG5jb25zdCBTUEFDRV9USU1JTkcgPSB7XG4gIGxlZ1NlY29uZHM6IExFR19TRUNPTkRTLFxuICBnYXRoZXJTZWNvbmRzOiBHQVRIRVJfU0VDT05EUyxcbiAgaG9sZFNlY29uZHM6IEhPTERfU0VDT05EUyxcbiAgc2NhdHRlclNlY29uZHM6IFNDQVRURVJfU0VDT05EUyxcbn1cblxuLyoqIFdoZXJlIHRoZSB2ZW5kb3IncyBnbHlwaCBzYW1wbGVyIGNlbnRyZXMgYSBnbHlwaCwgaW4gaXRzIG93biB1bml0cy4gKi9cbmNvbnN0IEdMWVBIX0NFTlRFUl9YID0gNS44XG4vKipcbiAqIEhlYWRyb29tIG9uIHRoZSBIRUlHSFQgZmxvb3IsIHNvIHRoZSBnbHlwaCBuZXZlciBsYW5kcyBleGFjdGx5IG9uIHRoZSAyLzMgbGluZS5cbiAqXG4gKiBgZml0RGlzdGFuY2VGb3JSb3N0ZXJgIHJldHVybnMgdGhlIGxhcmdlc3QgZGlzdGFuY2UgYXQgd2hpY2ggdGhlIGdseXBoIHN0aWxsXG4gKiBjbGVhcnMgYm90aCBmbG9vcnMsIHNvIHNpdHRpbmcgb24gaXQgbGVhdmVzIHRoZSBiaW5kaW5nIGZsb29yIEVRVUFMIHRvIHRoZSB1c2VyJ3NcbiAqIG51bWJlciB3aXRoIG5vdGhpbmcgbGVmdCBvdmVyLiBUaGUgbWVhc3VyZWQgY2xvdWQgc2l0cyBhIHBlcmNlbnQgb3IgdHdvIGluc2lkZVxuICogaXRzIG93biBhbmNob3IgYm94LCBzbyB0aGUgcmVhbCBzaGFyZSByZWFkcyB1bmRlciB0aGUgaWRlYWwg4oCUIHRoZSBwcm9iZSBtZWFzdXJlZFxuICogcG9ydHJhaXQgdmlld3BvcnRzIGF0IDAuNjQ5Ny4uMC42NTcwIGFnYWluc3QgYSAwLjY2NjcgZmxvb3Igd2hlbiB0aGUgaWRlYWwgd2FzXG4gKiBleGFjdGx5IDAuNjY2Ny4gQmVpbmcgMTIlIG5lYXJlciBwdXRzIHRoZSBpZGVhbCBhdCAwLjc0NjcsIGNsZWFyIG9mIHRoZSBmbG9vclxuICogd2l0aCB0aGUgY2xvdWQncyBvd24gc3ByZWFkIGFic29yYmVkLlxuICpcbiAqIEFwcGxpZWQgb25seSB3aGVuIHRoZSBoZWlnaHQgZmxvb3IgaXMgdGhlIGJpbmRpbmcgb25lIOKAlCBzZWUgYHVwZGF0ZUNhbWVyYUZpdGAuXG4gKiBJdCBpcyBub3QgYSB3aWR0aCBhbGxvd2FuY2UuICovXG5jb25zdCBGUkFNRV9NQVJHSU4gPSAxLjEyXG4vLyBUaGUgb3RoZXIgZnJhbWluZyBjb25zdGFudCB0aGF0IHVzZWQgdG8gbGl2ZSBoZXJlLCBgR0xZUEhfSEFMRl9FWFRFTlQgPSA2LjNgLCBpc1xuLy8gZ29uZSByYXRoZXIgdGhhbiBtZXJlbHkgdW51c2VkLCBhbmQgZGVsaWJlcmF0ZWx5IG5vdCByZXBsYWNlZCBieSBhbiBlcXVpdmFsZW50LlxuLy9cbi8vIEl0IGRlc2NyaWJlZCBoYWxmIG9mIHRoZSB2ZW5kb3IncyAxMi42LXVuaXQgaWNvbiBzcXVhcmUsIHdoaWNoIHdhcyB0aGUgd2lkZXN0XG4vLyB0aGluZyBvbiBzY3JlZW4gb25seSB1bnRpbCBgYnJhbmRUYXJnZXRzLnRzYCBiZWdhbiBsZXZlbGxpbmcgZXZlcnkgbWFyayB0b1xuLy8gYEdMWVBIX1dPUkxEX0hFSUdIVGAuIFRoZSByb3N0ZXIncyByZWFsIHdpZHRocyBhcmUgbm93IDcuMDA2Li4xNi40NzksIHNvIHRoZVxuLy8gY29uc3RhbnQgd2FzIHNpemluZyBhIHNoYXBlIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cy4gVGhlIGZyYW1pbmcgcXVlc3Rpb24gaXNcbi8vIGBnbHlwaFNpemUudHNgJ3Mgbm93IOKAlCBzZWUgYHVwZGF0ZUNhbWVyYUZpdGAuXG5cbi8qKiBDYXAgb24gdGhlIHBlci1mcmFtZSBzdGVwIGZlZCB0byB0aGUgcGhhc2UgY2xvY2ssIGluIHNlY29uZHMuIEEgdGFiIHRoYXQgd2FzXG4gKiAgYXNsZWVwIG11c3Qgbm90IHNraXAgYSB3aG9sZSBiZWF0OiBydW5uaW5nIGJyaWVmbHkgc2xvdyBiZWF0cyBqdW1waW5nLiAqL1xuY29uc3QgTUFYX0NMT0NLX1NURVAgPSAwLjFcbi8qKiBWZWxvY2l0eSBtZW1vcnkgZm9yIHRoZSBjb21ldCBwaGFzZXMsIG1hdGNoaW5nIHRoZSB2ZW5kb3JlZCBob2xkIHNwcmluZy4gKi9cbmNvbnN0IENPTUVUX1ZFTE9DSVRZX01FTU9SWSA9IDAuMjZcbi8qKiBTcHJpbmcgc3RpZmZuZXNzIHBlciBwaGFzZS4gVGhlIGhvbGQgaXMgc3RpZmZlc3QsIHdoaWNoIGlzIHdoYXQgbWFrZXMgYSBmb3JtZWRcbiAqICBnbHlwaCByZWFkIGFzIHNvbGlkIHJhdGhlciB0aGFuIGFzIGEgY2xvdWQgcGFzc2luZyB0aHJvdWdoIGl0LiAqL1xuY29uc3QgRk9MTE9XX1RSQVZFTCA9IDAuMDU1XG5jb25zdCBGT0xMT1dfR0FUSEVSID0gMC4xXG5jb25zdCBGT0xMT1dfSE9MRCA9IDAuMTA1XG5jb25zdCBGT0xMT1dfU0NBVFRFUiA9IDAuMDg1XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR2xvdyBzcHJpdGUg4oCUIG9uZSBwZXIgcHJvY2VzcywgcmVmY291bnRlZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmxldCBzaGFyZWRHbG93OiBDYW52YXNUZXh0dXJlIHwgbnVsbCA9IG51bGxcbmxldCBnbG93UmVmcyA9IDBcblxuLyoqXG4gKiBTb2Z0IHJhZGlhbCBzcHJpdGUgZm9yIGV2ZXJ5IHBhcnRpY2xlLiBTaGFyZWQgYmVjYXVzZSBhIHBlci1lbmdpbmUgY29weSB3b3VsZCBiZVxuICogaWRlbnRpY2FsIGJ5dGVzIGFuZCBhIHNlY29uZCBHUFUgdXBsb2FkOyByZWZjb3VudGVkIGJlY2F1c2UgYW4gSE1SIHJlbW91bnQgbXVzdFxuICogbm90IGRpc3Bvc2UgdGhlIHRleHR1cmUgYSBzdGlsbC1ydW5uaW5nIGVuZ2luZSBwb2ludHMgYXQuXG4gKi9cbmZ1bmN0aW9uIGFjcXVpcmVHbG93VGV4dHVyZSgpOiBDYW52YXNUZXh0dXJlIHwgbnVsbCB7XG4gIGlmIChzaGFyZWRHbG93KSB7XG4gICAgZ2xvd1JlZnMgKz0gMVxuICAgIHJldHVybiBzaGFyZWRHbG93XG4gIH1cblxuICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKVxuICBjYW52YXMud2lkdGggPSAxMjhcbiAgY2FudmFzLmhlaWdodCA9IDEyOFxuICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKVxuICBpZiAoIWN0eCkgcmV0dXJuIG51bGxcblxuICBjb25zdCBncmFkaWVudCA9IGN0eC5jcmVhdGVSYWRpYWxHcmFkaWVudCg2NCwgNjQsIDAsIDY0LCA2NCwgNjQpXG4gIGdyYWRpZW50LmFkZENvbG9yU3RvcCgwLCAncmdiYSgyNTUsMjU1LDI1NSwxKScpXG4gIGdyYWRpZW50LmFkZENvbG9yU3RvcCgwLjE2LCAncmdiYSgyNTUsMjU1LDI1NSwuOTgpJylcbiAgZ3JhZGllbnQuYWRkQ29sb3JTdG9wKDAuNDIsICdyZ2JhKDI1NSwyNTUsMjU1LC41OCknKVxuICBncmFkaWVudC5hZGRDb2xvclN0b3AoMC43MiwgJ3JnYmEoMjU1LDI1NSwyNTUsLjIwKScpXG4gIGdyYWRpZW50LmFkZENvbG9yU3RvcCgxLCAncmdiYSgyNTUsMjU1LDI1NSwwKScpXG4gIGN0eC5maWxsU3R5bGUgPSBncmFkaWVudFxuICBjdHguZmlsbFJlY3QoMCwgMCwgMTI4LCAxMjgpXG5cbiAgY29uc3QgdGV4dHVyZSA9IG5ldyBDYW52YXNUZXh0dXJlKGNhbnZhcylcbiAgdGV4dHVyZS5uZWVkc1VwZGF0ZSA9IHRydWVcbiAgc2hhcmVkR2xvdyA9IHRleHR1cmVcbiAgZ2xvd1JlZnMgKz0gMVxuICByZXR1cm4gdGV4dHVyZVxufVxuXG5mdW5jdGlvbiByZWxlYXNlR2xvd1RleHR1cmUoKTogdm9pZCB7XG4gIGdsb3dSZWZzID0gTWF0aC5tYXgoMCwgZ2xvd1JlZnMgLSAxKVxuICBpZiAoZ2xvd1JlZnMgPT09IDAgJiYgc2hhcmVkR2xvdykge1xuICAgIHNoYXJlZEdsb3cuZGlzcG9zZSgpXG4gICAgc2hhcmVkR2xvdyA9IG51bGxcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZW1lXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIFRoZW1lUGFsZXR0ZSB7XG4gIGNvcmU6IENvbG9yXG4gIGFjY2VudDogQ29sb3JcbiAgZ2FpbjogbnVtYmVyXG4gIGJsZW5kaW5nOiB0eXBlb2YgQWRkaXRpdmVCbGVuZGluZyB8IHR5cGVvZiBOb3JtYWxCbGVuZGluZ1xuICBiYWNrZ3JvdW5kOiBDb2xvclxuICBvcGFjaXR5OiBudW1iZXJcbiAgcG9pbnRTaXplOiBudW1iZXJcbn1cblxuLyoqXG4gKiBUaGUgcGFsZXR0ZSBmb3IgYSB0aGVtZS4gRXhwb3J0ZWQgc28gdGhlIGxpZ2h0IHRoZW1lJ3MgY29udHJhc3QgY2FuIGJlIGFzc2VydGVkXG4gKiBhcyBhIHVuaXQgdGVzdDogaXQgaXMgYXJpdGhtZXRpYyBvbiBjb2xvdXJzLCBhbmQgdGhlIGZhaWx1cmUgbW9kZSAoaW5rIHRvbyBwYWxlXG4gKiB0byBvdXQtc2hvdXQgaXRzIG93biBzdGFyZmllbGQpIGlzIGludmlzaWJsZSBpbiBhIGNvZGUgcmV2aWV3IOKAlCBpdCB0b29rIGFcbiAqIG1lYXN1cmVkIDIuODU6MSBhZ2FpbnN0IGEgNi43ODoxIGJhY2tncm91bmQgdG8gZmluZCBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhbGV0dGVGb3IoaXNMaWdodFRoZW1lOiBib29sZWFuKTogVGhlbWVQYWxldHRlIHtcbiAgcmV0dXJuIGlzTGlnaHRUaGVtZVxuICAgID8ge1xuICAgICAgICAvLyBBZGRpdGl2ZSBibGVuZGluZyB3YXNoZXMgb3V0IHRvIHdoaXRlIG9uIGEgcGFsZSBwYWdlLCBzbyB0aGUgbGlnaHQgdGhlbWVcbiAgICAgICAgLy8gaXMgZGFyayBpbmsgb24gYSBicmlnaHQgc2t5IGFuZCBtdXN0IGJsZW5kIG5vcm1hbGx5LlxuICAgICAgICAvL1xuICAgICAgICAvLyBOb3JtYWwgYmxlbmRpbmcgZG9lcyBub3QgYWNjdW11bGF0ZSB0aGUgd2F5IGFkZGl0aXZlIGRvZXM6IHRoZSBnbG93IHNwcml0ZVxuICAgICAgICAvLyBpcyBhIHNvZnQgcmFkaWFsIGZhbGxvZmYsIHNvIG92ZXJsYXBwaW5nIHRyYW5zbHVjZW50IHBvaW50cyBjb252ZXJnZSBvbiBhXG4gICAgICAgIC8vIGhhemUgcmF0aGVyIHRoYW4gb24gdGhlIHNwcml0ZSdzIGNlbnRyZSBjb2xvdXIuIE1lYXN1cmVkIHdpdGggdGhlIGVhcmxpZXJcbiAgICAgICAgLy8gdmFsdWVzIChvcGFjaXR5IDAuOCwgc2l6ZSAwLjA4MikgdGhlIGNvbWV0IHJlbmRlcmVkIGF0IDIuODU6MSBhZ2FpbnN0IHRoZVxuICAgICAgICAvLyBwYWdlIHdoaWxlIHRoZSBzdGFyZmllbGQgbWFuYWdlZCA2Ljc4OjEg4oCUIHRoZSBiYWNrZ3JvdW5kIG91dC1zaG91dGVkIHRoZVxuICAgICAgICAvLyBzdWJqZWN0LCBldmVuIHRob3VnaCB0aGUgY29tZXQncyBvd24gdmVydGV4IGNvbG91ciB3YXMgYSBkYXJrIDk4LzI1NS5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gU28gb24gdGhlIGxpZ2h0IHRoZW1lIGVhY2ggcGFydGljbGUgaGFzIHRvIGJlIGluZGl2aWR1YWxseSBtb3JlIHNvbGlkOlxuICAgICAgICAvLyBmdWxsIG9wYWNpdHksIGEgbGFyZ2VyIHNwcml0ZSwgYW5kIGEgZGFya2VyIGNvcmUuIFRoZSBwb2ludCBzaXplIGlzXG4gICAgICAgIC8vIGRlbGliZXJhdGVseSAqbGFyZ2VyKiB0aGFuIHRoZSBkYXJrIHRoZW1lJ3MsIHdoaWNoIGxvb2tzIGJhY2t3YXJkcyBidXQgaXNcbiAgICAgICAgLy8gdGhlIGNvbnNlcXVlbmNlIG9mIG5vcm1hbCBibGVuZGluZyDigJQgaW5rIG5lZWRzIGNvdmVyYWdlLCBsaWdodCBkb2VzIG5vdC5cbiAgICAgICAgY29yZTogbmV3IENvbG9yKDAuMDYsIDAuMDc1LCAwLjExNSksXG4gICAgICAgIGFjY2VudDogbmV3IENvbG9yKDAuNjIsIDAuMiwgMC4wKSxcbiAgICAgICAgZ2FpbjogMC43MixcbiAgICAgICAgYmxlbmRpbmc6IE5vcm1hbEJsZW5kaW5nLFxuICAgICAgICBiYWNrZ3JvdW5kOiBuZXcgQ29sb3IoMC45NzYsIDAuOTgsIDAuOTg0KSxcbiAgICAgICAgb3BhY2l0eTogMS4wLFxuICAgICAgICBwb2ludFNpemU6IDAuMTI1LFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICAvLyBEZWVwIHNwYWNlOiBjb29sLXdoaXRlIHN0YXJkdXN0IHdpdGggdGhlIHNpdGUncyBzaW5nbGUgd2FybSBhY2NlbnQgdXNlZFxuICAgICAgICAvLyBvbmx5IGF0IHRoZSBoZWFkLiBBIHNhdHVyYXRlZCBoZWFkIHdvdWxkIGZpZ2h0IHRoZSBnbHlwaCBpdCBmb3Jtcy5cbiAgICAgICAgY29yZTogbmV3IENvbG9yKDAuODgsIDAuOTIsIDEuMCksXG4gICAgICAgIGFjY2VudDogbmV3IENvbG9yKDEuMCwgMC40MiwgMC4wNSksXG4gICAgICAgIGdhaW46IDEuMjIsXG4gICAgICAgIGJsZW5kaW5nOiBBZGRpdGl2ZUJsZW5kaW5nLFxuICAgICAgICBiYWNrZ3JvdW5kOiBuZXcgQ29sb3IoMC4wMTIsIDAuMDE2LCAwLjAzOSksXG4gICAgICAgIG9wYWNpdHk6IDEuMCxcbiAgICAgICAgcG9pbnRTaXplOiAwLjA5OCxcbiAgICAgIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTY3JhdGNoIOKAlCBhbGxvY2F0ZWQgb25jZSBwZXIgZW5naW5lLCBtdXRhdGVkIGluIHBsYWNlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIEVuZ2luZVNjcmF0Y2gge1xuICBlbWl0dGVkVGFpbDogRW1pdHRlZFRhaWxcbiAgYm9keTogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlQ29tZXRCb2R5PlxuICBwb3NpdGlvbnM6IEZsb2F0MzJBcnJheVxuICB2ZWxvY2l0aWVzOiBGbG9hdDMyQXJyYXlcbiAgLyoqIFJHQkEgdmVydGV4IGNvbG91cnM7IGFscGhhIGlzIHRoZSBhY3R1YWwgbGlmZXRpbWUgdmlzaWJpbGl0eSBjaGFubmVsLiAqL1xuICBjb2xvcnM6IEZsb2F0MzJBcnJheVxuICB0YWlsQmlydGhQb3NpdGlvbjogRmxvYXQzMkFycmF5XG4gIHRhaWxCaXJ0aFZlbG9jaXR5OiBGbG9hdDMyQXJyYXlcbiAgdGFpbFJlYWR5OiBVaW50OEFycmF5XG4gIHNoYXBlRnJvbTogRmxvYXQzMkFycmF5XG4gIHNoYXBlQWxwaGE6IEZsb2F0MzJBcnJheVxuICBwb2ludGVyT2Zmc2V0OiBGbG9hdDMyQXJyYXlcbiAgLyoqXG4gICAqIFNlY29uZHMgc2luY2UgZWFjaCB0YWlsIHBhcnRpY2xlIHdhcyBib3JuLCBhbmQgaG93IGxvbmcgaXQgZ2V0cyB0byBsaXZlLlxuICAgKlxuICAgKiBUaGlzIHBhaXIgKmlzKiB0aGUgbW9kZWwuIEFnZSBhZHZhbmNlcyBieSB0aGUgZnJhbWUncyBvd24gZGVsdGEsIGFuZCB3aGVuIGl0XG4gICAqIHJlYWNoZXMgYHRhaWxMaWZlYCB0aGUgcGFydGljbGUgZGllcyBhbmQgaXMgcmVjeWNsZWQgYXQgdGhlIG51Y2xldXMg4oCUIHdoaWNoIGlzXG4gICAqIHdoeSB0aGUgcGx1bWUgaGFzIGEgbW92aW5nIHBvcHVsYXRpb24gaW5zdGVhZCBvZiBhIGZpeGVkIHNldCBvZiBzbG90cy4gVGhlcmUgaXNcbiAgICogbm8gcmluZyBidWZmZXIgYW5kIG5vIGFsbG9jYXRpb246IHRoZSBkZWF0aCBpcyBhIHJlc2V0IG9mIG9uZSBmbG9hdC5cbiAgICovXG4gIHRhaWxMaWZlOiBGbG9hdDMyQXJyYXlcbiAgdGFpbEFnZTogRmxvYXQzMkFycmF5XG4gIC8qKlxuICAgKiBXb3JsZCB1bml0cyBhIHBhcnRpY2xlIGNvdmVycyBhbG9uZyBpdHMgb3duIGJpcnRoIGF4aXMgb3ZlciBpdHMgd2hvbGUgbGlmZS5cbiAgICpcbiAgICogU3RvcmVkIGFzIGEgcmVhY2ggcmF0aGVyIHRoYW4gYSBzcGVlZCBzbyB0aGUgcGx1bWUncyBsZW5ndGggY2Fubm90IHJlLWNvdXBsZSB0b1xuICAgKiBsaWZldGltZSAoc2VlIGBUQUlMX0RVU1RfUkVBQ0hfTUlOYCkuIFRoZSBzcGVlZCBpcyBgcmVhY2ggLyBsaWZlYCwgcmVjb21wdXRlZFxuICAgKiB3aGVyZSBpdCBpcyB1c2VkLlxuICAgKi9cbiAgdGFpbFJlYWNoOiBGbG9hdDMyQXJyYXlcbiAgLyoqXG4gICAqIFRoZSBwYXJ0aWNsZSdzIGVqZWN0aW9uIGRpcmVjdGlvbiwgYmFrZWQgYXMgYSB1bml0IHZlY3RvciBpbiB0aGUgYmlydGggZnJhbWU6XG4gICAqIGAoY29zIM64LCBzaW4gzrjCt2NvcyDPhiwgc2luIM64wrdzaW4gz4YpYCwgYGNvdW50ICogM2AuXG4gICAqXG4gICAqIEJha2VkIGluIHRoZSBiaXJ0aCBmcmFtZSwgbm90IGluIHdvcmxkIHNwYWNlLCBiZWNhdXNlIHRoZSBmcmFtZSByb3RhdGVzIHdpdGggdGhlXG4gICAqIGhlYWQg4oCUIHRoZSBjb25lIGhhcyB0byBiZSBjYXJyaWVkIGFsb25nIGFuZCByZS1yZWZlcmVuY2VkIGVhY2ggZnJhbWUsIGFuZCBzdG9yaW5nXG4gICAqIHdvcmxkLXNwYWNlIGRpcmVjdGlvbnMgd291bGQgZnJlZXplIHRoZSBzcHJheSBpbiB0aGUgZGlyZWN0aW9uIHRoZSBjb21ldCBoYXBwZW5lZFxuICAgKiB0byBiZSBmYWNpbmcgd2hlbiB0aGUgcGFydGljbGUgd2FzIGJvcm4uXG4gICAqL1xuICB0YWlsQ29uZTogRmxvYXQzMkFycmF5XG4gIC8qKiBgMWAgZm9yIHRoZSBpb24gcG9wdWxhdGlvbiwgYDBgIGZvciBkdXN0LiBTZWxlY3RzIHRoZSB0aW50IGFuZCB0aGUgY29uZSB3aWR0aC4gKi9cbiAgdGFpbElvbjogVWludDhBcnJheVxuICAvKiogU3RhYmxlIHBlci1wYXJ0aWNsZSBwaGFzZSBmb3IgdGhlIHNoaW1tZXIgdGVybS4gKi9cbiAgdGFpbFNlZWQ6IEZsb2F0MzJBcnJheVxuICAvKipcbiAgICogT2Zmc2V0cyBpbnNpZGUgdGhlIG51Y2xldXMsIGBjb3VudCAqIDNgLlxuICAgKlxuICAgKiBFdmVyeSBwYXJ0aWNsZSdzIGJpcnRoIHBvaW50IHNpdHMgc29tZXdoZXJlIGluIHRoaXMgYmFsbCByYXRoZXIgdGhhbiBhdCBvbmUgZXhhY3RcbiAgICogcG9pbnQuIEZvciB0aGUgY29yZSBwYXJ0aWNsZXMgdGhhdCBpcyB3aGF0IHN0b3BzIHRoZSBudWNsZXVzIGRyYXdpbmcgYXMgYSBmbGF0XG4gICAqIG1hY2hpbmVkIGRpc2M7IGZvciB0aGUgdGFpbCBwYXJ0aWNsZXMgaXQgaXMgdGhlIGVtaXNzaW9uIGFwZXJ0dXJlLCBhbmQgaXQgaXMgd2hhdFxuICAgKiBrZWVwcyB0aGUgcGx1bWUncyByb290IGZyb20gYmVpbmcgYSBzaW5nbGUgYnJpZ2h0IHBpeGVsLlxuICAgKi9cbiAgaGVhZE9mZnNldDogRmxvYXQzMkFycmF5XG4gIC8qKiBHbHlwaCBhbmNob3JzIGluIHN1YmplY3Qgc3BhY2UgZm9yIHRoZSBicmFuZCBiZWluZyBhc3NlbWJsZWQuICovXG4gIGdseXBoVGFyZ2V0czogRmxvYXQzMkFycmF5XG4gIGdseXBoU3Ryb2tlRGVwdGg6IEZsb2F0MzJBcnJheVxuICAvKiogVGhlIGVtaXNzaW9uIHRhYmxlIHRoZSB0YWlsIHBhcnRpY2xlcyBpbmRleCBieSBhZ2UuIFNlZSB7QGxpbmsgRW1pc3Npb25UYWJsZX0uICovXG4gIHRhaWxUYWJsZTogRW1pc3Npb25UYWJsZVxuICAvKiogUGVyLWZyYW1lIHJhZGlhbCBkcmlmdCBvZiB0aGUgaW50ZXJuYWwgZ2x5cGggZmxvdy4gKi9cbiAgaWNvbk9yYml0T2Zmc2V0czogRmxvYXQzMkFycmF5XG4gIGljb25PcmJpdEZpZWxkOiBWb3hTcGFjZUljb25PcmJpdEZpZWxkXG4gIGljb25Ib2xkUG9zZTogVm94U3BhY2VJY29uSG9sZFBvc2VcbiAgcG9pbnRlckZpZWxkOiBWb3hTcGFjZVBvaW50ZXJGaWVsZFxuICAvKiogUmV1c2VkIHZlY3RvcnMg4oCUIHRoZSBmcmFtZSBsb29wIG11c3Qgbm90IGNvbnN0cnVjdCBhbnkuICovXG4gIHZlY0E6IFZlY3RvcjNcbiAgdmVjQjogVmVjdG9yM1xuICAvKiogUmV1c2VkIHNhbXBsZSB0YXJnZXQgZm9yIHRoZSBlbWlzc2lvbiB0YWJsZSB3YWxrLiAqL1xuICBwcm9iZVBvaW50OiBQb2ludDNcbiAgaW52ZXJzZVJvdGF0aW9uOiBRdWF0ZXJuaW9uXG59XG5cbi8qKlxuICogVGhlIGhlYWQncyBwYXN0LCBiYWtlZCBwZXIgZnJhbWUgaW50byBldmVyeXRoaW5nIGEgdGFpbCBwYXJ0aWNsZSBuZWVkcyB0byBrbm93XG4gKiBhYm91dCB0aGUgaW5zdGFudCBpdCB3YXMgYm9ybi5cbiAqXG4gKiBVbmlmb3JtIFRJTUUsIGFuZCBkZWxpYmVyYXRlbHkgbm8gbG9uZ2VyIHVuaWZvcm0gYXJjIGxlbmd0aC4gVGhlIGFyYy1sZW5ndGhcbiAqIHJlc2FtcGxpbmcgdGhlIG9sZCB0YWlsIHVzZWQgZXhpc3RlZCB0byBnaXZlIGEgcmlnaWQgcmliYm9uIGEgbGVuZ3RoIHRoYXQgZGlkIG5vdFxuICogZGVwZW5kIG9uIHRoZSBoZWFkJ3Mgc3BlZWQ7IHVuZGVyIFYyIHRoYXQgam9iIGJlbG9uZ3MgdG8gdGhlIGluaGVyaXRlZCBiaXJ0aFxuICogdmVsb2NpdHkgKHNlZSBgVEFJTF9FTlRSQUlOYCksIHNvIHRoaXMgdGFibGUgb25seSBoYXMgdG8gYW5zd2VyIHR3byBxdWVzdGlvbnMg4oCUXG4gKiB3aGVyZSB3YXMgdGhlIGhlYWQsIGFuZCBob3cgZmFzdCB3YXMgaXQgbW92aW5nLCB3aGVuIHRoaXMgcGFydGljbGUgbGVmdCBpdC5cbiAqXG4gKiBFdmVyeSBhcnJheSBpcyBgcHJvYmVDb3VudCAqIDNgIGFuZCBwcmVhbGxvY2F0ZWQ7IGB3cml0ZUVtaXNzaW9uVGFibGVgIHJlZmlsbHMgdGhlbVxuICogaW4gcGxhY2UuIFNwbGl0IG91dCBvZiBgRW5naW5lU2NyYXRjaGAgc28gdGhlIGVtaXNzaW9uIGtlcm5lbCBjYW4gYmUgdW5pdC10ZXN0ZWRcbiAqIGFnYWluc3QgYSBzeW50aGV0aWMgcGF0aCB3aXRoIG5vIFdlYkdMIGFueXdoZXJlIG5lYXIgaXQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRW1pc3Npb25UYWJsZSB7XG4gIC8qKiBBYnNvbHV0ZSBzdWJqZWN0LXNwYWNlIGhlYWQgcG9zaXRpb24gYXQgZWFjaCBwcm9iZSwgbmV3ZXN0IGZpcnN0LiAqL1xuICB4eXo6IEZsb2F0MzJBcnJheVxuICAvKiogKipGb3J3YXJkKiogaGVhZCB2ZWxvY2l0eSBhdCBlYWNoIHByb2JlLCBmcm9tIGEgY2VudHJhbCBkaWZmZXJlbmNlLiAqL1xuICB2ZWw6IEZsb2F0MzJBcnJheVxuICAvKiogVW5pdCBiYWNrd2FyZCB0YW5nZW50IOKAlCB0aGUgYXhpcyB0aGUgc3ByYXkgb3BlbnMgYXJvdW5kLiAqL1xuICBheGlzOiBGbG9hdDMyQXJyYXlcbiAgLyoqIEZpcnN0IGJhc2lzIHZlY3RvciBvZiB0aGUgcGxhbmUgbm9ybWFsIHRvIGBheGlzYC4gKi9cbiAgc2lkZTE6IEZsb2F0MzJBcnJheVxuICAvKiogU2Vjb25kIGJhc2lzIHZlY3RvciwgYGNyb3NzKGF4aXMsIHNpZGUxKWAuICovXG4gIHNpZGUyOiBGbG9hdDMyQXJyYXlcbiAgLyoqIFByb2JlcyBhY3R1YWxseSBwb3B1bGF0ZWQsIGAyIDw9IHByb2JlQ291bnQgPD0gVEFJTF9QUk9CRV9DT1VOVGAuICovXG4gIHByb2JlQ291bnQ6IG51bWJlclxuICAvKiogU2Vjb25kcyBvZiB0aGUgcGFzdCB0aGUgdGFibGUgc3BhbnMuIEFsd2F5cyBgVEFJTF9TRUNPTkRTYC4gKi9cbiAgc3BhblNlY29uZHM6IG51bWJlclxufVxuXG4vKipcbiAqIEEgZGVjb3JyZWxhdGVkIDAuLjEgcm9sbCBmb3IgYSBwYXJ0aWNsZSwgZnJvbSBhbiBpbnRlZ2VyIGluZGV4IGFuZCBhIHNhbHQuXG4gKlxuICogVGhlIG9idmlvdXMgd2F5IHRvIHNjYXR0ZXIgYSBwZXItcGFydGljbGUgYXR0cmlidXRlIGlzIGFub3RoZXIgZ29sZGVuLXJhdGlvXG4gKiB0ZXJtIOKAlCBgZnJhYyhpICogMyAqIFBISSlgLCBgZnJhYyhpICogNyAqIFBISSlgIGFuZCBzbyBvbi4gVGhhdCBpcyB3cm9uZywgYW5kXG4gKiB3cm9uZyBpbiBhIHdheSB0aGF0IGxvb2tzIGZpbmUgaW4gZXZlcnkgc2NhbGFyIHRlc3Q6IGBmcmFjKGkgKiBrICogUEhJKWAgaXMgYVxuICogKmRldGVybWluaXN0aWMgZnVuY3Rpb24gb2YqIGBmcmFjKGkgKiBQSEkpYCwgYmVjYXVzZSBgMyAqIGZyYWMoaSpQSEkpYCBkaWZmZXJzXG4gKiBmcm9tIGBmcmFjKDMqaSpQSEkpYCBieSBhbiBpbnRlZ2VyLiBTbyB0aGUgdGFpbCdzIHJhZGl1cywgYW5nbGUsIHNwaW4gYW5kXG4gKiBzaGltbWVyIGFsbCBlbmRlZCB1cCBiZWluZyBmdW5jdGlvbnMgb2YgaXRzIHBvc2l0aW9uLiBUaGUgcmVzdWx0IHdhcyBhIHBlcmZlY3RseVxuICogb3JkZXJlZCBoZWxpeCDigJQgdGhlIG9uLXNjcmVlbiByZWFkIHdhcyBhIHN0YWNrIG9mIGNvbmNlbnRyaWMgZWxsaXBzZSBvdXRsaW5lcywgYVxuICogbWFjaGluZWQgY29pbCwgYW5kIHRoZSBvbmx5IHdheSB0byBzZWUgaXQgd2FzIHRvIGxvb2sgYXQgYSByZW5kZXJlZCBmcmFtZS5cbiAqXG4gKiBBbiBhdmFsYW5jaGUgaGFzaCBnaXZlcyB3aGF0IHRoZSBnb2xkZW4gcmF0aW8gY2Fubm90OiBhIHJvbGwgdGhhdCBpc1xuICogaW5kZXBlbmRlbnQgb2YgdGhlIHBvc2l0aW9uIHJvbGwgYW5kIG9mIHRoZSBvdGhlciBhdHRyaWJ1dGVzLlxuICovXG5mdW5jdGlvbiBoYXNoMDEoaW5kZXg6IG51bWJlciwgc2FsdDogbnVtYmVyKTogbnVtYmVyIHtcbiAgbGV0IGggPSBNYXRoLmltdWwoaW5kZXggXiBzYWx0LCAweDllMzc3OWIxKVxuICBoIF49IGggPj4+IDE1XG4gIGggPSBNYXRoLmltdWwoaCwgMHg4NWViY2E2YilcbiAgaCBePSBoID4+PiAxM1xuICBoID0gTWF0aC5pbXVsKGgsIDB4YzJiMmFlMzUpXG4gIGggXj0gaCA+Pj4gMTZcbiAgcmV0dXJuIChoID4+PiAwKSAvIDQyOTQ5NjcyOTZcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVuZ2luZVNjcmF0Y2goY291bnQ6IG51bWJlciwgdGFpbFNhbXBsZUNvdW50OiBudW1iZXIpOiBFbmdpbmVTY3JhdGNoIHtcbiAgY29uc3QgdGFpbExpZmUgPSBuZXcgRmxvYXQzMkFycmF5KGNvdW50KVxuICBjb25zdCB0YWlsQWdlID0gbmV3IEZsb2F0MzJBcnJheShjb3VudClcbiAgY29uc3QgdGFpbFJlYWNoID0gbmV3IEZsb2F0MzJBcnJheShjb3VudClcbiAgY29uc3QgdGFpbENvbmUgPSBuZXcgRmxvYXQzMkFycmF5KGNvdW50ICogMylcbiAgY29uc3QgdGFpbElvbiA9IG5ldyBVaW50OEFycmF5KGNvdW50KVxuICBjb25zdCB0YWlsU2VlZCA9IG5ldyBGbG9hdDMyQXJyYXkoY291bnQpXG4gIGNvbnN0IGhlYWRPZmZzZXQgPSBuZXcgRmxvYXQzMkFycmF5KGNvdW50ICogMylcbiAgY29uc3QgZ29sZGVuID0gMC42MTgwMzM5ODg3NDk4OTQ5XG4gIGNvbnN0IGNvcmVDb3VudCA9IE1hdGguZmxvb3IoY291bnQgKiBIRUFEX0NPUkVfU0hBUkUpXG5cbiAgLy8gRGlzdGluY3Qgc2FsdHMsIHNvIG5vIHR3byBhdHRyaWJ1dGVzIGNhbiBmYWxsIGludG8gc3RlcCB3aXRoIGVhY2ggb3RoZXIuIFRoZVxuICAvLyBlYXJsaWVyIHZlcnNpb24gb2YgdGhpcyBmaWxlIGRlcml2ZWQgZXZlcnkgYXR0cmlidXRlIGZyb20gdGhlIHNhbWUgZ29sZGVuLXJhdGlvXG4gIC8vIHNlcXVlbmNlLCB3aGljaCBtYWRlIHRoZSByYWRpdXMsIGFuZ2xlIGFuZCBzcGluIGFsbCBmdW5jdGlvbnMgb2YgdGhlIHBhcnRpY2xlJ3NcbiAgLy8gcG9zaXRpb24g4oCUIHRoZSB0YWlsIHJlbmRlcmVkIGFzIGEgbWFjaGluZWQgaGVsaXguIEFueSB0d28gYXR0cmlidXRlcyB0aGF0IG11c3QgYmVcbiAgLy8gaW5kZXBlbmRlbnQgbmVlZCBkaWZmZXJlbnQgc2FsdHMuXG4gIGNvbnN0IExJRkVfU0FMVCA9IDB4N2ZlYjM1MmRcbiAgY29uc3QgUkVBQ0hfU0FMVCA9IDB4YTUxMWU5YjNcbiAgY29uc3QgVEhFVEFfU0FMVCA9IDB4MWI1NmM0ZTlcbiAgY29uc3QgUEhJX1NBTFQgPSAweDI3ZDRlYjJmXG4gIGNvbnN0IElPTl9TQUxUID0gMHg2OGUzMWRhNFxuICBjb25zdCBKSVRURVJfU0FMVCA9IDB4ODQ2Y2E2OGJcbiAgY29uc3QgU0VFRF9TQUxUID0gMHg5ZTM3NzliOVxuICBjb25zdCBDT1JFX1hfU0FMVCA9IDB4MjU0NWY0OTFcbiAgY29uc3QgQ09SRV9ZX1NBTFQgPSAweDllMzc3OWIxXG4gIGNvbnN0IENPUkVfWl9TQUxUID0gMHg4NWViY2E2YlxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY291bnQ7IGkrKykge1xuICAgIHRhaWxTZWVkW2ldID0gaGFzaDAxKGksIFNFRURfU0FMVClcblxuICAgIGlmIChpIDwgY29yZUNvdW50KSB7XG4gICAgICAvLyBBIGNvbmNlbnRyYXRlZCBudWNsZXVzIGluc2lkZSBhIHNwYXJzZSBjb21hLCB3aXRoIG5vIHVuaWZvcm0gYnJpZ2h0IHJpbS5cbiAgICAgIGNvbnN0IHIgPSBIRUFEX0NPUkVfUkFESVVTICogTWF0aC5wb3coaGFzaDAxKGksIENPUkVfWF9TQUxUKSwgMC43MilcbiAgICAgIGNvbnN0IGNvc1RoZXRhID0gaGFzaDAxKGksIENPUkVfWV9TQUxUKSAqIDIgLSAxXG4gICAgICBjb25zdCBwaGkgPSBoYXNoMDEoaSwgQ09SRV9aX1NBTFQpICogTWF0aC5QSSAqIDJcbiAgICAgIGNvbnN0IHNpblRoZXRhID0gTWF0aC5zcXJ0KE1hdGgubWF4KDAsIDEgLSBjb3NUaGV0YSAqIGNvc1RoZXRhKSlcbiAgICAgIGhlYWRPZmZzZXRbaSAqIDNdID0gciAqIHNpblRoZXRhICogTWF0aC5jb3MocGhpKVxuICAgICAgaGVhZE9mZnNldFtpICogMyArIDFdID0gciAqIHNpblRoZXRhICogTWF0aC5zaW4ocGhpKVxuICAgICAgaGVhZE9mZnNldFtpICogMyArIDJdID0gciAqIGNvc1RoZXRhXG4gICAgICAvLyBDb3JlIHBhcnRpY2xlcyBsaXZlIGZvcmV2ZXIgYW5kIG5ldmVyIG1vdmUgdW5kZXIgdGhlIGVtaXNzaW9uIG1vZGVsOiB0aGV5IGFyZVxuICAgICAgLy8gdGhlIG51Y2xldXMsIG5vdCB0aGUgcGx1bWUuIEEgemVybyBsaWZlIHdpdGggYSB6ZXJvIHJlYWNoIGxlYXZlcyB0aGVtIHBhcmtlZFxuICAgICAgLy8gb24gdGhlIGJpcnRoIHBvaW50LCBhbmQgYGludGVncmF0ZSgpYCBibGVuZHMgdGhlIGNvcmUgaW4gYnkgaW5kZXggaW5zdGVhZC5cbiAgICAgIHRhaWxMaWZlW2ldID0gMFxuICAgICAgdGFpbFJlYWNoW2ldID0gMFxuICAgICAgY29udGludWVcbiAgICB9XG5cbiAgICBjb25zdCBpb24gPSBoYXNoMDEoaSwgSU9OX1NBTFQpIDwgVEFJTF9JT05fU0hBUkVcbiAgICB0YWlsSW9uW2ldID0gaW9uID8gMSA6IDBcblxuICAgIC8vIFVuaWZvcm0gbGl2ZXMgd2l0aGluIHRoZSBjbGFzcy4gQSBzaW5nbGUgc2hhcmVkIGxpZmV0aW1lIHdvdWxkIG1ha2UgZXZlcnlcbiAgICAvLyBwYXJ0aWNsZSB0aGUgc2FtZSBhZ2UsIGFuZCB0aGUgcGx1bWUgd291bGQgcHVsc2UgYXMgb25lIHNsYWIgYnJlYXRoaW5nIGluIGFuZFxuICAgIC8vIG91dCBpbnN0ZWFkIG9mIHNob3dpbmcgbmV3Ym9ybiBhbmQgZHlpbmcgbWF0ZXJpYWwgYXQgb25jZS5cbiAgICBjb25zdCBsaWZlTWluID0gaW9uID8gVEFJTF9JT05fTElGRV9NSU4gOiBUQUlMX0RVU1RfTElGRV9NSU5cbiAgICBjb25zdCBsaWZlTWF4ID0gaW9uID8gVEFJTF9JT05fTElGRV9NQVggOiBUQUlMX0RVU1RfTElGRV9NQVhcbiAgICBjb25zdCBsaWZlID0gbGlmZU1pbiArIGhhc2gwMShpLCBMSUZFX1NBTFQpICogKGxpZmVNYXggLSBsaWZlTWluKVxuICAgIHRhaWxMaWZlW2ldID0gbGlmZVxuXG4gICAgLy8gQSByZWFjaCwgbm90IGEgc3BlZWQg4oCUIHNlZSBgVEFJTF9EVVNUX1JFQUNIX01JTmAuIEppdHRlcmVkIHNvIHRoZSBmYWRlIGVkZ2UgaXNcbiAgICAvLyBhIHNvZnQgYmFuZCByYXRoZXIgdGhhbiBhIG1hdGhlbWF0aWNhbGx5IGV4YWN0IGRpc2MuXG4gICAgY29uc3QgcmVhY2hNaW4gPSBpb24gPyBUQUlMX0lPTl9SRUFDSF9NSU4gOiBUQUlMX0RVU1RfUkVBQ0hfTUlOXG4gICAgY29uc3QgcmVhY2hNYXggPSBpb24gPyBUQUlMX0lPTl9SRUFDSF9NQVggOiBUQUlMX0RVU1RfUkVBQ0hfTUFYXG4gICAgY29uc3QgcmVhY2ggPSByZWFjaE1pbiArIGhhc2gwMShpLCBSRUFDSF9TQUxUKSAqIChyZWFjaE1heCAtIHJlYWNoTWluKVxuICAgIHRhaWxSZWFjaFtpXSA9IHJlYWNoICogKDEgKyAoaGFzaDAxKGksIEpJVFRFUl9TQUxUKSAtIDAuNSkgKiAyICogVEFJTF9TUEVFRF9KSVRURVIpXG5cbiAgICAvLyBBZ2Ugc3RhcnRzIHNwcmVhZCB1bmlmb3JtbHkgdGhyb3VnaCBsaWZlLCB3aGljaCBpcyB0aGUgc3RlYWR5IHN0YXRlIHRoZSBydW5uaW5nXG4gICAgLy8gZW5naW5lIGNvbnZlcmdlcyB0by4gU3RhcnRpbmcgZXZlcnkgcGFydGljbGUgYXQgYWdlIDAgd291bGQgb3BlbiB0aGUgcGFnZSB3aXRoXG4gICAgLy8gb25lIHN5bmNocm9uaXNlZCB3YXZlIG9mIG5ld2Jvcm5zIGNvbGxhcHNpbmcgdG8gbm90aGluZyAyLjUgcyBpbiDigJQgYSB2aXNpYmxlXG4gICAgLy8gcHVsc2Ugb24gZmlyc3QgcGFpbnQsIGV4YWN0bHkgd2hlcmUgbm9ib2R5IGlzIHdhdGNoaW5nIGZvciBhIGRlZmVjdC5cbiAgICB0YWlsQWdlW2ldID0gKCgoaSAtIGNvcmVDb3VudCkgKiBnb2xkZW4gKyAwLjUpICUgMSkgKiBsaWZlXG5cbiAgICAvLyBUaGUgZWplY3Rpb24gY29uZS4gYHNpbih0aGV0YSlgIGlzIHJhaXNlZCB0byBgVEFJTF9GSUxMYCBzbyB0aGUgYW5nbGVzIGNyb3dkXG4gICAgLy8gdG93YXJkIHRoZSBheGlzIOKAlCBhIGJyaWdodCBzcGluZSBpbnNpZGUgYSB0aGlubmluZyBlbnZlbG9wZSwgcmF0aGVyIHRoYW4gdGhlXG4gICAgLy8gdW5pZm9ybS1kZW5zaXR5IGNsb3VkIGEgcGxhaW4gYHNxcnRgIGdpdmVzIG9yIHRoZSBob2xsb3cgc2hlbGwgYSB1bmlmb3JtIHJvbGxcbiAgICAvLyBpbiBgc2luKHRoZXRhKWAgZ2l2ZXMuIElvbiBwYXJ0aWNsZXMgZ2V0IGEgcHJvcG9ydGlvbmFsbHkgbmFycm93ZXIgY29uZS5cbiAgICBjb25zdCBzcHJlYWQgPSBUQUlMX1NQUkVBRCAqIChpb24gPyBUQUlMX0lPTl9OQVJST1cgOiAxKVxuICAgIGNvbnN0IHNpblRoZXRhID0gc3ByZWFkICogTWF0aC5wb3coaGFzaDAxKGksIFRIRVRBX1NBTFQpLCBUQUlMX0ZJTEwpXG4gICAgY29uc3QgY29zVGhldGEgPSBNYXRoLnNxcnQoTWF0aC5tYXgoMCwgMSAtIHNpblRoZXRhICogc2luVGhldGEpKVxuICAgIGNvbnN0IHBoaSA9IGhhc2gwMShpLCBQSElfU0FMVCkgKiBNYXRoLlBJICogMlxuICAgIHRhaWxDb25lW2kgKiAzXSA9IGNvc1RoZXRhXG4gICAgdGFpbENvbmVbaSAqIDMgKyAxXSA9IHNpblRoZXRhICogTWF0aC5jb3MocGhpKVxuICAgIHRhaWxDb25lW2kgKiAzICsgMl0gPSBzaW5UaGV0YSAqIE1hdGguc2luKHBoaSlcblxuICAgIC8vIFRoZSBlbWlzc2lvbiBhcGVydHVyZTogYSBiYWxsIGFyb3VuZCB0aGUgbnVjbGV1cywgc28gdGhlIHBsdW1lJ3Mgcm9vdCBpcyBhXG4gICAgLy8gdm9sdW1lIGFuZCBub3Qgb25lIGJyaWdodCBwaXhlbC4gVW5pZm9ybSBpbiBkaXJlY3Rpb24sIGN1YmVkLXJvb3QgaW4gcmFkaXVzLlxuICAgIGNvbnN0IHIgPSBIRUFEX0NPUkVfUkFESVVTICogTWF0aC5jYnJ0KGhhc2gwMShpLCBDT1JFX1hfU0FMVCkpXG4gICAgY29uc3QgY29zWSA9IGhhc2gwMShpLCBDT1JFX1lfU0FMVCkgKiAyIC0gMVxuICAgIGNvbnN0IHBoaVkgPSBoYXNoMDEoaSwgQ09SRV9aX1NBTFQpICogTWF0aC5QSSAqIDJcbiAgICBjb25zdCBzaW5ZID0gTWF0aC5zcXJ0KE1hdGgubWF4KDAsIDEgLSBjb3NZICogY29zWSkpXG4gICAgaGVhZE9mZnNldFtpICogM10gPSByICogc2luWSAqIE1hdGguY29zKHBoaVkpXG4gICAgaGVhZE9mZnNldFtpICogMyArIDFdID0gciAqIHNpblkgKiBNYXRoLnNpbihwaGlZKVxuICAgIGhlYWRPZmZzZXRbaSAqIDMgKyAyXSA9IHIgKiBjb3NZXG4gIH1cblxuICByZXR1cm4ge1xuICAgIGVtaXR0ZWRUYWlsOiBuZXcgRW1pdHRlZFRhaWwoTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihjb3VudCAqICgxIC0gSEVBRF9DT1JFX1NIQVJFKSkpKSxcbiAgICBib2R5OiBjcmVhdGVDb21ldEJvZHkoY291bnQpLFxuICAgIC8vIFRoZSBvcGVuaW5nIGZyYW1lIGlzIGEgd2lkZSBzY2F0dGVyIHRoYXQgdGhlIHNwcmluZyBwdWxscyBpbnRvIHRoZSBmaXJzdFxuICAgIC8vIGNvbWV0LCBzbyB0aGUgYmFja2dyb3VuZCBhc3NlbWJsZXMgaXRzZWxmIGluc3RlYWQgb2YgcG9wcGluZyBpbnRvIGJlaW5nLlxuICAgIHBvc2l0aW9uczogY3JlYXRlSW5pdGlhbFNjYXR0ZXJUYXJnZXRzKGNvdW50KSxcbiAgICB2ZWxvY2l0aWVzOiBuZXcgRmxvYXQzMkFycmF5KGNvdW50ICogMyksXG4gICAgY29sb3JzOiBuZXcgRmxvYXQzMkFycmF5KGNvdW50ICogNCksXG4gICAgdGFpbEJpcnRoUG9zaXRpb246IG5ldyBGbG9hdDMyQXJyYXkoY291bnQgKiAzKSxcbiAgICB0YWlsQmlydGhWZWxvY2l0eTogbmV3IEZsb2F0MzJBcnJheShjb3VudCAqIDMpLFxuICAgIHRhaWxSZWFkeTogbmV3IFVpbnQ4QXJyYXkoY291bnQpLFxuICAgIHNoYXBlRnJvbTogbmV3IEZsb2F0MzJBcnJheShjb3VudCAqIDMpLFxuICAgIHNoYXBlQWxwaGE6IG5ldyBGbG9hdDMyQXJyYXkoY291bnQpLFxuICAgIHBvaW50ZXJPZmZzZXQ6IG5ldyBGbG9hdDMyQXJyYXkoY291bnQgKiAzKSxcbiAgICB0YWlsTGlmZSxcbiAgICB0YWlsQWdlLFxuICAgIHRhaWxSZWFjaCxcbiAgICB0YWlsQ29uZSxcbiAgICB0YWlsSW9uLFxuICAgIHRhaWxTZWVkLFxuICAgIGhlYWRPZmZzZXQsXG4gICAgZ2x5cGhUYXJnZXRzOiBuZXcgRmxvYXQzMkFycmF5KGNvdW50ICogMyksXG4gICAgZ2x5cGhTdHJva2VEZXB0aDogbmV3IEZsb2F0MzJBcnJheShjb3VudCksXG4gICAgdGFpbFRhYmxlOiBjcmVhdGVFbWlzc2lvblRhYmxlKHRhaWxTYW1wbGVDb3VudCksXG4gICAgaWNvbk9yYml0T2Zmc2V0czogbmV3IEZsb2F0MzJBcnJheShjb3VudCAqIDMpLFxuICAgIGljb25PcmJpdEZpZWxkOiBjcmVhdGVWb3hTcGFjZUljb25PcmJpdEZpZWxkKGNvdW50KSxcbiAgICBpY29uSG9sZFBvc2U6IHsgcm90YXRpb25YOiAwLCByb3RhdGlvblk6IDAsIHJvdGF0aW9uWjogMCwgdG9uZVNjYWxlOiAwIH0sXG4gICAgcG9pbnRlckZpZWxkOiB7XG4gICAgICBsb2NhbFg6IDAsXG4gICAgICBsb2NhbFk6IDAsXG4gICAgICBsb2NhbFo6IDAsXG4gICAgICByYWRpdXM6IFBPSU5URVJfUkFESVVTLFxuICAgICAgcmFkaXVzU3E6IFBPSU5URVJfUkFESVVTICogUE9JTlRFUl9SQURJVVMsXG4gICAgICB0aW1lOiAwLFxuICAgIH0sXG4gICAgdmVjQTogbmV3IFZlY3RvcjMoKSxcbiAgICB2ZWNCOiBuZXcgVmVjdG9yMygpLFxuICAgIHByb2JlUG9pbnQ6IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgIGludmVyc2VSb3RhdGlvbjogbmV3IFF1YXRlcm5pb24oKSxcbiAgfVxufVxuXG4vKipcbiAqIEFsbG9jYXRlIGFuIGVtaXNzaW9uIHRhYmxlLiBFdmVyeSBidWZmZXIgaXMgYWxsb2NhdGVkIGhlcmUgYW5kIG9ubHkgaGVyZSwgc28gdGhlXG4gKiBmcmFtZSBsb29wIGNhbiByZWZpbGwgaXQgd2l0aG91dCB0b3VjaGluZyB0aGUgYWxsb2NhdG9yLlxuICpcbiAqIGBwcm9iZUNvdW50YCBjb21lcyBmcm9tIHRoZSBxdWFsaXR5IHByb2ZpbGUncyBgdGFpbFNhbXBsZUNvdW50YCwgd2hpY2ggdGhlIGxhZGRlclxuICogYWxyZWFkeSB2YXJpZXMgZnJvbSA0OCB0byA5Ni4gVGhvc2UgbnVtYmVycyB1c2VkIHRvIGJlIFwiaG93IG1hbnkgcG9pbnRzIGFsb25nIHRoZVxuICogcmlnaWQgcmliYm9uXCIsIHdoaWNoIG5lZWRlZCB0byBiZSBkZW5zZSBiZWNhdXNlIHRoZSByaWJib24ncyBzaGFwZSB3YXMgZHJhd24gYnlcbiAqIGxpbmVhciBpbnRlcnBvbGF0aW9uIGJldHdlZW4gdGhlbS4gTm93IHRoZXkgYXJlIHRoZSByZXNvbHV0aW9uIG9mIHRoZSBlbWlzc2lvblxuICogdGFibGUncyAqdGltZSogYXhpcywgYW5kIHdoYXQgbmVlZHMgdG8gYmUgZGVuc2UgaXMgdGhlIHNhbXBsaW5nIG9mIHRoZSBoZWFkJ3NcbiAqIHZlbG9jaXR5LCBzaW5jZSBhIGNvYXJzZSB0YWJsZSBtYWtlcyBhIHBhcnRpY2xlIGJvcm4gbWlkLXR1cm4gaW5oZXJpdCBhIHZlbG9jaXR5XG4gKiBmcm9tIGEgZGlmZmVyZW50IHBhcnQgb2YgdGhlIGN1cnZlLiA0OCBpcyBzdGlsbCBlbm91Z2g6IHRoZSBmYXN0ZXN0IHRoZSBoZWFkIG1vdmVzXG4gKiBpcyA1LjAgdS9zLCBhbmQgMy4yIHMgLyA0OCBwcm9iZXMgaXMgYSAwLjA2NyBzIHN0ZXAsIG92ZXIgd2hpY2ggdGhlIGhlYWQgdHJhdmVscyBhdFxuICogbW9zdCAwLjMzIHVuaXRzIOKAlCBhbiBvcmRlciBvZiBtYWduaXR1ZGUgYmVsb3cgdGhlIHBsdW1lJ3Mgb3duIHdpZHRoLCBzbyB0aGVcbiAqIG1pc2luaGVyaXRhbmNlIGlzIHNtYWxsZXIgdGhhbiB0aGUgdGFpbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVtaXNzaW9uVGFibGUocHJvYmVDb3VudDogbnVtYmVyKTogRW1pc3Npb25UYWJsZSB7XG4gIGNvbnN0IG4gPSBNYXRoLm1heCgyLCBNYXRoLmZsb29yKHByb2JlQ291bnQpKVxuICByZXR1cm4ge1xuICAgIHh5ejogbmV3IEZsb2F0MzJBcnJheShuICogMyksXG4gICAgdmVsOiBuZXcgRmxvYXQzMkFycmF5KG4gKiAzKSxcbiAgICBheGlzOiBuZXcgRmxvYXQzMkFycmF5KG4gKiAzKSxcbiAgICBzaWRlMTogbmV3IEZsb2F0MzJBcnJheShuICogMyksXG4gICAgc2lkZTI6IG5ldyBGbG9hdDMyQXJyYXkobiAqIDMpLFxuICAgIHByb2JlQ291bnQ6IG4sXG4gICAgc3BhblNlY29uZHM6IFRBSUxfU0VDT05EUyxcbiAgfVxufVxuXG4vKiogVGhlIGJsZW5kIHdlaWdodCBiZXR3ZWVuIHRoZSBjb21ldCBzaGFwZSBhbmQgdGhlIGdseXBoIHNoYXBlLCBmb3IgYSBwaGFzZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnbHlwaE1peEZvcihwaGFzZTogQ29tZXRQaGFzZSwgcHJvZ3Jlc3M6IG51bWJlcik6IG51bWJlciB7XG4gIHN3aXRjaCAocGhhc2UpIHtcbiAgICBjYXNlICd0cmF2ZWwnOlxuICAgICAgcmV0dXJuIDBcbiAgICBjYXNlICdnYXRoZXInOlxuICAgICAgcmV0dXJuIHNtb290aGVyU3RlcChjbGFtcDAxKHByb2dyZXNzKSlcbiAgICBjYXNlICdob2xkJzpcbiAgICAgIHJldHVybiAxXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiAxIC0gc21vb3RoZXJTdGVwKGNsYW1wMDEocHJvZ3Jlc3MpKVxuICB9XG59XG5cbi8qKiBTcHJpbmcgc3RpZmZuZXNzIGZvciBhIHBoYXNlLiBFeHBvcnRlZCBzbyB0aGUgdGVzdHMgY2FuIHBpbiB0aGUgb3JkZXJpbmcgdGhhdFxuICogIG1ha2VzIGEgaGVsZCBnbHlwaCByZWFkIGFzIHNvbGlkOiBob2xkID4gZ2F0aGVyID4gc2NhdHRlciA+IHRyYXZlbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb2xsb3dTcGVlZEZvcihwaGFzZTogQ29tZXRQaGFzZSk6IG51bWJlciB7XG4gIHN3aXRjaCAocGhhc2UpIHtcbiAgICBjYXNlICdob2xkJzpcbiAgICAgIHJldHVybiBGT0xMT1dfSE9MRFxuICAgIGNhc2UgJ2dhdGhlcic6XG4gICAgICByZXR1cm4gRk9MTE9XX0dBVEhFUlxuICAgIGNhc2UgJ3NjYXR0ZXInOlxuICAgICAgcmV0dXJuIEZPTExPV19TQ0FUVEVSXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBGT0xMT1dfVFJBVkVMXG4gIH1cbn1cblxuLyoqXG4gKiBGaWxsIGB0YWJsZWAgd2l0aCB0aGUgaGVhZCdzIHJlY2VudCBwYXN0LCBuZXdlc3QgZmlyc3QsIGF0IHVuaWZvcm0gVElNRS5cbiAqXG4gKiBgc291cmNlYCBpcyB0aGUgY2hvcmVvZ3JhcGh5J3MgYHNhbXBsZVRyYWlsKGRlbGF5LCBvdXQpYC4gV29ya2luZyB0aHJvdWdoIGFcbiAqIGNhbGxiYWNrIHJhdGhlciB0aGFuIHJlYWNoaW5nIGZvciB0aGUgZW5naW5lJ3Mgb3duIGNob3Jlb2dyYXBoeSBpcyB3aGF0IGxldHMgdGhlXG4gKiB3aG9sZSBlbWlzc2lvbiBrZXJuZWwgYmUgdGVzdGVkIGFnYWluc3QgYSBzeW50aGV0aWMgcGF0aCBpbiBqc2RvbSDigJQgYW5kIHRoZSBrZXJuZWxcbiAqIGlzIHdoZXJlIGV2ZXJ5IGludGVyZXN0aW5nIG51bWJlciBpbiB0aGUgbmV3IHRhaWwgbGl2ZXMuXG4gKlxuICogYHByb2JlUG9pbnRgIGlzIGEgY2FsbGVyLW93bmVkIHNjcmF0Y2ggYFBvaW50M2AsIHNvIHRoaXMgYWxsb2NhdGVzIG5vdGhpbmcuXG4gKlxuICogVGhyZWUgcGFzc2VzLCBhbGwgaW4gcGxhY2U6XG4gKiAgIDEuIHBvc2l0aW9ucywgYXQgdW5pZm9ybSB0aW1lIGJhY2sgZnJvbSB0aGUgaGVhZFxuICogICAyLiAqKmZvcndhcmQqKiB2ZWxvY2l0aWVzLCBmcm9tIGEgY2VudHJhbCBkaWZmZXJlbmNlIOKAlCBmb3J3YXJkIGJlY2F1c2UgdGhlIHRhaWxcbiAqICAgICAgcGFydGljbGUncyBwb3NpdGlvbiBpcyBgYmlydGhQb3MgKyBiaXJ0aFZlbG9jaXR5ICogYWdlYCwgYW5kIGdldHRpbmcgdGhpcyBzaWduXG4gKiAgICAgIHdyb25nIHR1cm5zIHRoZSBwbHVtZSBpbnNpZGUgb3V0IChpdCB0cmFpbHMgYXQgdHdpY2UgdGhlIGhlYWQgc3BlZWQgaW5zdGVhZCBvZlxuICogICAgICBjby1tb3ZpbmcsIGFuZCB0aGUgdmlzaWJsZSBsZW5ndGggY29sbGFwc2VzIHRvIGEgZmV3IHVuaXRzKVxuICogICAzLiBwZXItcHJvYmUgdW5pdCBiYWNrd2FyZCB0YW5nZW50IGFuZCBhbiBvcnRob25vcm1hbCBiYXNpcyBub3JtYWwgdG8gaXQsIHdoaWNoIGlzXG4gKiAgICAgIHRoZSBmcmFtZSB0aGUgZWplY3Rpb24gY29uZSBpcyBleHByZXNzZWQgaW5cbiAqXG4gKiBUaGUgYmFzaXMgaXMgYnVpbHQgZnJvbSBhIGZpeGVkIHJlZmVyZW5jZSB2ZWN0b3IgY2hvc2VuIHBlciBwcm9iZSByYXRoZXIgdGhhbiBmcm9tXG4gKiB0aGUgd29ybGQgdXAgYXhpcyB1bmNvbmRpdGlvbmFsbHk6IGF0IHRoZSBTLWN1cnZlJ3MgZXh0cmVtZXMgdGhlIHRhbmdlbnQgaXMgbmVhcmx5XG4gKiBwYXJhbGxlbCB0byBgK1hgLCBhbmQgY3Jvc3NpbmcgdGhhdCB3aXRoIGArWWAgd291bGQgc3RpbGwgd29yaywgYnV0IHRoZSBjcm9zc1xuICogZGVnZW5lcmF0ZXMgdG8gemVybyBvbiBhIHBhdGggdGhhdCBoYXBwZW5lZCB0byBiZSB2ZXJ0aWNhbC4gUGlja2luZyB3aGljaGV2ZXIgb2ZcbiAqIGArWWAgLyBgK1hgIGlzIGZ1cnRoZXIgZnJvbSBwYXJhbGxlbCBrZWVwcyB0aGUgYmFzaXMgd2VsbC1jb25kaXRpb25lZCBldmVyeXdoZXJlIHRoZVxuICogaGVhZCBjYW4gZ28sIGF0IHRoZSBjb3N0IG9mIG9uZSBjb21wYXJpc29uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsbEVtaXNzaW9uVGFibGUoXG4gIHRhYmxlOiBFbWlzc2lvblRhYmxlLFxuICBzb3VyY2U6IHsgc2FtcGxlVHJhaWwoZGVsYXlTZWNvbmRzOiBudW1iZXIsIG91dDogUG9pbnQzKTogdm9pZCB9LFxuICBwcm9iZVBvaW50OiBQb2ludDNcbik6IHZvaWQge1xuICBjb25zdCBuID0gdGFibGUucHJvYmVDb3VudFxuICBjb25zdCB7IHh5eiwgdmVsLCBheGlzLCBzaWRlMSwgc2lkZTIgfSA9IHRhYmxlXG4gIGNvbnN0IHNwYW4gPSB0YWJsZS5zcGFuU2Vjb25kc1xuICBjb25zdCBzdGVwID0gc3BhbiAvIE1hdGgubWF4KDEsIG4gLSAxKVxuXG4gIC8vIFBhc3MgMTogdGhlIHBhdGggYXQgdW5pZm9ybSB0aW1lLlxuICBmb3IgKGxldCBrID0gMDsgayA8IG47IGsrKykge1xuICAgIHNvdXJjZS5zYW1wbGVUcmFpbChrICogc3RlcCwgcHJvYmVQb2ludClcbiAgICB4eXpbayAqIDNdID0gcHJvYmVQb2ludC54XG4gICAgeHl6W2sgKiAzICsgMV0gPSBwcm9iZVBvaW50LnlcbiAgICB4eXpbayAqIDMgKyAyXSA9IHByb2JlUG9pbnQuelxuICB9XG5cbiAgLy8gUGFzcyAyICsgMyBpbiBvbmUgd2FsazogdGhlIGNlbnRyYWwgZGlmZmVyZW5jZSBuZWVkcyBuZWlnaGJvdXJzLCBhbmQgdGhlIGF4aXMgaXNcbiAgLy8ganVzdCB0aGUgbmVnYXRlZCB1bml0IHZlbG9jaXR5LCBzbyBib3RoIGNvbWUgb3V0IG9mIHRoZSBzYW1lIHRocmVlIHBvaW50cy5cbiAgZm9yIChsZXQgayA9IDA7IGsgPCBuOyBrKyspIHtcbiAgICBjb25zdCBoaSA9IChrID09PSAwID8gMCA6IGsgLSAxKSAqIDNcbiAgICBjb25zdCBsbyA9IChrID09PSBuIC0gMSA/IG4gLSAxIDogayArIDEpICogM1xuICAgIC8vIGBoaWAgaXMgdGhlICpuZXdlciogcHJvYmUgKHNtYWxsZXIgZGVsYXkpIGFuZCBgbG9gIHRoZSBvbGRlciwgc29cbiAgICAvLyAobmV3ZXIgLSBvbGRlcikgLyBlbGFwc2VkIGlzIHRoZSBmb3J3YXJkIHZlbG9jaXR5LiBUaGUgZW5kcG9pbnRzIHJldXNlIHRoZWlyXG4gICAgLy8gc2luZ2xlIGF2YWlsYWJsZSBuZWlnaGJvdXIsIHdoaWNoIGhhbHZlcyB0aGUgc3BhbjsgYm90aCBhcmUgc28gZmFyIGRvd24gdGhlXG4gICAgLy8gdGFpbCAoPj0gMiBzIG9sZCkgdGhhdCB0aGUgZGlmZmVyZW5jZSBpcyBpbnZpc2libGUuXG4gICAgY29uc3QgZWxhcHNlZCA9IChrID09PSAwIHx8IGsgPT09IG4gLSAxID8gMSA6IDIpICogc3RlcFxuICAgIGNvbnN0IHZ4ID0gKHh5eltoaV0gLSB4eXpbbG9dKSAvIGVsYXBzZWRcbiAgICBjb25zdCB2eSA9ICh4eXpbaGkgKyAxXSAtIHh5eltsbyArIDFdKSAvIGVsYXBzZWRcbiAgICBjb25zdCB2eiA9ICh4eXpbaGkgKyAyXSAtIHh5eltsbyArIDJdKSAvIGVsYXBzZWRcbiAgICB2ZWxbayAqIDNdID0gdnhcbiAgICB2ZWxbayAqIDMgKyAxXSA9IHZ5XG4gICAgdmVsW2sgKiAzICsgMl0gPSB2elxuXG4gICAgY29uc3Qgc3BlZWQgPSBNYXRoLnNxcnQodnggKiB2eCArIHZ5ICogdnkgKyB2eiAqIHZ6KVxuICAgIGxldCBheDogbnVtYmVyXG4gICAgbGV0IGF5OiBudW1iZXJcbiAgICBsZXQgYXo6IG51bWJlclxuICAgIGlmIChzcGVlZCA+IDFlLTYpIHtcbiAgICAgIC8vIEJhY2t3YXJkOiB0aGUgcGx1bWUgaXMgbGVmdCBiZWhpbmQgdGhlIGRpcmVjdGlvbiBvZiB0cmF2ZWwuXG4gICAgICBheCA9IC12eCAvIHNwZWVkXG4gICAgICBheSA9IC12eSAvIHNwZWVkXG4gICAgICBheiA9IC12eiAvIHNwZWVkXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEEgaGVsZCBnbHlwaCBwaW5zIHRoZSBoZWFkLCBzbyBpdHMgdmVsb2NpdHkgaXMgZ2VudWluZWx5IHplcm8gYW5kIHRoZXJlIGlzIG5vXG4gICAgICAvLyB0YW5nZW50IHRvIGRlcml2ZS4gRmFsbCBiYWNrIHRvIHRoZSB3b3JsZCBYIGF4aXMgcmF0aGVyIHRoYW4gZGl2aWRpbmcgYnkgfjAg4oCUXG4gICAgICAvLyBhbnkgdW5pdCB2ZWN0b3IgaXMgYXMgZ29vZCBhcyBhbnkgb3RoZXIgaGVyZSwgYmVjYXVzZSB0aGUgZW1pc3Npb24gbW9kZWwgaXNcbiAgICAgIC8vIGdhdGVkIG9mZiBieSBgZ2x5cGhNaXhgIGluIGV4YWN0bHkgdGhlc2UgcGhhc2VzIChzZWUgYGludGVncmF0ZWApLlxuICAgICAgYXggPSAtMVxuICAgICAgYXkgPSAwXG4gICAgICBheiA9IDBcbiAgICB9XG4gICAgYXhpc1trICogM10gPSBheFxuICAgIGF4aXNbayAqIDMgKyAxXSA9IGF5XG4gICAgYXhpc1trICogMyArIDJdID0gYXpcblxuICAgIC8vIEFuIG9ydGhvbm9ybWFsIHBhaXIgc3Bhbm5pbmcgdGhlIHBsYW5lIG5vcm1hbCB0byB0aGUgYXhpcy5cbiAgICBjb25zdCByeCA9IE1hdGguYWJzKGF5KSA8IDAuOSA/IDAgOiAxXG4gICAgY29uc3QgcnkgPSBNYXRoLmFicyhheSkgPCAwLjkgPyAxIDogMFxuICAgIGNvbnN0IHJ6ID0gMFxuICAgIGxldCBzMXggPSByeSAqIGF6IC0gcnogKiBheVxuICAgIGxldCBzMXkgPSByeiAqIGF4IC0gcnggKiBhelxuICAgIGxldCBzMXogPSByeCAqIGF5IC0gcnkgKiBheFxuICAgIGNvbnN0IHMxTGVuID0gTWF0aC5zcXJ0KHMxeCAqIHMxeCArIHMxeSAqIHMxeSArIHMxeiAqIHMxeilcbiAgICBpZiAoczFMZW4gPiAxZS02KSB7XG4gICAgICBzMXggLz0gczFMZW5cbiAgICAgIHMxeSAvPSBzMUxlblxuICAgICAgczF6IC89IHMxTGVuXG4gICAgfSBlbHNlIHtcbiAgICAgIHMxeCA9IDFcbiAgICAgIHMxeSA9IDBcbiAgICAgIHMxeiA9IDBcbiAgICB9XG4gICAgc2lkZTFbayAqIDNdID0gczF4XG4gICAgc2lkZTFbayAqIDMgKyAxXSA9IHMxeVxuICAgIHNpZGUxW2sgKiAzICsgMl0gPSBzMXpcbiAgICAvLyBUaGUgc2Vjb25kIGJhc2lzIHZlY3RvciBpcyBhIGNyb3NzIHByb2R1Y3Qgb2YgdHdvIHVuaXQsIG9ydGhvZ29uYWwgdmVjdG9ycywgc29cbiAgICAvLyBpdCBpcyBhbHJlYWR5IHVuaXQgbGVuZ3RoIGFuZCBuZWVkcyBubyBub3JtYWxpc2F0aW9uLlxuICAgIHNpZGUyW2sgKiAzXSA9IGF5ICogczF6IC0gYXogKiBzMXlcbiAgICBzaWRlMltrICogMyArIDFdID0gYXogKiBzMXggLSBheCAqIHMxelxuICAgIHNpZGUyW2sgKiAzICsgMl0gPSBheCAqIHMxeSAtIGF5ICogczF4XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgbGlmZXRpbWUgZmFsbG9mZjogMSBhdCBiaXJ0aCwgZXhhY3RseSAwIGF0IHRoZSBlbmQgb2YgbGlmZSwgbW9ub3RvbmUgYmV0d2Vlbi5cbiAqXG4gKiBgKDEgLSB1KSAqKiBUQUlMX0ZBREVfUE9XRVJgIHJhdGhlciB0aGFuIGEgc21vb3Roc3RlcCBvciBhIGxpbmVhciByYW1wIGJlY2F1c2UgdGhlXG4gKiByZXF1aXJlbWVudCBpcyBhICpncmFkdWFsKiBmYWRlIHRvIG5vdGhpbmcsIGFuZCB0aGlzIGZvcm0gY2Fubm90IG92ZXJzaG9vdDogdGhlXG4gKiB2YWx1ZSBpcyAwIGF0IGB1ID0gMWAgYnkgY29uc3RydWN0aW9uLCBzbyBhIHJlY3ljbGVkIHBhcnRpY2xlIGlzIGludmlzaWJsZSBvbiB0aGVcbiAqIGZyYW1lIGl0IGlzIHJldXNlZCByYXRoZXIgdGhhbiBwb3BwaW5nLiBUaGUgZXhwb25lbnQgYmVsb3cgMSBmcm9udC1sb2FkcyB0aGUgZGVjYXksXG4gKiB3aGljaCByZWFkcyBhcyBtYXRlcmlhbCBhbHJlYWR5IGNvb2xpbmcgYXMgaXQgbGVhdmVzIHRoZSBudWNsZXVzLlxuICpcbiAqIENsYW1wZWQgb24gYm90aCBzaWRlczogYHVgIGNvbWVzIGZyb20gYSBkaXZpc2lvbiBieSBgbGlmZWAsIGFuZCBhIHJlY3ljbGVkIHBhcnRpY2xlXG4gKiB3aG9zZSBgbGlmZWAgd2FzIHNvbWVob3cgMCB3b3VsZCBvdGhlcndpc2UgcHVzaCBhIG5lZ2F0aXZlIGJhc2UgaW50byBgTWF0aC5wb3dgIGFuZFxuICogd3JpdGUgYSBOYU4gaW50byB0aGUgY29sb3VyIGJ1ZmZlciwgd2hpY2ggYmxhbmtzIHRoZSB3aG9sZSBjbG91ZCBmb3IgYSBmcmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxGYWRlKHU6IG51bWJlcik6IG51bWJlciB7XG4gIC8vIE5vbi1maW5pdGUgYHVgIGNhbm5vdCBiZSBjbGFtcGVkIG1lYW5pbmdmdWxseSwgYW5kIHJldHVybmluZyAxIGZvciBhIE5hTiB3b3VsZFxuICAvLyBsZWF2ZSBhIHBlcm1hbmVudGx5IGJyaWdodCBwYXJ0aWNsZSBzdHVjayBpbiB0aGUgcGx1bWUuIEludmlzaWJsZSBpcyB0aGUgc2FmZVxuICAvLyBmYWlsdXJlOiB0aGUgd29yc3QgY2FzZSBpcyBvbmUgbWlzc2luZyBwb2ludCwgbm90IGEgZ2xvd2luZyBhcnRlZmFjdC5cbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodSkpIHJldHVybiAwXG4gIGNvbnN0IHcgPSAxIC0gY2xhbXAwMSh1KVxuICByZXR1cm4gdyA8PSAwID8gMCA6IE1hdGgucG93KHcsIFRBSUxfRkFERV9QT1dFUilcbn1cblxuLyoqXG4gKiBXaGVyZSBvbmUgdGFpbCBwYXJ0aWNsZSBzaXRzLCBpbiBzdWJqZWN0IHNwYWNlLCBmcm9tIGl0cyBvd24gYmFrZWQgbnVtYmVycy5cbiAqXG4gKiAgICAgcCA9IGhlYWQoYWdlKSArIGhlYWRWZWxvY2l0eShhZ2UpwrdhZ2XCt0VOVFJBSU5cbiAqICAgICAgICsgYXBlcnR1cmVPZmZzZXRcbiAqICAgICAgICsgKGF4aXPCt2Nvc864ICsgc2lkZTHCt3Npbs64Y29zz4YgKyBzaWRlMsK3c2luzrhzaW7PhikgwrcgcmVhY2ggwrcgKGFnZS9saWZlKVxuICpcbiAqIEV4dHJhY3RlZCBzbyB0aGUgZW1pc3Npb24gbW9kZWwg4oCUIHRoZSB0aGluZyB0aGUgdXNlciBhY3R1YWxseSBjb21wbGFpbmVkIGFib3V0IOKAlCBpc1xuICogYXNzZXJ0ZWQgYXMgYXJpdGhtZXRpYyByYXRoZXIgdGhhbiBpbnNwZWN0ZWQgaW4gYSBzY3JlZW5zaG90LiBOb3RoaW5nIGhlcmUgdG91Y2hlc1xuICogV2ViR0wsIGFuZCB0aGUgYXhpYWwgcHJvZmlsZSBhbmQgYWdlIGhpc3RvZ3JhbSBpbiB0aGUgYWNjZXB0YW5jZSBkYXRhIGFyZSBwcm9kdWNlZFxuICogYnkgcnVubmluZyB0aGlzIGZ1bmN0aW9uIG92ZXIgdGhlIHNjcmF0Y2ggYXJyYXlzLlxuICpcbiAqIFdyaXRlcyBgb3V0WzAuLjJdYC4gQWxsb2NhdGlvbi1mcmVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVUYWlsUGFydGljbGVQb3NpdGlvbihcbiAgdGFibGU6IEVtaXNzaW9uVGFibGUsXG4gIGFnZTogbnVtYmVyLFxuICBsaWZlOiBudW1iZXIsXG4gIHJlYWNoOiBudW1iZXIsXG4gIGNvbmVYOiBudW1iZXIsXG4gIGNvbmVZOiBudW1iZXIsXG4gIGNvbmVaOiBudW1iZXIsXG4gIGppdHRlclg6IG51bWJlcixcbiAgaml0dGVyWTogbnVtYmVyLFxuICBqaXR0ZXJaOiBudW1iZXIsXG4gIG91dDogRmxvYXQzMkFycmF5XG4pOiB2b2lkIHtcbiAgY29uc3QgbiA9IHRhYmxlLnByb2JlQ291bnRcbiAgY29uc3QgeyB4eXosIHZlbCwgYXhpcywgc2lkZTEsIHNpZGUyIH0gPSB0YWJsZVxuICBjb25zdCBzcGFuID0gdGFibGUuc3BhblNlY29uZHNcbiAgY29uc3Qgc3RlcCA9IHNwYW4gLyBNYXRoLm1heCgxLCBuIC0gMSlcblxuICAvLyBTYW5pdGlzZSBldmVyeSBzY2FsYXIgZmlyc3QuIFRoZXNlIGNvbWUgZnJvbSBhIGZsb2F0IGFjY3VtdWxhdG9yIGluIHRoZSBmcmFtZSBsb29wLFxuICAvLyBhbmQgYSBzaW5nbGUgTmFOIHJlYWNoaW5nIHRoZSBjb2xvdXIgYnVmZmVyIGJsYW5rcyB0aGUgZW50aXJlIGNsb3VkIGZvciBhIGZyYW1lIOKAlFxuICAvLyBzbyB0aGUgZmFpbHVyZSBoYXMgdG8gYmUgbG9jYWwgdG8gb25lIHBhcnRpY2xlLCBub3QgZ2xvYmFsLiBgYWdlYCBpcyBjbGFtcGVkIGludG9cbiAgLy8gdGhlIHRhYmxlIHJhdGhlciB0aGFuIHJlamVjdGVkLCBzaW5jZSAwIGlzIGEgbGVnaXRpbWF0ZSBcImp1c3QgYm9yblwiIHJlYWRpbmcuXG4gIGNvbnN0IHNhZmVBZ2UgPSBOdW1iZXIuaXNGaW5pdGUoYWdlKSA/IGNsYW1wVG8oYWdlLCBzcGFuKSA6IDBcbiAgY29uc3Qgc2FmZUxpZmUgPSBOdW1iZXIuaXNGaW5pdGUobGlmZSkgPyBsaWZlIDogMFxuICBjb25zdCBzYWZlUmVhY2ggPSBOdW1iZXIuaXNGaW5pdGUocmVhY2gpID8gcmVhY2ggOiAwXG5cbiAgLy8gTG9jYXRlIHRoZSBiaXJ0aCBpbnN0YW50IG9uIHRoZSB0YWJsZSdzIHRpbWUgYXhpcywgdGhlbiBsZXJwLiBUaGUgY2xhbXAgaXMgdGhlXG4gIC8vIHJlYXNvbiBgVEFJTF9TRUNPTkRTYCBoYXMgdG8gZXhjZWVkIHRoZSBsb25nZXN0IGxpZmU6IGEgY2xhbXBlZCBwcm9iZSB3b3VsZCBwaW4gYVxuICAvLyB3aG9sZSBjb2x1bW4gb2YgZHlpbmcgcGFydGljbGVzIG9udG8gYSAqZnJlc2hlciogcG9pbnQgb2YgdGhlIHBhdGggYW5kIHRoZXkgd291bGRcbiAgLy8gdmlzaWJseSBzbmFwIHRvd2FyZCB0aGUgaGVhZCBhcyB0aGV5IGZhZGVkLlxuICBjb25zdCBmID0gc2FmZUFnZSAvIHN0ZXBcbiAgY29uc3QgayA9IE1hdGgubWluKG4gLSAyLCBNYXRoLmZsb29yKGYpKVxuICBjb25zdCB0ID0gZiAtIGtcbiAgY29uc3QgYSA9IGsgKiAzXG4gIGNvbnN0IGIgPSAoayArIDEpICogM1xuXG4gIGNvbnN0IHB4ID0geHl6W2FdICsgKHh5eltiXSAtIHh5elthXSkgKiB0XG4gIGNvbnN0IHB5ID0geHl6W2EgKyAxXSArICh4eXpbYiArIDFdIC0geHl6W2EgKyAxXSkgKiB0XG4gIGNvbnN0IHB6ID0geHl6W2EgKyAyXSArICh4eXpbYiArIDJdIC0geHl6W2EgKyAyXSkgKiB0XG5cbiAgLy8gVGhlIGluaGVyaXRlZCBiaXJ0aCB2ZWxvY2l0eS4gVGhpcyBpcyB3aGF0IGtlZXBzIHRoZSBwbHVtZSdzIHZpc2libGUgbGVuZ3RoIGZyb21cbiAgLy8gdHJhY2tpbmcgdGhlIGhlYWQncyBzcGVlZCDigJQgc2VlIGBUQUlMX0VOVFJBSU5gLlxuICBjb25zdCB2eCA9IHZlbFthXSArICh2ZWxbYl0gLSB2ZWxbYV0pICogdFxuICBjb25zdCB2eSA9IHZlbFthICsgMV0gKyAodmVsW2IgKyAxXSAtIHZlbFthICsgMV0pICogdFxuICBjb25zdCB2eiA9IHZlbFthICsgMl0gKyAodmVsW2IgKyAyXSAtIHZlbFthICsgMl0pICogdFxuICBjb25zdCBkcmlmdCA9IHNhZmVBZ2UgKiBUQUlMX0VOVFJBSU5cblxuICAvLyBUaGUgZWplY3Rpb24gY29uZSwgcmUtcmVmZXJlbmNlZCBpbnRvIHRoZSBiaXJ0aCBmcmFtZSBldmVyeSBmcmFtZTogdGhlIGNvbmUgdHVybnNcbiAgLy8gd2l0aCB0aGUgY29tZXQgaW5zdGVhZCBvZiBzdGF5aW5nIGZyb3plbiBpbiB0aGUgZGlyZWN0aW9uIGl0IHdhcyBwb2ludGluZy5cbiAgY29uc3Qgc3ggPSBheGlzW2FdICsgKGF4aXNbYl0gLSBheGlzW2FdKSAqIHRcbiAgY29uc3Qgc3kgPSBheGlzW2EgKyAxXSArIChheGlzW2IgKyAxXSAtIGF4aXNbYSArIDFdKSAqIHRcbiAgY29uc3Qgc3ogPSBheGlzW2EgKyAyXSArIChheGlzW2IgKyAyXSAtIGF4aXNbYSArIDJdKSAqIHRcbiAgY29uc3QgdXggPSBzaWRlMVthXSArIChzaWRlMVtiXSAtIHNpZGUxW2FdKSAqIHRcbiAgY29uc3QgdXkgPSBzaWRlMVthICsgMV0gKyAoc2lkZTFbYiArIDFdIC0gc2lkZTFbYSArIDFdKSAqIHRcbiAgY29uc3QgdXogPSBzaWRlMVthICsgMl0gKyAoc2lkZTFbYiArIDJdIC0gc2lkZTFbYSArIDJdKSAqIHRcbiAgY29uc3Qgd3ggPSBzaWRlMlthXSArIChzaWRlMltiXSAtIHNpZGUyW2FdKSAqIHRcbiAgY29uc3Qgd3kgPSBzaWRlMlthICsgMV0gKyAoc2lkZTJbYiArIDFdIC0gc2lkZTJbYSArIDFdKSAqIHRcbiAgY29uc3Qgd3ogPSBzaWRlMlthICsgMl0gKyAoc2lkZTJbYiArIDJdIC0gc2lkZTJbYSArIDJdKSAqIHRcblxuICAvLyBEaXN0YW5jZSBjb3ZlcmVkIGFsb25nIHRoZSBiaXJ0aCBheGlzLCBpbiB3b3JsZCB1bml0czogdGhlIHBhcnRpY2xlJ3Mgb3duIHJlYWNoLFxuICAvLyByZWFjaGVkIGF0IGl0cyBvd24gZGVhdGgsIHNvIGBsaWZlYCBkcm9wcyBvdXQgYW5kIHRoZSBmYWRlIGVkZ2Ugc3RheXMgY29oZXJlbnQuXG4gIGNvbnN0IHRyYXZlbGxlZCA9IHNhZmVMaWZlID4gMWUtNiA/IHNhZmVSZWFjaCAqIGNsYW1wMDEoc2FmZUFnZSAvIHNhZmVMaWZlKSA6IDBcblxuICBvdXRbMF0gPSBweCArIHZ4ICogZHJpZnQgKyBqaXR0ZXJYICsgKHN4ICogY29uZVggKyB1eCAqIGNvbmVZICsgd3ggKiBjb25lWikgKiB0cmF2ZWxsZWRcbiAgb3V0WzFdID0gcHkgKyB2eSAqIGRyaWZ0ICsgaml0dGVyWSArIChzeSAqIGNvbmVYICsgdXkgKiBjb25lWSArIHd5ICogY29uZVopICogdHJhdmVsbGVkXG4gIG91dFsyXSA9IHB6ICsgdnogKiBkcmlmdCArIGppdHRlclogKyAoc3ogKiBjb25lWCArIHV6ICogY29uZVkgKyB3eiAqIGNvbmVaKSAqIHRyYXZlbGxlZFxufVxuXG4vKiogQWR2YW5jZSBhIHBhcnRpY2xlIGZyb20gaXRzIGxhdGNoZWQgYmlydGggZnJhbWUsIG5ldmVyIGZyb20gaXRzIHByZXZpb3VzIGdseXBoIHBvc2UuICovXG5leHBvcnQgZnVuY3Rpb24gYWR2YW5jZUVtaXR0ZWRUYWlsKFxuICBzOiBFbmdpbmVTY3JhdGNoLFxuICBpOiBudW1iZXIsXG4gIGRlbHRhOiBudW1iZXIsXG4gIG91dDogRmxvYXQzMkFycmF5XG4pOiBudW1iZXIge1xuICBjb25zdCBsaWZlID0gcy50YWlsTGlmZVtpXVxuICBpZiAoIShsaWZlID4gMCkpIHJldHVybiAwXG4gIGNvbnN0IGlkeCA9IGkgKiAzXG4gIGxldCBhZ2UgPSBzLnRhaWxBZ2VbaV0gKyBNYXRoLm1heCgwLCBkZWx0YSlcbiAgY29uc3QgcmVjeWNsZWQgPSBhZ2UgPj0gbGlmZVxuICBpZiAocmVjeWNsZWQpIGFnZSAlPSBsaWZlXG4gIHMudGFpbEFnZVtpXSA9IGFnZVxuXG4gIGlmICghcy50YWlsUmVhZHlbaV0gfHwgcmVjeWNsZWQpIHtcbiAgICBjb25zdCB0YWJsZSA9IHMudGFpbFRhYmxlXG4gICAgY29uc3QgZiA9IE1hdGgubWluKHRhYmxlLnByb2JlQ291bnQgLSAxLCBhZ2UgLyB0YWJsZS5zcGFuU2Vjb25kcyAqICh0YWJsZS5wcm9iZUNvdW50IC0gMSkpXG4gICAgY29uc3QgYSA9IE1hdGgubWluKHRhYmxlLnByb2JlQ291bnQgLSAyLCBNYXRoLmZsb29yKGYpKSAqIDNcbiAgICBjb25zdCB0ID0gZiAtIGEgLyAzXG4gICAgY29uc3Qgc3BlZWQgPSBzLnRhaWxSZWFjaFtpXSAvIGxpZmVcbiAgICBmb3IgKGxldCBqID0gMDsgaiA8IDM7IGorKykge1xuICAgICAgY29uc3QgayA9IGEgKyBqXG4gICAgICBjb25zdCBiID0gayArIDNcbiAgICAgIGNvbnN0IG9yaWdpbiA9IHRhYmxlLnh5eltrXSArICh0YWJsZS54eXpbYl0gLSB0YWJsZS54eXpba10pICogdFxuICAgICAgY29uc3QgdmVsb2NpdHkgPSB0YWJsZS52ZWxba10gKyAodGFibGUudmVsW2JdIC0gdGFibGUudmVsW2tdKSAqIHRcbiAgICAgIGNvbnN0IGF4aXMgPSB0YWJsZS5heGlzW2tdICsgKHRhYmxlLmF4aXNbYl0gLSB0YWJsZS5heGlzW2tdKSAqIHRcbiAgICAgIGNvbnN0IHNpZGUxID0gdGFibGUuc2lkZTFba10gKyAodGFibGUuc2lkZTFbYl0gLSB0YWJsZS5zaWRlMVtrXSkgKiB0XG4gICAgICBjb25zdCBzaWRlMiA9IHRhYmxlLnNpZGUyW2tdICsgKHRhYmxlLnNpZGUyW2JdIC0gdGFibGUuc2lkZTJba10pICogdFxuICAgICAgcy50YWlsQmlydGhQb3NpdGlvbltpZHggKyBqXSA9IG9yaWdpbiArIHMuaGVhZE9mZnNldFtpZHggKyBqXVxuICAgICAgcy50YWlsQmlydGhWZWxvY2l0eVtpZHggKyBqXSA9IHZlbG9jaXR5ICogVEFJTF9FTlRSQUlOICsgc3BlZWQgKiAoXG4gICAgICAgIGF4aXMgKiBzLnRhaWxDb25lW2lkeF0gKyBzaWRlMSAqIHMudGFpbENvbmVbaWR4ICsgMV0gKyBzaWRlMiAqIHMudGFpbENvbmVbaWR4ICsgMl1cbiAgICAgIClcbiAgICAgIHMucG9pbnRlck9mZnNldFtpZHggKyBqXSA9IDBcbiAgICAgIHMudmVsb2NpdGllc1tpZHggKyBqXSA9IDBcbiAgICB9XG4gICAgcy50YWlsUmVhZHlbaV0gPSAxXG4gIH1cbiAgZm9yIChsZXQgaiA9IDA7IGogPCAzOyBqKyspIHtcbiAgICBvdXRbal0gPSBzLnRhaWxCaXJ0aFBvc2l0aW9uW2lkeCArIGpdICsgcy50YWlsQmlydGhWZWxvY2l0eVtpZHggKyBqXSAqIGFnZVxuICB9XG4gIHJldHVybiB0YWlsRmFkZShhZ2UgLyBsaWZlKVxufVxuXG4vKiogQ2xhbXAgYHZgIGludG8gYFswLCBoaV1gLCBtYXBwaW5nIE5hTiBhbmQgbmVnYXRpdmVzIHRvIDAuICovXG5mdW5jdGlvbiBjbGFtcFRvKHY6IG51bWJlciwgaGk6IG51bWJlcik6IG51bWJlciB7XG4gIGlmICghKHYgPiAwKSkgcmV0dXJuIDBcbiAgcmV0dXJuIHYgPCBoaSA/IHYgOiBoaVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEVuZ2luZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjbGFzcyBQYXJ0aWNsZUVuZ2luZSBpbXBsZW1lbnRzIFBhcnRpY2xlRW5naW5lQ29udHJhY3Qge1xuICBwcml2YXRlIHJlYWRvbmx5IG9wdGlvbnM6IFBhcnRpY2xlRW5naW5lT3B0aW9uc1xuICBwcml2YXRlIHJlYWRvbmx5IHF1YWxpdHk6IFF1YWxpdHlQcm9maWxlXG4gIHByaXZhdGUgcmVhZG9ubHkgcm9zdGVyOiByZWFkb25seSB7IHNsdWc6IHN0cmluZzsgbGFiZWw6IHN0cmluZyB9W11cblxuICBwcml2YXRlIHJlYWRvbmx5IGNvbnRhaW5lcjogSFRNTEVsZW1lbnRcbiAgcHJpdmF0ZSByZWFkb25seSByZW5kZXJlcjogV2ViR0xSZW5kZXJlclxuICBwcml2YXRlIHJlYWRvbmx5IHNjZW5lID0gbmV3IFNjZW5lKClcbiAgcHJpdmF0ZSByZWFkb25seSBjYW1lcmE6IFBlcnNwZWN0aXZlQ2FtZXJhXG4gIHByaXZhdGUgcmVhZG9ubHkgcG9pbnRzOiBQb2ludHNcbiAgcHJpdmF0ZSByZWFkb25seSBnZW9tZXRyeTogQnVmZmVyR2VvbWV0cnlcbiAgcHJpdmF0ZSByZWFkb25seSBtYXRlcmlhbDogUG9pbnRzTWF0ZXJpYWxcbiAgLyoqIERldi1vYnNlcnZhYmxlOiBpbmRlcGVuZGVudCBmaW5hbCBHUFUgYnVmZmVycywgbmV2ZXIgZ2x5cGggdGFyZ2V0cy4gKi9cbiAgcmVhZG9ubHkgdGFpbFBvaW50czogUG9pbnRzXG4gIHByaXZhdGUgcmVhZG9ubHkgdGFpbEdlb21ldHJ5OiBCdWZmZXJHZW9tZXRyeVxuICBwcml2YXRlIHJlYWRvbmx5IHRhaWxNYXRlcmlhbDogUG9pbnRzTWF0ZXJpYWxcblxuICBwcml2YXRlIHJlYWRvbmx5IGNob3Jlb2dyYXBoeTogQ2hvcmVvZ3JhcGh5XG4gIHByaXZhdGUgcmVhZG9ubHkgc3RhcmZpZWxkOiBTdGFyZmllbGRcbiAgcHJpdmF0ZSByZWFkb25seSBicmFuZFNvdXJjZTogQnJhbmRUYXJnZXRTb3VyY2VcbiAgcHJpdmF0ZSByZWFkb25seSBvd25zQnJhbmRTb3VyY2U6IGJvb2xlYW5cblxuICBwcml2YXRlIHJlYWRvbmx5IHNjcmF0Y2g6IEVuZ2luZVNjcmF0Y2hcbiAgLyoqIE9uZSBvYmplY3QsIG11dGF0ZWQgaW4gcGxhY2UgYW5kIHJlcHVibGlzaGVkIGV2ZXJ5IGZyYW1lIChzZWUgwqc2IGl0ZW0gMikuICovXG4gIHByaXZhdGUgcmVhZG9ubHkgc3RhdHM6IEVuZ2luZVN0YXRzXG5cbiAgcHJpdmF0ZSBydW5uaW5nID0gZmFsc2VcbiAgcHJpdmF0ZSByYWZJZCA9IDBcbiAgcHJpdmF0ZSBkaXNwb3NlZCA9IGZhbHNlXG4gIHByaXZhdGUgbGFzdEZyYW1lTXMgPSAwXG4gIHByaXZhdGUgZG9sbHlTZWNvbmRzID0gMFxuICBwcml2YXRlIHJlZHVjZWRNb3Rpb246IGJvb2xlYW5cbiAgcHJpdmF0ZSBsaWdodDogYm9vbGVhblxuICBwcml2YXRlIHBhbGV0dGU6IFRoZW1lUGFsZXR0ZVxuICBwcml2YXRlIHdpZHRoID0gMVxuICBwcml2YXRlIGhlaWdodCA9IDFcbiAgcHJpdmF0ZSBmaXRHYXAgPSBET0xMWV9GUk9NX1pcbiAgcHJpdmF0ZSBmaXREaXN0YW5jZSA9IERPTExZX0ZST01fWlxuICBwcml2YXRlIHJlYWRvbmx5IHBhcnRpY2xlQ291bnQ6IG51bWJlclxuICBwcml2YXRlIHJlYWRvbmx5IHRhaWxTYW1wbGVDb3VudDogbnVtYmVyXG4gIHByaXZhdGUgcmVhZG9ubHkgZnJhbWVUaW1lcyA9IG5ldyBGbG9hdDY0QXJyYXkoMzApXG4gIHByaXZhdGUgZnJhbWVDb3VudCA9IDBcbiAgcHJpdmF0ZSBmcmFtZUN1cnNvciA9IDBcblxuICBwcml2YXRlIHJlYWRvbmx5IHBvaW50ZXIgPSB7IGNsaWVudFg6IDAsIGNsaWVudFk6IDAsIGFjdGl2ZTogZmFsc2UsIGxhc3RNb3ZlOiAwIH1cbiAgcHJpdmF0ZSBwb2ludGVyQm91bmQgPSBmYWxzZVxuXG4gIHByaXZhdGUgY3VycmVudEJyYW5kU2x1Zzogc3RyaW5nIHwgbnVsbCA9IG51bGxcbiAgcHJpdmF0ZSBjdXJyZW50R2x5cGhMZWcgPSAtMVxuICAvKiogQ2VudHJlIHJlcHJlc2VudGVkIGJ5IHRoZSBwcmV2aW91cyBnZW9tZXRyeSB1cGxvYWQsIGJlZm9yZSBpbnRlcm5hbCBvZmZzZXRzLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHJlbmRlcmVkSGVhZCA9IG5ldyBWZWN0b3IzKClcbiAgcHJpdmF0ZSBsYXN0UGhhc2U6IENvbWV0UGhhc2UgPSAndHJhdmVsJ1xuICBwcml2YXRlIGhvbGRGYWRlID0gMFxuICBwcml2YXRlIHJlbmRlcmVkUGhhc2U6IENvbWV0UGhhc2UgPSAndHJhdmVsJ1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM6IFBhcnRpY2xlRW5naW5lT3B0aW9ucykge1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnNcbiAgICB0aGlzLmNvbnRhaW5lciA9IG9wdGlvbnMuY29udGFpbmVyXG4gICAgdGhpcy5saWdodCA9IG9wdGlvbnMuaXNMaWdodFRoZW1lID8/IGZhbHNlXG4gICAgdGhpcy5yZWR1Y2VkTW90aW9uID0gb3B0aW9ucy5yZWR1Y2VkTW90aW9uID8/IGZhbHNlXG4gICAgdGhpcy5wYWxldHRlID0gcGFsZXR0ZUZvcih0aGlzLmxpZ2h0KVxuICAgIHRoaXMucm9zdGVyID0gb3B0aW9ucy5icmFuZHMubGVuZ3RoID4gMCA/IG9wdGlvbnMuYnJhbmRzIDogQlJBTkRTXG5cbiAgICBjb25zdCBwcm9iZWQgPSBwcm9iZVF1YWxpdHlQcm9maWxlKFxuICAgICAgdHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcgPyAxMjgwIDogd2luZG93LmlubmVyV2lkdGhcbiAgICApXG4gICAgdGhpcy5xdWFsaXR5ID0gY3JlYXRlUXVhbGl0eVByb2ZpbGUoeyAuLi5wcm9iZWQsIC4uLm9wdGlvbnMucXVhbGl0eSB9KVxuICAgIHRoaXMucGFydGljbGVDb3VudCA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IodGhpcy5xdWFsaXR5LnBhcnRpY2xlQ291bnQpKVxuICAgIHRoaXMudGFpbFNhbXBsZUNvdW50ID0gTWF0aC5tYXgoOCwgTWF0aC5mbG9vcih0aGlzLnF1YWxpdHkudGFpbFNhbXBsZUNvdW50KSlcblxuICAgIGNvbnN0IHJlY3QgPSB0aGlzLmNvbnRhaW5lci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKVxuICAgIHRoaXMud2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHJlY3Qud2lkdGggfHwgdGhpcy5jb250YWluZXIuY2xpZW50V2lkdGggfHwgMSkpXG4gICAgdGhpcy5oZWlnaHQgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHJlY3QuaGVpZ2h0IHx8IHRoaXMuY29udGFpbmVyLmNsaWVudEhlaWdodCB8fCAxKSlcblxuICAgIC8vIFRocm93cyB3aGVuIHRoZXJlIGlzIG5vIGNvbnRleHQgdG8gYmUgaGFkOyB0aGUgY2FsbGVyIGRlZ3JhZGVzLlxuICAgIHRoaXMucmVuZGVyZXIgPSBuZXcgV2ViR0xSZW5kZXJlcih7XG4gICAgICBhbnRpYWxpYXM6IHRoaXMucXVhbGl0eS5hbnRpYWxpYXMsXG4gICAgICBhbHBoYTogdHJ1ZSxcbiAgICAgIHBvd2VyUHJlZmVyZW5jZTogJ2hpZ2gtcGVyZm9ybWFuY2UnLFxuICAgIH0pXG4gICAgdGhpcy5yZW5kZXJlci5zZXRQaXhlbFJhdGlvKE1hdGgubWluKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDEsIHRoaXMucXVhbGl0eS5tYXhEcHIpKVxuICAgIHRoaXMucmVuZGVyZXIuc2V0U2l6ZSh0aGlzLndpZHRoLCB0aGlzLmhlaWdodCwgdHJ1ZSlcbiAgICB0aGlzLnJlbmRlcmVyLnNldENsZWFyQ29sb3IodGhpcy5wYWxldHRlLmJhY2tncm91bmQsIHRoaXMubGlnaHQgPyAxIDogMClcblxuICAgIGNvbnN0IGNhbnZhcyA9IHRoaXMucmVuZGVyZXIuZG9tRWxlbWVudFxuICAgIGNhbnZhcy5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJ1xuICAgIGNhbnZhcy5zdHlsZS53aWR0aCA9ICcxMDAlJ1xuICAgIGNhbnZhcy5zdHlsZS5oZWlnaHQgPSAnMTAwJSdcbiAgICBjYW52YXMuc2V0QXR0cmlidXRlKCdhcmlhLWhpZGRlbicsICd0cnVlJylcbiAgICB0aGlzLmNvbnRhaW5lci5hcHBlbmRDaGlsZChjYW52YXMpXG5cbiAgICB0aGlzLmNhbWVyYSA9IG5ldyBQZXJzcGVjdGl2ZUNhbWVyYShcbiAgICAgIENBTUVSQV9GT1YsXG4gICAgICB0aGlzLndpZHRoIC8gdGhpcy5oZWlnaHQsXG4gICAgICBDQU1FUkFfTkVBUixcbiAgICAgIENBTUVSQV9GQVJcbiAgICApXG4gICAgdGhpcy5jYW1lcmEucG9zaXRpb24uc2V0KDAsIDAsIERPTExZX0ZST01fWilcblxuICAgIHRoaXMuc2NyYXRjaCA9IGNyZWF0ZUVuZ2luZVNjcmF0Y2godGhpcy5wYXJ0aWNsZUNvdW50LCB0aGlzLnRhaWxTYW1wbGVDb3VudClcblxuICAgIHRoaXMuZ2VvbWV0cnkgPSBuZXcgQnVmZmVyR2VvbWV0cnkoKVxuICAgIGNvbnN0IHBvc0F0dHIgPSBuZXcgQnVmZmVyQXR0cmlidXRlKHRoaXMuc2NyYXRjaC5wb3NpdGlvbnMsIDMpXG4gICAgcG9zQXR0ci5zZXRVc2FnZShEeW5hbWljRHJhd1VzYWdlKVxuICAgIGNvbnN0IGNvbEF0dHIgPSBuZXcgQnVmZmVyQXR0cmlidXRlKHRoaXMuc2NyYXRjaC5jb2xvcnMsIDQpXG4gICAgY29sQXR0ci5zZXRVc2FnZShEeW5hbWljRHJhd1VzYWdlKVxuICAgIHRoaXMuZ2VvbWV0cnkuc2V0QXR0cmlidXRlKCdwb3NpdGlvbicsIHBvc0F0dHIpXG4gICAgdGhpcy5nZW9tZXRyeS5zZXRBdHRyaWJ1dGUoJ2NvbG9yJywgY29sQXR0cilcbiAgICB0aGlzLmdlb21ldHJ5LnNldEF0dHJpYnV0ZSgnY29tZXRTY2FsZScsIG5ldyBCdWZmZXJBdHRyaWJ1dGUodGhpcy5zY3JhdGNoLmJvZHkuc3ByaXRlU2NhbGUsIDEpLnNldFVzYWdlKER5bmFtaWNEcmF3VXNhZ2UpKVxuICAgIC8vIFRoZSBjbG91ZCBpcyBhdXRob3JlZCBwZXIgZnJhbWUgYW5kIG5ldmVyIGN1bGxlZCwgc28gdGhyZWUgbXVzdCBub3QgdHJ5IHRvXG4gICAgLy8gY29tcHV0ZSBhIGJvdW5kaW5nIHNwaGVyZSBmcm9tIG9uZSBmcmFtZSdzIHdvcnRoIG9mIHBvc2l0aW9ucy5cbiAgICB0aGlzLmdlb21ldHJ5LmJvdW5kaW5nU3BoZXJlID0gbnVsbFxuXG4gICAgdGhpcy5tYXRlcmlhbCA9IG5ldyBQb2ludHNNYXRlcmlhbCh7XG4gICAgICBtYXA6IGFjcXVpcmVHbG93VGV4dHVyZSgpID8/IHVuZGVmaW5lZCxcbiAgICAgIHZlcnRleENvbG9yczogdHJ1ZSxcbiAgICAgIHRyYW5zcGFyZW50OiB0cnVlLFxuICAgICAgZGVwdGhXcml0ZTogZmFsc2UsXG4gICAgICBkZXB0aFRlc3Q6IGZhbHNlLFxuICAgICAgYmxlbmRpbmc6IHRoaXMucGFsZXR0ZS5ibGVuZGluZyxcbiAgICAgIHNpemU6IHRoaXMucGFsZXR0ZS5wb2ludFNpemUsXG4gICAgICBzaXplQXR0ZW51YXRpb246IHRydWUsXG4gICAgICBvcGFjaXR5OiB0aGlzLnBhbGV0dGUub3BhY2l0eSxcbiAgICB9KVxuXG4gICAgdGhpcy5wb2ludHMgPSBuZXcgUG9pbnRzKHRoaXMuZ2VvbWV0cnksIHRoaXMubWF0ZXJpYWwpXG4gICAgLy8gQm90aCBwb29scyBzaGFyZSB0aGlzIGZpeGVkIG9yaWdpbi4gTW90aW9uIGxpdmVzIGluIHRoZSBnZW9tZXRyeSBhcnJheXM7XG4gICAgLy8gY2FtZXJhIHRyYXZlbCBtdXN0IG5ldmVyIHRyYW5zbGF0ZSBwYXJ0aWNsZXMgdGhhdCBoYXZlIGFscmVhZHkgYmVlbiBib3JuLlxuICAgIHRoaXMucG9pbnRzLnBvc2l0aW9uLnNldCgwLCAwLCBTVUJKRUNUX1opXG4gICAgdGhpcy5wb2ludHMuZnJ1c3R1bUN1bGxlZCA9IGZhbHNlXG4gICAgdGhpcy5zY2VuZS5hZGQodGhpcy5wb2ludHMpXG5cbiAgICB0aGlzLnRhaWxHZW9tZXRyeSA9IG5ldyBCdWZmZXJHZW9tZXRyeSgpXG4gICAgdGhpcy50YWlsR2VvbWV0cnkuc2V0QXR0cmlidXRlKCdwb3NpdGlvbicsIG5ldyBCdWZmZXJBdHRyaWJ1dGUodGhpcy5zY3JhdGNoLmVtaXR0ZWRUYWlsLnBvc2l0aW9ucywgMykuc2V0VXNhZ2UoRHluYW1pY0RyYXdVc2FnZSkpXG4gICAgdGhpcy50YWlsR2VvbWV0cnkuc2V0QXR0cmlidXRlKCdjb2xvcicsIG5ldyBCdWZmZXJBdHRyaWJ1dGUodGhpcy5zY3JhdGNoLmVtaXR0ZWRUYWlsLmNvbG9ycywgNCkuc2V0VXNhZ2UoRHluYW1pY0RyYXdVc2FnZSkpXG4gICAgdGhpcy50YWlsTWF0ZXJpYWwgPSB0aGlzLm1hdGVyaWFsLmNsb25lKClcbiAgICB0aGlzLnRhaWxNYXRlcmlhbC5zaXplID0gdGhpcy5wYWxldHRlLnBvaW50U2l6ZSAqICh0aGlzLmxpZ2h0ID8gMS4wNSA6IDMuNilcbiAgICAvLyBPbmx5IHRoZSBib2R5IHVzZXMgcGVyLXBvaW50IGNvdmVyYWdlOyB0aGUgdGFpbCBrZWVwcyBpdHMgb3duIG1hdGVyaWFsLlxuICAgIHRoaXMubWF0ZXJpYWwub25CZWZvcmVDb21waWxlID0gc2hhZGVyID0+IHtcbiAgICAgIHNoYWRlci52ZXJ0ZXhTaGFkZXIgPSBgYXR0cmlidXRlIGZsb2F0IGNvbWV0U2NhbGU7XFxuJHtzaGFkZXIudmVydGV4U2hhZGVyfWAucmVwbGFjZShcbiAgICAgICAgJ2dsX1BvaW50U2l6ZSA9IHNpemU7JywgJ2dsX1BvaW50U2l6ZSA9IHNpemUgKiBjb21ldFNjYWxlOydcbiAgICAgIClcbiAgICB9XG4gICAgdGhpcy5tYXRlcmlhbC5jdXN0b21Qcm9ncmFtQ2FjaGVLZXkgPSAoKSA9PiAnY29tZXQtYm9keS1jb3ZlcmFnZS12MSdcbiAgICB0aGlzLnRhaWxQb2ludHMgPSBuZXcgUG9pbnRzKHRoaXMudGFpbEdlb21ldHJ5LCB0aGlzLnRhaWxNYXRlcmlhbClcbiAgICB0aGlzLnRhaWxQb2ludHMubmFtZSA9ICdjYXVzYWwtZW1pdHRlZC10YWlsJ1xuICAgIHRoaXMudGFpbFBvaW50cy5mcnVzdHVtQ3VsbGVkID0gZmFsc2VcbiAgICB0aGlzLnRhaWxQb2ludHMucG9zaXRpb24uY29weSh0aGlzLnBvaW50cy5wb3NpdGlvbilcbiAgICB0aGlzLnNjZW5lLmFkZCh0aGlzLnRhaWxQb2ludHMpXG5cbiAgICB0aGlzLnN0YXJmaWVsZCA9IGNyZWF0ZVN0YXJmaWVsZCh7XG4gICAgICBjb3VudDogdGhpcy5xdWFsaXR5LnN0YXJDb3VudCxcbiAgICAgIHJlZHVjZWRNb3Rpb246IHRoaXMucmVkdWNlZE1vdGlvbixcbiAgICAgIGlzTGlnaHRUaGVtZTogdGhpcy5saWdodCxcbiAgICB9KVxuICAgIHRoaXMuc2NlbmUuYWRkKHRoaXMuc3RhcmZpZWxkLm9iamVjdClcblxuICAgIHRoaXMuY2hvcmVvZ3JhcGh5ID0gY3JlYXRlQ2hvcmVvZ3JhcGh5KHtcbiAgICAgIGJyYW5kQ291bnQ6IHRoaXMucm9zdGVyLmxlbmd0aCxcbiAgICAgIGFtcGxpdHVkZVg6IEFNUExJVFVERV9YLFxuICAgICAgLy8gU3BhY2UgbW90aW9uIGtlZXBzIHRoZSBjZW50cmUgb24gWT0wIGluIGV2ZXJ5IHZpZXdwb3J0LlxuICAgICAgc3dheVk6IDAsXG4gICAgICBzd2F5WjogMCxcbiAgICAgIGxlZ1NlY29uZHM6IExFR19TRUNPTkRTLFxuICAgICAgZ2F0aGVyU2Vjb25kczogR0FUSEVSX1NFQ09ORFMsXG4gICAgICBob2xkU2Vjb25kczogSE9MRF9TRUNPTkRTLFxuICAgICAgc2NhdHRlclNlY29uZHM6IFNDQVRURVJfU0VDT05EUyxcbiAgICB9KVxuXG4gICAgdGhpcy5vd25zQnJhbmRTb3VyY2UgPSAhb3B0aW9ucy50YXJnZXRTb3VyY2VcbiAgICB0aGlzLmJyYW5kU291cmNlID0gb3B0aW9ucy50YXJnZXRTb3VyY2UgPz8gY3JlYXRlQnJhbmRUYXJnZXRTb3VyY2UoKVxuXG4gICAgdGhpcy5zdGF0cyA9IHtcbiAgICAgIGZwczogMCxcbiAgICAgIHBhcnRpY2xlQ291bnQ6IHRoaXMucGFydGljbGVDb3VudCxcbiAgICAgIHBoYXNlOiAndHJhdmVsJyxcbiAgICAgIGJyYW5kU2x1ZzogbnVsbCxcbiAgICAgIGRyYXdDYWxsczogMCxcbiAgICAgIHRyaWFuZ2xlczogMCxcbiAgICAgIGdlb21ldHJ5Qnl0ZXM6IDAsXG4gICAgfVxuXG4gICAgdGhpcy51cGRhdGVDYW1lcmFGaXQoKVxuICAgIHRoaXMuYWR2YW5jZUNhbWVyYSgpXG4gICAgY29uc3QgaGVhZCA9IHRoaXMuY2hvcmVvZ3JhcGh5LnN0YXRlXG4gICAgdGhpcy5yZW5kZXJlZEhlYWQuc2V0KGhlYWQuaGVhZFgsIGhlYWQuaGVhZFksIGhlYWQuaGVhZFopXG4gICAgLy8gVGhlIGhlYWQgYW5kIGhpc3RvcmljYWwgc2FtcGxlcyB1c2UgdGhlIHNhbWUgdmlld3BvcnQgb3B0aW9ucy5cbiAgICB0aGlzLmFwcGx5Vmlld3BvcnRTd2F5KClcbiAgICB0aGlzLmJpbmRQb2ludGVyKClcbiAgICB0aGlzLmJpbmRDb250ZXh0TG9zcygpXG5cbiAgICAvLyBTZWVkIHRoZSBvcGVuaW5nIGdseXBoIGFuZCBxdWV1ZSB0aGUgbmV4dCwgc28gdGhlIGZpcnN0IGdhdGhlciBuZXZlciB3YWl0c1xuICAgIC8vIG9uIGEgcmFzdGVyaXNlLlxuICAgIHRoaXMuc3luY0dseXBoKClcbiAgICB0aGlzLnByZWZldGNoQWhlYWQoKVxuXG4gICAgLy8gRGV2LW9ubHkgaGFuZGxlIHNvIGFuIGFjY2VwdGFuY2Ugc2NyaXB0IGNhbiBpbnRlcnJvZ2F0ZSB0aGUgbGl2ZSBzY2VuZVxuICAgIC8vIChsYXllciBjb3VudHMsIGNhbWVyYSBwb3NpdGlvbiwgb3JiaXQgY3Vyc29yKSBpbnN0ZWFkIG9mIGluZmVycmluZyBpdHMgc3RhdGVcbiAgICAvLyBmcm9tIGEgc2NyZWVuc2hvdC4gU3RyaXBwZWQgZnJvbSBhIHByb2R1Y3Rpb24gYnVpbGQgYnkgdGhlIGJ1bmRsZXIuXG4gICAgaWYgKGltcG9ydC5tZXRhLmVudi5ERVYpIHtcbiAgICAgIGNvbnN0IGhvbGRlciA9IHdpbmRvdyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICBob2xkZXIuX19TVUIyQVBJX1BBUlRJQ0xFX0VOR0lORV9fID0gdGhpc1xuICAgIH1cbiAgfVxuXG4gIC8qKiBEZXYtb25seTogdGhlIGxpdmUgdGhyZWUuanMgb2JqZWN0cywgZm9yIHRoZSBhY2NlcHRhbmNlIHNjcmlwdHMuICovXG4gIGdldCBkZWJ1Z1NjZW5lKCk6IHsgY2FtZXJhOiBQZXJzcGVjdGl2ZUNhbWVyYTsgc2NlbmU6IFNjZW5lOyBwb2ludHM6IFBvaW50cyB9IHtcbiAgICByZXR1cm4geyBjYW1lcmE6IHRoaXMuY2FtZXJhLCBzY2VuZTogdGhpcy5zY2VuZSwgcG9pbnRzOiB0aGlzLnBvaW50cyB9XG4gIH1cblxuICAvKipcbiAgICogRGV2LW9ubHk6IHRoZSByZW5kZXJlcidzIGN1cnJlbnQgY2xlYXIgY29sb3VyIGFzIGEgaGV4IHN0cmluZy5cbiAgICpcbiAgICogUmVhZCBvZmYgdGhlIHJlbmRlcmVyIHJhdGhlciB0aGFuIHJlLWRlcml2aW5nIGl0IGZyb20gdGhlIHBhbGV0dGUsIHNvIGFcbiAgICogbWlzbWF0Y2ggYmV0d2VlbiB3aGF0IHRoZSB0aGVtZSBzZXQgYW5kIHdoYXQgd2FzIGFjdHVhbGx5IGFwcGxpZWQgaXMgdmlzaWJsZVxuICAgKiB0byB0aGUgYWNjZXB0YW5jZSBwcm9iZXMuIFRoaXMgaXMgdGhlIGNvbG91ciB0aGF0IGRlY2lkZXMgd2hldGhlciB0aGUgY2FudmFzXG4gICAqIHNpdHMgKmJlaGluZCogdGhlIHBhZ2Ugb3IgcGFpbnRzIG92ZXIgaXQsIHdoaWNoIGlzIGEgbGlnaHQtdGhlbWUtb25seSBmYWlsdXJlXG4gICAqIHRoYXQgbm90aGluZyBlbHNlIHdvdWxkIGNhdGNoLlxuICAgKi9cbiAgZGVidWdSZW5kZXJlckNsZWFySGV4KCk6IHN0cmluZyB7XG4gICAgLy8gYGdldENsZWFyQ29sb3JgIHdyaXRlcyBpbnRvIGEgY2FsbGVyLW93bmVkIENvbG9yLCBzbyB0aGlzIGFsbG9jYXRlcyBvbmx5IHdoZW5cbiAgICAvLyBhIHByb2JlIGNhbGxzIGl0LCBuZXZlciBwZXIgZnJhbWUuXG4gICAgY29uc3Qgb3V0ID0gbmV3IENvbG9yKClcbiAgICB0aGlzLnJlbmRlcmVyLmdldENsZWFyQ29sb3Iob3V0KVxuICAgIHJldHVybiAnIycgKyBvdXQuZ2V0SGV4U3RyaW5nKClcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gUHVibGljIEFQSVxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgc3RhcnQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuZGlzcG9zZWQgfHwgdGhpcy5ydW5uaW5nKSByZXR1cm5cbiAgICB0aGlzLnJ1bm5pbmcgPSB0cnVlXG4gICAgdGhpcy5sYXN0RnJhbWVNcyA9IDBcbiAgICB0aGlzLnJhZklkID0gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHRoaXMudGljaylcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5ydW5uaW5nID0gZmFsc2VcbiAgICBpZiAodGhpcy5yYWZJZCkge1xuICAgICAgLy8gQ2FuY2VsbGluZyDigJQgcmF0aGVyIHRoYW4gcmV0dXJuaW5nIGVhcmx5IGluc2lkZSB0aGUgY2FsbGJhY2sg4oCUIGlzIHdoYXRcbiAgICAgIC8vIG1ha2VzIGEgaGlkZGVuIHRhYiBjb3N0IG5vdGhpbmcgaW5zdGVhZCBvZiBhIG5vLW9wIGZyYW1lIGV2ZXJ5IHRpY2suXG4gICAgICBjYW5jZWxBbmltYXRpb25GcmFtZSh0aGlzLnJhZklkKVxuICAgICAgdGhpcy5yYWZJZCA9IDBcbiAgICB9XG4gIH1cblxuICBzZXRUaGVtZShpc0xpZ2h0VGhlbWU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBpZiAodGhpcy5kaXNwb3NlZCB8fCB0aGlzLmxpZ2h0ID09PSBpc0xpZ2h0VGhlbWUpIHJldHVyblxuICAgIHRoaXMubGlnaHQgPSBpc0xpZ2h0VGhlbWVcbiAgICB0aGlzLnBhbGV0dGUgPSBwYWxldHRlRm9yKGlzTGlnaHRUaGVtZSlcbiAgICB0aGlzLm1hdGVyaWFsLmJsZW5kaW5nID0gdGhpcy5wYWxldHRlLmJsZW5kaW5nXG4gICAgdGhpcy5tYXRlcmlhbC5zaXplID0gdGhpcy5wYWxldHRlLnBvaW50U2l6ZVxuICAgIHRoaXMubWF0ZXJpYWwub3BhY2l0eSA9IHRoaXMucGFsZXR0ZS5vcGFjaXR5XG4gICAgdGhpcy5tYXRlcmlhbC5uZWVkc1VwZGF0ZSA9IHRydWVcbiAgICB0aGlzLnRhaWxNYXRlcmlhbC5ibGVuZGluZyA9IHRoaXMucGFsZXR0ZS5ibGVuZGluZ1xuICAgIHRoaXMudGFpbE1hdGVyaWFsLnNpemUgPSB0aGlzLnBhbGV0dGUucG9pbnRTaXplICogKHRoaXMubGlnaHQgPyAxLjA1IDogMy42KVxuICAgIHRoaXMudGFpbE1hdGVyaWFsLm9wYWNpdHkgPSB0aGlzLnBhbGV0dGUub3BhY2l0eVxuICAgIHRoaXMudGFpbE1hdGVyaWFsLm5lZWRzVXBkYXRlID0gdHJ1ZVxuICAgIHRoaXMucmVuZGVyZXIuc2V0Q2xlYXJDb2xvcih0aGlzLnBhbGV0dGUuYmFja2dyb3VuZCwgaXNMaWdodFRoZW1lID8gMSA6IDApXG4gICAgdGhpcy5zdGFyZmllbGQuc2V0VGhlbWUoaXNMaWdodFRoZW1lKVxuICAgIC8vIENvbG91cnMgYXJlIHJld3JpdHRlbiBldmVyeSBmcmFtZSwgc28gdGhlIG5leHQgdGljayBwaWNrcyB0aGUgcGFsZXR0ZSB1cC5cbiAgfVxuXG4gIHNldFJlZHVjZWRNb3Rpb24odmFsdWU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBpZiAodGhpcy5kaXNwb3NlZCB8fCB0aGlzLnJlZHVjZWRNb3Rpb24gPT09IHZhbHVlKSByZXR1cm5cbiAgICB0aGlzLnJlZHVjZWRNb3Rpb24gPSB2YWx1ZVxuICAgIHRoaXMuc3RhcmZpZWxkLnNldFJlZHVjZWRNb3Rpb24odmFsdWUpXG4gICAgLy8gRnJlZXplIGJvdGggY2xvY2tzIGF0IHRoZWlyIGN1cnJlbnQgZXBvY2guIFJlc2V0dGluZyBvbmx5IHRoZSBkb2xseSB3b3VsZFxuICAgIC8vIHB1dCBhIGxhdGVyIHdvcmxkLXNwYWNlIGdseXBoIGJlaGluZCB0aGUgY2FtZXJhLCBhbmQgcmVzdW1pbmcgd291bGQgZHJpZnQuXG4gICAgdGhpcy51cGRhdGVDYW1lcmFGaXQoKVxuICB9XG5cbiAgcmVzaXplKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmRpc3Bvc2VkKSByZXR1cm5cbiAgICBjb25zdCByZWN0ID0gdGhpcy5jb250YWluZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KClcbiAgICBjb25zdCB3ID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihyZWN0LndpZHRoIHx8IHRoaXMuY29udGFpbmVyLmNsaWVudFdpZHRoIHx8IDEpKVxuICAgIGNvbnN0IGggPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHJlY3QuaGVpZ2h0IHx8IHRoaXMuY29udGFpbmVyLmNsaWVudEhlaWdodCB8fCAxKSlcbiAgICBpZiAodyA9PT0gdGhpcy53aWR0aCAmJiBoID09PSB0aGlzLmhlaWdodCkgcmV0dXJuXG4gICAgdGhpcy53aWR0aCA9IHdcbiAgICB0aGlzLmhlaWdodCA9IGhcbiAgICB0aGlzLmNhbWVyYS5hc3BlY3QgPSB3IC8gaFxuICAgIHRoaXMuY2FtZXJhLnVwZGF0ZVByb2plY3Rpb25NYXRyaXgoKVxuICAgIHRoaXMucmVuZGVyZXIuc2V0UGl4ZWxSYXRpbyhNYXRoLm1pbih3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxLCB0aGlzLnF1YWxpdHkubWF4RHByKSlcbiAgICB0aGlzLnJlbmRlcmVyLnNldFNpemUodywgaCwgdHJ1ZSlcbiAgICB0aGlzLnVwZGF0ZUNhbWVyYUZpdCgpXG4gICAgdGhpcy5hcHBseVZpZXdwb3J0U3dheSgpXG4gIH1cblxuICAvKiogUmVzaXplIGNoYW5nZXMgY2FtZXJhIGZyYW1pbmcsIG5ldmVyIHRoZSB3b3JsZCByb3V0ZSBvciBpdHMgaGlzdG9yaWNhbCB0YWlsLiAqL1xuICBwcml2YXRlIGFwcGx5Vmlld3BvcnRTd2F5KCk6IHZvaWQge1xuICAgIHRoaXMuY2hvcmVvZ3JhcGh5LnNldFN3YXlZKDApXG4gICAgZmlsbEVtaXNzaW9uVGFibGUodGhpcy5zY3JhdGNoLnRhaWxUYWJsZSwgdGhpcy5jaG9yZW9ncmFwaHksIHRoaXMuc2NyYXRjaC5wcm9iZVBvaW50KVxuICB9XG5cbiAgZ2V0U3RhdHMoKTogRW5naW5lU3RhdHMge1xuICAgIHJldHVybiB0aGlzLnN0YXRzXG4gIH1cblxuICBkaXNwb3NlKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmRpc3Bvc2VkKSByZXR1cm5cbiAgICB0aGlzLmRpc3Bvc2VkID0gdHJ1ZVxuICAgIHRoaXMuc3RvcCgpXG4gICAgdGhpcy51bmJpbmRQb2ludGVyKClcbiAgICB0aGlzLnVuYmluZENvbnRleHRMb3NzKClcblxuICAgIHRoaXMuc2NlbmUucmVtb3ZlKHRoaXMucG9pbnRzKVxuICAgIHRoaXMuc2NlbmUucmVtb3ZlKHRoaXMudGFpbFBvaW50cylcbiAgICB0aGlzLnRhaWxHZW9tZXRyeS5kaXNwb3NlKClcbiAgICB0aGlzLnRhaWxNYXRlcmlhbC5kaXNwb3NlKClcbiAgICB0aGlzLnNjZW5lLnJlbW92ZSh0aGlzLnN0YXJmaWVsZC5vYmplY3QpXG4gICAgdGhpcy5zdGFyZmllbGQuZGlzcG9zZSgpXG5cbiAgICB0aGlzLmdlb21ldHJ5LmRpc3Bvc2UoKVxuICAgIHRoaXMubWF0ZXJpYWwuZGlzcG9zZSgpXG4gICAgcmVsZWFzZUdsb3dUZXh0dXJlKClcblxuICAgIGlmICh0aGlzLm93bnNCcmFuZFNvdXJjZSkgdGhpcy5icmFuZFNvdXJjZS5kaXNwb3NlKClcblxuICAgIGNvbnN0IGNhbnZhcyA9IHRoaXMucmVuZGVyZXIuZG9tRWxlbWVudFxuICAgIGNhbnZhcy5wYXJlbnROb2RlPy5yZW1vdmVDaGlsZChjYW52YXMpXG4gICAgdGhpcy5yZW5kZXJlci5kaXNwb3NlKClcbiAgICAvLyBUaGUgb25seSB3YXkgdG8gaGFuZCB0aGUgR1BVIGJ1ZGdldCBiYWNrOiB3aXRob3V0IHRoaXMgYSByb3V0ZSBjaGFuZ2UgbGVhdmVzXG4gICAgLy8gdGhlIGNvbnRleHQgYWxpdmUgdW50aWwgdGhlIGJyb3dzZXIgZXZpY3RzIGl0LCBhbmQgYnJvd3NlcnMgY2FwIGNvbnRleHRzLlxuICAgIHRoaXMucmVuZGVyZXIuZm9yY2VDb250ZXh0TG9zcygpXG5cbiAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGNvbnN0IGhvbGRlciA9IHdpbmRvdyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICBpZiAoaG9sZGVyLl9fU1VCMkFQSV9QQVJUSUNMRV9TVEFUU19fID09PSB0aGlzLnN0YXRzKSB7XG4gICAgICAgIGhvbGRlci5fX1NVQjJBUElfUEFSVElDTEVfU1RBVFNfXyA9IG51bGxcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIFdpcmluZ1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBiaW5kUG9pbnRlcigpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5wb2ludGVyQm91bmQpIHJldHVyblxuICAgIC8vIFRoZSBjYW52YXMgaXMgcG9pbnRlci1ldmVudHMtbm9uZSBzbyB0aGUgYmFja2dyb3VuZCBuZXZlciBlYXRzIGEgY2xpY2sgbWVhbnRcbiAgICAvLyBmb3IgdGhlIHBhZ2UsIHNvIHRoZSBsaXN0ZW5lcnMgaGF2ZSB0byBzaXQgb24gdGhlIHdpbmRvdy5cbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCB0aGlzLm9uUG9pbnRlck1vdmUsIHsgcGFzc2l2ZTogdHJ1ZSB9KVxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybGVhdmUnLCB0aGlzLm9uUG9pbnRlckxlYXZlKVxuICAgIHRoaXMucG9pbnRlckJvdW5kID0gdHJ1ZVxuICB9XG5cbiAgcHJpdmF0ZSB1bmJpbmRQb2ludGVyKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5wb2ludGVyQm91bmQpIHJldHVyblxuICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIHRoaXMub25Qb2ludGVyTW92ZSlcbiAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcigncG9pbnRlcmxlYXZlJywgdGhpcy5vblBvaW50ZXJMZWF2ZSlcbiAgICB0aGlzLnBvaW50ZXJCb3VuZCA9IGZhbHNlXG4gIH1cblxuICBwcml2YXRlIHJlYWRvbmx5IG9uUG9pbnRlck1vdmUgPSAoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQgPT4ge1xuICAgIC8vIE9ubHkgdGhlIHJhdyBwb3NpdGlvbiBpcyByZWNvcmRlZCBoZXJlOiBhIGJ1cnN0IG9mIHBvaW50ZXIgZXZlbnRzIGFsbG9jYXRlc1xuICAgIC8vIG5vdGhpbmcgYW5kIGNhbm5vdCBvdXRwYWNlIHRoZSBmcmFtZSB0aGF0IGNvbnN1bWVzIHRoZSByZXN1bHQuXG4gICAgdGhpcy5wb2ludGVyLmNsaWVudFggPSBldmVudC5jbGllbnRYXG4gICAgdGhpcy5wb2ludGVyLmNsaWVudFkgPSBldmVudC5jbGllbnRZXG4gICAgdGhpcy5wb2ludGVyLmFjdGl2ZSA9IHRydWVcbiAgICB0aGlzLnBvaW50ZXIubGFzdE1vdmUgPSBwZXJmb3JtYW5jZS5ub3coKVxuICB9XG5cbiAgcHJpdmF0ZSByZWFkb25seSBvblBvaW50ZXJMZWF2ZSA9ICgpOiB2b2lkID0+IHtcbiAgICB0aGlzLnBvaW50ZXIuYWN0aXZlID0gZmFsc2VcbiAgfVxuXG4gIHByaXZhdGUgcmVhZG9ubHkgb25Db250ZXh0TG9zdCA9IChldmVudDogRXZlbnQpOiB2b2lkID0+IHtcbiAgICAvLyBXaXRob3V0IHByZXZlbnREZWZhdWx0IHRoZSBjb250ZXh0IG5ldmVyIGNvbWVzIGJhY2sgYW5kIHRoZSBjYW52YXMgc3RheXNcbiAgICAvLyBibGFuayBmb3IgdGhlIGxpZmUgb2YgdGhlIHBhZ2UuXG4gICAgZXZlbnQucHJldmVudERlZmF1bHQoKVxuICAgIHRoaXMuc3RvcCgpXG4gICAgdGhpcy5vcHRpb25zLm9uRXJyb3I/LihuZXcgRXJyb3IoJ1BhcnRpY2xlRW5naW5lOiBXZWJHTCBjb250ZXh0IGxvc3QnKSlcbiAgfVxuXG4gIHByaXZhdGUgYmluZENvbnRleHRMb3NzKCk6IHZvaWQge1xuICAgIHRoaXMucmVuZGVyZXIuZG9tRWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCd3ZWJnbGNvbnRleHRsb3N0JywgdGhpcy5vbkNvbnRleHRMb3N0LCBmYWxzZSlcbiAgfVxuXG4gIHByaXZhdGUgdW5iaW5kQ29udGV4dExvc3MoKTogdm9pZCB7XG4gICAgdGhpcy5yZW5kZXJlci5kb21FbGVtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3dlYmdsY29udGV4dGxvc3QnLCB0aGlzLm9uQ29udGV4dExvc3QsIGZhbHNlKVxuICB9XG5cbiAgLyoqXG4gICAqIEhvdyBmYXIgdGhlIGNhbWVyYSBtdXN0IHNpdCBmcm9tIHRoZSBDT05URU5UIFBMQU5FIGZvciB0aGUgZm9ybWVkIGdseXBoIHRvXG4gICAqIGNsZWFyIGJvdGggb2YgdGhlIHVzZXIncyBmbG9vcnMgKFY2KTogYXQgbGVhc3QgMi8zIG9mIHRoZSB2aWV3cG9ydCBoZWlnaHQgYW5kXG4gICAqIGF0IGxlYXN0IDEvMyBvZiBpdHMgd2lkdGguXG4gICAqXG4gICAqIFRoaXMgdXNlZCB0byBiZSBjb21wdXRlZCBoZXJlIGZyb20gYEdMWVBIX0hBTEZfRVhURU5UID0gNi4zYCwgd2hpY2ggaXMgYVxuICAgKiBwcmUtbm9ybWFsaXNhdGlvbiBudW1iZXIgKGl0IGRlc2NyaWJlcyB0aGUgdmVuZG9yJ3MgMTIuNi11bml0IGljb24gc3F1YXJlLCBhbmRcbiAgICogNi4zIHdhcyBvbmx5IGV2ZXIgY29ycmVjdCB3aGlsZSB0aGUgd2lkZXN0IHRoaW5nIG9uIHNjcmVlbiB3YXMgdGhhdCBzcXVhcmUpLlxuICAgKiBBZnRlciB0aGUgZ2x5cGhzIGFyZSBsZXZlbGxlZCBpbiBgYnJhbmRUYXJnZXRzLnRzYCB0aGUgcm9zdGVyJ3MgcmVhbCBleHRlbnRzIGFyZVxuICAgKiA3LjAwNiAoZ3JvcSkgdG8gMTYuNDc5ICh4aWFvbWltaW1vKSB3b3JsZCB1bml0cyB3aWRlLCBzbyB0aGF0IGNvbnN0YW50IHdhc1xuICAgKiBkZXNjcmliaW5nIGEgc2hhcGUgdGhhdCBubyBsb25nZXIgZXhpc3RzLiBJdCBpcyBgZ2x5cGhTaXplLnRzYCB0aGF0IG93bnMgdGhpc1xuICAgKiBxdWVzdGlvbiBub3csIGFuZCBpdCBhbnN3ZXJzIGl0IGFnYWluc3QgdGhlIGxldmVsbGVkIGBHTFlQSF9XT1JMRF9IRUlHSFRgIGFuZFxuICAgKiB0aGUgcm9zdGVyJ3MgbmFycm93ZXN0IGJib3ggYXNwZWN0LCB3aGljaCBpcyB0aGUgd29yc3QgY2FzZSBvdmVyIGFsbCAyOCBicmFuZHMuXG4gICAqXG4gICAqIFRoZSB0d28gY29uc3RyYWludHMgcHVsbCBpbiBPUFBPU0lURSBkaXJlY3Rpb25zLCB3aGljaCBpcyB0aGUgd2hvbGUgdGVuc2lvblxuICAgKiBoZXJlIGFuZCB3b3J0aCBzdGF0aW5nIHBsYWlubHk6XG4gICAqXG4gICAqICAgLSB0aGUgb2xkIGBmaXREaXN0YW5jZWAgd2FzIGEgTE9XRVIgYm91bmQgb24gdGhlIGRpc3RhbmNlLCBiZWNhdXNlIGl0IHdhc1xuICAgKiAgICAgc29sdmluZyBcInRoZSB3aWRlc3QgY29udGVudCBtdXN0IG5vdCBvdmVyZmxvdyB0aGUgZnJhbWVcIiDigJQgYSBmdXJ0aGVyIGNhbWVyYVxuICAgKiAgICAgZHJhd3MgZXZlcnl0aGluZyBzbWFsbGVyLCBzbyBhbnkgZGlzdGFuY2UgYXQgb3IgYmV5b25kIGl0IHdhcyBzYWZlO1xuICAgKiAgIC0gYGZpdERpc3RhbmNlRm9yUm9zdGVyYCBpcyBhbiBVUFBFUiBib3VuZCwgYmVjYXVzZSBpdCBpcyBzb2x2aW5nIFwidGhlIGdseXBoXG4gICAqICAgICBtdXN0IGJlIGF0IGxlYXN0IDIvMyBhcyB0YWxsIGFzIHRoZSB2aWV3cG9ydFwiIOKAlCBhIGZ1cnRoZXIgY2FtZXJhIGRyYXdzIHRoZVxuICAgKiAgICAgZ2x5cGggc21hbGxlciwgc28gdGhlIGRpc3RhbmNlIG11c3QgYmUgYXQgb3IgSU5TSURFIGl0LlxuICAgKlxuICAgKiBBIGxheW91dCB0aGF0IHNhdGlzZmllZCB0aGUgZmlyc3QgYnkgc2hvdmluZyB0aGUgY2FtZXJhIGJhY2sgdGhlcmVmb3JlIG1hZGUgdGhlXG4gICAqIHNlY29uZCB3b3JzZSwgYW5kIHRoYXQgaXMgZXhhY3RseSB0aGUgMC4yOCBoZWlnaHQgc2hhcmUgdGhlIHByb2JlIG1lYXN1cmVkLiBUaGVcbiAgICogZml4IGlzIG5vdCBhIGJpZ2dlciBtYXJnaW4sIGl0IGlzIGEgbmVhcmVyIGNhbWVyYSwgYW5kIHRvIGtlZXAgdGhlIGdseXBoIGluc2lkZVxuICAgKiB0aGUgZnJhbWUgYXQgdGhhdCBuZWFyZXIgZGlzdGFuY2UgdGhlIHBhdHJvbCBhbXBsaXR1ZGUgY29tZXMgZG93biAoc2VlXG4gICAqIGBBTVBMSVRVREVfWGApLlxuICAgKlxuICAgKiBPbiB0aGUgb25lIGhvcml6b250YWwgY29zdCB0aGlzIGxlYXZlcyBiZWhpbmQsIHN0YXRlZCByYXRoZXIgdGhhbiBzbW9vdGhlZCBvdmVyOlxuICAgKlxuICAgKiAgIC0gb24gYSBsYW5kc2NhcGUgdmlld3BvcnQgYXQgdGhlIHJvc3RlciBkaXN0YW5jZSB0aGUgZnJhbWUgaXMgMjEuMTY4IHdvcmxkXG4gICAqICAgICB1bml0cyB3aWRlLCBpLmUuICsvLTEwLjU4NCBhY3Jvc3M7XG4gICAqICAgLSB0aGUgd2lkZXN0IGJyYW5kLCB4aWFvbWltaW1vLCBsZXZlbHMgdG8gMTYuNDc5IHdpZGUgKGhhbGYtd2lkdGggOC4yNCkgYW5kXG4gICAqICAgICBmb3JtcyBhdCB4ID0gKy8tMi41Niwgc28gaXRzIGZhciBlZGdlIHJlYWNoZXMgMTAuODAwIOKAlCBhYm91dCAwLjIyIHVuaXRzLCBvclxuICAgKiAgICAgMSUgb2YgdGhlIGZyYW1lIHdpZHRoLCBwYXN0IHRoZSBlZGdlLiBFdmVyeSBvdGhlciBicmFuZCBmaXRzLlxuICAgKlxuICAgKiBUaGUgYnJpZWYncyBhbnN3ZXIgdG8gdGhhdCB3YXMgYSBwZXItYnJhbmQgdW5pZm9ybSBzaHJpbmsgb2YgYWJvdXQgMy41JSBmb3IgdGhpc1xuICAgKiBvbmUgZ2x5cGguIFRoYXQgaXMgZGVsaWJlcmF0ZWx5IE5PVCBkb25lIGhlcmUsIGJlY2F1c2UgaXQgd291bGQgYnJlYWsgYSBzdHJvbmdlclxuICAgKiBpbnZhcmlhbnQgdGhhbiBpdCByZXBhaXJzOiBgYnJhbmRUYXJnZXRzYCBsZXZlbHMgZXZlcnkgbWFyayB0b1xuICAgKiBgR0xZUEhfV09STERfSEVJR0hUYCBwcmVjaXNlbHkgc28gdGhhdCBPTkUgZGlzdGFuY2Ugc2VydmVzIGFsbCAyOCBicmFuZHMsIGFuZFxuICAgKiBib3RoIHRoZSB1bml0IHNwZWMgYW5kIHRoZSBhY2NlcHRhbmNlIHByb2JlIGFzc2VydCB0aGUgYnVmZmVyJ3Mgd29ybGQgaGVpZ2h0IGlzXG4gICAqIGBHTFlQSF9XT1JMRF9IRUlHSFRgIHdpdGhpbiAwLjAwNSAvIDAuMDUuIEEgMy41JSBzaHJpbmsgcHV0cyB0aGF0IHJlYWRiYWNrIGF0XG4gICAqIDkuODE2IOKAlCBhIDAuMjY0IG1pc3Mgb24gYm90aC4gUGF5aW5nIDElIG9mIG92ZXJoYW5nIHdpdGggYW4gYXNzZXJ0aW9uIGFib3V0IHRoZVxuICAgKiBsZXZlbGxpbmcgY29udHJhY3Qgd291bGQgdHJhZGUgYSBjb3NtZXRpYyBlZGdlIGNsaXAgZm9yIGEgYnJva2VuIGd1YXJhbnRlZSwgc29cbiAgICogdGhlIG92ZXJoYW5nIGlzIHJlcG9ydGVkIHRvIHRoZSByZXZpZXdlciBpbnN0ZWFkIG9mIGJlaW5nIGhpZGRlbi5cbiAgICpcbiAgICogVGhlIGBNYXRoLm1heCgwLjIsIC4uLilgIGZsb29yIHN0YXlzIGJlY2F1c2UgYSB6ZXJvIG9yIG5lZ2F0aXZlIGFzcGVjdCB3b3VsZFxuICAgKiBvdGhlcndpc2UgZGl2aWRlIHRoZSBmaXQgYXdheSBhbmQgYmxhbmsgdGhlIGNhbnZhcy5cbiAgICovXG4gIHByaXZhdGUgdXBkYXRlQ2FtZXJhRml0KCk6IHZvaWQge1xuICAgIGNvbnN0IGFzcGVjdCA9IE1hdGgubWF4KDAuMiwgdGhpcy53aWR0aCAvIHRoaXMuaGVpZ2h0KVxuICAgIC8vIFN0YXJ0IGZyb20gdGhlIHJvc3RlciBmaXQsIHdoaWNoIGlzIHRoZSBsYXJnZXN0IGRpc3RhbmNlIGF0IHdoaWNoIHRoZSBnbHlwaFxuICAgIC8vIHN0aWxsIGNsZWFycyBib3RoIGZsb29ycywgdGhlbiBnaXZlIHRoZSBIRUlHSFQgZmxvb3IgaXRzIDEyJSBvZiBoZWFkcm9vbS5cbiAgICAvL1xuICAgIC8vIFdoeSB0aGUgbWFyZ2luIGlzIHdvcnRoIGhhdmluZyBhdCBhbGw6IHNpdHRpbmcgZXhhY3RseSBvbiBgZml0RGlzdGFuY2VGb3JSb3N0ZXJgXG4gICAgLy8gbGVhdmVzIHRoZSBiaW5kaW5nIGZsb29yIEVRVUFMIHRvIHRoZSB1c2VyJ3MgbnVtYmVyLCB3aXRoIG5vdGhpbmcgbGVmdCBmb3IgdGhlXG4gICAgLy8gbWVhc3VyZWQgY2xvdWQuIFBhcnRpY2xlcyBvcmJpdCBhbmQgc2V0dGxlIHNsaWdodGx5IG91dHNpZGUgdGhlIGFuY2hvciBib3gsIHNvXG4gICAgLy8gdGhlIHJlYWwgc2hhcmUgcmVhZHMgYSBwZXJjZW50IG9yIHR3byB1bmRlciB0aGUgaWRlYWwg4oCUIHRoZSBwcm9iZSBtZWFzdXJlZFxuICAgIC8vIHBvcnRyYWl0IHZpZXdwb3J0cyBhdCAwLjY0OTcuLjAuNjU3MCBhZ2FpbnN0IGEgMC42NjY3IGZsb29yIHdoZW4gdGhlIGlkZWFsIHdhc1xuICAgIC8vIGV4YWN0bHkgMC42NjY3LiBCZWluZyAxMiUgbmVhcmVyIHJhaXNlcyB0aGUgaWRlYWwgdG8gMC43NDY3IGFuZCBjbGVhcnMgaXQuXG4gICAgLy9cbiAgICAvLyBXaHkgaXQgaXMgdGFrZW4gT05MWSB3aGVyZSB0aGUgaGVpZ2h0IGZsb29yIGJpbmRzLCBhbmQgbmV2ZXIgb2ZmIHRoZSB3aWR0aFxuICAgIC8vIHRlcm06IHRoZSB0d28gZmxvb3JzIGFyZSBib3VuZHMgb24gdGhlIHNhbWUgZGlzdGFuY2UgaW4gT1BQT1NJVEUgZGlyZWN0aW9ucy5cbiAgICAvLyBUaGUgaGVpZ2h0IGZsb29yIGlzIGFuIHVwcGVyIGJvdW5kIChuZWFyZXIgaXMgYmlnZ2VyLCB3aGljaCBpcyB3aGF0IGl0IHdhbnRzKSxcbiAgICAvLyBzbyBoZWFkcm9vbSBtZWFucyBjb21pbmcgbmVhcmVyLiBUaGUgd2lkdGggZmxvb3IgaXMgYSBsb3dlciBib3VuZCAodGhlIGdseXBoXG4gICAgLy8gbXVzdCBub3Qgb3ZlcmhhbmcgdGhlIGZyYW1lKSwgc28gY29taW5nIG5lYXJlciBtYWtlcyBpdCBXT1JTRS4gQXBwbHlpbmcgMTIlIHRvXG4gICAgLy8gdGhlIHdob2xlIGZpdCB0aGVyZWZvcmUgaGVscGVkIHBvcnRyYWl0IHZpZXdwb3J0cywgd2hlcmUgdGhlIGhlaWdodCBiaW5kcywgYW5kXG4gICAgLy8gaHVydCBsYW5kc2NhcGUgb25lcywgd2hlcmUgdGhlIHdpZHRoIGJpbmRzIOKAlCBpdCB3aWRlbmVkIHRoZSB3aWRlc3QgYnJhbmQnc1xuICAgIC8vIG92ZXJoYW5nIGZyb20gMC4yNDkgdG8gMS4zODMgd29ybGQgdW5pdHMgb24gMTY6OS4gU28gdGhlIG1hcmdpbiBpcyBjb21wdXRlZCBvblxuICAgIC8vIHRoZSBoZWlnaHQtb25seSBkaXN0YW5jZSBhbmQgb25seSBhZG9wdGVkIHdoZW4gdGhhdCBpcyB3aGF0IGJpbmRzLlxuICAgIC8vXG4gICAgLy8gYHJlcXVpcmVkR2x5cGhXb3JsZFNpemVgIGlzIGFza2VkIHdoaWNoIGZsb29yIGJpbmRzIHJhdGhlciB0aGFuIHJlLWRlcml2aW5nIHRoZVxuICAgIC8vIHR3byBjYW5kaWRhdGVzIGhlcmUsIHNvIHRoaXMgZGVjaXNpb24ga2VlcHMgYWdyZWVpbmcgd2l0aCBgZ2x5cGhTaXplLnRzYCBpZiB0aGVcbiAgICAvLyBmbG9vcnMgb3IgdGhlIHJvc3RlcidzIG5hcnJvd2VzdCBhc3BlY3QgYXJlIGV2ZXIgcmV0dW5lZC5cbiAgICBjb25zdCByb3N0ZXIgPSBmaXREaXN0YW5jZUZvclJvc3Rlcihhc3BlY3QsIENBTUVSQV9GT1YpXG4gICAgY29uc3QgYmluZGluZyA9IHJlcXVpcmVkR2x5cGhXb3JsZFNpemUoYXNwZWN0LCBDQU1FUkFfRk9WLCByb3N0ZXIsIEdMWVBIX01JTl9CQk9YX0FTUEVDVClcbiAgICB0aGlzLmZpdEdhcCA9IGJpbmRpbmcuYmluZGluZyA9PT0gJ2hlaWdodCcgPyByb3N0ZXIgLyBGUkFNRV9NQVJHSU4gOiByb3N0ZXJcbiAgICB0aGlzLmZpdERpc3RhbmNlID0gdGhpcy5maXRHYXAgKyBTVUJKRUNUX1pcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gRnJhbWUgbG9vcFxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSByZWFkb25seSB0aWNrID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICghdGhpcy5ydW5uaW5nIHx8IHRoaXMuZGlzcG9zZWQpIHJldHVyblxuICAgIHRoaXMucmFmSWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUodGhpcy50aWNrKVxuXG4gICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KClcbiAgICBjb25zdCBkZWx0YSA9IHRoaXMubGFzdEZyYW1lTXMgPT09IDAgPyAxIC8gNjAgOiAobm93IC0gdGhpcy5sYXN0RnJhbWVNcykgLyAxMDAwXG4gICAgdGhpcy5sYXN0RnJhbWVNcyA9IG5vd1xuXG4gICAgLy8gRnJhbWUtcmF0ZSBpbmRlcGVuZGVuY2U6IHBlci1wYXJ0aWNsZSBwaHlzaWNzIGlzIGV4cHJlc3NlZCBwZXIgNjAgSHogZnJhbWUsXG4gICAgLy8gYW5kIHRoZSBzdGVwIGlzIGNsYW1wZWQgc28gYSBzdGFsbCBjYW5ub3QgZmxpbmcgdGhlIGNsb3VkIGFjcm9zcyB0aGUgc2NlbmUuXG4gICAgY29uc3QgZnJhbWVTdGVwID0gTWF0aC5taW4oTWF0aC5tYXgoZGVsdGEgKiA2MCwgMC4wMDAxKSwgMilcbiAgICBjb25zdCBjbG9ja1N0ZXAgPSBNYXRoLm1pbihNYXRoLm1heChkZWx0YSwgMCksIE1BWF9DTE9DS19TVEVQKVxuXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuYWR2YW5jZUNsb2NrKGNsb2NrU3RlcClcbiAgICAgIC8vIFBvaW50ZXIgdW5wcm9qZWN0aW9uIG11c3QgdXNlIHRoaXMgZnJhbWUncyBjYW1lcmEgbWF0cml4LlxuICAgICAgdGhpcy5hZHZhbmNlQ2FtZXJhKClcbiAgICAgIHRoaXMud3JpdGVFbWlzc2lvblRhYmxlKClcbiAgICAgIHRoaXMuaW50ZWdyYXRlKGZyYW1lU3RlcCwgbm93IC8gMTAwMCwgY2xvY2tTdGVwKVxuICAgICAgdGhpcy51cGxvYWQoKVxuICAgICAgdGhpcy5zdGFyZmllbGQudXBkYXRlKGNsb2NrU3RlcCwgdGhpcy5jYW1lcmEucG9zaXRpb24ueiwgbm93IC8gMTAwMClcbiAgICAgIHRoaXMucmVuZGVyZXIucmVuZGVyKHRoaXMuc2NlbmUsIHRoaXMuY2FtZXJhKVxuICAgICAgdGhpcy5wdWJsaXNoU3RhdHMobm93KVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAvLyBBIHRocm93IGluc2lkZSBhIHJBRiBjYWxsYmFjayB3b3VsZCBvdGhlcndpc2UgcmVwZWF0IGV2ZXJ5IGZyYW1lIGZvcmV2ZXIuXG4gICAgICB0aGlzLnN0b3AoKVxuICAgICAgdGhpcy5vcHRpb25zLm9uRXJyb3I/LihlcnJvcilcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFkdmFuY2VDbG9jayhkZWx0YTogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnJlZHVjZWRNb3Rpb24pIHRoaXMuY2hvcmVvZ3JhcGh5LnVwZGF0ZShkZWx0YSlcbiAgICBjb25zdCBzdGF0ZSA9IHRoaXMuY2hvcmVvZ3JhcGh5LnN0YXRlXG5cbiAgICBpZiAoc3RhdGUucGhhc2UgIT09IHRoaXMubGFzdFBoYXNlKSB7XG4gICAgICB0aGlzLmxhc3RQaGFzZSA9IHN0YXRlLnBoYXNlXG4gICAgICB0aGlzLm9wdGlvbnMub25QaGFzZUNoYW5nZT8uKHN0YXRlLnBoYXNlKVxuICAgIH1cblxuICAgIGNvbnN0IGJyYW5kID0gdGhpcy5yb3N0ZXJbc3RhdGUuYnJhbmRJbmRleCAlIHRoaXMucm9zdGVyLmxlbmd0aF1cbiAgICBpZiAoYnJhbmQgJiYgYnJhbmQuc2x1ZyAhPT0gdGhpcy5jdXJyZW50QnJhbmRTbHVnKSB7XG4gICAgICB0aGlzLmN1cnJlbnRCcmFuZFNsdWcgPSBicmFuZC5zbHVnXG4gICAgICB0aGlzLnN5bmNHbHlwaCgpXG4gICAgICB0aGlzLm9wdGlvbnMub25CcmFuZENoYW5nZT8uKGJyYW5kLnNsdWcsIHN0YXRlLmJyYW5kSW5kZXgpXG4gICAgfSBlbHNlIGlmICh0aGlzLmN1cnJlbnRHbHlwaExlZyAhPT0gc3RhdGUubGVnSW5kZXgpIHtcbiAgICAgIC8vIEEgb25lLWJyYW5kL2N1c3RvbSByb3N0ZXIgY2FuIGtlZXAgdGhlIHNsdWcgd2hpbGUgdGhlIHdvcmxkIGFuY2hvciBtb3Zlcy5cbiAgICAgIHRoaXMuc3luY0dseXBoKClcbiAgICB9XG4gICAgdGhpcy5wcmVmZXRjaEFoZWFkKClcblxuICAgIGlmICghdGhpcy5yZWR1Y2VkTW90aW9uKSB0aGlzLmRvbGx5U2Vjb25kcyArPSBkZWx0YVxuICB9XG5cbiAgLyoqIFF1ZXVlIHRoZSBnbHlwaCBhZnRlciB0aGUgY3VycmVudCBvbmUsIG9mZiB0aGUgY3JpdGljYWwgcGF0aC4gKi9cbiAgcHJpdmF0ZSBwcmVmZXRjaEFoZWFkKCk6IHZvaWQge1xuICAgIGNvbnN0IHN0YXRlID0gdGhpcy5jaG9yZW9ncmFwaHkuc3RhdGVcbiAgICAvLyBQcm9maWxpbmcgZm91bmQgbmV4dC1icmFuZCByYXN0ZXJpc2F0aW9uIGluIHRoZSBmaXJzdCBmbGlnaHQgZnJhbWUncyBpZGxlXG4gICAgLy8gdGFzay4gUXVldWUgaXQgZHVyaW5nIHRoZSBwcmVjZWRpbmcgaG9sZCwgd2l0aCBhbXBsZSB0aW1lIGJlZm9yZSBkZXBhcnR1cmUuXG4gICAgaWYgKHN0YXRlLnBoYXNlICE9PSAnaG9sZCcpIHJldHVyblxuICAgIGNvbnN0IG5leHQgPSB0aGlzLnJvc3Rlclsoc3RhdGUuYnJhbmRJbmRleCArIDEpICUgdGhpcy5yb3N0ZXIubGVuZ3RoXVxuICAgIGlmIChuZXh0KSB7XG4gICAgICB0aGlzLmJyYW5kU291cmNlLnByZWZldGNoKG5leHQuc2x1ZywgdGhpcy5wYXJ0aWNsZUNvdW50LCB0aGlzLnF1YWxpdHkuaWNvbkNhbnZhc1NpemUpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIExvYWQgdGhlIGdseXBoIGZvciB0aGUgY3VycmVudCBicmFuZCBpbnRvIHNjcmF0Y2ggYW5kIGJha2UgaXRzIG9yYml0IGZpZWxkLlxuICAgKlxuICAgKiBUaGUgc2FtcGxlciB3b3JrcyBpbiBpdHMgb3duIGdseXBoIHNwYWNlLCBjZW50cmVkIG9uIGBHTFlQSF9DRU5URVJfWGA7IHRoZVxuICAgKiBlbmdpbmUgd29ya3MgaW4gc3ViamVjdCBzcGFjZSwgY2VudHJlZCBvbiB0aGUgZXh0cmVtZSB0aGUgY29tZXQgYXJyaXZlZCBhdC5cbiAgICogVGhlIHNoaWZ0IGhhcHBlbnMgaGVyZSBzbyBldmVyeSBsYXRlciBzdGFnZSAoc3ByaW5nLCBvcmJpdCBmbG93LCBjb2xvdXJpbmcpXG4gICAqIHNlZXMgYSBzaW5nbGUgZnJhbWUgb2YgcmVmZXJlbmNlLlxuICAgKi9cbiAgcHJpdmF0ZSBzeW5jR2x5cGgoKTogdm9pZCB7XG4gICAgY29uc3QgYnJhbmQgPSB0aGlzLnJvc3Rlclt0aGlzLmNob3Jlb2dyYXBoeS5zdGF0ZS5icmFuZEluZGV4ICUgdGhpcy5yb3N0ZXIubGVuZ3RoXVxuICAgIGlmICghYnJhbmQpIHJldHVyblxuXG4gICAgY29uc3QgdGFyZ2V0cyA9IHRoaXMuYnJhbmRTb3VyY2UuZW5zdXJlKFxuICAgICAgYnJhbmQuc2x1ZyxcbiAgICAgIHRoaXMucGFydGljbGVDb3VudCxcbiAgICAgIHRoaXMucXVhbGl0eS5pY29uQ2FudmFzU2l6ZVxuICAgIClcbiAgICBpZiAoIXRhcmdldHMpIHJldHVyblxuXG4gICAgLy8gVGhlIGFuY2hvciBiZWxvbmdzIHRvIHRoZSBsZWcsIG5vdCB0aGUgcm9zdGVyIGluZGV4LiBuZXh0QnJhbmQoKSBjaGFuZ2VzXG4gICAgLy8gdGhlIG1hcmsgYXQgdGhlIHNhbWUgcGhhc2Ugd2l0aG91dCBjaGFuZ2luZyBpdHMgd29ybGQtc3BhY2UgZGVzdGluYXRpb24uXG4gICAgY29uc3Qgc3RhdGUgPSB0aGlzLmNob3Jlb2dyYXBoeS5zdGF0ZVxuICAgIGNvbnN0IGFtcGxpdHVkZSA9IHN0YXRlLnRvWFxuICAgIGNvbnN0IGFuY2hvclogPSBnbHlwaFN0b3BaKHN0YXRlLmxlZ0luZGV4LCBTUEFDRV9USU1JTkcpXG4gICAgY29uc3QgZ2x5cGggPSB0aGlzLnNjcmF0Y2guZ2x5cGhUYXJnZXRzXG4gICAgY29uc3QgbiA9IE1hdGgubWluKHRoaXMucGFydGljbGVDb3VudCwgTWF0aC5mbG9vcih0YXJnZXRzLnRhcmdldHMubGVuZ3RoIC8gMykpXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICAgIGdseXBoW2kgKiAzXSA9IHRhcmdldHMudGFyZ2V0c1tpICogM10gLSBHTFlQSF9DRU5URVJfWCArIGFtcGxpdHVkZVxuICAgICAgZ2x5cGhbaSAqIDMgKyAxXSA9IHRhcmdldHMudGFyZ2V0c1tpICogMyArIDFdXG4gICAgICBnbHlwaFtpICogMyArIDJdID0gdGFyZ2V0cy50YXJnZXRzW2kgKiAzICsgMl0gKyBhbmNob3JaXG4gICAgfVxuICAgIC8vIE1pc3NpbmcgYW5jaG9ycyBzaXQgYXQgdGhpcyBzYW1lIGRlc3RpbmF0aW9uLCBpbmNsdWRpbmcgaXRzIGFjY3VtdWxhdGVkIFouXG4gICAgZm9yIChsZXQgaSA9IG47IGkgPCB0aGlzLnBhcnRpY2xlQ291bnQ7IGkrKykge1xuICAgICAgZ2x5cGhbaSAqIDNdID0gYW1wbGl0dWRlXG4gICAgICBnbHlwaFtpICogMyArIDFdID0gMFxuICAgICAgZ2x5cGhbaSAqIDMgKyAyXSA9IGFuY2hvclpcbiAgICB9XG4gICAgdGhpcy5jdXJyZW50R2x5cGhMZWcgPSBzdGF0ZS5sZWdJbmRleFxuICAgIHRoaXMuc2NyYXRjaC5nbHlwaFN0cm9rZURlcHRoLmZpbGwoMClcbiAgICB0aGlzLnNjcmF0Y2guZ2x5cGhTdHJva2VEZXB0aC5zZXQodGFyZ2V0cy5zdHJva2VEZXB0aC5zdWJhcnJheSgwLCBuKSlcblxuICAgIGZpbGxWb3hTcGFjZUljb25PcmJpdEZpZWxkKFxuICAgICAgdGhpcy5zY3JhdGNoLmljb25PcmJpdEZpZWxkLFxuICAgICAgdGFyZ2V0cy50YXJnZXRzLFxuICAgICAgdGFyZ2V0cy5zdHJva2VEZXB0aFxuICAgIClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWZpbGwgdGhlIGVtaXNzaW9uIHRhYmxlIGZyb20gdGhlIGhlYWQncyByZWNlbnQgcGFzdC5cbiAgICpcbiAgICogVGhlIHdob2xlIG1ldGhvZCBpcyB0aGUgY2FsbCB0byB7QGxpbmsgZmlsbEVtaXNzaW9uVGFibGV9LCB3aGljaCBpcyBhIGZyZWVcbiAgICogZnVuY3Rpb24gc28gdGhhdCBpdCBjYW4gYmUgZXhlcmNpc2VkIGFnYWluc3QgYSBzeW50aGV0aWMgcGF0aCBpbiBhIHVuaXQgdGVzdCDigJRcbiAgICogdGhpcyBjbGFzcyBjYW5ub3QgYmUgY29uc3RydWN0ZWQgdW5kZXIganNkb20sIGFuZCB0aGUgdGFibGUncyAqc2lnbiBjb252ZW50aW9ucypcbiAgICogYXJlIHRoZSBwYXJ0IG9mIHRoZSBuZXcgdGFpbCBtb3N0IGxpa2VseSB0byBiZSBnb3Qgc3VidGx5IHdyb25nLiBFdmVyeXRoaW5nIGl0XG4gICAqIG5lZWRzIGlzIHByZWFsbG9jYXRlZCBpbiBgc2NyYXRjaGAsIHNvIHRoZSBmcmFtZSBhbGxvY2F0ZXMgbm90aGluZy5cbiAgICovXG4gIHByaXZhdGUgd3JpdGVFbWlzc2lvblRhYmxlKCk6IHZvaWQge1xuICAgIGZpbGxFbWlzc2lvblRhYmxlKHRoaXMuc2NyYXRjaC50YWlsVGFibGUsIHRoaXMuY2hvcmVvZ3JhcGh5LCB0aGlzLnNjcmF0Y2gucHJvYmVQb2ludClcbiAgfVxuXG4gIHByaXZhdGUgaW50ZWdyYXRlKGZyYW1lU3RlcDogbnVtYmVyLCB0aW1lOiBudW1iZXIsIGRlbHRhID0gZnJhbWVTdGVwIC8gNjApOiB2b2lkIHtcbiAgICBjb25zdCBzID0gdGhpcy5zY3JhdGNoXG4gICAgY29uc3QgcG9zaXRpb25zID0gcy5wb3NpdGlvbnNcbiAgICBjb25zdCB2ZWxvY2l0aWVzID0gcy52ZWxvY2l0aWVzXG4gICAgY29uc3QgY29sb3JzID0gcy5jb2xvcnNcbiAgICBjb25zdCBnbHlwaCA9IHMuZ2x5cGhUYXJnZXRzXG4gICAgY29uc3QgY291bnQgPSB0aGlzLnBhcnRpY2xlQ291bnRcbiAgICBjb25zdCBzdGF0ZSA9IHRoaXMuY2hvcmVvZ3JhcGh5LnN0YXRlXG4gICAgY29uc3QgcGFsZXR0ZSA9IHRoaXMucGFsZXR0ZVxuICAgIGNvbnN0IHBoYXNlID0gc3RhdGUucGhhc2VcbiAgICBpZiAocGhhc2UgIT09IHRoaXMucmVuZGVyZWRQaGFzZSkge1xuICAgICAgaWYgKHBoYXNlID09PSAnZ2F0aGVyJyB8fCBwaGFzZSA9PT0gJ3NjYXR0ZXInKSB7XG4gICAgICAgIHMuc2hhcGVGcm9tLnNldChwb3NpdGlvbnMpXG4gICAgICAgIGlmIChwaGFzZSA9PT0gJ2dhdGhlcicpIHtcbiAgICAgICAgICAvLyBUaGUgcHJpb3IgdXBsb2FkIHdhcyBzdGlsbCBpbiBmbGlnaHQuIE1vdmUgaXRzIGludGVybmFsIHNoYXBlIG9udG9cbiAgICAgICAgICAvLyB0aGUgZXhhY3Qgc3RvcCBhbmNob3IgYmVmb3JlIG1vcnBoaW5nLCBzbyB0aGUgY2VudHJlIHN0b3BzIGluIFgvWlxuICAgICAgICAgIC8vIHRvZ2V0aGVyIGV2ZW4gd2hlbiB0aGUgZnJhbWUgY3Jvc3NlcyB0aGUgYXJyaXZhbCBib3VuZGFyeS5cbiAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvdW50OyBpKyspIHtcbiAgICAgICAgICAgIHMuc2hhcGVGcm9tW2kgKiAzXSArPSBzdGF0ZS5oZWFkWCAtIHRoaXMucmVuZGVyZWRIZWFkLnhcbiAgICAgICAgICAgIHMuc2hhcGVGcm9tW2kgKiAzICsgMV0gKz0gc3RhdGUuaGVhZFkgLSB0aGlzLnJlbmRlcmVkSGVhZC55XG4gICAgICAgICAgICBzLnNoYXBlRnJvbVtpICogMyArIDJdICs9IHN0YXRlLmhlYWRaIC0gdGhpcy5yZW5kZXJlZEhlYWQuelxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvdW50OyBpKyspIHtcbiAgICAgICAgICBjb25zdCBzcHJpdGVTY2FsZSA9IHMuYm9keS5zcHJpdGVTY2FsZVtpXVxuICAgICAgICAgIHMuc2hhcGVBbHBoYVtpXSA9IGNvbG9yc1tpICogNCArIDNdICogc3ByaXRlU2NhbGUgKiBzcHJpdGVTY2FsZVxuICAgICAgICB9XG4gICAgICAgIHMucG9pbnRlck9mZnNldC5maWxsKDApXG4gICAgICAgIHZlbG9jaXRpZXMuZmlsbCgwKVxuICAgICAgfVxuICAgICAgdGhpcy5yZW5kZXJlZFBoYXNlID0gcGhhc2VcbiAgICB9XG5cbiAgICAvLyBIb3cgY29tbWl0dGVkIHRoaXMgZnJhbWUgaXMgdG8gdGhlIGdseXBoIHNoYXBlOiAwIGlzIGEgcHVyZSBjb21ldCwgMSBpcyB0aGVcbiAgICAvLyBzZXR0bGVkIGxvZ28uIEV2ZXJ5dGhpbmcgdGhhdCBvbmx5IG1ha2VzIHNlbnNlIG9uIGEgZ2x5cGggaXMgZ2F0ZWQgYnkgaXQsIHNvXG4gICAgLy8gdGhlIHR3byBzaGFwZXMgY2FuIG5ldmVyIGJsZWVkIGludG8gZWFjaCBvdGhlci5cbiAgICBjb25zdCBzaGFwZVByb2dyZXNzID0gcGhhc2UgPT09ICdzY2F0dGVyJyA/IGNsYW1wMDEoc3RhdGUucGhhc2VQcm9ncmVzcyAvIENPQUxFU0NFX0VORCkgOiBzdGF0ZS5waGFzZVByb2dyZXNzXG4gICAgbGV0IGdseXBoTWl4ID0gZ2x5cGhNaXhGb3IocGhhc2UsIHNoYXBlUHJvZ3Jlc3MpXG4gICAgLy8gUmVkdWNlZCBtb3Rpb24gc25hcHMgdGhlIGJsZW5kIGluc3RlYWQgb2YgYW5pbWF0aW5nIGl0OiB0aGUgc2hhcGUgY2hhbmdlIGlzXG4gICAgLy8gdGhlIHBhcnQgb2YgdGhpcyB0aGF0IGEgbW90aW9uLXNlbnNpdGl2ZSB2aXNpdG9yIGFza2VkIHVzIG5vdCB0byBhbmltYXRlLlxuICAgIGlmICh0aGlzLnJlZHVjZWRNb3Rpb24pIGdseXBoTWl4ID0gZ2x5cGhNaXggPiAwLjUgPyAxIDogMFxuXG4gICAgLy8gVGhlIGludGVybmFsIGZsb3cgdGhlIHVzZXIgYXNrZWQgZm9yOiB0aGUgZ2x5cGggaG9sZHMgaXRzIG91dGxpbmUgd2hpbGUgdGhlXG4gICAgLy8gcGFydGljbGVzIGluc2lkZSBpdCBrZWVwIGRyaWZ0aW5nLiBHYXRlZCBieSB0aGUgc2FtZSBtaXgsIHNvIGl0IGZhZGVzIGluIGFuZFxuICAgIC8vIG91dCB3aXRoIHRoZSBzaGFwZSBpbnN0ZWFkIG9mIHN3aXRjaGluZyBvbi5cbiAgICBpZiAoZ2x5cGhNaXggPiAwLjAwMSkge1xuICAgICAgZmlsbFZveFNwYWNlSWNvbk9yYml0T2Zmc2V0cyhzLmljb25PcmJpdE9mZnNldHMsIHMuaWNvbk9yYml0RmllbGQsIHRpbWUsIGdseXBoTWl4KVxuICAgIH1cblxuICAgIGNvbnN0IGZvbGxvd1NwZWVkID0gdGhpcy5yZWR1Y2VkTW90aW9uID8gRk9MTE9XX1RSQVZFTCAqIDAuNiA6IGZvbGxvd1NwZWVkRm9yKHBoYXNlKVxuICAgIGNvbnN0IGZyaWN0aW9uID1cbiAgICAgIHBoYXNlID09PSAnaG9sZCdcbiAgICAgICAgPyBnZXRWb3hTcGFjZUhvbGRGcmFtZUZyaWN0aW9uKGZyYW1lU3RlcClcbiAgICAgICAgOiBNYXRoLnBvdyhGUklDVElPTiwgZnJhbWVTdGVwKVxuXG4gICAgLy8gSW50ZXJuYWwgb3JiaXQgYW5kIGRlcHRoIHRvbmUgcmVtYWluIGxvY2FsIHRvIHRoZSBnbHlwaC4gUm90YXRpbmcgdGhlXG4gICAgLy8gd2hvbGUgZ3JvdXAgd291bGQgb3JiaXQgaXRzIGFjY3VtdWxhdGVkIFogYXJvdW5kIHRoZSB3b3JsZCBvcmlnaW4uXG4gICAgdGhpcy5ob2xkRmFkZSA9IG5leHRWb3hTcGFjZUljb25Ib2xkRmFkZSh0aGlzLmhvbGRGYWRlLCBnbHlwaE1peCwgZnJhbWVTdGVwKVxuICAgIHdyaXRlVm94U3BhY2VJY29uSG9sZFBvc2Uocy5pY29uSG9sZFBvc2UsIHRpbWUsIHRoaXMuaG9sZEZhZGUpXG4gICAgdGhpcy5wb2ludHMucm90YXRpb24uc2V0KDAsIDAsIDApXG5cbiAgICAvLyBSZXNvbHZlIHRoZSBwb2ludGVyIG9uIHRoZSBjdXJyZW50IGhlYWQvZ2x5cGggcGxhbmUgaW4gdGhlIGZpeGVkIGdyb3VwLlxuICAgIGxldCBwb2ludGVyQWN0aXZlID0gaXNWb3hTcGFjZVBvaW50ZXJBY3RpdmUoXG4gICAgICB0aGlzLnBvaW50ZXIuYWN0aXZlLFxuICAgICAgdGhpcy5wb2ludGVyLmxhc3RNb3ZlLFxuICAgICAgcGVyZm9ybWFuY2Uubm93KClcbiAgICApXG4gICAgaWYgKHBvaW50ZXJBY3RpdmUpIHtcbiAgICAgIGNvbnN0IHJlY3QgPSB0aGlzLnJlbmRlcmVyLmRvbUVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KClcbiAgICAgIGlmIChyZWN0LndpZHRoID4gMCAmJiByZWN0LmhlaWdodCA+IDApIHtcbiAgICAgICAgY29uc3QgbmRjID0gcy52ZWNBLnNldChcbiAgICAgICAgICAoKHRoaXMucG9pbnRlci5jbGllbnRYIC0gcmVjdC5sZWZ0KSAvIHJlY3Qud2lkdGgpICogMiAtIDEsXG4gICAgICAgICAgLSgoKHRoaXMucG9pbnRlci5jbGllbnRZIC0gcmVjdC50b3ApIC8gcmVjdC5oZWlnaHQpICogMiAtIDEpLFxuICAgICAgICAgIDAuNVxuICAgICAgICApXG4gICAgICAgIG5kYy51bnByb2plY3QodGhpcy5jYW1lcmEpXG4gICAgICAgIGNvbnN0IGRpciA9IHMudmVjQi5jb3B5KG5kYykuc3ViKHRoaXMuY2FtZXJhLnBvc2l0aW9uKVxuICAgICAgICBjb25zdCBkaXJaID0gZGlyLnpcbiAgICAgICAgZGlyLm5vcm1hbGl6ZSgpXG4gICAgICAgIC8vIEdlb21ldHJ5IGNhcnJpZXMgY2hyb25vbG9neSBaOyB0aGUgT2JqZWN0M0Qgb3JpZ2luIHN0YXlzIGF0IFNVQkpFQ1RfWi5cbiAgICAgICAgY29uc3QgcGxhbmVaID0gdGhpcy5wb2ludHMucG9zaXRpb24ueiArIHN0YXRlLmhlYWRaXG4gICAgICAgIGNvbnN0IGRpc3RhbmNlID0gZGlyWiA9PT0gMCA/IC0xIDogKHBsYW5lWiAtIHRoaXMuY2FtZXJhLnBvc2l0aW9uLnopIC8gZGlyLnpcbiAgICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShkaXN0YW5jZSkgJiYgZGlzdGFuY2UgPiAwKSB7XG4gICAgICAgICAgY29uc3Qgd29ybGQgPSBzLnZlY0FcbiAgICAgICAgICAgIC5jb3B5KHRoaXMuY2FtZXJhLnBvc2l0aW9uKVxuICAgICAgICAgICAgLmFkZFNjYWxlZFZlY3RvcihkaXIsIGRpc3RhbmNlKVxuICAgICAgICAgICAgLnN1Yih0aGlzLnBvaW50cy5wb3NpdGlvbilcbiAgICAgICAgICBzLmludmVyc2VSb3RhdGlvbi5jb3B5KHRoaXMucG9pbnRzLnF1YXRlcm5pb24pLmludmVydCgpXG4gICAgICAgICAgd29ybGQuYXBwbHlRdWF0ZXJuaW9uKHMuaW52ZXJzZVJvdGF0aW9uKVxuICAgICAgICAgIHMucG9pbnRlckZpZWxkLmxvY2FsWCA9IHdvcmxkLnhcbiAgICAgICAgICBzLnBvaW50ZXJGaWVsZC5sb2NhbFkgPSB3b3JsZC55XG4gICAgICAgICAgcy5wb2ludGVyRmllbGQubG9jYWxaID0gd29ybGQuelxuICAgICAgICAgIHMucG9pbnRlckZpZWxkLnRpbWUgPSB0aW1lXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcG9pbnRlckFjdGl2ZSA9IGZhbHNlXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBvaW50ZXJBY3RpdmUgPSBmYWxzZVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHVzZUhvbGRTdGVwID0gcGhhc2UgPT09ICdob2xkJyAmJiBnbHlwaE1peCA+IDAuNVxuICAgIGNvbnN0IGNvbWV0TWl4ID0gMSAtIGdseXBoTWl4XG4gICAgLy8gUGVyLXBvaW50IGNvdmVyYWdlIHNlcGFyYXRlcyB0aGUgc21hbGwgbnVjbGV1cyBmcm9tIHRoZSBkaWZmdXNlIGNvbWEuXG4gICAgLy8gUmVzdG9yZSB0aGUgb3JpZ2luYWwgcG9pbnQgZm9vdHByaW50IGFzIHRoZSBib2R5IGJlY29tZXMgYSBnbHlwaC5cbiAgICBjb25zdCBib2R5TWF0ZXJpYWwgPSB0aGlzLnBvaW50cy5tYXRlcmlhbCBhcyBQb2ludHNNYXRlcmlhbFxuICAgIGJvZHlNYXRlcmlhbC5zaXplID0gcGFsZXR0ZS5wb2ludFNpemVcbiAgICBjb25zdCB0YWJsZSA9IHMudGFpbFRhYmxlXG4gICAgY29uc3QgZGVwYXJ0dXJlID0gZGVwYXJ0dXJlU2Vjb25kcyhwaGFzZSwgc3RhdGUucGhhc2VQcm9ncmVzcywgTEVHX1NFQ09ORFMsIFNDQVRURVJfU0VDT05EUylcbiAgICBjb25zdCBtb3ZpbmcgPSBNYXRoLmh5cG90KHRhYmxlLnZlbFswXSwgdGFibGUudmVsWzFdLCB0YWJsZS52ZWxbMl0pID4gMWUtNlxuICAgIHMuZW1pdHRlZFRhaWwudXBkYXRlKGRlbHRhLCBkZXBhcnR1cmUsIGRlcGFydHVyZSA+IDAgJiYgbW92aW5nICYmICF0aGlzLnJlZHVjZWRNb3Rpb24sXG4gICAgICB0YWJsZSwgc3RhdGUuaGVhZFgsIHN0YXRlLmhlYWRZLCBzdGF0ZS5oZWFkWiwgcGFsZXR0ZS5jb3JlLCBwYWxldHRlLmFjY2VudCwgdGhpcy5saWdodClcblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY291bnQ7IGkrKykge1xuICAgICAgY29uc3QgaWR4ID0gaSAqIDNcbiAgICAgIGNvbnN0IHB4ID0gcG9zaXRpb25zW2lkeF1cbiAgICAgIGNvbnN0IHB5ID0gcG9zaXRpb25zW2lkeCArIDFdXG4gICAgICBjb25zdCBweiA9IHBvc2l0aW9uc1tpZHggKyAyXVxuXG4gICAgICAvLyBBbGwgZm9ybWVyIGxvZ28gcGFydGljbGVzIGJlbG9uZyB0byB0aGUgY29tcGFjdCBib2R5IHRocm91Z2hvdXQgZmxpZ2h0LlxuICAgICAgY29uc3QgY29tZXRYID0gc3RhdGUuaGVhZFggKyBzLmJvZHkub2Zmc2V0c1tpZHhdXG4gICAgICBjb25zdCBjb21ldFkgPSBzdGF0ZS5oZWFkWSArIHMuYm9keS5vZmZzZXRzW2lkeCArIDFdXG4gICAgICBjb25zdCBjb21ldFogPSBzdGF0ZS5oZWFkWiArIHMuYm9keS5vZmZzZXRzW2lkeCArIDJdXG4gICAgICBjb25zdCBlbWl0ID0gcy5ib2R5LmFscGhhW2ldICogKHRoaXMubGlnaHQgPyAxLjcgOiAxKVxuXG4gICAgICAvLyAtLS0gZ2x5cGggdGFyZ2V0OiB0aGUgYW5jaG9yIHBsdXMgaXRzIGJvdW5kZWQgaW50ZXJuYWwgZHJpZnQgLS0tLS0tLS0tLS1cbiAgICAgIGxldCB0eCA9IGNvbWV0WFxuICAgICAgbGV0IHR5ID0gY29tZXRZXG4gICAgICBsZXQgdHogPSBjb21ldFpcbiAgICAgIGNvbnN0IG1peCA9IHRoaXMucmVkdWNlZE1vdGlvbiA/IGdseXBoTWl4IDogc3RhZ2dlcmVkR2x5cGhNaXgocGhhc2UsIHNoYXBlUHJvZ3Jlc3MsIGkpXG4gICAgICBsZXQgYWxwaGEgPSBlbWl0XG4gICAgICBpZiAocGhhc2UgPT09ICdnYXRoZXInKSB7XG4gICAgICAgIHR4ID0gcy5zaGFwZUZyb21baWR4XSArIChnbHlwaFtpZHhdICsgcy5pY29uT3JiaXRPZmZzZXRzW2lkeF0gLSBzLnNoYXBlRnJvbVtpZHhdKSAqIG1peFxuICAgICAgICB0eSA9IHMuc2hhcGVGcm9tW2lkeCArIDFdICsgKGdseXBoW2lkeCArIDFdICsgcy5pY29uT3JiaXRPZmZzZXRzW2lkeCArIDFdIC0gcy5zaGFwZUZyb21baWR4ICsgMV0pICogbWl4XG4gICAgICAgIHR6ID0gcy5zaGFwZUZyb21baWR4ICsgMl0gKyAoZ2x5cGhbaWR4ICsgMl0gKyBzLmljb25PcmJpdE9mZnNldHNbaWR4ICsgMl0gLSBzLnNoYXBlRnJvbVtpZHggKyAyXSkgKiBtaXhcbiAgICAgICAgYWxwaGEgPSBzLnNoYXBlQWxwaGFbaV0gKyAoMSAtIHMuc2hhcGVBbHBoYVtpXSkgKiBtaXhcbiAgICAgIH0gZWxzZSBpZiAocGhhc2UgPT09ICdzY2F0dGVyJykge1xuICAgICAgICBjb25zdCBiZW5kID0gTWF0aC5zaW4oTWF0aC5QSSAqIG1peCkgKiAocy50YWlsU2VlZFtpXSAtIDAuNSkgKiAwLjE2XG4gICAgICAgIHR4ICs9IChzLnNoYXBlRnJvbVtpZHhdIC0gY29tZXRYKSAqIG1peCAtIChzLnNoYXBlRnJvbVtpZHggKyAxXSAtIGNvbWV0WSkgKiBiZW5kXG4gICAgICAgIHR5ICs9IChzLnNoYXBlRnJvbVtpZHggKyAxXSAtIGNvbWV0WSkgKiBtaXggKyAocy5zaGFwZUZyb21baWR4XSAtIGNvbWV0WCkgKiBiZW5kXG4gICAgICAgIHR6ICs9IChzLnNoYXBlRnJvbVtpZHggKyAyXSAtIGNvbWV0WikgKiBtaXggKyBNYXRoLnNpbihNYXRoLlBJICogbWl4KSAqIChzLnRhaWxTZWVkW2ldIC0gMC41KSAqIDAuMjJcbiAgICAgICAgLy8gUHJvamVjdGVkIGFyZWEgZmFsbHMgcm91Z2hseSBxdWFkcmF0aWNhbGx5IHdoaWxlIHRoZSBsb2dvIGNvbmNlbnRyYXRlcy5cbiAgICAgICAgLy8gTm9ybWFsaXplIHRoZSBpbi1mbGlnaHQgZ2x5cGggbGlnaHQgYmVmb3JlIGl0cyBwb2ludHMgb3ZlcmxhcCBhdCB0aGUgY29yZS5cbiAgICAgICAgYWxwaGEgPSBlbWl0ICsgKHMuc2hhcGVBbHBoYVtpXSAtIGVtaXQpICogbWl4ICogbWl4XG4gICAgICB9IGVsc2UgaWYgKHBoYXNlID09PSAnaG9sZCcpIHtcbiAgICAgICAgdHggPSBnbHlwaFtpZHhdICsgcy5pY29uT3JiaXRPZmZzZXRzW2lkeF1cbiAgICAgICAgdHkgPSBnbHlwaFtpZHggKyAxXSArIHMuaWNvbk9yYml0T2Zmc2V0c1tpZHggKyAxXVxuICAgICAgICB0eiA9IGdseXBoW2lkeCArIDJdICsgcy5pY29uT3JiaXRPZmZzZXRzW2lkeCArIDJdXG4gICAgICAgIGFscGhhID0gMVxuICAgICAgfVxuXG4gICAgICBsZXQgdnggPSB2ZWxvY2l0aWVzW2lkeF1cbiAgICAgIGxldCB2eSA9IHZlbG9jaXRpZXNbaWR4ICsgMV1cbiAgICAgIGxldCB2eiA9IHZlbG9jaXRpZXNbaWR4ICsgMl1cblxuICAgICAgaWYgKHVzZUhvbGRTdGVwKSB7XG4gICAgICAgIHN0ZXBWb3hTcGFjZUhvbGRQYXJ0aWNsZSh2ZWxvY2l0aWVzLCBpZHgsIHB4LCBweSwgcHosIHR4LCB0eSwgdHosIGZvbGxvd1NwZWVkLCBmcmFtZVN0ZXApXG4gICAgICAgIHZ4ID0gdmVsb2NpdGllc1tpZHhdXG4gICAgICAgIHZ5ID0gdmVsb2NpdGllc1tpZHggKyAxXVxuICAgICAgICB2eiA9IHZlbG9jaXRpZXNbaWR4ICsgMl1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZ4ID0gdnggKiBDT01FVF9WRUxPQ0lUWV9NRU1PUlkgLSBzLnBvaW50ZXJPZmZzZXRbaWR4XSAqIGZvbGxvd1NwZWVkICogZnJhbWVTdGVwXG4gICAgICAgIHZ5ID0gdnkgKiBDT01FVF9WRUxPQ0lUWV9NRU1PUlkgLSBzLnBvaW50ZXJPZmZzZXRbaWR4ICsgMV0gKiBmb2xsb3dTcGVlZCAqIGZyYW1lU3RlcFxuICAgICAgICB2eiA9IHZ6ICogQ09NRVRfVkVMT0NJVFlfTUVNT1JZIC0gcy5wb2ludGVyT2Zmc2V0W2lkeCArIDJdICogZm9sbG93U3BlZWQgKiBmcmFtZVN0ZXBcbiAgICAgICAgdmVsb2NpdGllc1tpZHhdID0gdnhcbiAgICAgICAgdmVsb2NpdGllc1tpZHggKyAxXSA9IHZ5XG4gICAgICAgIHZlbG9jaXRpZXNbaWR4ICsgMl0gPSB2elxuICAgICAgfVxuXG4gICAgICBpZiAocG9pbnRlckFjdGl2ZSkge1xuICAgICAgICBhcHBseVZveFNwYWNlUG9pbnRlclB1c2godmVsb2NpdGllcywgaWR4LCBweCwgcHksIHB6LCBpIC8gY291bnQsIHMucG9pbnRlckZpZWxkKVxuICAgICAgICB2eCA9IHZlbG9jaXRpZXNbaWR4XVxuICAgICAgICB2eSA9IHZlbG9jaXRpZXNbaWR4ICsgMV1cbiAgICAgICAgdnogPSB2ZWxvY2l0aWVzW2lkeCArIDJdXG4gICAgICB9XG5cbiAgICAgIHZ4ICo9IGZyaWN0aW9uXG4gICAgICB2eSAqPSBmcmljdGlvblxuICAgICAgdnogKj0gZnJpY3Rpb25cbiAgICAgIHZlbG9jaXRpZXNbaWR4XSA9IHZ4XG4gICAgICB2ZWxvY2l0aWVzW2lkeCArIDFdID0gdnlcbiAgICAgIHZlbG9jaXRpZXNbaWR4ICsgMl0gPSB2elxuXG4gICAgICBpZiAoIXVzZUhvbGRTdGVwKSB7XG4gICAgICAgIHMucG9pbnRlck9mZnNldFtpZHhdICs9IHZ4XG4gICAgICAgIHMucG9pbnRlck9mZnNldFtpZHggKyAxXSArPSB2eVxuICAgICAgICBzLnBvaW50ZXJPZmZzZXRbaWR4ICsgMl0gKz0gdnpcbiAgICAgIH1cbiAgICAgIGNvbnN0IG54ID0gdXNlSG9sZFN0ZXAgPyBweCArIHZ4IDogdHggKyBzLnBvaW50ZXJPZmZzZXRbaWR4XVxuICAgICAgY29uc3QgbnkgPSB1c2VIb2xkU3RlcCA/IHB5ICsgdnkgOiB0eSArIHMucG9pbnRlck9mZnNldFtpZHggKyAxXVxuICAgICAgY29uc3QgbnogPSB1c2VIb2xkU3RlcCA/IHB6ICsgdnogOiB0eiArIHMucG9pbnRlck9mZnNldFtpZHggKyAyXVxuICAgICAgcG9zaXRpb25zW2lkeF0gPSBueFxuICAgICAgcG9zaXRpb25zW2lkeCArIDFdID0gbnlcbiAgICAgIHBvc2l0aW9uc1tpZHggKyAyXSA9IG56XG5cbiAgICAgIC8vIC0tLSBjb2xvdXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIERhcmsgdGhlbWUgaXMgYSB3aGl0ZS1ob3QgaGVhZCBjb29saW5nIGRvd24gdGhlIHRhaWwsIHdpdGggdGhlIHNpdGUnc1xuICAgICAgLy8gc2luZ2xlIHdhcm0gYWNjZW50IG1peGVkIGluIGF0IHRoZSBoZWFkIG9ubHkg4oCUIGEgY29tZXQgcmVhZHMgYXMgd2hpdGUtaG90LFxuICAgICAgLy8gYW5kIGEgc2F0dXJhdGVkIGhlYWQgd291bGQgZmlnaHQgdGhlIGdseXBoIGl0IGZvcm1zLlxuICAgICAgLy9cbiAgICAgIC8vIGBlbWl0YCBpcyB0aGUgbGlmZXRpbWUgZmFkZSwgYW5kIGl0IGlzIHdoYXQgdGhlIHVzZXIgYXNrZWQgZm9yIGJ5IG5hbWU6XG4gICAgICAvLyBcIui+vuWIsOS4gOWumui3neemu+WQjua4kOWPmOa2iOWksVwiLiBBIHBhcnRpY2xlJ3MgYnJpZ2h0bmVzcyBmYWxscyB0byBleGFjdGx5IHplcm8gYXMgaXRzXG4gICAgICAvLyBsaWZlIHJ1bnMgb3V0LCBzbyB0aGUgZmFyIGVuZCBvZiB0aGUgcGx1bWUgZGlzc29sdmVzIGluc3RlYWQgb2YgYmVpbmcgY3V0IG9mZi5cbiAgICAgIC8vIFRoZSBoZWFkJ3Mgb3duIGx1bWluYW5jZSBpcyBsZWZ0IHdoZXJlIGl0IHdhczsgbm90aGluZyBoZXJlIHNocmlua3MgdGhlIGNvbWV0LlxuICAgICAgY29uc3Qgd2FybSA9IGdseXBoTWl4ICogMC4yNiArIGNvbWV0TWl4ICogMC4wNDVcbiAgICAgIGNvbnN0IGRlcHRoID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIChueiAtIHN0YXRlLmhlYWRaKSAvIDEuNCkpICogdGhpcy5ob2xkRmFkZVxuICAgICAgY29uc3Qgc2hpbW1lciA9IDAuODYgKyBNYXRoLnNpbih0aW1lICogMi4xICsgcy50YWlsU2VlZFtpXSAqIDQzLjApICogMC4wNSArIGRlcHRoICogMC4wOFxuICAgICAgLy8gVGhlIGlvbiBwb3B1bGF0aW9uIGlzIHRpbnRlZCB0b3dhcmQgdGhlIGFjY2VudCBhbmQgdGhlIGR1c3QgdG93YXJkIHRoZSBjb29sXG4gICAgICAvLyBjb3JlLCB3aGljaCBpcyB0aGUgb25lIG5vZCB0byB0aGUgdHdvLXRhaWwgc3RydWN0dXJlIHRoZSBicmllZiBhc2tzIGZvciB0aGF0XG4gICAgICAvLyB0aGlzIHJlbmRlcmVyIGNhbiBhZmZvcmQ6IG9uZSBtdWx0aXBseSBhbmQgb25lIGNvbXBhcmUgcGVyIHBhcnRpY2xlLlxuICAgICAgY29uc3QgdyA9IHdhcm1cbiAgICAgIGNvbnN0IGx1bSA9IChnbHlwaE1peCAqIDEuMTQgKyBjb21ldE1peCAqIHMuYm9keS50b25lW2ldICsgTWF0aC5hYnMoZGVwdGgpICogMC4wNikgKiBzaGltbWVyICogcGFsZXR0ZS5nYWluXG5cbiAgICAgIGxldCBjciA9IChwYWxldHRlLmNvcmUuciArIChwYWxldHRlLmFjY2VudC5yIC0gcGFsZXR0ZS5jb3JlLnIpICogdykgKiBsdW1cbiAgICAgIGxldCBjZyA9IChwYWxldHRlLmNvcmUuZyArIChwYWxldHRlLmFjY2VudC5nIC0gcGFsZXR0ZS5jb3JlLmcpICogdykgKiBsdW1cbiAgICAgIGxldCBjYiA9IChwYWxldHRlLmNvcmUuYiArIChwYWxldHRlLmFjY2VudC5iIC0gcGFsZXR0ZS5jb3JlLmIpICogdykgKiBsdW1cbiAgICAgIC8vIEEgd2FybSBjb21wYWN0IG51Y2xldXMgc2l0cyBpbnNpZGUgYSBjb29sIGdhcyBlbnZlbG9wZS4gUHJlc2VydmUgdGhlXG4gICAgICAvLyBvcmlnaW5hbCBicmFuZCBwYWxldHRlIGV4YWN0bHkgYXMgdGhlIGJvZHkgcmVzb2x2ZXMgaW50byBhIGdseXBoLlxuICAgICAgY29uc3QgbnVjbGV1cyA9IHMuYm9keS5zcHJpdGVTaXplW2ldIDwgM1xuICAgICAgaWYgKHRoaXMubGlnaHQpIHtcbiAgICAgICAgY29uc3QgaW5rID0gbnVjbGV1cyA/IDEgLSBjb21ldE1peCAqIDAuNzIgOiAxXG4gICAgICAgIGNyICo9IGlua1xuICAgICAgICBjZyAqPSBpbmtcbiAgICAgICAgY2IgKj0gaW5rXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjciAqPSAxICsgY29tZXRNaXggKiAobnVjbGV1cyA/IDAuMDQgOiAtMC43MilcbiAgICAgICAgY2cgKj0gMSArIGNvbWV0TWl4ICogKG51Y2xldXMgPyAwIDogLTAuMTgpXG4gICAgICAgIGNiICo9IDEgKyBjb21ldE1peCAqIChudWNsZXVzID8gLTAuMTIgOiAwLjE4KVxuICAgICAgfVxuXG4gICAgICBjb25zdCBjYXAgPSB0aGlzLmxpZ2h0ID8gMC44MiA6IDEuNFxuICAgICAgY29uc3QgY29sb3JJbmRleCA9IGkgKiA0XG4gICAgICBjb2xvcnNbY29sb3JJbmRleF0gPSBjciA+IGNhcCA/IGNhcCA6IGNyXG4gICAgICBjb2xvcnNbY29sb3JJbmRleCArIDFdID0gY2cgPiBjYXAgPyBjYXAgOiBjZ1xuICAgICAgY29sb3JzW2NvbG9ySW5kZXggKyAyXSA9IGNiID4gY2FwID8gY2FwIDogY2JcbiAgICAgIGNvbnN0IHNwcml0ZVNjYWxlID0gMSArIGNvbWV0TWl4ICogKHRoaXMubGlnaHQgPyAwLjM1IDogcy5ib2R5LnNwcml0ZVNpemVbaV0gLSAxKVxuICAgICAgcy5ib2R5LnNwcml0ZVNjYWxlW2ldID0gc3ByaXRlU2NhbGVcbiAgICAgIGNvbG9yc1tjb2xvckluZGV4ICsgM10gPSBhbHBoYSAvIChzcHJpdGVTY2FsZSAqIHNwcml0ZVNjYWxlKVxuICAgIH1cbiAgICB0aGlzLnJlbmRlcmVkSGVhZC5zZXQoc3RhdGUuaGVhZFgsIHN0YXRlLmhlYWRZLCBzdGF0ZS5oZWFkWilcbiAgfVxuXG4gIHByaXZhdGUgdXBsb2FkKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VvbWV0cnkuZ2V0QXR0cmlidXRlKCdwb3NpdGlvbicpLm5lZWRzVXBkYXRlID0gdHJ1ZVxuICAgIHRoaXMuZ2VvbWV0cnkuZ2V0QXR0cmlidXRlKCdjb2xvcicpLm5lZWRzVXBkYXRlID0gdHJ1ZVxuICAgIHRoaXMuZ2VvbWV0cnkuZ2V0QXR0cmlidXRlKCdjb21ldFNjYWxlJykubmVlZHNVcGRhdGUgPSB0cnVlXG4gICAgdGhpcy50YWlsR2VvbWV0cnkuZ2V0QXR0cmlidXRlKCdwb3NpdGlvbicpLm5lZWRzVXBkYXRlID0gdHJ1ZVxuICAgIHRoaXMudGFpbEdlb21ldHJ5LmdldEF0dHJpYnV0ZSgnY29sb3InKS5uZWVkc1VwZGF0ZSA9IHRydWVcbiAgfVxuXG4gIC8qKiBDYW1lcmEgcmV0cmVhdHMgaW5kZWZpbml0ZWx5IHdoaWxlIGJvdGggcGFydGljbGUgcG9vbHMga2VlcCBhIGZpeGVkIG9yaWdpbi4gKi9cbiAgcHJpdmF0ZSBhZHZhbmNlQ2FtZXJhKCk6IHZvaWQge1xuICAgIGNvbnN0IGNhbWVyYVogPSB0aGlzLmZpdERpc3RhbmNlICsgY2FtZXJhVHJhdmVsQXQodGhpcy5kb2xseVNlY29uZHMpXG4gICAgdGhpcy5jYW1lcmEucG9zaXRpb24uc2V0KDAsIDAsIGNhbWVyYVopXG4gICAgLy8gQSBmaXhlZCAtWiB2aWV3IGFsc28gd29ya3Mgd2hlbiBjYW1lcmFaIGNyb3NzZXMgdGhlIHdvcmxkIG9yaWdpbi5cbiAgICB0aGlzLmNhbWVyYS5xdWF0ZXJuaW9uLmlkZW50aXR5KClcbiAgICB0aGlzLmNhbWVyYS51cGRhdGVNYXRyaXhXb3JsZCgpXG4gIH1cblxuICBwcml2YXRlIHB1Ymxpc2hTdGF0cyhub3c6IG51bWJlcik6IHZvaWQge1xuICAgIC8vIFNsaWRpbmcgbWVhbiBvdmVyIHRoZSBsYXN0IDMwIGZyYW1lcywgaW4gYSBwcmVhbGxvY2F0ZWQgcmluZyBzbyB0aGVcbiAgICAvLyBkaWFnbm9zdGljIGl0c2VsZiBkb2VzIG5vdCBhbGxvY2F0ZSBwZXIgZnJhbWUuXG4gICAgdGhpcy5mcmFtZVRpbWVzW3RoaXMuZnJhbWVDdXJzb3JdID0gbm93XG4gICAgdGhpcy5mcmFtZUN1cnNvciA9ICh0aGlzLmZyYW1lQ3Vyc29yICsgMSkgJSB0aGlzLmZyYW1lVGltZXMubGVuZ3RoXG4gICAgaWYgKHRoaXMuZnJhbWVDb3VudCA8IHRoaXMuZnJhbWVUaW1lcy5sZW5ndGgpIHRoaXMuZnJhbWVDb3VudCArPSAxXG4gICAgaWYgKHRoaXMuZnJhbWVDb3VudCA+IDEpIHtcbiAgICAgIGNvbnN0IG9sZGVzdCA9XG4gICAgICAgIHRoaXMuZnJhbWVDb3VudCA8IHRoaXMuZnJhbWVUaW1lcy5sZW5ndGhcbiAgICAgICAgICA/IHRoaXMuZnJhbWVUaW1lc1swXVxuICAgICAgICAgIDogdGhpcy5mcmFtZVRpbWVzW3RoaXMuZnJhbWVDdXJzb3JdXG4gICAgICBjb25zdCBzcGFuID0gbm93IC0gb2xkZXN0XG4gICAgICBpZiAoc3BhbiA+IDApIHRoaXMuc3RhdHMuZnBzID0gKCh0aGlzLmZyYW1lQ291bnQgLSAxKSAqIDEwMDApIC8gc3BhblxuICAgIH1cblxuICAgIGNvbnN0IGluZm8gPSB0aGlzLnJlbmRlcmVyLmluZm9cbiAgICB0aGlzLnN0YXRzLnBhcnRpY2xlQ291bnQgPSB0aGlzLnBhcnRpY2xlQ291bnRcbiAgICB0aGlzLnN0YXRzLnBoYXNlID0gdGhpcy5jaG9yZW9ncmFwaHkuc3RhdGUucGhhc2VcbiAgICB0aGlzLnN0YXRzLmJyYW5kU2x1ZyA9IHRoaXMuY3VycmVudEJyYW5kU2x1Z1xuICAgIHRoaXMuc3RhdHMuZHJhd0NhbGxzID0gaW5mby5yZW5kZXIuY2FsbHNcbiAgICB0aGlzLnN0YXRzLnRyaWFuZ2xlcyA9IGluZm8ucmVuZGVyLnRyaWFuZ2xlc1xuICAgIC8vIEluY2x1ZGUgcGVyLXBvaW50IGNvdmVyYWdlIGFzIHdlbGwgYXMgdGhlIHBvc2l0aW9uL2NvbG91ciBidWZmZXJzLlxuICAgIHRoaXMuc3RhdHMuZ2VvbWV0cnlCeXRlcyA9XG4gICAgICB0aGlzLmdlb21ldHJ5LmdldEF0dHJpYnV0ZSgncG9zaXRpb24nKS5hcnJheS5ieXRlTGVuZ3RoICtcbiAgICAgIHRoaXMuZ2VvbWV0cnkuZ2V0QXR0cmlidXRlKCdjb2xvcicpLmFycmF5LmJ5dGVMZW5ndGggK1xuICAgICAgdGhpcy5nZW9tZXRyeS5nZXRBdHRyaWJ1dGUoJ2NvbWV0U2NhbGUnKS5hcnJheS5ieXRlTGVuZ3RoICtcbiAgICAgIHRoaXMudGFpbEdlb21ldHJ5LmdldEF0dHJpYnV0ZSgncG9zaXRpb24nKS5hcnJheS5ieXRlTGVuZ3RoICtcbiAgICAgIHRoaXMudGFpbEdlb21ldHJ5LmdldEF0dHJpYnV0ZSgnY29sb3InKS5hcnJheS5ieXRlTGVuZ3RoXG5cbiAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIC8vIFRoZSBleHRlcm5hbCBhY2NlcHRhbmNlIGhhcm5lc3MgcmVhZHMgdGhpcy4gSXQgaXMgdGhlIHNhbWUgb2JqZWN0IGV2ZXJ5XG4gICAgICAvLyBmcmFtZSwgc28gcHVibGlzaGluZyBpdCBhbGxvY2F0ZXMgbm90aGluZy5cbiAgICAgIGNvbnN0IGhvbGRlciA9IHdpbmRvdyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICBob2xkZXIuX19TVUIyQVBJX1BBUlRJQ0xFX1NUQVRTX18gPSB0aGlzLnN0YXRzXG4gICAgfVxuICB9XG59XG4iXSwibWFwcGluZ3MiOiJBQXNDQTtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FB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LElBQUksUUFBUTtBQU1uRCxRQUFNLElBQUksVUFBVTtBQUNwQixRQUFNLElBQUksS0FBSyxJQUFJLElBQUksR0FBRyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQ3ZDLFFBQU0sSUFBSSxJQUFJO0FBQ2QsUUFBTSxJQUFJLElBQUk7QUFDZCxRQUFNLEtBQUssSUFBSSxLQUFLO0FBRXBCLFFBQU0sS0FBSyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSztBQUN4QyxRQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLEtBQUs7QUFDcEQsUUFBTSxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxLQUFLO0FBSXBELFFBQU0sS0FBSyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSztBQUN4QyxRQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLEtBQUs7QUFDcEQsUUFBTSxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxLQUFLO0FBQ3BELFFBQU0sUUFBUSxVQUFVO0FBSXhCLFFBQU0sS0FBSyxLQUFLLENBQUMsS0FBSyxLQUFLLENBQUMsSUFBSSxLQUFLLENBQUMsS0FBSztBQUMzQyxRQUFNLEtBQUssS0FBSyxJQUFJLENBQUMsS0FBSyxLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSSxDQUFDLEtBQUs7QUFDdkQsUUFBTSxLQUFLLEtBQUssSUFBSSxDQUFDLEtBQUssS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxLQUFLO0FBQ3ZELFFBQU0sS0FBSyxNQUFNLENBQUMsS0FBSyxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsS0FBSztBQUM5QyxRQUFNLEtBQUssTUFBTSxJQUFJ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