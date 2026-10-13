import type { EmissionTable } from './ParticleEngine'

/**
 * World solar wind bends the depth-heavy path tangent into an oblique jet.
 * Absolute birth position supplies a continuous phase, including across beats.
 * No camera, retained orientation, table mutation or per-call allocation.
 */
export function writeCometFlowBasis(out: Float64Array, table: EmissionTable): void {
  const phase = table.xyz[2] * 0.028 + table.xyz[0] * 0.065
  const x = table.axis[0] / Math.hypot(table.axis[0], 0.006)
  const y = 0.32 + 0.06 * Math.sin(phase) + table.axis[1] * 0.2
  // A finite depth component keeps both the jet and its aperture genuinely 3D.
  const z = -0.34 + 0.1 * table.axis[2]
  const length = Math.hypot(x, y, z)
  const ax = x / length, ay = y / length, az = z / length
  // cross(world-up, axis) is well conditioned: z is strictly negative.
  const transverse = Math.hypot(ax, az)
  const ux = az / transverse, uz = -ax / transverse
  const vx = ay * uz, vy = az * ux - ax * uz, vz = -ay * ux
  const roll = 0.18 * Math.sin(phase * 0.7)
  const c = Math.cos(roll), s = Math.sin(roll)
  out[0] = ax; out[1] = ay; out[2] = az
  out[3] = ux * c + vx * s; out[4] = vy * s; out[5] = uz * c + vz * s
  out[6] = vx * c - ux * s; out[7] = vy * c; out[8] = vz * c - uz * s
}
