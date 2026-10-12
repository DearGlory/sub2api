import { describe, expect, it } from 'vitest'
import { COALESCE_END, departureSeconds } from '../flightTiming'

// Shared boundary between the motion and emission workers.
describe('departure timing', () => {
  it('keeps coalescence and hold separate from flight', () => {
    expect(departureSeconds('scatter', COALESCE_END, 6.5, 1.1)).toBe(0)
    expect(departureSeconds('hold', 1, 6.5, 1.1)).toBe(0)
    expect(departureSeconds('gather', 1, 6.5, 1.1)).toBe(0)
  })

  it('carries the launch time across the scatter to travel boundary', () => {
    const atDeparture = departureSeconds('scatter', 1, 6.5, 1.1)
    expect(atDeparture).toBeGreaterThan(0)
    expect(departureSeconds('travel', 0, 6.5, 1.1)).toBe(atDeparture)
    expect(departureSeconds('travel', 0.1, 6.5, 1.1)).toBeCloseTo(atDeparture + 0.65)
  })
})
