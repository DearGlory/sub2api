import fs from 'node:fs/promises'
import { decodePng, encodePng } from '../tail-probe-lib/png.mjs'

export async function saveAlignedShot(cdp, sample, path) {
  const raw=Buffer.from(await cdp.shot(),'base64')
  await fs.writeFile(path,raw)
  const img=decodePng(raw), rgb=Buffer.alloc(img.w*img.h*3)
  for(let i=0;i<img.w*img.h;i++) for(let c=0;c<3;c++) rgb[i*3+c]=img.data[i*img.chans+c]
  const sx=img.w/sample.viewport[0],sy=img.h/sample.viewport[1]
  const dot=(p,color)=>{const x=Math.round(p[0]*sx),y=Math.round(p[1]*sy);for(let d=-2;d<=2;d++) for(const [px,py] of [[x+d,y],[x,y+d]]) if(px>=0&&py>=0&&px<img.w&&py<img.h) for(let c=0;c<3;c++) rgb[(py*img.w+px)*3+c]=color[c]}
  for(const a of sample.anchors) dot(a.screen,[0,255,90])
  for(const a of sample.geometryPoints) dot(a.screen,[255,40,190])
  const overlay=path.replace(/\.png$/,'.anchors.png')
  await fs.writeFile(overlay,encodePng(img.w,img.h,rgb))
  return {path,overlay,width:img.w,height:img.h,phase:sample.phase,brand:sample.brand,t:sample.t,anchorCount:sample.anchors.length,geometryCount:sample.geometryPoints.length}
}
