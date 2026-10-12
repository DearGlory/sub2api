import { BackSide, BoxGeometry, Matrix4, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import type { CometVisualFrame, CometVisualOptions } from './cometVisualContract'
import { collapseProgress } from './cometTransition'

const vertexShader = /* glsl */ `
  uniform vec3 uHead;
  uniform float uRadius;
  varying vec3 vFrame;
  void main() {
    vFrame = uHead + position * (2.0 * uRadius);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragmentShader = /* glsl */ `
  uniform float uEventMode;
  uniform float uEventProgress;
  uniform float uEventStrength;
  uniform vec3 uHead;
  uniform float uRadius;
  uniform vec3 uCameraFrame;
  uniform float uLightTheme;
  varying vec3 vFrame;
  float hash(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
  float noise(vec3 p) {
    vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  // Fixed inclined world basis, followed by differential rotation about its normal.
  // Neither the density coordinates nor the tilt depend on a projected screen point.
  vec3 tilted(vec3 p) {
    p.xy = mat2(0.94,-0.342,0.342,0.94)*p.xy;
    p.yz = mat2(0.38,-0.92499,0.92499,0.38)*p.yz;
    return p;
  }
  void main() {
    if (uEventMode < 0.5 || uEventStrength <= 0.0) discard;
    vec3 ray = normalize(vFrame-uCameraFrame);
    vec3 origin = uCameraFrame-uHead;
    // Restrict marching to the local spherical support inside the single box.
    float b=dot(origin,ray), c=dot(origin,origin)-uRadius*uRadius;
    float discriminant=b*b-c;
    if(discriminant<=0.0) discard;
    float root=sqrt(discriminant);
    float enter=max(0.0,-b-root), leave=-b+root;
    if(leave<=enter) discard;
    float stepLength=(leave-enter)/float(MARCH_STEPS);
    float jitter=hash(floor((vFrame-uHead)*137.0));
    float opacity=0.0;
    vec3 radiance=vec3(0.0);
    float q=uEventProgress;
    for(int i=0;i<MARCH_STEPS;i++) {
      vec3 p=origin+ray*(enter+(float(i)+0.2+jitter*0.6)*stepLength);
      float r=length(p);
      float dust=0.0, dark=0.0, heat=0.0;
      if(uEventMode<1.5) {
        // Radial fissures cut through the entire front and wake. Opposed,
        // irregular pressure vents expose the rock instead of filling its centre.
        float front=0.18+6.5*(1.0-exp(-q*3.8));
        vec3 direction=p/max(r,0.001);
        float lobe=noise(direction*3.1+vec3(1.2,4.7,0.3));
        float fracture=noise(direction*5.4+vec3(4.1,0.8,2.7));
        float openings=smoothstep(0.43,0.64,fracture+0.14*(lobe-0.5));
        float vent=abs(dot(direction,normalize(vec3(0.18,-0.12,1.0))));
        openings*=1.0-smoothstep(0.38+0.18*lobe,0.78+0.12*lobe,vent);
        float wave=front*(0.62+0.55*lobe+0.12*(fracture-0.5));
        float thickness=mix(0.13,0.055,smoothstep(0.03,0.5,q));
        // Integrate sub-step sheets without widening the world-space front.
        float filtered=sqrt(thickness*thickness+stepLength*stepLength*0.16);
        float shell=exp(-pow((r-wave)/filtered,2.0))*thickness/filtered;
        float gas=noise(p*4.8-direction*q*4.5);
        float wake=exp(-pow((r-wave*0.87)/(filtered*1.4),2.0))*0.12;
        float wings=smoothstep(0.52,0.73,lobe)*smoothstep(0.40,0.7,gas);
        dust=(shell*(0.45+0.8*gas)+wake*wings)*openings*1.6;
        heat=shell*openings*smoothstep(0.63,0.85,gas)*0.55;
      } else {
        vec3 d=tilted(p);
        float radial=length(d.xy);
        float radius=uRadius*0.84;
        float inward=q*q*(2.0+q*2.5);
        float angle=atan(d.y,d.x)-inward-1.35*log(0.25+radial);
        vec2 orbit=vec2(cos(angle),sin(angle));
        // Continuous, aperiodic strata: angular noise changes both the outer
        // extent and the density. There is no repeated arm or luminous ring.
        float sector=noise(vec3(orbit*1.7,radial*0.22)+vec3(3.7,1.4,5.2));
        vec3 flow=vec3(orbit*radial,d.z);
        float eddy=noise(flow*1.65+vec3(0.7,4.2,1.8));
        float grit=noise(flow*6.2+vec3(2.3,0.4,7.1));
        float warp=radial*0.045*(sector-0.5)+0.055*(eddy-0.5);
        float height=d.z-warp;
        float thickness=0.075+radial*(0.025+0.02*sector);
        float layer=exp(-pow(height/thickness,2.0));
        float lower=exp(-pow((height+thickness*1.6)/(thickness*0.8),2.0));
        float edge=radius*(0.76+0.24*sector);
        float support=(1.0-smoothstep(edge*0.68,edge,radial))*smoothstep(0.34,0.75,radial);
        float filaments=smoothstep(0.37,0.75,eddy*0.72+grit*0.28+sector*0.12);
        dust=(layer+lower*0.38)*support*(0.65+2.2*filaments)*(0.7+0.55*grit);
        // A cooler lower stratum has actual optical thickness. Along oblique
        // rays the nearer rim absorbs the back strata before they reach the eye.
        float rim=exp(-pow((height+thickness*0.8)/(thickness*1.15),2.0));
        float core=exp(-dot(d,d)/0.19)*3.2;
        dark=core+rim*support*(0.6+0.7*eddy);
        heat=(1.0-smoothstep(0.65,1.8,radial))*smoothstep(0.56,0.79,grit)
          *smoothstep(0.42,0.68,eddy)*0.95;
      }
      float extinction=(dust+dark)*uEventStrength;
      float alpha=1.0-exp(-extinction*stepLength);
      vec3 tint=mix(vec3(0.20,0.34,0.43),vec3(0.57,0.37,0.18),heat);
      tint*=uEventMode<1.5 ? 0.28+0.72*max(0.0,dot(p/max(r,0.001),normalize(vec3(-0.5,0.7,0.6))))
        : 0.68+0.32*smoothstep(-uRadius,uRadius,p.z);
      tint=mix(tint,tint*0.32,uLightTheme);
      tint=mix(tint,vec3(0.006,0.009,0.018),dark/max(dust+dark,0.0001));
      radiance+=(1.0-opacity)*alpha*tint;
      opacity+=(1.0-opacity)*alpha;
      if(opacity>0.92) break;
    }
    if(opacity<0.001) discard;
    gl_FragColor=vec4(radiance/max(opacity,0.0001),opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

function smooth(q: number): number {
  const t = Math.max(0, Math.min(1, q))
  return t * t * (3 - 2 * t)
}

/** One bounded local volume in exactly the same SUBJECT_Z frame as the nucleus. */
export function createCometEventField(options: CometVisualOptions) {
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.deleteAttribute('normal')
  geometry.deleteAttribute('uv')
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  const material = new ShaderMaterial({
    name: 'comet-event-field', vertexShader, fragmentShader,
    defines: { MARCH_STEPS: options.particleCount <= 5000 ? 24 : 40 },
    uniforms: {
      uEventMode: { value: 0 }, uEventProgress: { value: 0 }, uEventStrength: { value: 0 },
      uHead: { value: new Vector3() }, uRadius: { value: 1 },
      uCameraFrame: { value: new Vector3() }, uLightTheme: { value: options.light ? 1 : 0 },
    },
    side: BackSide, blending: NormalBlending, transparent: true, depthWrite: false, depthTest: true,
  })
  const mesh = new Mesh(geometry, material)
  mesh.name = 'comet-event-field'
  mesh.visible = false
  const inverse = new Matrix4()
  const uniforms = material.uniforms
  let disposed = false
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const cameraFrame = uniforms.uCameraFrame!.value as Vector3
    cameraFrame.setFromMatrixPosition(camera.matrixWorld)
    if (mesh.parent) cameraFrame.applyMatrix4(inverse.copy(mesh.parent.matrixWorld).invert())
  }
  return {
    mesh,
    update(frame: CometVisualFrame) {
      if (disposed) return
      const p = Number.isFinite(frame.progress) ? Math.max(0, Math.min(1, frame.progress)) : 0
      const gather = frame.phase === 'gather'
      const collapse = frame.phase === 'scatter' && p < 0.62
      const q = gather ? p : collapse ? p / 0.62 : 0
      const strength = frame.reducedMotion ? 0 : gather
        ? smooth(q / 0.065) * (1 - smooth((q - 0.2) / 0.48))
        : collapse ? smooth(q / 0.16) * (1 - smooth((q - 0.64) / 0.36)) : 0
      const radius = gather ? 0.9 + 6.5 * (1 - Math.exp(-q * 3.8))
        : collapse ? 6.4 - 5.2 * collapseProgress(q) : 1
      mesh.position.set(frame.headX, frame.headY, frame.headZ)
      mesh.scale.setScalar(radius * 2)
      uniforms.uHead!.value.copy(mesh.position)
      uniforms.uRadius!.value = radius
      uniforms.uEventProgress!.value = q
      uniforms.uEventStrength!.value = strength
      uniforms.uEventMode!.value = strength > 0 ? gather ? 1 : 2 : 0
      uniforms.uLightTheme!.value = frame.light ? 1 : 0
      mesh.visible = strength > 0
    },
    dispose() {
      if (disposed) return
      disposed = true
      mesh.visible = false
      uniforms.uEventMode!.value = uniforms.uEventStrength!.value = 0
      geometry.dispose()
      material.dispose()
      mesh.removeFromParent()
    },
  }
}
