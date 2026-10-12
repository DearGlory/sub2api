// Adapter for the observed A volume shader layout. Unknown layouts are not accepted.
// Positions/age/birth membership come from the live pool; GPU uniform values are read
// with gl.getUniform, independently of material.uniforms and object names.
export function volumeProvenance(object,geometry) {
  const m=object.materials.find(m=>/#define IS_COMA 0\b/.test(m.fragment||''))
  if(!m)return {status:'instrument-invalid',reason:'unrecognized actual tail shader layout'}
  const bins=m.uniforms.uBins,density=m.uniforms.uDensities,gpuBins=m.gpuUniforms['uBins[0]'],gpuDensity=m.gpuUniforms['uDensities[0]']
  if(!bins||!density||!gpuBins||!gpuDensity||!geometry?.tail?.births)return {status:'instrument-invalid',reason:'missing full GPU arrays or actual pool'}
  const n=density.length,groups=Array.from({length:n},()=>({mass:0,weighted:[0,0,0],count:0,birthMin:Infinity,birthMax:-Infinity}))
  for(const b of geometry.tail.births){if(!Number.isFinite(b.birthTime)||b.birthTime<0||b.age<=0||b.age>=b.life)continue;const index=Math.min(n-1,Math.floor(b.age/3.2*n)),g=groups[index],w=(1-b.age/b.life)**1.7*Math.min(1,b.age/.035);g.mass+=w;g.count++;g.birthMin=Math.min(g.birthMin,b.birthTime);g.birthMax=Math.max(g.birthMax,b.birthTime);for(let j=0;j<3;j++)g.weighted[j]+=b.position[j]*w}
  let maxCenterError=0,maxGPUError=0,active=0,emptyNonzero=0
  for(let i=0;i<n;i++){
    const g=groups[i]
    if(g.mass>0){active++;for(let j=0;j<3;j++)maxCenterError=Math.max(maxCenterError,Math.abs(bins[i*4+j]-g.weighted[j]/g.mass));if(!(bins[i*4+3]>0&&density[i]>0))emptyNonzero++}else if(density[i]!==0)emptyNonzero++
    for(let j=0;j<4;j++)maxGPUError=Math.max(maxGPUError,Math.abs(bins[i*4+j]-gpuBins[i]?.[j]))
    maxGPUError=Math.max(maxGPUError,Math.abs(density[i]-gpuDensity[i]))
  }
  const shader=m.fragment,raymarch=/density\(p\)/.test(shader)&&/uCameraFrame\s*\+\s*ray/.test(shader)&&/1\.0\s*-\s*exp\(/.test(shader)&&/p-uBins\[j\]\.xyz/.test(shader)
  const ok=active>0&&maxCenterError<1e-4&&maxGPUError<1e-6&&!emptyNonzero&&raymarch&&m.linked
  return {status:ok?'pass':'fail',active,maxCenterError,maxGPUError,emptyNonzero,raymarch,groups,note:'actual active pool age bins, weighted positions and valid birth times; CPU bins compared against all linked GPU uniform entries'}
}
