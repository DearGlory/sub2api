import type { Color } from 'three'
import type { EmissionTable } from './ParticleEngine'
import { COMET_VOLUME_SCALE } from './cometVisualContract'

function noise(i: number, salt: number): number {
  let n = Math.imul(i ^ salt, 0x45d9f3b)
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** Filled wedge, with a porous outer sheath on every side, in the local flow basis. */
function writeAperture(out: Float32Array, i: number, sheath: boolean): number {
  const t = Math.pow(noise(i, 277), 1.25)
  const angle = noise(i, 307) * Math.PI * 2
  const radius = sheath ? 0.48 + 0.52 * Math.sqrt(noise(i, 337)) : 0.56 * Math.sqrt(noise(i, 337))
  const width = (0.1 + 0.96 * Math.pow(Math.sin(Math.PI * t), 0.7)) * (1 - 0.33 * t)
  const k = i * 3
  out[k] = ((sheath ? -0.75 : -0.55) + (sheath ? 3.05 : 2.45) * t) * COMET_VOLUME_SCALE
  out[k + 1] = width * radius * Math.cos(angle) * COMET_VOLUME_SCALE
  out[k + 2] = width * radius * Math.sin(angle) * COMET_VOLUME_SCALE
  return t
}

/** Independent real births. Camera, head and later nozzle changes cannot move old particles. */
export class EmittedTail {
  readonly positions: Float32Array
  readonly colors: Float32Array
  readonly birthTime: Float64Array
  readonly birthPosition: Float32Array
  readonly birthVelocity: Float32Array
  readonly age: Float32Array
  readonly life: Float32Array
  /** 0 = free, 1 = alive, 2 = transparent retirement upload. */
  readonly active: Uint8Array
  private readonly aperture: Float32Array
  private readonly ejection: Float32Array
  private readonly birthAcceleration: Float32Array
  private readonly birthStrength: Float32Array
  private readonly ion: Float32Array
  private readonly grain: Float32Array
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
    this.birthAcceleration = new Float32Array(count * 3)
    this.birthStrength = new Float32Array(count)
    this.ion = new Float32Array(count)
    this.grain = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const k = i * 3
      const ion = noise(i, 103) < 0.42
      this.ion[i] = ion ? 0.72 + noise(i, 109) * 0.28 : noise(i, 109) * 0.16
      this.grain[i] = noise(i, 113)
      writeAperture(this.aperture, i, noise(i, 71) < 0.44)
      // Lifetime remains below the logo hold. Length comes from ejection speed,
      // not a lingering fog or larger sprites. Cold grains run slightly farther.
      this.life[i] = 1.65 + noise(i, 131) * 1.2
      const speed = 7.4 + noise(i, 173) * (ion ? 6.2 : 4.8)
      const skirt = noise(i, 193) < 0.2
      const spread = (skirt ? 0.13 : 0.045) * Math.pow(noise(i, 197), 1.3)
      const angle = noise(i, 229) * Math.PI * 2
      this.ejection[k] = speed
      this.ejection[k + 1] = speed * spread * Math.cos(angle)
      // side2 points down for the normal X/Z flight basis. Both streams overlap.
      this.ejection[k + 2] = speed * (spread * Math.sin(angle) + (ion ? -0.025 : 0.018))
    }
  }

  update(delta: number, departure: number, canEmit: boolean, table: EmissionTable,
    headX: number, headY: number, headZ: number, core: Color, accent: Color, light: boolean): void {
    // The palette arguments remain in the shared API; comet colour is independent of logo colour.
    void core; void accent
    const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0
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
      const k = i * 3, c = i * 4
      if (age >= this.life[i]) {
        this.colors[c + 3] = 0
        this.active[i] = 2
        continue
      }
      // A weak, birth-frozen transverse force makes a shallow arc. It does not
      // consult the present frame, so turning or camera travel cannot drag a trail.
      for (let j = 0; j < 3; j++) {
        this.positions[k + j] = this.birthPosition[k + j] + this.birthVelocity[k + j] * age +
          0.5 * this.birthAcceleration[k + j] * age * age
      }
      const u = age / this.life[i]
      const fade = Math.pow(1 - u, 1.15) * Math.min(1, age / 0.025)
      const cool = this.ion[i] * (1 - Math.exp(-age * 4.5))
      const white = this.grain[i] > 0.93 ? 0.42 : 0
      const r = 1 + (0.14 - 1) * cool
      const g = 0.49 + (0.47 - 0.49) * cool + white * (1 - u)
      const b = 0.085 + (0.94 - 0.085) * cool + white * (1 - u)
      const ink = light ? 0.48 : 1
      this.colors[c] = r * ink
      this.colors[c + 1] = g * ink
      this.colors[c + 2] = b * ink
      // Fine sprites spend alpha on actual grains, never an area compensation.
      this.colors[c + 3] = fade * this.birthStrength[i] * (0.5 + 0.38 * this.grain[i])
    }

    // Irregular multi-frequency jets: density, speed and brightness are decided
    // only at birth, and the resulting packets advect down the tail with age.
    const clock = Number.isFinite(departure) ? departure : 0
    const pulse = Math.pow(Math.max(0, Math.sin(clock * 8.7 + 0.55 * Math.sin(clock * 3.1))), 6)
    const strength = 0.58 + 0.42 * pulse
    this.credit += emissionDelta * this.count / 2.25 * (0.88 + 0.32 * pulse)
    let births = Math.floor(this.credit + 1e-9)
    this.credit -= births
    let searched = 0
    while (births > 0 && searched < this.count) {
      const i = this.cursor
      this.cursor = (i + 1) % this.count
      searched++
      if (this.active[i] !== 0) continue
      const k = i * 3, c = i * 4
      const jet = 1 + 0.16 * pulse * (0.5 + this.grain[i])
      const curl = 0.22 - 0.62 * this.ion[i]
      this.birthTime[i] = departure
      this.birthStrength[i] = strength
      this.age[i] = 0
      this.active[i] = 1
      for (let j = 0; j < 3; j++) {
        const head = j === 0 ? headX : j === 1 ? headY : headZ
        this.positions[k + j] = this.birthPosition[k + j] = head +
          table.axis[j] * this.aperture[k] + table.side1[j] * this.aperture[k + 1] +
          table.side2[j] * this.aperture[k + 2]
        this.birthVelocity[k + j] = table.vel[j] * 0.25 + jet * (
          table.axis[j] * this.ejection[k] + table.side1[j] * this.ejection[k + 1] +
          table.side2[j] * this.ejection[k + 2])
        this.birthAcceleration[k + j] = table.side2[j] * curl +
          table.side1[j] * (this.grain[i] - 0.5) * 0.08
      }
      this.colors[c] = 1
      this.colors[c + 1] = 0.62
      this.colors[c + 2] = 0.18
      this.colors[c + 3] = 0 // First upload is the real, transparent nozzle location.
      births--
    }
  }
}

/** Gold-white porous wedge and orange sheath; x=tail axis, y=side1, z=side2. */
export function createCometBody(count: number) {
  const offsets = new Float32Array(count * 3)
  const alpha = new Float32Array(count)
  const tone = new Float32Array(count)
  const spriteSize = new Float32Array(count)
  const spriteScale = new Float32Array(count).fill(1)
  for (let i = 0; i < count; i++) {
    const sheath = noise(i, 251) >= 0.57
    const t = writeAperture(offsets, i, sheath)
    const k = i * 3
    // Uneven strands leave black interstices without a solid shell or smooth disc.
    const grain = noise(i, 367)
    const texture = 0.48 + 0.52 * Math.abs(Math.sin(offsets[k] * 8 + offsets[k + 1] * 13) *
      Math.cos(offsets[k + 2] * 11 - offsets[k] * 5))
    alpha[i] = (sheath ? 0.3 : 0.68) * texture * (0.7 + 0.3 * grain) * (1 - 0.45 * t)
    // tone >= .72 is the gold-white inner population; lower values are orange gold.
    tone[i] = sheath ? 0.24 + 0.34 * grain : 0.76 + 0.24 * grain
    spriteSize[i] = 0.42 + 0.32 * grain + (grain > 0.985 ? 0.24 : 0)
  }
  return { offsets, alpha, tone, spriteSize, spriteScale }
}
