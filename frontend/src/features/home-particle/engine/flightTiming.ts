import type { CometPhase } from './types'

/** The nucleus closes before departure; the remaining scatter time starts the next flight. */
export const COALESCE_END = 0.62

export function departureSeconds(
  phase: CometPhase,
  progress: number,
  legSeconds: number,
  scatterSeconds: number
): number {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
  if (phase === 'scatter') return Math.max(0, p - COALESCE_END) * scatterSeconds
  if (phase === 'travel') return scatterSeconds * (1 - COALESCE_END) + p * legSeconds
  return 0
}
