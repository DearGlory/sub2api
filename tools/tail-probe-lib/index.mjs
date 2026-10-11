/** Barrel for the pure Node side of the probe. No browser imports anywhere below. */
export { decodePng, encodePng, luminance, axialProfile, profileSummary, axisRoom, percentile, bandWidthPx, binCount, findPlumeAxis } from './png.mjs'
export { TH, checkFade, checkTable } from './checkers.mjs'
export { checkReachModel, checkPixelProfile } from './checkers-trail.mjs'
export { checkTransition, checkHold, holdRuns } from './checkers-motion.mjs'
export {
  fadeMutants, reachMutant, birthMutant, tableMutant, pixelMutants, transitionMutant, holdMutants,
  rotatedSummary,
} from './discrimination.mjs'
export { drawRigidCone, drawNoFadePlume, makeViewportLike, emissionControlFrame, CONTROL_DENSITY } from './synthetic.mjs'
export { drawEmissionPlume } from './synthetic-emission.mjs'
