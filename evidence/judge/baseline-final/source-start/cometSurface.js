import { BufferAttribute, IcosahedronGeometry, Mesh, NormalBlending, ShaderMaterial, Vector3 } from "/node_modules/.vite/deps/three.js?v=b7dcf682";
import { COMET_SURFACE_RADIUS } from "/src/features/home-particle/engine/cometVisualContract.ts";
export const smoothEnvelope = (start, end, value) => {
  const t = Math.min(1, Math.max(0, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
};
export function nucleusEnvelope(frame) {
  if (frame.phase === "gather") return 1 - smoothEnvelope(0.12, 0.55, frame.progress);
  if (frame.phase === "hold") return 0;
  if (frame.phase === "scatter") return smoothEnvelope(0.7, 1, Math.min(frame.progress / 0.62, 1));
  return 1;
}
const vertexShader = (
  /* glsl */
  `
  attribute vec3 aFaceCenter;
  attribute vec3 aBarycentric;
  attribute float aSeed;
  uniform float uFracture;
  uniform float uExpansion;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vBarycentric;
  varying vec3 vView;
  varying float vSeed;
  void main() {
    // Each triangle has a single seed, centre and flat terrain normal: no stretched bridges.
    vec3 p = aFaceCenter + (position - aFaceCenter) * (1.0 - 0.46 * uFracture);
    p += normal * uExpansion * (0.55 + 0.7 * aSeed);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vView = -view.xyz;
    vNormal = normalize(normalMatrix * normal);
    vLocal = position;
    vBarycentric = aBarycentric;
    vSeed = aSeed;
    gl_Position = projectionMatrix * view;
  }
`
);
const fragmentShader = (
  /* glsl */
  `
  uniform vec3 uLightDirection;
  uniform float uRoughness;
  uniform float uOpacity;
  uniform float uEnergy;
  uniform float uLightTheme;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying vec3 vBarycentric;
  varying vec3 vView;
  varying float vSeed;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                   mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                   mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize((viewMatrix * vec4(uLightDirection, 0.0)).xyz);
    vec3 V = normalize(vView);
    float nl = max(dot(N, L), 0.0);
    float nv = max(dot(N, V), 0.01);
    // Oren–Nayar rough diffuse: terrain normals, view and an independent world sun.
    float sigma2 = uRoughness * uRoughness;
    float A = 1.0 - 0.5 * sigma2 / (sigma2 + 0.33);
    float B = 0.45 * sigma2 / (sigma2 + 0.09);
    float grazing = max(dot(L - N * nl, V - N * nv), 0.0);
    float diffuse = nl * (A + B * grazing / max(max(nl, nv), 0.12));
    float strata = noise(vLocal * 8.0);
    float grain = noise(vLocal * 74.0);
    float ice = smoothstep(0.51, 0.77, strata + 0.15 * sin(vLocal.y * 24.0 + strata * 6.0));
    float seam = 1.0 - smoothstep(0.018, 0.065, abs(sin(vLocal.x * 12.0 + vLocal.z * 9.0 + strata * 5.0)));
    vec3 rock = mix(vec3(0.22, 0.25, 0.29), vec3(0.42, 0.50, 0.57), ice);
    rock = mix(rock, vec3(0.32, 0.27, 0.22), smoothstep(0.59, 0.8, noise(vLocal * 5.0 + 13.0)) * 0.5);
    rock *= (0.72 + 0.32 * grain) * (1.0 - 0.65 * seam);
    vec3 ambient = vec3(0.27, 0.32, 0.40) + uLightTheme * vec3(0.035);
    vec3 color = rock * (ambient + vec3(1.02, 0.94, 0.82) * diffuse * 1.65);
    float edge = 1.0 - smoothstep(0.01, 0.07, min(vBarycentric.x, min(vBarycentric.y, vBarycentric.z)));
    color += vec3(0.22, 0.085, 0.024) * uEnergy * max(seam, edge * step(0.76, vSeed));
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`
);
export function createCometSurface(options) {
  const geometry = new IcosahedronGeometry(COMET_SURFACE_RADIUS, 18);
  geometry.deleteAttribute("uv");
  const position = geometry.getAttribute("position");
  const craters = [
    new Vector3(0.6, 0.45, 0.7).normalize(),
    new Vector3(-0.5, 0.1, 0.9).normalize(),
    new Vector3(0.15, -0.7, 0.6).normalize(),
    new Vector3(-0.2, 0.9, -0.4).normalize(),
    new Vector3(0.9, -0.1, -0.4).normalize(),
    new Vector3(-0.8, -0.5, -0.2).normalize()
  ];
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) / COMET_SURFACE_RADIUS;
    const y = position.getY(i) / COMET_SURFACE_RADIUS;
    const z = position.getZ(i) / COMET_SURFACE_RADIUS;
    let terrain = 1 + 0.065 * Math.sin(5 * x + 1) * Math.sin(6 * y - 2) * Math.cos(5 * z);
    terrain += 0.029 * Math.sin(x * 21 + y * 11) * Math.sin(z * 19 - y * 13);
    terrain += 0.018 * Math.cos(y * 32 + Math.sin(z * 8) * 2);
    for (let c = 0; c < craters.length; c++) {
      const axis = craters[c];
      const d = Math.sqrt(Math.max(0, 2 - 2 * (x * axis.x + y * axis.y + z * axis.z)));
      const width = 0.19 + c % 3 * 0.05;
      terrain -= 0.12 * Math.exp(-Math.pow(d / width, 4));
      terrain += 0.038 * Math.exp(-Math.pow((d - width) / 0.055, 2));
    }
    position.setXYZ(
      i,
      x * COMET_SURFACE_RADIUS * terrain * 1.1,
      y * COMET_SURFACE_RADIUS * terrain * 0.92,
      z * COMET_SURFACE_RADIUS * terrain
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  const center = new Float32Array(position.count * 3);
  const barycentric = new Float32Array(position.count * 3);
  const seed = new Float32Array(position.count);
  for (let i = 0; i < position.count; i += 3) {
    const cx = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const cy = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3;
    const cz = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
    const random = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    for (let j = 0; j < 3; j++) {
      const vertex = i + j;
      center[vertex * 3] = cx;
      center[vertex * 3 + 1] = cy;
      center[vertex * 3 + 2] = cz;
      barycentric[vertex * 3 + j] = 1;
      seed[vertex] = random - Math.floor(random);
    }
  }
  geometry.setAttribute("aFaceCenter", new BufferAttribute(center, 3));
  geometry.setAttribute("aBarycentric", new BufferAttribute(barycentric, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seed, 1));
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius += 1.6;
  const material = new ShaderMaterial({
    name: "comet-rough-rock-ice",
    vertexShader,
    fragmentShader,
    uniforms: {
      uLightDirection: { value: new Vector3(-0.65, 0.85, 1.4).normalize() },
      uRoughness: { value: 0.92 },
      uOpacity: { value: 1 },
      uEnergy: { value: 0 },
      uFracture: { value: 0 },
      uExpansion: { value: 0 },
      uLightTheme: { value: options.light ? 1 : 0 }
    },
    transparent: true,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: true
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "comet-nucleus";
  const uniforms = material.uniforms;
  return {
    mesh,
    update(frame) {
      const envelope = nucleusEnvelope(frame);
      const fracture = frame.phase === "gather" && !frame.reducedMotion ? smoothEnvelope(0.05, 0.3, frame.progress) : 0;
      mesh.visible = envelope > 0;
      mesh.position.set(frame.headX, frame.headY, frame.headZ);
      mesh.scale.setScalar(frame.phase === "scatter" ? 0.12 + 0.88 * envelope : 1);
      if (!frame.reducedMotion) mesh.rotation.set(0.18 + frame.time * 0.018, frame.time * 0.075, 0.12);
      uniforms.uOpacity.value = envelope;
      uniforms.uFracture.value = fracture;
      uniforms.uExpansion.value = fracture * (0.55 + 0.65 * smoothEnvelope(0.3, 0.55, frame.progress));
      uniforms.uEnergy.value = frame.phase === "gather" && !frame.reducedMotion ? (0.12 + 0.58 * smoothEnvelope(0, 0.07, frame.progress)) * envelope : 0;
      uniforms.uLightTheme.value = frame.light ? 1 : 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    }
  };
}

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNvbWV0U3VyZmFjZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBCdWZmZXJBdHRyaWJ1dGUsIEljb3NhaGVkcm9uR2VvbWV0cnksIE1lc2gsIE5vcm1hbEJsZW5kaW5nLCBTaGFkZXJNYXRlcmlhbCwgVmVjdG9yMyB9IGZyb20gJ3RocmVlJ1xuaW1wb3J0IHsgQ09NRVRfU1VSRkFDRV9SQURJVVMgfSBmcm9tICcuL2NvbWV0VmlzdWFsQ29udHJhY3QnXG5pbXBvcnQgdHlwZSB7IENvbWV0VmlzdWFsRnJhbWUsIENvbWV0VmlzdWFsT3B0aW9ucyB9IGZyb20gJy4vY29tZXRWaXN1YWxDb250cmFjdCdcblxuZXhwb3J0IGNvbnN0IHNtb290aEVudmVsb3BlID0gKHN0YXJ0OiBudW1iZXIsIGVuZDogbnVtYmVyLCB2YWx1ZTogbnVtYmVyKTogbnVtYmVyID0+IHtcbiAgY29uc3QgdCA9IE1hdGgubWluKDEsIE1hdGgubWF4KDAsICh2YWx1ZSAtIHN0YXJ0KSAvIChlbmQgLSBzdGFydCkpKVxuICByZXR1cm4gdCAqIHQgKiAoMyAtIDIgKiB0KVxufVxuXG4vKiogU2hhcmVkIGNvbnRpbnVvdXMgdmlzaWJpbGl0eTsgdGhlIGVtaXR0ZWQgdGFpbCBkZWxpYmVyYXRlbHkgZG9lcyBub3QgdXNlIHRoaXMgZW52ZWxvcGUuICovXG5leHBvcnQgZnVuY3Rpb24gbnVjbGV1c0VudmVsb3BlKGZyYW1lOiBDb21ldFZpc3VhbEZyYW1lKTogbnVtYmVyIHtcbiAgaWYgKGZyYW1lLnBoYXNlID09PSAnZ2F0aGVyJykgcmV0dXJuIDEgLSBzbW9vdGhFbnZlbG9wZSgwLjEyLCAwLjU1LCBmcmFtZS5wcm9ncmVzcylcbiAgaWYgKGZyYW1lLnBoYXNlID09PSAnaG9sZCcpIHJldHVybiAwXG4gIGlmIChmcmFtZS5waGFzZSA9PT0gJ3NjYXR0ZXInKSByZXR1cm4gc21vb3RoRW52ZWxvcGUoMC43LCAxLCBNYXRoLm1pbihmcmFtZS5wcm9ncmVzcyAvIDAuNjIsIDEpKVxuICByZXR1cm4gMVxufVxuXG5jb25zdCB2ZXJ0ZXhTaGFkZXIgPSAvKiBnbHNsICovIGBcbiAgYXR0cmlidXRlIHZlYzMgYUZhY2VDZW50ZXI7XG4gIGF0dHJpYnV0ZSB2ZWMzIGFCYXJ5Y2VudHJpYztcbiAgYXR0cmlidXRlIGZsb2F0IGFTZWVkO1xuICB1bmlmb3JtIGZsb2F0IHVGcmFjdHVyZTtcbiAgdW5pZm9ybSBmbG9hdCB1RXhwYW5zaW9uO1xuICB2YXJ5aW5nIHZlYzMgdk5vcm1hbDtcbiAgdmFyeWluZyB2ZWMzIHZMb2NhbDtcbiAgdmFyeWluZyB2ZWMzIHZCYXJ5Y2VudHJpYztcbiAgdmFyeWluZyB2ZWMzIHZWaWV3O1xuICB2YXJ5aW5nIGZsb2F0IHZTZWVkO1xuICB2b2lkIG1haW4oKSB7XG4gICAgLy8gRWFjaCB0cmlhbmdsZSBoYXMgYSBzaW5nbGUgc2VlZCwgY2VudHJlIGFuZCBmbGF0IHRlcnJhaW4gbm9ybWFsOiBubyBzdHJldGNoZWQgYnJpZGdlcy5cbiAgICB2ZWMzIHAgPSBhRmFjZUNlbnRlciArIChwb3NpdGlvbiAtIGFGYWNlQ2VudGVyKSAqICgxLjAgLSAwLjQ2ICogdUZyYWN0dXJlKTtcbiAgICBwICs9IG5vcm1hbCAqIHVFeHBhbnNpb24gKiAoMC41NSArIDAuNyAqIGFTZWVkKTtcbiAgICB2ZWM0IHZpZXcgPSBtb2RlbFZpZXdNYXRyaXggKiB2ZWM0KHAsIDEuMCk7XG4gICAgdlZpZXcgPSAtdmlldy54eXo7XG4gICAgdk5vcm1hbCA9IG5vcm1hbGl6ZShub3JtYWxNYXRyaXggKiBub3JtYWwpO1xuICAgIHZMb2NhbCA9IHBvc2l0aW9uO1xuICAgIHZCYXJ5Y2VudHJpYyA9IGFCYXJ5Y2VudHJpYztcbiAgICB2U2VlZCA9IGFTZWVkO1xuICAgIGdsX1Bvc2l0aW9uID0gcHJvamVjdGlvbk1hdHJpeCAqIHZpZXc7XG4gIH1cbmBcblxuY29uc3QgZnJhZ21lbnRTaGFkZXIgPSAvKiBnbHNsICovIGBcbiAgdW5pZm9ybSB2ZWMzIHVMaWdodERpcmVjdGlvbjtcbiAgdW5pZm9ybSBmbG9hdCB1Um91Z2huZXNzO1xuICB1bmlmb3JtIGZsb2F0IHVPcGFjaXR5O1xuICB1bmlmb3JtIGZsb2F0IHVFbmVyZ3k7XG4gIHVuaWZvcm0gZmxvYXQgdUxpZ2h0VGhlbWU7XG4gIHZhcnlpbmcgdmVjMyB2Tm9ybWFsO1xuICB2YXJ5aW5nIHZlYzMgdkxvY2FsO1xuICB2YXJ5aW5nIHZlYzMgdkJhcnljZW50cmljO1xuICB2YXJ5aW5nIHZlYzMgdlZpZXc7XG4gIHZhcnlpbmcgZmxvYXQgdlNlZWQ7XG4gIGZsb2F0IGhhc2godmVjMyBwKSB7IHJldHVybiBmcmFjdChzaW4oZG90KHAsIHZlYzMoMTI3LjEsIDMxMS43LCA3NC43KSkpICogNDM3NTguNTQ1Myk7IH1cbiAgZmxvYXQgbm9pc2UodmVjMyBwKSB7XG4gICAgdmVjMyBpID0gZmxvb3IocCksIGYgPSBmcmFjdChwKTsgZiA9IGYqZiooMy4wLTIuMCpmKTtcbiAgICByZXR1cm4gbWl4KG1peChtaXgoaGFzaChpKSwgaGFzaChpK3ZlYzMoMSwwLDApKSwgZi54KSxcbiAgICAgICAgICAgICAgICAgICBtaXgoaGFzaChpK3ZlYzMoMCwxLDApKSwgaGFzaChpK3ZlYzMoMSwxLDApKSwgZi54KSwgZi55KSxcbiAgICAgICAgICAgICAgIG1peChtaXgoaGFzaChpK3ZlYzMoMCwwLDEpKSwgaGFzaChpK3ZlYzMoMSwwLDEpKSwgZi54KSxcbiAgICAgICAgICAgICAgICAgICBtaXgoaGFzaChpK3ZlYzMoMCwxLDEpKSwgaGFzaChpK3ZlYzMoMSwxLDEpKSwgZi54KSwgZi55KSwgZi56KTtcbiAgfVxuICB2b2lkIG1haW4oKSB7XG4gICAgdmVjMyBOID0gbm9ybWFsaXplKHZOb3JtYWwpO1xuICAgIHZlYzMgTCA9IG5vcm1hbGl6ZSgodmlld01hdHJpeCAqIHZlYzQodUxpZ2h0RGlyZWN0aW9uLCAwLjApKS54eXopO1xuICAgIHZlYzMgViA9IG5vcm1hbGl6ZSh2Vmlldyk7XG4gICAgZmxvYXQgbmwgPSBtYXgoZG90KE4sIEwpLCAwLjApO1xuICAgIGZsb2F0IG52ID0gbWF4KGRvdChOLCBWKSwgMC4wMSk7XG4gICAgLy8gT3JlbuKAk05heWFyIHJvdWdoIGRpZmZ1c2U6IHRlcnJhaW4gbm9ybWFscywgdmlldyBhbmQgYW4gaW5kZXBlbmRlbnQgd29ybGQgc3VuLlxuICAgIGZsb2F0IHNpZ21hMiA9IHVSb3VnaG5lc3MgKiB1Um91Z2huZXNzO1xuICAgIGZsb2F0IEEgPSAxLjAgLSAwLjUgKiBzaWdtYTIgLyAoc2lnbWEyICsgMC4zMyk7XG4gICAgZmxvYXQgQiA9IDAuNDUgKiBzaWdtYTIgLyAoc2lnbWEyICsgMC4wOSk7XG4gICAgZmxvYXQgZ3JhemluZyA9IG1heChkb3QoTCAtIE4gKiBubCwgViAtIE4gKiBudiksIDAuMCk7XG4gICAgZmxvYXQgZGlmZnVzZSA9IG5sICogKEEgKyBCICogZ3JhemluZyAvIG1heChtYXgobmwsIG52KSwgMC4xMikpO1xuICAgIGZsb2F0IHN0cmF0YSA9IG5vaXNlKHZMb2NhbCAqIDguMCk7XG4gICAgZmxvYXQgZ3JhaW4gPSBub2lzZSh2TG9jYWwgKiA3NC4wKTtcbiAgICBmbG9hdCBpY2UgPSBzbW9vdGhzdGVwKDAuNTEsIDAuNzcsIHN0cmF0YSArIDAuMTUgKiBzaW4odkxvY2FsLnkgKiAyNC4wICsgc3RyYXRhICogNi4wKSk7XG4gICAgZmxvYXQgc2VhbSA9IDEuMCAtIHNtb290aHN0ZXAoMC4wMTgsIDAuMDY1LCBhYnMoc2luKHZMb2NhbC54ICogMTIuMCArIHZMb2NhbC56ICogOS4wICsgc3RyYXRhICogNS4wKSkpO1xuICAgIHZlYzMgcm9jayA9IG1peCh2ZWMzKDAuMjIsIDAuMjUsIDAuMjkpLCB2ZWMzKDAuNDIsIDAuNTAsIDAuNTcpLCBpY2UpO1xuICAgIHJvY2sgPSBtaXgocm9jaywgdmVjMygwLjMyLCAwLjI3LCAwLjIyKSwgc21vb3Roc3RlcCgwLjU5LCAwLjgsIG5vaXNlKHZMb2NhbCAqIDUuMCArIDEzLjApKSAqIDAuNSk7XG4gICAgcm9jayAqPSAoMC43MiArIDAuMzIgKiBncmFpbikgKiAoMS4wIC0gMC42NSAqIHNlYW0pO1xuICAgIHZlYzMgYW1iaWVudCA9IHZlYzMoMC4yNywgMC4zMiwgMC40MCkgKyB1TGlnaHRUaGVtZSAqIHZlYzMoMC4wMzUpO1xuICAgIHZlYzMgY29sb3IgPSByb2NrICogKGFtYmllbnQgKyB2ZWMzKDEuMDIsIDAuOTQsIDAuODIpICogZGlmZnVzZSAqIDEuNjUpO1xuICAgIGZsb2F0IGVkZ2UgPSAxLjAgLSBzbW9vdGhzdGVwKDAuMDEsIDAuMDcsIG1pbih2QmFyeWNlbnRyaWMueCwgbWluKHZCYXJ5Y2VudHJpYy55LCB2QmFyeWNlbnRyaWMueikpKTtcbiAgICBjb2xvciArPSB2ZWMzKDAuMjIsIDAuMDg1LCAwLjAyNCkgKiB1RW5lcmd5ICogbWF4KHNlYW0sIGVkZ2UgKiBzdGVwKDAuNzYsIHZTZWVkKSk7XG4gICAgZ2xfRnJhZ0NvbG9yID0gdmVjNChjb2xvciwgdU9wYWNpdHkpO1xuICAgICNpbmNsdWRlIDx0b25lbWFwcGluZ19mcmFnbWVudD5cbiAgICAjaW5jbHVkZSA8Y29sb3JzcGFjZV9mcmFnbWVudD5cbiAgfVxuYFxuXG4vKiogUHJvY2VkdXJhbCByb2NrL2ljZSB0ZXJyYWluLCBub3QgYSBzY2FubmVkIGFzdHJvbm9taWNhbCBhc3NldC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVDb21ldFN1cmZhY2Uob3B0aW9uczogQ29tZXRWaXN1YWxPcHRpb25zKSB7XG4gIC8vIE5vbi1pbmRleGVkIHRyaWFuZ2xlcyBrZWVwIGZyYWN0dXJlIG5vcm1hbHMvY2VudHJlcyBpbmRlcGVuZGVudC4gQWJvdXQgN2sgZmFjZXMuXG4gIGNvbnN0IGdlb21ldHJ5ID0gbmV3IEljb3NhaGVkcm9uR2VvbWV0cnkoQ09NRVRfU1VSRkFDRV9SQURJVVMsIDE4KVxuICBnZW9tZXRyeS5kZWxldGVBdHRyaWJ1dGUoJ3V2JylcbiAgY29uc3QgcG9zaXRpb24gPSBnZW9tZXRyeS5nZXRBdHRyaWJ1dGUoJ3Bvc2l0aW9uJylcbiAgY29uc3QgY3JhdGVycyA9IFtcbiAgICBuZXcgVmVjdG9yMygwLjYsIDAuNDUsIDAuNykubm9ybWFsaXplKCksIG5ldyBWZWN0b3IzKC0wLjUsIDAuMSwgMC45KS5ub3JtYWxpemUoKSxcbiAgICBuZXcgVmVjdG9yMygwLjE1LCAtMC43LCAwLjYpLm5vcm1hbGl6ZSgpLCBuZXcgVmVjdG9yMygtMC4yLCAwLjksIC0wLjQpLm5vcm1hbGl6ZSgpLFxuICAgIG5ldyBWZWN0b3IzKDAuOSwgLTAuMSwgLTAuNCkubm9ybWFsaXplKCksIG5ldyBWZWN0b3IzKC0wLjgsIC0wLjUsIC0wLjIpLm5vcm1hbGl6ZSgpLFxuICBdXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcG9zaXRpb24uY291bnQ7IGkrKykge1xuICAgIGNvbnN0IHggPSBwb3NpdGlvbi5nZXRYKGkpIC8gQ09NRVRfU1VSRkFDRV9SQURJVVNcbiAgICBjb25zdCB5ID0gcG9zaXRpb24uZ2V0WShpKSAvIENPTUVUX1NVUkZBQ0VfUkFESVVTXG4gICAgY29uc3QgeiA9IHBvc2l0aW9uLmdldFooaSkgLyBDT01FVF9TVVJGQUNFX1JBRElVU1xuICAgIGxldCB0ZXJyYWluID0gMSArIDAuMDY1ICogTWF0aC5zaW4oNSAqIHggKyAxKSAqIE1hdGguc2luKDYgKiB5IC0gMikgKiBNYXRoLmNvcyg1ICogeilcbiAgICB0ZXJyYWluICs9IDAuMDI5ICogTWF0aC5zaW4oeCAqIDIxICsgeSAqIDExKSAqIE1hdGguc2luKHogKiAxOSAtIHkgKiAxMylcbiAgICB0ZXJyYWluICs9IDAuMDE4ICogTWF0aC5jb3MoeSAqIDMyICsgTWF0aC5zaW4oeiAqIDgpICogMikgLy8gZXh0cnVkZWQgaWNlIHN0cmF0YVxuICAgIGZvciAobGV0IGMgPSAwOyBjIDwgY3JhdGVycy5sZW5ndGg7IGMrKykge1xuICAgICAgY29uc3QgYXhpcyA9IGNyYXRlcnNbY10hXG4gICAgICBjb25zdCBkID0gTWF0aC5zcXJ0KE1hdGgubWF4KDAsIDIgLSAyICogKHggKiBheGlzLnggKyB5ICogYXhpcy55ICsgeiAqIGF4aXMueikpKVxuICAgICAgY29uc3Qgd2lkdGggPSAwLjE5ICsgKGMgJSAzKSAqIDAuMDVcbiAgICAgIHRlcnJhaW4gLT0gMC4xMiAqIE1hdGguZXhwKC1NYXRoLnBvdyhkIC8gd2lkdGgsIDQpKVxuICAgICAgdGVycmFpbiArPSAwLjAzOCAqIE1hdGguZXhwKC1NYXRoLnBvdygoZCAtIHdpZHRoKSAvIDAuMDU1LCAyKSlcbiAgICB9XG4gICAgcG9zaXRpb24uc2V0WFlaKGksIHggKiBDT01FVF9TVVJGQUNFX1JBRElVUyAqIHRlcnJhaW4gKiAxLjEsXG4gICAgICB5ICogQ09NRVRfU1VSRkFDRV9SQURJVVMgKiB0ZXJyYWluICogMC45MiwgeiAqIENPTUVUX1NVUkZBQ0VfUkFESVVTICogdGVycmFpbilcbiAgfVxuICBwb3NpdGlvbi5uZWVkc1VwZGF0ZSA9IHRydWVcbiAgZ2VvbWV0cnkuY29tcHV0ZVZlcnRleE5vcm1hbHMoKVxuICBjb25zdCBjZW50ZXIgPSBuZXcgRmxvYXQzMkFycmF5KHBvc2l0aW9uLmNvdW50ICogMylcbiAgY29uc3QgYmFyeWNlbnRyaWMgPSBuZXcgRmxvYXQzMkFycmF5KHBvc2l0aW9uLmNvdW50ICogMylcbiAgY29uc3Qgc2VlZCA9IG5ldyBGbG9hdDMyQXJyYXkocG9zaXRpb24uY291bnQpXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcG9zaXRpb24uY291bnQ7IGkgKz0gMykge1xuICAgIGNvbnN0IGN4ID0gKHBvc2l0aW9uLmdldFgoaSkgKyBwb3NpdGlvbi5nZXRYKGkgKyAxKSArIHBvc2l0aW9uLmdldFgoaSArIDIpKSAvIDNcbiAgICBjb25zdCBjeSA9IChwb3NpdGlvbi5nZXRZKGkpICsgcG9zaXRpb24uZ2V0WShpICsgMSkgKyBwb3NpdGlvbi5nZXRZKGkgKyAyKSkgLyAzXG4gICAgY29uc3QgY3ogPSAocG9zaXRpb24uZ2V0WihpKSArIHBvc2l0aW9uLmdldFooaSArIDEpICsgcG9zaXRpb24uZ2V0WihpICsgMikpIC8gM1xuICAgIGNvbnN0IHJhbmRvbSA9IE1hdGguc2luKGkgKiAxMi45ODk4ICsgNzguMjMzKSAqIDQzNzU4LjU0NTNcbiAgICBmb3IgKGxldCBqID0gMDsgaiA8IDM7IGorKykge1xuICAgICAgY29uc3QgdmVydGV4ID0gaSArIGpcbiAgICAgIGNlbnRlclt2ZXJ0ZXggKiAzXSA9IGN4XG4gICAgICBjZW50ZXJbdmVydGV4ICogMyArIDFdID0gY3lcbiAgICAgIGNlbnRlclt2ZXJ0ZXggKiAzICsgMl0gPSBjelxuICAgICAgYmFyeWNlbnRyaWNbdmVydGV4ICogMyArIGpdID0gMVxuICAgICAgc2VlZFt2ZXJ0ZXhdID0gcmFuZG9tIC0gTWF0aC5mbG9vcihyYW5kb20pXG4gICAgfVxuICB9XG4gIGdlb21ldHJ5LnNldEF0dHJpYnV0ZSgnYUZhY2VDZW50ZXInLCBuZXcgQnVmZmVyQXR0cmlidXRlKGNlbnRlciwgMykpXG4gIGdlb21ldHJ5LnNldEF0dHJpYnV0ZSgnYUJhcnljZW50cmljJywgbmV3IEJ1ZmZlckF0dHJpYnV0ZShiYXJ5Y2VudHJpYywgMykpXG4gIGdlb21ldHJ5LnNldEF0dHJpYnV0ZSgnYVNlZWQnLCBuZXcgQnVmZmVyQXR0cmlidXRlKHNlZWQsIDEpKVxuICBnZW9tZXRyeS5jb21wdXRlQm91bmRpbmdTcGhlcmUoKVxuICAvLyBGcmFnbWVudHMgbWF5IGV4cGFuZCBiZXlvbmQgdGhlIHJlc3Rpbmcgc3VyZmFjZSdzIGJvdW5kcy5cbiAgZ2VvbWV0cnkuYm91bmRpbmdTcGhlcmUhLnJhZGl1cyArPSAxLjZcbiAgY29uc3QgbWF0ZXJpYWwgPSBuZXcgU2hhZGVyTWF0ZXJpYWwoe1xuICAgIG5hbWU6ICdjb21ldC1yb3VnaC1yb2NrLWljZScsIHZlcnRleFNoYWRlciwgZnJhZ21lbnRTaGFkZXIsXG4gICAgdW5pZm9ybXM6IHtcbiAgICAgIHVMaWdodERpcmVjdGlvbjogeyB2YWx1ZTogbmV3IFZlY3RvcjMoLTAuNjUsIDAuODUsIDEuNCkubm9ybWFsaXplKCkgfSxcbiAgICAgIHVSb3VnaG5lc3M6IHsgdmFsdWU6IDAuOTIgfSwgdU9wYWNpdHk6IHsgdmFsdWU6IDEgfSwgdUVuZXJneTogeyB2YWx1ZTogMCB9LFxuICAgICAgdUZyYWN0dXJlOiB7IHZhbHVlOiAwIH0sIHVFeHBhbnNpb246IHsgdmFsdWU6IDAgfSwgdUxpZ2h0VGhlbWU6IHsgdmFsdWU6IG9wdGlvbnMubGlnaHQgPyAxIDogMCB9LFxuICAgIH0sXG4gICAgdHJhbnNwYXJlbnQ6IHRydWUsIGJsZW5kaW5nOiBOb3JtYWxCbGVuZGluZywgZGVwdGhUZXN0OiB0cnVlLCBkZXB0aFdyaXRlOiB0cnVlLFxuICB9KVxuICBjb25zdCBtZXNoID0gbmV3IE1lc2goZ2VvbWV0cnksIG1hdGVyaWFsKVxuICBtZXNoLm5hbWUgPSAnY29tZXQtbnVjbGV1cydcbiAgY29uc3QgdW5pZm9ybXMgPSBtYXRlcmlhbC51bmlmb3Jtc1xuICByZXR1cm4ge1xuICAgIG1lc2gsXG4gICAgdXBkYXRlKGZyYW1lOiBDb21ldFZpc3VhbEZyYW1lKSB7XG4gICAgICBjb25zdCBlbnZlbG9wZSA9IG51Y2xldXNFbnZlbG9wZShmcmFtZSlcbiAgICAgIGNvbnN0IGZyYWN0dXJlID0gZnJhbWUucGhhc2UgPT09ICdnYXRoZXInICYmICFmcmFtZS5yZWR1Y2VkTW90aW9uXG4gICAgICAgID8gc21vb3RoRW52ZWxvcGUoMC4wNSwgMC4zLCBmcmFtZS5wcm9ncmVzcykgOiAwXG4gICAgICBtZXNoLnZpc2libGUgPSBlbnZlbG9wZSA+IDBcbiAgICAgIG1lc2gucG9zaXRpb24uc2V0KGZyYW1lLmhlYWRYLCBmcmFtZS5oZWFkWSwgZnJhbWUuaGVhZFopXG4gICAgICBtZXNoLnNjYWxlLnNldFNjYWxhcihmcmFtZS5waGFzZSA9PT0gJ3NjYXR0ZXInID8gMC4xMiArIDAuODggKiBlbnZlbG9wZSA6IDEpXG4gICAgICBpZiAoIWZyYW1lLnJlZHVjZWRNb3Rpb24pIG1lc2gucm90YXRpb24uc2V0KDAuMTggKyBmcmFtZS50aW1lICogMC4wMTgsIGZyYW1lLnRpbWUgKiAwLjA3NSwgMC4xMilcbiAgICAgIHVuaWZvcm1zLnVPcGFjaXR5IS52YWx1ZSA9IGVudmVsb3BlXG4gICAgICB1bmlmb3Jtcy51RnJhY3R1cmUhLnZhbHVlID0gZnJhY3R1cmVcbiAgICAgIHVuaWZvcm1zLnVFeHBhbnNpb24hLnZhbHVlID0gZnJhY3R1cmUgKiAoMC41NSArIDAuNjUgKiBzbW9vdGhFbnZlbG9wZSgwLjMsIDAuNTUsIGZyYW1lLnByb2dyZXNzKSlcbiAgICAgIHVuaWZvcm1zLnVFbmVyZ3khLnZhbHVlID0gZnJhbWUucGhhc2UgPT09ICdnYXRoZXInICYmICFmcmFtZS5yZWR1Y2VkTW90aW9uXG4gICAgICAgID8gKDAuMTIgKyAwLjU4ICogc21vb3RoRW52ZWxvcGUoMCwgMC4wNywgZnJhbWUucHJvZ3Jlc3MpKSAqIGVudmVsb3BlIDogMFxuICAgICAgdW5pZm9ybXMudUxpZ2h0VGhlbWUhLnZhbHVlID0gZnJhbWUubGlnaHQgPyAxIDogMFxuICAgIH0sXG4gICAgZGlzcG9zZSgpIHsgZ2VvbWV0cnkuZGlzcG9zZSgpOyBtYXRlcmlhbC5kaXNwb3NlKCkgfSxcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxTQUFTLGlCQUFpQixxQkFBcUIsTUFBTSxnQkFBZ0IsZ0JBQWdCLGVBQWU7QUFDcEcsU0FBUyw0QkFBNEI7QUFHOUIsYUFBTSxpQkFBaUIsQ0FBQyxPQUFlLEtBQWEsVUFBMEI7QUFDbkYsUUFBTSxJQUFJLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLFFBQVEsVUFBVSxNQUFNLE1BQU0sQ0FBQztBQUNsRSxTQUFPLElBQUksS0FBSyxJQUFJLElBQUk7QUFDMUI7QUFHTyxnQkFBUyxnQkFBZ0IsT0FBaUM7QUFDL0QsTUFBSSxNQUFNLFVBQVUsU0FBVSxRQUFPLElBQUksZUFBZSxNQUFNLE1BQU0sTUFBTSxRQUFRO0FBQ2xGLE1BQUksTUFBTSxVQUFVLE9BQVEsUUFBTztBQUNuQyxNQUFJLE1BQU0sVUFBVSxVQUFXLFFBQU8sZUFBZSxLQUFLLEdBQUcsS0FBSyxJQUFJLE1BQU0sV0FBVyxNQUFNLENBQUMsQ0FB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