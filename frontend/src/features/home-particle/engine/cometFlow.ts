import type { EmissionTable } from './ParticleEngine'

/** Writes the birth-local axis, side1, side2 into an existing nine-scalar buffer. */
export function writeCometFlowBasis(out: Float64Array, table: EmissionTable): void {
  for (let j = 0; j < 3; j++) {
    out[j] = table.axis[j]
    out[j + 3] = table.side1[j]
    out[j + 6] = table.side2[j]
  }
}
