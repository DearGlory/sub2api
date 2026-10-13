import { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import {
  CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR, DOLLY_FROM_Z,
} from '@/features/home-particle/engine/constants'
import { createStarfield } from '@/features/home-particle/engine/starfield'
import { cameraTravelAt } from '@/features/home-particle/engine/spaceMotion'
import type { QualityProfile, Starfield } from '@/features/home-particle/engine/types'

export interface UniverseStarfieldOptions {
  container: HTMLElement
  quality: QualityProfile
  reducedMotion: boolean
  onError: () => void
}

/** The shared home starfield alone: no particle engine, comet, tail or brand targets. */
export class UniverseStarfield {
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR)
  private renderer: WebGLRenderer | null = null
  private stars: Starfield | null = null
  private raf: number | null = null
  private previousTime: number | null = null
  private elapsed = 0
  private active = false
  private ready = false
  private disposed = false
  private reducedMotion: boolean

  constructor(private readonly options: UniverseStarfieldOptions) {
    this.reducedMotion = options.reducedMotion
    this.camera.position.z = DOLLY_FROM_Z
    try {
      this.renderer = new WebGLRenderer({ alpha: true, antialias: options.quality.antialias })
      this.renderer.setClearColor('#03040a', 0)
      const canvas = this.renderer.domElement
      canvas.dataset.testid = 'universe-starfield'
      canvas.style.position = 'absolute'
      canvas.style.inset = '0'
      canvas.style.display = 'block'
      canvas.addEventListener('webglcontextlost', this.onContextLost)
      options.container.appendChild(canvas)
      this.stars = createStarfield({
        count: options.quality.starCount,
        reducedMotion: this.reducedMotion,
        isLightTheme: false,
      })
      this.scene.add(this.stars.object)
      this.resize()
      this.ready = true
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  start(): void {
    if (this.disposed || this.active) return
    this.active = true
    this.previousTime = null
    if (this.reducedMotion) this.render(0)
    else this.raf = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.active = false
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.previousTime = null
  }

  setReducedMotion(value: boolean): void {
    if (this.disposed || value === this.reducedMotion) return
    const resume = this.active
    this.stop()
    this.reducedMotion = value
    this.stars?.setReducedMotion(value)
    if (resume) this.start()
  }

  resize(): void {
    if (this.disposed || !this.renderer) return
    try {
      const width = Math.max(1, this.options.container.clientWidth || window.innerWidth)
      const height = Math.max(1, this.options.container.clientHeight || window.innerHeight)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.options.quality.maxDpr))
      this.renderer.setSize(width, height)
      if (this.active && this.reducedMotion) this.render(0)
    } catch (error) {
      // During construction the caller owns the fallback; afterwards report it
      // through onError, including resize failures while the tab is paused.
      if (!this.ready) throw error
      this.fail()
    }
  }

  getStats() {
    return {
      drawCalls: this.renderer?.info.render.calls ?? 0,
      starfieldLayers: this.stars?.object.children.length ?? 0,
      starCount: this.options.quality.starCount,
      cometCount: 0,
      tailCount: 0,
      brandCount: 0,
      running: this.raf !== null,
      reducedMotion: this.reducedMotion,
      disposed: this.disposed,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.stars?.dispose()
    this.stars = null
    this.scene.clear()
    if (this.renderer) {
      const canvas = this.renderer.domElement
      canvas.removeEventListener('webglcontextlost', this.onContextLost)
      this.renderer.dispose()
      this.renderer.forceContextLoss()
      canvas.remove()
      this.renderer = null
    }
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.fail()
  }

  private fail(): void {
    if (this.disposed) return
    this.dispose()
    this.options.onError()
  }

  private render(dt: number): void {
    if (this.disposed || !this.renderer || !this.stars) return
    try {
      this.camera.position.z = DOLLY_FROM_Z + cameraTravelAt(this.elapsed)
      this.stars.update(dt, this.camera.position.z, this.elapsed)
      this.renderer.render(this.scene, this.camera)
    } catch {
      this.fail()
    }
  }

  private readonly tick = (time: number): void => {
    this.raf = null
    if (!this.active || this.disposed) return
    const dt = this.previousTime === null ? 0 : Math.min(0.05, Math.max(0, (time - this.previousTime) / 1000))
    this.previousTime = time
    this.elapsed += dt
    this.render(dt)
    if (this.active && !this.disposed) this.raf = requestAnimationFrame(this.tick)
  }
}
