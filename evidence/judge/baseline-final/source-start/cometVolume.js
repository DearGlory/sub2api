import { BackSide, BoxGeometry, Matrix4, Mesh, NormalBlending, ShaderMaterial, Vector3 } from "/node_modules/.vite/deps/three.js?v=b7dcf682";
import { COMET_COMA_RADIUS } from "/src/features/home-particle/engine/cometVisualContract.ts";
import { nucleusEnvelope } from "/src/features/home-particle/engine/cometSurface.ts";
const BIN_COUNT = 20;
const vertexShader = (
  /* glsl */
  `
  uniform vec3 uCenter;
  uniform vec3 uSize;
  varying vec3 vFrame;
  void main() {
    vFrame = position * uSize + uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
);
const fragmentShader = (
  /* glsl */
  `
  uniform vec3 uCenter;
  uniform vec3 uSize;
  uniform vec3 uCameraFrame;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uLightTheme;
  uniform vec4 uBins[20];
  uniform float uDensities[20];
  varying vec3 vFrame;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float density(vec3 p) {
    float base = 0.0;
    #if IS_COMA == 1
      float radius = length((p-uCenter) / 1.53);
      base = pow(max(0.0, 1.0-radius*radius), 2.0) * 0.37;
      // The solid nucleus owns the centre, with a faint, genuinely 3D outer envelope.
      base *= smoothstep(0.38, 0.58, radius);
      vec3 q = (p-uCenter) * 3.6;
    #else
      for (int j=0; j<20; j++) {
        if (uDensities[j] > 0.00001) {
          vec3 d = (p-uBins[j].xyz) / max(uBins[j].w, 0.01);
          float support = max(0.0, 1.0-dot(d,d));
          base += support * support * uDensities[j];
        }
      }
      // World-frame density: no head-attached scrolling or screen-space sheets.
      vec3 q = p * vec3(3.1, 5.8, 4.5);
    #endif
    if (base < 0.00001) return 0.0;
    float coarse = noise(q + vec3(0.0, uTime * 0.025, 0.0));
    float fine = noise(q * 2.7 + coarse * 1.4);
    float filament = smoothstep(0.24, 0.8, coarse * 0.7 + fine * 0.3);
    return base * (0.12 + filament * 1.35);
  }
  void main() {
    vec3 ray = normalize(vFrame-uCameraFrame);
    // Safe slab intersection; march only the projected local proxy, never the viewport.
    vec3 invRay = 1.0 / (sign(ray + vec3(0.0000001)) * max(abs(ray), vec3(0.000001)));
    vec3 lo = (uCenter-uSize*0.5-uCameraFrame)*invRay;
    vec3 hi = (uCenter+uSize*0.5-uCameraFrame)*invRay;
    vec3 nearT = min(lo,hi), farT = max(lo,hi);
    float enter = max(0.0, max(nearT.x,max(nearT.y,nearT.z)));
    float leave = min(farT.x,min(farT.y,farT.z));
    if (leave <= enter) discard;
    float stepLength = (leave-enter)/float(MARCH_STEPS);
    float jitter = hash(floor(vFrame*173.0));
    float opacity = 0.0;
    vec3 light = vec3(0.0);
    for (int i=0; i<MARCH_STEPS; i++) {
      vec3 p = uCameraFrame + ray * (enter + (float(i)+0.25+0.5*jitter)*stepLength);
      float d = density(p);
      float alpha = 1.0-exp(-d * stepLength * uOpacity * 1.45);
      float ion = noise(p*2.4+7.0);
      vec3 tint = mix(vec3(0.36,0.39,0.43), vec3(0.43,0.58,0.69), smoothstep(0.38,0.72,ion));
      tint = mix(tint, vec3(0.44,0.38,0.31), smoothstep(0.66,0.85,ion)*0.35);
      tint = mix(tint, tint*0.57, uLightTheme);
      light += (1.0-opacity)*alpha*tint;
      opacity += (1.0-opacity)*alpha;
      if (opacity > 0.66) break;
    }
    if (opacity < 0.001) discard;
    gl_FragColor = vec4(light / max(opacity,0.0001), min(opacity,0.66));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`
);
function proxy(name, coma, steps, options, bins, densities) {
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  const material = new ShaderMaterial({
    name,
    vertexShader,
    fragmentShader,
    defines: { IS_COMA: coma ? 1 : 0, MARCH_STEPS: steps },
    uniforms: {
      uCenter: { value: new Vector3() },
      uSize: { value: new Vector3(1, 1, 1) },
      uCameraFrame: { value: new Vector3() },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uLightTheme: { value: options.light ? 1 : 0 },
      uBins: { value: bins },
      uDensities: { value: densities }
    },
    side: BackSide,
    blending: NormalBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.visible = false;
  const inverse = new Matrix4();
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const cameraFrame = material.uniforms.uCameraFrame.value;
    cameraFrame.setFromMatrixPosition(camera.matrixWorld);
    if (mesh.parent) cameraFrame.applyMatrix4(inverse.copy(mesh.parent.matrixWorld).invert());
  };
  return mesh;
}
export function createCometVolume(options) {
  const bins = new Float32Array(BIN_COUNT * 4);
  const densities = new Float32Array(BIN_COUNT);
  const mass = new Float64Array(BIN_COUNT);
  const means = new Float64Array(BIN_COUNT * 3);
  const variance = new Float64Array(BIN_COUNT);
  const ages = new Float64Array(BIN_COUNT);
  const samples = new Uint32Array(BIN_COUNT);
  const steps = options.particleCount <= 1200 ? 16 : 28;
  const coma = proxy("comet-coma-volume", true, steps, options, bins, densities);
  const tail = proxy("comet-tail-volume", false, steps, options, bins, densities);
  const comaUniforms = coma.material.uniforms;
  const tailUniforms = tail.material.uniforms;
  const expectedPerBin = Math.max(12, options.particleCount / BIN_COUNT * 0.55);
  let noiseTime = 0;
  return {
    coma,
    tail,
    update(frame, pool) {
      const envelope = nucleusEnvelope(frame);
      coma.visible = envelope > 0;
      coma.position.set(frame.headX, frame.headY, frame.headZ);
      coma.scale.setScalar(COMET_COMA_RADIUS * 2);
      comaUniforms.uCenter.value.copy(coma.position);
      comaUniforms.uSize.value.copy(coma.scale);
      comaUniforms.uOpacity.value = envelope * 0.72;
      if (!frame.reducedMotion) noiseTime = frame.time;
      comaUniforms.uTime.value = tailUniforms.uTime.value = noiseTime;
      comaUniforms.uLightTheme.value = tailUniforms.uLightTheme.value = frame.light ? 1 : 0;
      mass.fill(0);
      means.fill(0);
      variance.fill(0);
      ages.fill(0);
      samples.fill(0);
      bins.fill(0);
      densities.fill(0);
      for (let i = 0; i < pool.count; i++) {
        if (pool.active[i] !== 1 || !Number.isFinite(pool.birthTime[i]) || pool.birthTime[i] < 0) continue;
        const age = pool.age[i], life = pool.life[i];
        if (!Number.isFinite(age) || !Number.isFinite(life) || life <= 0 || age <= 0 || age >= life) continue;
        const k = i * 3;
        const x = pool.positions[k], y = pool.positions[k + 1], z = pool.positions[k + 2];
        if (!Number.isFinite(x + y + z)) continue;
        const b = Math.min(BIN_COUNT - 1, Math.floor(age / 3.2 * BIN_COUNT));
        const m = b * 3;
        const weight = Math.pow(1 - age / life, 1.7) * Math.min(1, age / 0.035);
        const nextMass = mass[b] + weight;
        const dx = x - means[m], dy = y - means[m + 1], dz = z - means[m + 2];
        means[m] += dx * weight / nextMass;
        means[m + 1] += dy * weight / nextMass;
        means[m + 2] += dz * weight / nextMass;
        variance[b] += weight * (dx * (x - means[m]) + dy * (y - means[m + 1]) + dz * (z - means[m + 2]));
        mass[b] = nextMass;
        ages[b] += age * weight;
        samples[b]++;
      }
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let b = 0; b < BIN_COUNT; b++) {
        if (mass[b] <= 0) continue;
        const m = b * 3, k = b * 4;
        const radius = Math.min(2.8, 0.22 + ages[b] / mass[b] * 0.18 + 2.1 * Math.sqrt(Math.max(0, variance[b] / mass[b])));
        const x = means[m], y = means[m + 1], z = means[m + 2];
        bins[k] = x;
        bins[k + 1] = y;
        bins[k + 2] = z;
        bins[k + 3] = radius;
        densities[b] = Math.min(1, mass[b] / expectedPerBin) * Math.min(1, samples[b] / 8) * 0.92;
        minX = Math.min(minX, x - radius);
        maxX = Math.max(maxX, x + radius);
        minY = Math.min(minY, y - radius);
        maxY = Math.max(maxY, y + radius);
        minZ = Math.min(minZ, z - radius);
        maxZ = Math.max(maxZ, z + radius);
      }
      tail.visible = minX < Infinity;
      if (tail.visible) {
        tail.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        tail.scale.set(maxX - minX, maxY - minY, maxZ - minZ);
        tailUniforms.uCenter.value.copy(tail.position);
        tailUniforms.uSize.value.copy(tail.scale);
      }
    },
    dispose() {
      coma.geometry.dispose();
      coma.material.dispose();
      tail.geometry.dispose();
      tail.material.dispose();
    }
  };
}

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNvbWV0Vm9sdW1lLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEJhY2tTaWRlLCBCb3hHZW9tZXRyeSwgTWF0cml4NCwgTWVzaCwgTm9ybWFsQmxlbmRpbmcsIFNoYWRlck1hdGVyaWFsLCBWZWN0b3IzIH0gZnJvbSAndGhyZWUnXG5pbXBvcnQgeyBDT01FVF9DT01BX1JBRElVUyB9IGZyb20gJy4vY29tZXRWaXN1YWxDb250cmFjdCdcbmltcG9ydCB0eXBlIHsgQ29tZXRUYWlsVmlldywgQ29tZXRWaXN1YWxGcmFtZSwgQ29tZXRWaXN1YWxPcHRpb25zIH0gZnJvbSAnLi9jb21ldFZpc3VhbENvbnRyYWN0J1xuaW1wb3J0IHsgbnVjbGV1c0VudmVsb3BlIH0gZnJvbSAnLi9jb21ldFN1cmZhY2UnXG5cbmNvbnN0IEJJTl9DT1VOVCA9IDIwXG5jb25zdCB2ZXJ0ZXhTaGFkZXIgPSAvKiBnbHNsICovIGBcbiAgdW5pZm9ybSB2ZWMzIHVDZW50ZXI7XG4gIHVuaWZvcm0gdmVjMyB1U2l6ZTtcbiAgdmFyeWluZyB2ZWMzIHZGcmFtZTtcbiAgdm9pZCBtYWluKCkge1xuICAgIHZGcmFtZSA9IHBvc2l0aW9uICogdVNpemUgKyB1Q2VudGVyO1xuICAgIGdsX1Bvc2l0aW9uID0gcHJvamVjdGlvbk1hdHJpeCAqIG1vZGVsVmlld01hdHJpeCAqIHZlYzQocG9zaXRpb24sIDEuMCk7XG4gIH1cbmBcbmNvbnN0IGZyYWdtZW50U2hhZGVyID0gLyogZ2xzbCAqLyBgXG4gIHVuaWZvcm0gdmVjMyB1Q2VudGVyO1xuICB1bmlmb3JtIHZlYzMgdVNpemU7XG4gIHVuaWZvcm0gdmVjMyB1Q2FtZXJhRnJhbWU7XG4gIHVuaWZvcm0gZmxvYXQgdU9wYWNpdHk7XG4gIHVuaWZvcm0gZmxvYXQgdVRpbWU7XG4gIHVuaWZvcm0gZmxvYXQgdUxpZ2h0VGhlbWU7XG4gIHVuaWZvcm0gdmVjNCB1Qmluc1syMF07XG4gIHVuaWZvcm0gZmxvYXQgdURlbnNpdGllc1syMF07XG4gIHZhcnlpbmcgdmVjMyB2RnJhbWU7XG4gIGZsb2F0IGhhc2godmVjMyBwKSB7IHJldHVybiBmcmFjdChzaW4oZG90KHAsIHZlYzMoMTI3LjEsMzExLjcsNzQuNykpKSAqIDQzNzU4LjU0NTMpOyB9XG4gIGZsb2F0IG5vaXNlKHZlYzMgcCkge1xuICAgIHZlYzMgaT1mbG9vcihwKSwgZj1mcmFjdChwKTsgZj1mKmYqKDMuMC0yLjAqZik7XG4gICAgcmV0dXJuIG1peChtaXgobWl4KGhhc2goaSksaGFzaChpK3ZlYzMoMSwwLDApKSxmLngpLG1peChoYXNoKGkrdmVjMygwLDEsMCkpLGhhc2goaSt2ZWMzKDEsMSwwKSksZi54KSxmLnkpLFxuICAgICAgbWl4KG1peChoYXNoKGkrdmVjMygwLDAsMSkpLGhhc2goaSt2ZWMzKDEsMCwxKSksZi54KSxtaXgoaGFzaChpK3ZlYzMoMCwxLDEpKSxoYXNoKGkrdmVjMygxLDEsMSkpLGYueCksZi55KSxmLnopO1xuICB9XG4gIGZsb2F0IGRlbnNpdHkodmVjMyBwKSB7XG4gICAgZmxvYXQgYmFzZSA9IDAuMDtcbiAgICAjaWYgSVNfQ09NQSA9PSAxXG4gICAgICBmbG9hdCByYWRpdXMgPSBsZW5ndGgoKHAtdUNlbnRlcikgLyAxLjUzKTtcbiAgICAgIGJhc2UgPSBwb3cobWF4KDAuMCwgMS4wLXJhZGl1cypyYWRpdXMpLCAyLjApICogMC4zNztcbiAgICAgIC8vIFRoZSBzb2xpZCBudWNsZXVzIG93bnMgdGhlIGNlbnRyZSwgd2l0aCBhIGZhaW50LCBnZW51aW5lbHkgM0Qgb3V0ZXIgZW52ZWxvcGUuXG4gICAgICBiYXNlICo9IHNtb290aHN0ZXAoMC4zOCwgMC41OCwgcmFkaXVzKTtcbiAgICAgIHZlYzMgcSA9IChwLXVDZW50ZXIpICogMy42O1xuICAgICNlbHNlXG4gICAgICBmb3IgKGludCBqPTA7IGo8MjA7IGorKykge1xuICAgICAgICBpZiAodURlbnNpdGllc1tqXSA+IDAuMDAwMDEpIHtcbiAgICAgICAgICB2ZWMzIGQgPSAocC11Qmluc1tqXS54eXopIC8gbWF4KHVCaW5zW2pdLncsIDAuMDEpO1xuICAgICAgICAgIGZsb2F0IHN1cHBvcnQgPSBtYXgoMC4wLCAxLjAtZG90KGQsZCkpO1xuICAgICAgICAgIGJhc2UgKz0gc3VwcG9ydCAqIHN1cHBvcnQgKiB1RGVuc2l0aWVzW2pdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBXb3JsZC1mcmFtZSBkZW5zaXR5OiBubyBoZWFkLWF0dGFjaGVkIHNjcm9sbGluZyBvciBzY3JlZW4tc3BhY2Ugc2hlZXRzLlxuICAgICAgdmVjMyBxID0gcCAqIHZlYzMoMy4xLCA1LjgsIDQuNSk7XG4gICAgI2VuZGlmXG4gICAgaWYgKGJhc2UgPCAwLjAwMDAxKSByZXR1cm4gMC4wO1xuICAgIGZsb2F0IGNvYXJzZSA9IG5vaXNlKHEgKyB2ZWMzKDAuMCwgdVRpbWUgKiAwLjAyNSwgMC4wKSk7XG4gICAgZmxvYXQgZmluZSA9IG5vaXNlKHEgKiAyLjcgKyBjb2Fyc2UgKiAxLjQpO1xuICAgIGZsb2F0IGZpbGFtZW50ID0gc21vb3Roc3RlcCgwLjI0LCAwLjgsIGNvYXJzZSAqIDAuNyArIGZpbmUgKiAwLjMpO1xuICAgIHJldHVybiBiYXNlICogKDAuMTIgKyBmaWxhbWVudCAqIDEuMzUpO1xuICB9XG4gIHZvaWQgbWFpbigpIHtcbiAgICB2ZWMzIHJheSA9IG5vcm1hbGl6ZSh2RnJhbWUtdUNhbWVyYUZyYW1lKTtcbiAgICAvLyBTYWZlIHNsYWIgaW50ZXJzZWN0aW9uOyBtYXJjaCBvbmx5IHRoZSBwcm9qZWN0ZWQgbG9jYWwgcHJveHksIG5ldmVyIHRoZSB2aWV3cG9ydC5cbiAgICB2ZWMzIGludlJheSA9IDEuMCAvIChzaWduKHJheSArIHZlYzMoMC4wMDAwMDAxKSkgKiBtYXgoYWJzKHJheSksIHZlYzMoMC4wMDAwMDEpKSk7XG4gICAgdmVjMyBsbyA9ICh1Q2VudGVyLXVTaXplKjAuNS11Q2FtZXJhRnJhbWUpKmludlJheTtcbiAgICB2ZWMzIGhpID0gKHVDZW50ZXIrdVNpemUqMC41LXVDYW1lcmFGcmFtZSkqaW52UmF5O1xuICAgIHZlYzMgbmVhclQgPSBtaW4obG8saGkpLCBmYXJUID0gbWF4KGxvLGhpKTtcbiAgICBmbG9hdCBlbnRlciA9IG1heCgwLjAsIG1heChuZWFyVC54LG1heChuZWFyVC55LG5lYXJULnopKSk7XG4gICAgZmxvYXQgbGVhdmUgPSBtaW4oZmFyVC54LG1pbihmYXJULnksZmFyVC56KSk7XG4gICAgaWYgKGxlYXZlIDw9IGVudGVyKSBkaXNjYXJkO1xuICAgIGZsb2F0IHN0ZXBMZW5ndGggPSAobGVhdmUtZW50ZXIpL2Zsb2F0KE1BUkNIX1NURVBTKTtcbiAgICBmbG9hdCBqaXR0ZXIgPSBoYXNoKGZsb29yKHZGcmFtZSoxNzMuMCkpO1xuICAgIGZsb2F0IG9wYWNpdHkgPSAwLjA7XG4gICAgdmVjMyBsaWdodCA9IHZlYzMoMC4wKTtcbiAgICBmb3IgKGludCBpPTA7IGk8TUFSQ0hfU1RFUFM7IGkrKykge1xuICAgICAgdmVjMyBwID0gdUNhbWVyYUZyYW1lICsgcmF5ICogKGVudGVyICsgKGZsb2F0KGkpKzAuMjUrMC41KmppdHRlcikqc3RlcExlbmd0aCk7XG4gICAgICBmbG9hdCBkID0gZGVuc2l0eShwKTtcbiAgICAgIGZsb2F0IGFscGhhID0gMS4wLWV4cCgtZCAqIHN0ZXBMZW5ndGggKiB1T3BhY2l0eSAqIDEuNDUpO1xuICAgICAgZmxvYXQgaW9uID0gbm9pc2UocCoyLjQrNy4wKTtcbiAgICAgIHZlYzMgdGludCA9IG1peCh2ZWMzKDAuMzYsMC4zOSwwLjQzKSwgdmVjMygwLjQzLDAuNTgsMC42OSksIHNtb290aHN0ZXAoMC4zOCwwLjcyLGlvbikpO1xuICAgICAgdGludCA9IG1peCh0aW50LCB2ZWMzKDAuNDQsMC4zOCwwLjMxKSwgc21vb3Roc3RlcCgwLjY2LDAuODUsaW9uKSowLjM1KTtcbiAgICAgIHRpbnQgPSBtaXgodGludCwgdGludCowLjU3LCB1TGlnaHRUaGVtZSk7XG4gICAgICBsaWdodCArPSAoMS4wLW9wYWNpdHkpKmFscGhhKnRpbnQ7XG4gICAgICBvcGFjaXR5ICs9ICgxLjAtb3BhY2l0eSkqYWxwaGE7XG4gICAgICBpZiAob3BhY2l0eSA+IDAuNjYpIGJyZWFrO1xuICAgIH1cbiAgICBpZiAob3BhY2l0eSA8IDAuMDAxKSBkaXNjYXJkO1xuICAgIGdsX0ZyYWdDb2xvciA9IHZlYzQobGlnaHQgLyBtYXgob3BhY2l0eSwwLjAwMDEpLCBtaW4ob3BhY2l0eSwwLjY2KSk7XG4gICAgI2luY2x1ZGUgPHRvbmVtYXBwaW5nX2ZyYWdtZW50PlxuICAgICNpbmNsdWRlIDxjb2xvcnNwYWNlX2ZyYWdtZW50PlxuICB9XG5gXG5cbmZ1bmN0aW9uIHByb3h5KG5hbWU6IHN0cmluZywgY29tYTogYm9vbGVhbiwgc3RlcHM6IG51bWJlciwgb3B0aW9uczogQ29tZXRWaXN1YWxPcHRpb25zLFxuICBiaW5zOiBGbG9hdDMyQXJyYXksIGRlbnNpdGllczogRmxvYXQzMkFycmF5KSB7XG4gIGNvbnN0IGdlb21ldHJ5ID0gbmV3IEJveEdlb21ldHJ5KDEsIDEsIDEpXG4gIGdlb21ldHJ5LmRlbGV0ZUF0dHJpYnV0ZSgnbm9ybWFsJylcbiAgZ2VvbWV0cnkuZGVsZXRlQXR0cmlidXRlKCd1dicpXG4gIGNvbnN0IG1hdGVyaWFsID0gbmV3IFNoYWRlck1hdGVyaWFsKHtcbiAgICBuYW1lLCB2ZXJ0ZXhTaGFkZXIsIGZyYWdtZW50U2hhZGVyLCBkZWZpbmVzOiB7IElTX0NPTUE6IGNvbWEgPyAxIDogMCwgTUFSQ0hfU1RFUFM6IHN0ZXBzIH0sXG4gICAgdW5pZm9ybXM6IHtcbiAgICAgIHVDZW50ZXI6IHsgdmFsdWU6IG5ldyBWZWN0b3IzKCkgfSwgdVNpemU6IHsgdmFsdWU6IG5ldyBWZWN0b3IzKDEsIDEsIDEpIH0sXG4gICAgICB1Q2FtZXJhRnJhbWU6IHsgdmFsdWU6IG5ldyBWZWN0b3IzKCkgfSwgdU9wYWNpdHk6IHsgdmFsdWU6IDEgfSwgdVRpbWU6IHsgdmFsdWU6IDAgfSxcbiAgICAgIHVMaWdodFRoZW1lOiB7IHZhbHVlOiBvcHRpb25zLmxpZ2h0ID8gMSA6IDAgfSwgdUJpbnM6IHsgdmFsdWU6IGJpbnMgfSwgdURlbnNpdGllczogeyB2YWx1ZTogZGVuc2l0aWVzIH0sXG4gICAgfSxcbiAgICBzaWRlOiBCYWNrU2lkZSwgYmxlbmRpbmc6IE5vcm1hbEJsZW5kaW5nLCB0cmFuc3BhcmVudDogdHJ1ZSwgZGVwdGhXcml0ZTogZmFsc2UsIGRlcHRoVGVzdDogdHJ1ZSxcbiAgfSlcbiAgY29uc3QgbWVzaCA9IG5ldyBNZXNoKGdlb21ldHJ5LCBtYXRlcmlhbClcbiAgbWVzaC5uYW1lID0gbmFtZVxuICBtZXNoLnZpc2libGUgPSBmYWxzZVxuICBjb25zdCBpbnZlcnNlID0gbmV3IE1hdHJpeDQoKVxuICBtZXNoLm9uQmVmb3JlUmVuZGVyID0gKF9yZW5kZXJlciwgX3NjZW5lLCBjYW1lcmEpID0+IHtcbiAgICBjb25zdCBjYW1lcmFGcmFtZSA9IG1hdGVyaWFsLnVuaWZvcm1zLnVDYW1lcmFGcmFtZSEudmFsdWUgYXMgVmVjdG9yM1xuICAgIGNhbWVyYUZyYW1lLnNldEZyb21NYXRyaXhQb3NpdGlvbihjYW1lcmEubWF0cml4V29ybGQpXG4gICAgaWYgKG1lc2gucGFyZW50KSBjYW1lcmFGcmFtZS5hcHBseU1hdHJpeDQoaW52ZXJzZS5jb3B5KG1lc2gucGFyZW50Lm1hdHJpeFdvcmxkKS5pbnZlcnQoKSlcbiAgfVxuICByZXR1cm4gbWVzaFxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQ29tZXRWb2x1bWUob3B0aW9uczogQ29tZXRWaXN1YWxPcHRpb25zKSB7XG4gIGNvbnN0IGJpbnMgPSBuZXcgRmxvYXQzMkFycmF5KEJJTl9DT1VOVCAqIDQpXG4gIGNvbnN0IGRlbnNpdGllcyA9IG5ldyBGbG9hdDMyQXJyYXkoQklOX0NPVU5UKVxuICBjb25zdCBtYXNzID0gbmV3IEZsb2F0NjRBcnJheShCSU5fQ09VTlQpXG4gIGNvbnN0IG1lYW5zID0gbmV3IEZsb2F0NjRBcnJheShCSU5fQ09VTlQgKiAzKVxuICBjb25zdCB2YXJpYW5jZSA9IG5ldyBGbG9hdDY0QXJyYXkoQklOX0NPVU5UKVxuICBjb25zdCBhZ2VzID0gbmV3IEZsb2F0NjRBcnJheShCSU5fQ09VTlQpXG4gIGNvbnN0IHNhbXBsZXMgPSBuZXcgVWludDMyQXJyYXkoQklOX0NPVU5UKVxuICBjb25zdCBzdGVwcyA9IG9wdGlvbnMucGFydGljbGVDb3VudCA8PSAxMjAwID8gMTYgOiAyOFxuICBjb25zdCBjb21hID0gcHJveHkoJ2NvbWV0LWNvbWEtdm9sdW1lJywgdHJ1ZSwgc3RlcHMsIG9wdGlvbnMsIGJpbnMsIGRlbnNpdGllcylcbiAgY29uc3QgdGFpbCA9IHByb3h5KCdjb21ldC10YWlsLXZvbHVtZScsIGZhbHNlLCBzdGVwcywgb3B0aW9ucywgYmlucywgZGVuc2l0aWVzKVxuICBjb25zdCBjb21hVW5pZm9ybXMgPSBjb21hLm1hdGVyaWFsLnVuaWZvcm1zXG4gIGNvbnN0IHRhaWxVbmlmb3JtcyA9IHRhaWwubWF0ZXJpYWwudW5pZm9ybXNcbiAgY29uc3QgZXhwZWN0ZWRQZXJCaW4gPSBNYXRoLm1heCgxMiwgb3B0aW9ucy5wYXJ0aWNsZUNvdW50IC8gQklOX0NPVU5UICogMC41NSlcbiAgbGV0IG5vaXNlVGltZSA9IDBcbiAgcmV0dXJuIHtcbiAgICBjb21hLCB0YWlsLFxuICAgIHVwZGF0ZShmcmFtZTogQ29tZXRWaXN1YWxGcmFtZSwgcG9vbDogQ29tZXRUYWlsVmlldykge1xuICAgICAgY29uc3QgZW52ZWxvcGUgPSBudWNsZXVzRW52ZWxvcGUoZnJhbWUpXG4gICAgICBjb21hLnZpc2libGUgPSBlbnZlbG9wZSA+IDBcbiAgICAgIGNvbWEucG9zaXRpb24uc2V0KGZyYW1lLmhlYWRYLCBmcmFtZS5oZWFkWSwgZnJhbWUuaGVhZFopXG4gICAgICBjb21hLnNjYWxlLnNldFNjYWxhcihDT01FVF9DT01BX1JBRElVUyAqIDIpXG4gICAgICBjb21hVW5pZm9ybXMudUNlbnRlciEudmFsdWUuY29weShjb21hLnBvc2l0aW9uKVxuICAgICAgY29tYVVuaWZvcm1zLnVTaXplIS52YWx1ZS5jb3B5KGNvbWEuc2NhbGUpXG4gICAgICBjb21hVW5pZm9ybXMudU9wYWNpdHkhLnZhbHVlID0gZW52ZWxvcGUgKiAwLjcyXG4gICAgICBpZiAoIWZyYW1lLnJlZHVjZWRNb3Rpb24pIG5vaXNlVGltZSA9IGZyYW1lLnRpbWVcbiAgICAgIGNvbWFVbmlmb3Jtcy51VGltZSEudmFsdWUgPSB0YWlsVW5pZm9ybXMudVRpbWUhLnZhbHVlID0gbm9pc2VUaW1lXG4gICAgICBjb21hVW5pZm9ybXMudUxpZ2h0VGhlbWUhLnZhbHVlID0gdGFpbFVuaWZvcm1zLnVMaWdodFRoZW1lIS52YWx1ZSA9IGZyYW1lLmxpZ2h0ID8gMSA6IDBcbiAgICAgIG1hc3MuZmlsbCgwKTsgbWVhbnMuZmlsbCgwKTsgdmFyaWFuY2UuZmlsbCgwKTsgYWdlcy5maWxsKDApOyBzYW1wbGVzLmZpbGwoMClcbiAgICAgIGJpbnMuZmlsbCgwKTsgZGVuc2l0aWVzLmZpbGwoMClcbiAgICAgIC8vIE9uZSBsaW5lYXIgcG9vbCBzY2FuLCB3ZWlnaHRlZCBXZWxmb3JkIHZhcmlhbmNlIGF2b2lkcyBjYW5jZWxsYXRpb24gYXQgZGVlcCBjaHJvbm9sb2d5IFouXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHBvb2wuY291bnQ7IGkrKykge1xuICAgICAgICBpZiAocG9vbC5hY3RpdmVbaV0gIT09IDEgfHwgIU51bWJlci5pc0Zpbml0ZShwb29sLmJpcnRoVGltZVtpXSkgfHwgcG9vbC5iaXJ0aFRpbWVbaV0hIDwgMCkgY29udGludWVcbiAgICAgICAgY29uc3QgYWdlID0gcG9vbC5hZ2VbaV0hLCBsaWZlID0gcG9vbC5saWZlW2ldIVxuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShhZ2UpIHx8ICFOdW1iZXIuaXNGaW5pdGUobGlmZSkgfHwgbGlmZSA8PSAwIHx8IGFnZSA8PSAwIHx8IGFnZSA+PSBsaWZlKSBjb250aW51ZVxuICAgICAgICBjb25zdCBrID0gaSAqIDNcbiAgICAgICAgY29uc3QgeCA9IHBvb2wucG9zaXRpb25zW2tdISwgeSA9IHBvb2wucG9zaXRpb25zW2sgKyAxXSEsIHogPSBwb29sLnBvc2l0aW9uc1trICsgMl0hXG4gICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHggKyB5ICsgeikpIGNvbnRpbnVlXG4gICAgICAgIGNvbnN0IGIgPSBNYXRoLm1pbihCSU5fQ09VTlQgLSAxLCBNYXRoLmZsb29yKGFnZSAvIDMuMiAqIEJJTl9DT1VOVCkpXG4gICAgICAgIGNvbnN0IG0gPSBiICogM1xuICAgICAgICBjb25zdCB3ZWlnaHQgPSBNYXRoLnBvdygxIC0gYWdlIC8gbGlmZSwgMS43KSAqIE1hdGgubWluKDEsIGFnZSAvIDAuMDM1KVxuICAgICAgICBjb25zdCBuZXh0TWFzcyA9IG1hc3NbYl0hICsgd2VpZ2h0XG4gICAgICAgIGNvbnN0IGR4ID0geCAtIG1lYW5zW21dISwgZHkgPSB5IC0gbWVhbnNbbSArIDFdISwgZHogPSB6IC0gbWVhbnNbbSArIDJdIVxuICAgICAgICBtZWFuc1ttXSArPSBkeCAqIHdlaWdodCAvIG5leHRNYXNzXG4gICAgICAgIG1lYW5zW20gKyAxXSArPSBkeSAqIHdlaWdodCAvIG5leHRNYXNzXG4gICAgICAgIG1lYW5zW20gKyAyXSArPSBkeiAqIHdlaWdodCAvIG5leHRNYXNzXG4gICAgICAgIHZhcmlhbmNlW2JdICs9IHdlaWdodCAqIChkeCAqICh4IC0gbWVhbnNbbV0hKSArIGR5ICogKHkgLSBtZWFuc1ttICsgMV0hKSArIGR6ICogKHogLSBtZWFuc1ttICsgMl0hKSlcbiAgICAgICAgbWFzc1tiXSA9IG5leHRNYXNzXG4gICAgICAgIGFnZXNbYl0gKz0gYWdlICogd2VpZ2h0XG4gICAgICAgIHNhbXBsZXNbYl0rK1xuICAgICAgfVxuICAgICAgbGV0IG1pblggPSBJbmZpbml0eSwgbWluWSA9IEluZmluaXR5LCBtaW5aID0gSW5maW5pdHlcbiAgICAgIGxldCBtYXhYID0gLUluZmluaXR5LCBtYXhZID0gLUluZmluaXR5LCBtYXhaID0gLUluZmluaXR5XG4gICAgICBmb3IgKGxldCBiID0gMDsgYiA8IEJJTl9DT1VOVDsgYisrKSB7XG4gICAgICAgIGlmIChtYXNzW2JdISA8PSAwKSBjb250aW51ZVxuICAgICAgICBjb25zdCBtID0gYiAqIDMsIGsgPSBiICogNFxuICAgICAgICBjb25zdCByYWRpdXMgPSBNYXRoLm1pbigyLjgsIDAuMjIgKyBhZ2VzW2JdISAvIG1hc3NbYl0hICogMC4xOCArIDIuMSAqIE1hdGguc3FydChNYXRoLm1heCgwLCB2YXJpYW5jZVtiXSEgLyBtYXNzW2JdISkpKVxuICAgICAgICBjb25zdCB4ID0gbWVhbnNbbV0hLCB5ID0gbWVhbnNbbSArIDFdISwgeiA9IG1lYW5zW20gKyAyXSFcbiAgICAgICAgYmluc1trXSA9IHg7IGJpbnNbayArIDFdID0geTsgYmluc1trICsgMl0gPSB6OyBiaW5zW2sgKyAzXSA9IHJhZGl1c1xuICAgICAgICAvLyBCb3RoIHNhbXBsZSBjb3VudCBhbmQgc3Vydml2aW5nIG1hc3MgbWF0dGVyOiBhIGxvbmUgc3Vydml2b3IgY2Fubm90IGluZmxhdGUgYSBsdW1pbm91cyBjb25lLlxuICAgICAgICBkZW5zaXRpZXNbYl0gPSBNYXRoLm1pbigxLCBtYXNzW2JdISAvIGV4cGVjdGVkUGVyQmluKSAqIE1hdGgubWluKDEsIHNhbXBsZXNbYl0hIC8gOCkgKiAwLjkyXG4gICAgICAgIG1pblggPSBNYXRoLm1pbihtaW5YLCB4IC0gcmFkaXVzKTsgbWF4WCA9IE1hdGgubWF4KG1heFgsIHggKyByYWRpdXMpXG4gICAgICAgIG1pblkgPSBNYXRoLm1pbihtaW5ZLCB5IC0gcmFkaXVzKTsgbWF4WSA9IE1hdGgubWF4KG1heFksIHkgKyByYWRpdXMpXG4gICAgICAgIG1pblogPSBNYXRoLm1pbihtaW5aLCB6IC0gcmFkaXVzKTsgbWF4WiA9IE1hdGgubWF4KG1heFosIHogKyByYWRpdXMpXG4gICAgICB9XG4gICAgICB0YWlsLnZpc2libGUgPSBtaW5YIDwgSW5maW5pdHlcbiAgICAgIGlmICh0YWlsLnZpc2libGUpIHtcbiAgICAgICAgdGFpbC5wb3NpdGlvbi5zZXQoKG1pblggKyBtYXhYKSAvIDIsIChtaW5ZICsgbWF4WSkgLyAyLCAobWluWiArIG1heFopIC8gMilcbiAgICAgICAgdGFpbC5zY2FsZS5zZXQobWF4WCAtIG1pblgsIG1heFkgLSBtaW5ZLCBtYXhaIC0gbWluWilcbiAgICAgICAgdGFpbFVuaWZvcm1zLnVDZW50ZXIhLnZhbHVlLmNvcHkodGFpbC5wb3NpdGlvbilcbiAgICAgICAgdGFpbFVuaWZvcm1zLnVTaXplIS52YWx1ZS5jb3B5KHRhaWwuc2NhbGUpXG4gICAgICB9XG4gICAgfSxcbiAgICBkaXNwb3NlKCkge1xuICAgICAgY29tYS5nZW9tZXRyeS5kaXNwb3NlKCk7IGNvbWEubWF0ZXJpYWwuZGlzcG9zZSgpXG4gICAgICB0YWlsLmdlb21ldHJ5LmRpc3Bvc2UoKTsgdGFpbC5tYXRlcmlhbC5kaXNwb3NlKClcbiAgICB9LFxuICB9XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLFNBQVMsVUFBVSxhQUFhLFNBQVMsTUFBTSxnQkFBZ0IsZ0JBQWdCLGVBQWU7QUFDOUYsU0FBUyx5QkFBeUI7QUFFbEMsU0FBUyx1QkFBdUI7QUFFaEMsTUFBTSxZQUFZO0FBQ2xCLE1BQU07QUFBQTtBQUFBLEVBQTBCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU2hDLE1BQU07QUFBQTtBQUFBLEVBQTRCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUEwRWxDLFNBQVMsTUFBTSxNQUFjLE1BQWUsT0FBZSxTQUN6RCxNQUFvQixXQUF5QjtBQUM3QyxRQUFNLFdBQVcsSUFBSSxZQUFZLEdBQUcsR0FBRyxDQUFDO0FBQ3hDLFdBQVMsZ0JBQWdCLFFBQVE7QUFDakMsV0FBUyxnQkFBZ0IsSUFBSTtBQUM3QixRQUFNLFdBQVcsSUFBSSxlQUFlO0FBQUEsSUFDbEM7QUFBQSxJQUFNO0FBQUEsSUFBYztBQUFBLElBQWdCLFNBQVMsRUFBRSxTQUFTLE9BQU8sSUFBSSxHQUFHLGFBQWEsTUFBTTtBQUFBLElBQ3pGLFVBQVU7QUFBQSxNQUNSLFNBQVMsRUFBRSxPQUFPLElBQUksUUFBUSxFQUFFO0FBQUEsTUFBRyxPQUFPLEVBQUUsT0FBTyxJQUFJLFFBQVEsR0FBRyxHQUFHLENBQUMsRUFBRTtBQUFBLE1BQ3hFLGNBQWMsRUFBRSxPQUFPLElBQUksUUFBUSxFQUFFO0FBQUEsTUFBRyxVQUFVLEVBQUUsT0FBTyxFQUFFO0FBQUEsTUFBRyxPQUFPLEVBQUUsT0FBTyxFQUFFO0FBQUEsTUFDbEYsYUFBYSxFQUFFLE9BQU8sUUFBUSxRQUFRLElBQUksRUFBRTtBQUFBLE1BQUcsT0FBTyxFQUFFLE9BQU8sS0FBSztBQUFBLE1BQUcsWUFBWSxFQUFFLE9BQU8sVUFBVTtBQUFBLElBQ3hHO0FBQUEsSUFDQSxNQUFNO0FBQUEsSUFBVSxVQUFVO0FBQUEsSUFBZ0IsYUFBYTtBQUFBLElBQU0sWUFBWTtBQUFBLElBQU8sV0FBVztBQUFBLEVBQzdGLENBQUM7QUFDRCxRQUFNLE9BQU8sSUFBSSxLQUFLLFVBQVUsUUFBUTtBQUN4QyxPQUFLLE9BQU87QUFDWixPQUFLLFVBQVU7QUFDZixRQUFNLFVBQVUsSUFBSSxRQUFRO0FBQzVCLE9BQUssaUJBQWlCLENBQUMsV0FBVyxRQUFRLFdBQVc7QUFDbkQsVUFBTSxjQUFjLFNBQVMsU0FBUyxhQUFjO0FBQ3BELGdCQUFZLHNCQUFzQixPQUFPLFdBQVc7QUFDcEQsUUFBSSxLQUFLLE9BQVEsYUFBWSxhQUFhLFFBQVEsS0FBSyxLQUFLLE9BQU8sV0FBVyxFQUFFLE9BQU8sQ0FBQztBQUFBLEVBQzFGO0FBQ0EsU0FBTztBQUNUO0FBRU8sZ0JBQVMsa0JBQWtCLFNBQTZCO0FBQzdELFFBQU0sT0FBTyxJQUFJLGFBQWEsWUFBWSxDQUFDO0FBQzNDLFFBQU0sWUFBWSxJQUFJLGFBQWEsU0FBUztBQUM1QyxRQUFNLE9BQU8sSUFBSSxhQUFhLFNBQVM7QUFDdkMsUUFBTSxRQUFRLElBQUksYUFBYSxZQUFZLENBQUM7QUFDNUMsUUFBTSxXQUFXLElBQUksYUFBYSxTQUFTO0FBQzNDLFFBQU0sT0FBTyxJQUFJLGFBQWEsU0FBUztBQUN2QyxRQUFNLFVBQVUsSUFBSSxZQUFZLFNBQVM7QUFDekMsUUFBTSxRQUFRLFFBQVEsaUJBQWlCLE9BQU8sS0FBSztBQUNuRCxRQUFNLE9BQU8sTUFBTSxxQkFBcUIsTUFBTSxPQUFPLFNBQVMsTUFBTSxTQUFTO0FBQzdFLFFBQU0sT0FBTyxNQUFNLHFCQUFxQixPQUFPLE9BQU8sU0FBUyxNQUFNLFNBQVM7QUFDOUUsUUFBTSxlQUFlLEtBQUssU0FBUztBQUNuQyxRQUFNLGVBQWUsS0FBSyxTQUFTO0FBQ25DLFFBQU0saUJBQWlCLEtBQUssSUFBSSxJQUFJLFFBQVEsZ0JBQWdCLFlBQVksSUFBSTtBQUM1RSxNQUFJLFlBQVk7QUFDaEIsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUFNO0FBQUEsSUFDTixPQUFPLE9BQXlCLE1BQXFCO0FBQ25ELFlBQU0sV0FBVyxnQkFBZ0IsS0FBSztBQUN0QyxXQUFLLFVBQVUsV0FBVztBQUMxQixXQUFLLFNBQVMsSUFBSSxNQUFNLE9BQU8sTUFBTSxPQUFPLE1BQU0sS0FBSztBQUN2RCxXQUFLLE1BQU0sVUFBVSxvQkFBb0IsQ0FBQztBQUMxQyxtQkFBYSxRQUFTLE1BQU0sS0FBSyxLQUFLLFFBQVE7QUFDOUMsbUJBQWEsTUFBTyxNQUFNLEtBQUssS0FBSyxLQUFLO0FBQ3pDLG1CQUFhLFNBQVUsUUFBUSxXQUFXO0FBQzFDLFVBQUksQ0FBQyxNQUFNLGNBQWUsYUFBWSxNQUFNO0FBQzVDLG1CQUFhLE1BQU8sUUFBUSxhQUFhLE1BQU8sUUFBUTtBQUN4RCxtQkFBYSxZQUFhLFFBQVEsYUFBYSxZQUFhLFFBQVEsTUFBTSxRQUFRLElBQUk7QUFDdEYsV0FBSyxLQUFLLENBQUM7QUFBRyxZQUFNLEtBQUssQ0FBQztBQUFHLGVBQVMsS0FBSyxDQUFDO0FBQUcsV0FBSyxLQUFLLENBQUM7QUFBRyxjQUFRLEtBQUssQ0FBQztBQUMzRSxXQUFLLEtBQUssQ0FBQztBQUFHLGdCQUFVLEtBQUssQ0FBQztBQUU5QixlQUFTLElBQUksR0FBRyxJQUFJLEtBQUssT0FBTyxLQUFLO0FBQ25DLFlBQUksS0FBSyxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsT0FBTyxTQUFTLEtBQUssVUFBVSxDQUFDLENBQUMsS0FBSyxLQUFLLFVBQVUsQ0FBQyxJQUFLLEVBQUc7QUFDM0YsY0FBTSxNQUFNLEtBQUssSUFBSSxDQUFDLEdBQUksT0FBTyxLQUFLLEtBQUssQ0FBQztBQUM1QyxZQUFJLENBQUMsT0FBTyxTQUFTLEdBQUcsS0FBSyxDQUFDLE9BQU8sU0FBUyxJQUFJLEtBQUssUUFBUSxLQUFLLE9BQU8sS0FBSyxPQUFPLEtBQU07QUFDN0YsY0FBTSxJQUFJLElBQUk7QUFDZCxjQUFNLElBQUksS0FBSyxVQUFVLENBQUMsR0FBSSxJQUFJLEtBQUssVUFBVSxJQUFJLENBQUMsR0FBSSxJQUFJLEtBQUssVUFBVSxJQUFJLENBQUM7QUFDbEYsWUFBSSxDQUFDLE9BQU8sU0FBUyxJQUFJLElBQUksQ0FBQyxFQUFHO0FBQ2pDLGNBQU0sSUFBSSxLQUFLLElBQUksWUFBWSxHQUFHLEtBQUssTUFBTSxNQUFNLE1BQU0sU0FBUyxDQUFDO0FBQ25FLGNBQU0sSUFBSSxJQUFJO0FBQ2QsY0FBTSxTQUFTLEtBQUssSUFBSSxJQUFJLE1BQU0sTUFBTSxHQUFHLElBQUksS0FBSyxJQUFJLEdBQUcsTUFBTSxLQUFLO0FBQ3RFLGNBQU0sV0FBVyxLQUFLLENBQUMsSUFBSztBQUM1QixjQUFNLEtBQUssSUFBSSxNQUFNLENBQUMsR0FBSSxLQUFLLElBQUksTUFBTSxJQUFJLENBQUMsR0FBSSxLQUFLLElBQUksTUFBTSxJQUFJLENBQUM7QUFDdEUsY0FBTSxDQUFDLEtBQUssS0FBSyxTQUFTO0FBQzFCLGNBQU0sSUFBSSxDQUFDLEtBQUssS0FBSyxTQUFTO0FBQzlCLGNBQU0sSUFBSSxDQUFDLEtBQUssS0FBSyxTQUFTO0FBQzlCLGlCQUFTLENBQUMsS0FBSyxVQUFVLE1BQU0sSUFBSSxNQUFNLENBQUMsS0FBTSxNQUFNLElBQUksTUFBTSxJQUFJLENBQUMsS0FBTSxNQUFNLElBQUksTUFBTSxJQUFJLENBQUM7QUFDaEcsYUFBSyxDQUFDLElBQUk7QUFDVixhQUFLLENBQUMsS0FBSyxNQUFNO0FBQ2pCLGdCQUFRLENBQUM7QUFBQSxNQUNYO0FBQ0EsVUFBSSxPQUFPLFVBQVUsT0FBTyxVQUFVLE9BQU87QUFDN0MsVUFBSSxPQUFPLFdBQVcsT0FBTyxXQUFXLE9BQU87QUFDL0MsZUFBUyxJQUFJLEdBQUcsSUFBSSxXQUFXLEtBQUs7QUFDbEMsWUFBSSxLQUFLLENBQUMsS0FBTSxFQUFHO0FBQ25CLGNBQU0sSUFBSSxJQUFJLEdBQUcsSUFBSSxJQUFJO0FBQ3pCLGNBQU0sU0FBUyxLQUFLLElBQUksS0FBSyxPQUFPLEtBQUssQ0FBQyxJQUFLLEtBQUssQ0FBQyxJQUFLLE9BQU8sTUFBTSxLQUFLLEtBQUssS0FBSyxJQUFJLEdBQUcsU0FBUyxDQUFDLElBQUssS0FBSyxDQUFDLENBQUUsQ0FBQyxDQUFDO0FBQ3RILGNBQU0sSUFBSSxNQUFNLENBQUMsR0FBSSxJQUFJLE1BQU0sSUFBSSxDQUFDLEdBQUksSUFBSSxNQUFNLElBQUksQ0FBQztBQUN2RCxhQUFLLENBQUMsSUFBSTtBQUFHLGFBQUssSUFBSSxDQUFDLElBQUk7QUFBRyxhQUFLLElBQUksQ0FBQyxJQUFJO0FBQUcsYUFBSyxJQUFJLENBQUMsSUFBSTtBQUU3RCxrQkFBVSxDQUFDLElBQUksS0FBSyxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQUssY0FBYyxJQUFJLEtBQUssSUFBSSxHQUFHLFFBQVEsQ0FBQyxJQUFLLENBQUMsSUFBSTtBQUN2RixlQUFPLEtBQUssSUFBSSxNQUFNLElBQUksTUFBTTtBQUFHLGVBQU8sS0FBSyxJQUFJLE1BQU0sSUFBSSxNQUFNO0FBQ25FLGVBQU8sS0FBSyxJQUFJLE1BQU0sSUFBSSxNQUFNO0FBQUcsZUFBTyxLQUFLLElBQUksTUFBTSxJQUFJLE1BQU07QUFDbkUsZUFBTyxLQUFLLElBQUksTUFBTSxJQUFJLE1BQU07QUFBRyxlQUFPLEtBQUssSUFBSSxNQUFNLElBQUksTUFBTTtBQUFBLE1BQ3JFO0FBQ0EsV0FBSyxVQUFVLE9BQU87QUFDdEIsVUFBSSxLQUFLLFNBQVM7QUFDaEIsYUFBSyxTQUFTLEtBQUssT0FBTyxRQUFRLElBQUksT0FBTyxRQUFRLElBQUksT0FBTyxRQUFRLENBQUM7QUFDekUsYUFBSyxNQUFNLElBQUksT0FBTyxNQUFNLE9BQU8sTUFBTSxPQUFPLElBQUk7QUFDcEQscUJBQWEsUUFBUyxNQUFNLEtBQUssS0FBSyxRQUFRO0FBQzlDLHFCQUFhLE1BQU8sTUFBTSxLQUFLLEtBQUssS0FBSztBQUFBLE1BQzNDO0FBQUEsSUFDRjtBQUFBLElBQ0EsVUFBVTtBQUNSLFdBQUssU0FBUyxRQUFRO0FBQUcsV0FBSyxTQUFTLFFBQVE7QUFDL0MsV0FBSyxTQUFTLFFBQVE7QUFBRyxXQUFLLFNBQVMsUUFBUTtBQUFBLElBQ2pEO0FBQUEsRUFDRjtBQUNGOyIsIm5hbWVzIjpbXX0=