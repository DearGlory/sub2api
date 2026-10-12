// Explicitly synthetic checker fixtures. Never accepted as browser evidence.
// Independent piecewise linear-velocity motion; no production motion imports.
export function positiveFixture() {
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-6,1]
  const duration=6.918,up=.42,down=.12,area=duration-(up+down)/2
  const progress=t=>t<=0?0:t>=duration?1:t<up?t*t/(2*up*area):t<duration-down?(t-up/2)/area:1-(duration-t)**2/(2*down*area)
  const box=(center,size)=>({min:center.map((v,i)=>v-size[i]/2),max:center.map((v,i)=>v+size[i]/2),center,size,n:100})
  function row(t) {
    const leg=Math.floor(t/12),u=t-leg*12
    const phase=u<6.5?'travel':u<7.9?'gather':u<10.9?'hold':'scatter'
    const phaseProgress=phase==='travel'?u/6.5:phase==='gather'?(u-6.5)/1.4:phase==='hold'?(u-7.9)/3:(u-10.9)/1.1
    const moving=phase==='travel'||phase==='scatter'&&phaseProgress>.62
    const flight=phase==='scatter'?leg+1:leg,from=flight%2===0?-2.56:2.56
    const p=phase==='travel'?progress(u+.418):phase==='scatter'?progress(u-11.582):1
    const x=moving?from*(1-2*p):(leg%2===0?2.56:-2.56)
    const anchor=1.35*(leg*12+6.5)-6
    const z=moving?1.35*((flight-1)*12+6.5)-6+16.2*p:anchor
    const head=[x,0,z],camera=[0,0,16.3727-6+1.35*t],gap=camera[2]-z
    const glyphCenter=[leg%2===0?2.56:-2.56,0,anchor]
    const geometry=box(moving?head:glyphCenter,moving?[1,1,1]:[4,4,.1])
    const glyph=box(glyphCenter,[4,4,.1]), screen=box([720,450,0],[300*16.3727/gap,300*16.3727/gap,.01])
    const birth={i:0,bornAt:u+.418,clock:t,phase,progress:phaseProgress,head,world:head,actual:head,velocity:[0,0,-3],axis:[0,0,-1],emitterVelocity:[1,0,2]}
    return {t,leg,brand:'fixture-'+leg,phase,progress:phaseProgress,head,camera,gap,fitGap:16.3727,geometry,glyph,projected:screen,glyphProjected:screen,headGeometryMaxError:moving?0:null,
      matrices:{body:matrix,tail:matrix,camera:matrix,projection:matrix},births:{count:moving?1:0,examples:moving?[birth]:[],errors:[],inertiaErrors:[]},drawCalls:4}
  }
  const data={meta:{headSource:'choreography.state.headX/headY/headZ + points.matrixWorld',glyphSource:'scratch.glyphTargets + points.matrixWorld',geometrySource:'points.geometry.attributes.position + points.matrixWorld',cameraSource:'camera.matrixWorld actual position',geometryBytes:1000000},gpu:[{attributes:{position:{exactGPU:true},color:{exactGPU:true},cometScale:{exactGPU:true}},pointScaleOnly:true},{attributes:{position:{exactGPU:true},color:{exactGPU:true}}}],samples:[],pairs:[],arrivals:[]}
  for(let i=1;i<600;i++) data.samples.push(row(i/10))
  for(let leg=1;leg<=4;leg++) {
    const t=leg*12
    data.pairs.push({before:row(t+7.8999),enter:row(t+7.90001),start:row(t+7.9001),end:row(t+10.8999),exit:row(t+10.90001),png:{start:'SYNTHETIC',end:'SYNTHETIC',aligned:true}})
    data.arrivals.push(row(t+6.50001))
  }
  data.cameraBoundary=[149.9,150,150.1,151,152.1,152.2,152.3].map(row)
  return data
}
