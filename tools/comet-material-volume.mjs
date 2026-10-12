// Adapter for the observed volume shader layouts. Unknown layouts are instrument-invalid.
// Births are read from the preserved live pool; uniform arrays are read from the linked GPU.
const finite = Number.isFinite
const array20 = (value,n,slots) => Array.isArray(value)&&value.length===n&&value.every(v=>Array.isArray(v)&&v.length===slots&&v.every(finite))
const flat4 = value => ArrayBuffer.isView(value)||Array.isArray(value) ? Array.from(value) : null

export function volumeProvenance(object,geometry) {
  const m=object.materials?.find(m=>/#define IS_COMA 0\b/.test(m.fragment||''))
  if(!m)return {status:'instrument-invalid',reason:'unrecognized actual tail shader layout'}
  const bins=flat4(m.uniforms?.uBins),density=flat4(m.uniforms?.uDensities)
  const axes=flat4(m.uniforms?.uBinAxes),gpuBins=m.gpuUniforms?.['uBins[0]'],gpuAxes=m.gpuUniforms?.['uBinAxes[0]'],gpuDensity=m.gpuUniforms?.['uDensities[0]']
  const births=geometry?.tail?.births
  if(!bins||!density||!births||!Array.isArray(gpuBins)||!Array.isArray(gpuDensity))return {status:'instrument-invalid',reason:'missing full GPU arrays or actual pool'}
  const n=density.length
  if(n!==20||bins.length!==n*4||!array20(gpuBins,n,4)||gpuDensity.length!==n)return {status:'instrument-invalid',reason:'unsupported uniform array layout'}
  const legacy=!axes&&!gpuAxes
  const shader=m.fragment||''
  if(legacy)return /vec3\s+d\s*=\s*\(p-uBins\[j\]\.xyz\)\s*\/\s*max\(uBins\[j\]\.w/.test(shader)
    ? {status:'fail',reason:'legacy spherical volume layout; uBinAxes absent',layout:'legacy-spherical'}
    : {status:'instrument-invalid',reason:'unknown volume shader layout'}
  if(!axes||axes.length!==n*4||!array20(gpuAxes,n,4))return {status:'instrument-invalid',reason:'anisotropic axes GPU array missing or malformed'}
  const anisotropic=/uniform\s+vec4\s+uBinAxes\[20\]/.test(shader)&&/uBinAxes\[j\]\.xyz/.test(shader)&&/uBinAxes\[j\]\.w/.test(shader)&&/uBins\[j\]\.w/.test(shader)
    &&/dot\(d,axis\)/.test(shader)&&/d-axis\*along/.test(shader)&&/r2-s\*s/.test(shader)
  if(!anisotropic)return {status:'instrument-invalid',reason:'unrecognized anisotropic shader layout'}
  const groups=Array.from({length:n},()=>({mass:0,weighted:[0,0,0],ageMass:0,count:0,birthMin:Infinity,birthMax:-Infinity}))
  const samples=[]
  let invalidBirth=0
  for(const b of births){
    if(!finite(b?.birthTime)||b.birthTime<0||!finite(b?.age)||b.age<0||!finite(b?.life)||b.life<=0||!Array.isArray(b.position)||b.position.length!==3||!b.position.every(finite)){invalidBirth++;continue}
    // Newborns and expired slots have zero extinction; they are valid lifecycle states.
    if(b.age===0||b.age>=b.life)continue
    const index=Math.min(n-1,Math.floor(b.age/3.2*n)),g=groups[index],w=(1-b.age/b.life)**1.7*Math.min(1,b.age/.035)
    if(!(w>0&&finite(w))){invalidBirth++;continue}
    g.mass+=w;g.count++;g.ageMass+=b.age*w;g.birthMin=Math.min(g.birthMin,b.birthTime);g.birthMax=Math.max(g.birthMax,b.birthTime)
    for(let j=0;j<3;j++)g.weighted[j]+=b.position[j]*w
    samples.push({index,position:b.position,weight:w})
  }
  const moments=Array.from({length:n},()=>[0,0,0,0,0,0])
  for(const {index,position,weight} of samples){
    const g=groups[index],mean=g.weighted.map(v=>v/g.mass),d=position.map((v,j)=>v-mean[j]),c=moments[index]
    c[0]+=weight*d[0]*d[0];c[1]+=weight*d[1]*d[1];c[2]+=weight*d[2]*d[2]
    c[3]+=weight*d[0]*d[1];c[4]+=weight*d[0]*d[2];c[5]+=weight*d[1]*d[2]
  }
  let maxCenterError=0,maxGPUError=0,active=0,emptyNonzero=0,axisInvalid=0,geometryMismatch=0,birthProvenance=0
  for(let i=0;i<n;i++){
    const g=groups[i],k=i*4
    if(g.mass>0){
      active++;birthProvenance+=g.count
      const mean=g.weighted.map(v=>v/g.mass)
      for(let j=0;j<3;j++)maxCenterError=Math.max(maxCenterError,Math.abs(bins[k+j]-mean[j]))
      if(!(bins[k+3]>0&&density[i]>0))emptyNonzero++
      // Independently derive flow from adjacent occupied birth centroids, not reported axes.
      let prev=i-1,next=i+1
      while(prev>=0&&groups[prev].mass<=0)prev--
      while(next<n&&groups[next].mass<=0)next++
      const p=prev>=0?prev:i,q=next<n?next:i
      const pm=groups[p].weighted.map(v=>v/groups[p].mass),qm=groups[q].weighted.map(v=>v/groups[q].mass)
      const flow=qm.map((v,j)=>v-pm[j]),flowLength=Math.hypot(...flow)
      const reportedAxis=axes.slice(k,k+3),c=moments[i].map(v=>v/g.mass)
      let ax,ay,az
      if(flowLength>=1e-5){ax=flow[0]/flowLength;ay=flow[1]/flowLength;az=flow[2]/flowLength}
      else {
        ax=1;ay=0;az=0
        for(let iteration=0;iteration<12;iteration++){
          const vx=c[0]*ax+c[3]*ay+c[4]*az,vy=c[3]*ax+c[1]*ay+c[5]*az,vz=c[4]*ax+c[5]*ay+c[2]*az,norm=Math.hypot(vx,vy,vz)
          if(norm<1e-8)break
          ax=vx/norm;ay=vy/norm;az=vz/norm
        }
      }
      const axis=[ax,ay,az]
      const along=Math.max(0,ax*ax*c[0]+ay*ay*c[1]+az*az*c[2]+2*(ax*ay*c[3]+ax*az*c[4]+ay*az*c[5]))
      const transverse=Math.max(0,c[0]+c[1]+c[2]-along),age=g.ageMass/g.mass
      const width=Math.min(1.15,.12+age*.045+1.15*Math.sqrt(transverse*.5))
      const before=Math.hypot(...mean.map((v,j)=>v-pm[j])),after=Math.hypot(...mean.map((v,j)=>v-qm[j]))
      const length=Math.min(4.5,Math.max(width*1.5,2.2*Math.sqrt(Math.max(0,along)),Math.max(before,after)*1.3))
      const axisDot=Math.abs(reportedAxis[0]*ax+reportedAxis[1]*ay+reportedAxis[2]*az)
      if(axisDot<.99)geometryMismatch++
      if(Math.abs(bins[k+3]-width)>2e-4||Math.abs(axes[k+3]-length)>2e-4)geometryMismatch++
    }else if(density[i]!==0)emptyNonzero++
    const norm=Math.hypot(axes[k],axes[k+1],axes[k+2])
    if(g.mass>0&&(!finite(norm)||Math.abs(norm-1)>2e-3||!(axes[k+3]>0&&finite(axes[k+3]))||!(bins[k+3]>0&&finite(bins[k+3])))||g.mass<=0&&(density[i]!==0||axes[k+3]!==0||bins[k+3]!==0))axisInvalid++
    for(let j=0;j<4;j++){maxGPUError=Math.max(maxGPUError,Math.abs(bins[k+j]-gpuBins[i][j]),Math.abs(axes[k+j]-gpuAxes[i][j]))}
    maxGPUError=Math.max(maxGPUError,Math.abs(density[i]-gpuDensity[i]))
  }
  const raymarch=/density\(p\)/.test(shader)&&/uCameraFrame\s*\+\s*ray/.test(shader)&&/1\.0\s*-\s*exp\(/.test(shader)&&/p-uBins\[j\]\.xyz/.test(shader)
  const ok=active>0&&invalidBirth===0&&birthProvenance>0&&maxCenterError<1e-4&&maxGPUError<1e-6&&!emptyNonzero&&!axisInvalid&&!geometryMismatch&&raymarch&&anisotropic&&m.linked
  return {status:ok?'pass':'fail',layout:'anisotropic',active,birthProvenance,invalidBirth,maxCenterError,maxGPUError,emptyNonzero,axisInvalid,geometryMismatch,raymarch,anisotropic,groups,note:'independent active-pool age bins, birth provenance, CPU/GPU centers+density+axes, covariance-derived flow/width/length, finite positive radii and unit axes'}
}
