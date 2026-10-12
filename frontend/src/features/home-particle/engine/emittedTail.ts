import type { Color } from 'three'
import type { EmissionTable } from './ParticleEngine'
import { COMET_VOLUME_SCALE } from './cometVisualContract'

function noise(i: number, salt: number): number {
  let n = Math.imul(i ^ salt, 0x45d9f3b)
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** An independent, initially empty pool. No glyph coordinate ever enters this object. */
export class EmittedTail {
  readonly positions: Float32Array
  readonly colors: Float32Array
  readonly birthTime: Float64Array
  readonly birthPosition: Float32Array
  readonly birthVelocity: Float32Array
  readonly age: Float32Array
  readonly life: Float32Array
  /** 0 = free, 1 = alive, 2 = transparent retirement frame. */
  readonly active: Uint8Array
  private readonly aperture: Float32Array
  private readonly ejection: Float32Array
  private cursor = 0
  private credit = 0
  private previousDeparture = 0

  constructor(readonly count: number) {
    this.positions = new Float32Array(count * 3)
    this.colors = new Float32Array(count * 4)
    this.birthTime = new Float64Array(count).fill(-1)
    this.birthPosition = new Float32Array(count * 3)
    this.birthVelocity = new Float32Array(count * 3)
    this.age = new Float32Array(count)
    this.life = new Float32Array(count)
    this.active = new Uint8Array(count)
    this.aperture = new Float32Array(count * 3)
    this.ejection = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const k = i * 3
      const azimuth = noise(i, 19) * Math.PI * 2
      const z = noise(i, 43) * 2 - 1
      const radius = 0.19 * Math.cbrt(noise(i, 71))
      const planar = Math.sqrt(1 - z * z)
      this.aperture[k] = radius * planar * Math.cos(azimuth)
      this.aperture[k + 1] = radius * planar * Math.sin(azimuth)
      this.aperture[k + 2] = radius * z
      const ion = noise(i, 103) < 0.3
      this.life[i] = 1.4 + noise(i, 131) * 1.25
      const speed = 3.2 + noise(i, 173) * (ion ? 3.4 : 2.6)
      // A dense near-axis stream and an increasingly sparse dusty envelope.
      const spread = (ion ? 0.065 : 0.19) * Math.pow(noise(i, 197), 1.5)
      const angle = noise(i, 229) * Math.PI * 2
      this.ejection[k] = speed
      this.ejection[k + 1] = speed * spread * Math.cos(angle)
      this.ejection[k + 2] = speed * spread * Math.sin(angle)
    }
  }

  update(delta: number, departure: number, canEmit: boolean, table: EmissionTable,
    headX: number, headY: number, headZ: number, core: Color, accent: Color, light: boolean): void {
    const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0
    // Coordinates and velocities already include chronology Z in the fixed
    // SUBJECT_Z frame. Never add camera travel here or transform an existing birth.
    const moving = Math.hypot(table.vel[0], table.vel[1], table.vel[2]) > 1e-6
    const emitting = canEmit && moving && Number.isFinite(departure) && departure > 0
    if (!emitting || departure < this.previousDeparture) this.credit = 0
    const emissionDelta = emitting ? Math.min(dt, Math.max(0, departure - this.previousDeparture)) : 0
    this.previousDeparture = Number.isFinite(departure) ? departure : 0

    for (let i = 0; i < this.count; i++) {
      if (this.active[i] === 2) this.active[i] = 0
      if (this.active[i] !== 1) continue
      const age = this.age[i] + dt
      this.age[i] = age
      const k = i * 3
      const c = i * 4
      if (age >= this.life[i]) {
        this.colors[c + 3] = 0
        this.active[i] = 2 // Cannot be reused on this upload.
        continue
      }
      this.positions[k] = this.birthPosition[k] + this.birthVelocity[k] * age
      this.positions[k + 1] = this.birthPosition[k + 1] + this.birthVelocity[k + 1] * age
      this.positions[k + 2] = this.birthPosition[k + 2] + this.birthVelocity[k + 2] * age
      const u = age / this.life[i]
      const fade = Math.pow(1 - u, 1.55) * Math.min(1, age / 0.035)
      const warm = 0.035 + 0.14 * u
      const lum = light ? 0.85 : 0.85 + 0.15 * (1 - u)
      this.colors[c] = (core.r + (accent.r - core.r) * warm) * lum
      this.colors[c + 1] = (core.g + (accent.g - core.g) * warm) * lum
      this.colors[c + 2] = (core.b + (accent.b - core.b) * warm) * lum
      // Light the narrow axial stream without filling the dusty envelope uniformly.
      // This only weights opacity: birth, velocity and lifetime stay independent.
      const spread = Math.hypot(this.ejection[k + 1], this.ejection[k + 2]) / this.ejection[k]
      const spine = Math.exp(-((spread / 0.045) ** 2))
      const coverage = light ? 1 : (1.05 / 3.6) ** 2
      this.colors[c + 3] = fade * (light ? 0.48 : 0.32 * (1 - u) ** 2 + 0.48 * spine) * coverage * Math.min(3.6, 14760 / this.count)
    }

    this.credit += emissionDelta * this.count / 2.85
    let births = Math.floor(this.credit + 1e-9)
    this.credit -= births
    // Bounded ring scan: never overwrite a visible particle, including on a stall.
    let searched = 0
    while (births > 0 && searched < this.count) {
      const i = this.cursor
      this.cursor = (i + 1) % this.count
      searched++
      if (this.active[i] !== 0) continue
      const k = i * 3
      const c = i * 4
      this.birthTime[i] = departure
      this.age[i] = 0
      this.active[i] = 1
      for (let j = 0; j < 3; j++) {
        const head = j === 0 ? headX : j === 1 ? headY : headZ
        this.positions[k + j] = this.birthPosition[k + j] = head + this.aperture[k + j]
        this.birthVelocity[k + j] = table.vel[j] * 0.25 +
          table.axis[j] * this.ejection[k] + table.side1[j] * this.ejection[k + 1] +
          table.side2[j] * this.ejection[k + 2]
      }
      this.colors[c + 3] = 0 // Visible fade-in begins only after the nozzle position is uploaded.
      births--
    }
  }
}

/** Compact textured nucleus + diffuse coma, sharing the glyph draw call. */
export function createCometBody(count: number) {
  const offsets = new Float32Array(count * 3)
  const alpha = new Float32Array(count)
  const tone = new Float32Array(count)
  const spriteSize = new Float32Array(count)
  const spriteScale = new Float32Array(count).fill(1)
  const normalization = Math.min(3.6, 18000 / count)
  for (let i = 0; i < count; i++) {
    const nucleus = noise(i, 251) < 0.24
    const z = noise(i, 277) * 2 - 1
    const angle = noise(i, 307) * Math.PI * 2
    const radial = Math.sqrt(1 - z * z)
    const r = nucleus ? 0.32 * Math.pow(noise(i, 337), 0.45) : 1.02 * Math.cbrt(noise(i, 367))
    const x = r * radial * Math.cos(angle)
    const y = r * radial * Math.sin(angle)
    const texture = 0.76 + 0.24 * Math.sin(x * 34 + y * 17) * Math.sin(z * 9 - y * 23)
    // 1.5x coma volume; the visible .72 rocky surface belongs to CometVisual.
    offsets[i * 3] = x * (nucleus ? 1.12 : 1) * COMET_VOLUME_SCALE
    offsets[i * 3 + 1] = y * (nucleus ? 0.79 : 1) * COMET_VOLUME_SCALE
    offsets[i * 3 + 2] = r * z * 0.8 * COMET_VOLUME_SCALE
    const shade = 0.42 + 0.58 * Math.max(0, (z - y / r + 1) / 3)
    // Keep the bright nucleus small; the coma spends its light on a wider,
    // softer footprint. Both remain particles of this same coalescing body.
    alpha[i] = normalization * (nucleus ? 0.19 * texture * shade * Math.exp(-3 * (r / 0.32) ** 2) : 0.25 * Math.exp(-r * r * 2.2))
    tone[i] = nucleus ? 0.66 + shade * 0.34 : 0.68
    spriteSize[i] = nucleus ? 2.8 : 4.4
  }
  return { offsets, alpha, tone, spriteSize, spriteScale }
}
