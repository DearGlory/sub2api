import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createCometBody } from '../emittedTail'
import { writeCometTransition } from '../cometTransition'

describe('transition hot-path allocation and bounded CPU work', () => {
  it('has no constructors, literals, closures or allocating array helpers in the changed hot path', () => {
    const violations: string[] = []
    const inspected: string[] = []
    for (const filename of ['ParticleEngine.ts', 'cometTransition.ts']) {
      const path = resolve('src/features/home-particle/engine', filename)
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const inspect = (node: ts.Node): void => {
        if (ts.isNewExpression(node) || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) ||
          ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isSpreadElement(node) ||
          (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            /^(map|filter|slice|subarray|concat|flat|flatMap|from|of|bind)$/.test(node.expression.name.text))) {
          violations.push(`${filename}:${file.getLineAndCharacterOfPosition(node.pos).line + 1}: ${node.getText(file)}`)
        }
        ts.forEachChild(node, inspect)
      }
      const locate = (node: ts.Node): void => {
        if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body &&
          (filename === 'cometTransition.ts' || /^(integrate|updateCometVisual|upload|publishStats)$/.test(node.name?.getText(file) ?? ''))) {
          inspected.push(`${filename}:${node.name?.getText(file)}`)
          inspect(node.body)
          return
        }
        ts.forEachChild(node, locate)
      }
      locate(file)
    }
    expect(inspected).toContain('ParticleEngine.ts:integrate')
    expect(inspected).toContain('cometTransition.ts:writeCometTransition')
    expect(violations).toEqual([])
    console.info('allocation audit (AST; excludes dependency internals)', inspected)
  })

  it('measures both kernels at the desktop particle budget using preallocated inputs', () => {
    const count = 18000
    const body = createCometBody(count)
    const out = new Float64Array(6)
    const durations: number[] = []
    let checksum = 0
    for (let frame = 0; frame < 80; frame++) {
      const phase = frame % 2 ? 'scatter' : 'gather'
      const q = (frame % 39 + 1) / 40
      const start = performance.now()
      for (let i = 0; i < count; i++) {
        const k = i * 3
        const x = body.offsets[k], y = body.offsets[k + 1], z = body.offsets[k + 2]
        writeCometTransition(out, phase, q,
          phase === 'gather' ? x : x * 5, phase === 'gather' ? y : y * 5, z,
          x * 5, y * 5, z * 0.1, x, y, z, 0, 0, 0,
          i / count, phase === 'gather' ? 0.02 : 1, 0.02)
        checksum += out[0] + out[3]
      }
      if (frame >= 10) durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    expect(Number.isFinite(checksum)).toBe(true)
    console.info('CPU only; not GPU/fps evidence', {
      particles: count, measuredFrames: durations.length,
      medianMs: durations[Math.floor(durations.length / 2)],
      p95Ms: durations[Math.floor(durations.length * 0.95)],
      maxMs: durations[durations.length - 1], checksum,
    })
  })
})
