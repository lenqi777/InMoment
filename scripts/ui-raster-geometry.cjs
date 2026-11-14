'use strict';
const fs = require('node:fs');
const { inflateSync } = require('node:zlib');

// Decode our own Electron captures for read-only measurements. These captures
// use non-interlaced, 8-bit RGB/RGBA PNGs; unsupported formats fail visibly.
function readCapturedPng(filename) {
  const png=fs.readFileSync(filename),width=png.readUInt32BE(16),height=png.readUInt32BE(20),type=png[25];
  if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png[24]!==8 || ![2,6].includes(type) || png[28]!==0)throw new Error('Unsupported capture PNG format.');
  const channels=type===6?4:3,stride=width*channels,chunks=[];
  for(let offset=8;offset+12<=png.length;){const length=png.readUInt32BE(offset),tag=png.toString('ascii',offset+4,offset+8);if(offset+12+length>png.length)throw new Error('Truncated capture PNG.');if(tag==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
  const raw=inflateSync(Buffer.concat(chunks));if(raw.length!==(stride+1)*height)throw new Error('Capture PNG rows do not match its dimensions.');
  const data=Buffer.alloc(stride*height);const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];if(filter>4)throw new Error('Invalid capture PNG row filter.');for(let x=0;x<stride;x++){const at=y*stride+x,a=x>=channels?data[at-channels]:0,b=y?data[at-stride]:0,c=y&&x>=channels?data[at-stride-channels]:0;const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);data[at]=(raw[y*(stride+1)+1+x]+predictor)&255;}}
  return {data,width,height,channels,format:'rgba'};
}
function checkboxInk(image,box,scale) {
  const {data,width,height,channels=4,format='bgra'}=image,mask=new Set();
  const left=Math.max(0,Math.floor(box.left*scale)),right=Math.min(width,Math.ceil(box.right*scale)),top=Math.max(0,Math.floor(box.top*scale)),bottom=Math.min(height,Math.ceil(box.bottom*scale));
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const at=(y*width+x)*channels,r=data[at+(format==='bgra'?2:0)],g=data[at+1],b=data[at+(format==='bgra'?0:2)],alpha=channels===4?data[at+3]:255;const ink=(Math.max(r,g,b)-Math.min(r,g,b)<28&&Math.max(r,g,b)<205)||(r<120&&g>70&&b<160&&g>r*1.2);if(alpha>=200&&ink)mask.add(y*width+x);}
  // Adjacent title glyphs can touch the rounded pixel edge of a 32px hit frame.
  // Measure the connected checkbox contour, rather than unioning unrelated ink.
  const components=[];
  while(mask.size){const first=mask.values().next().value,queue=[first];mask.delete(first);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,pixels=0;for(let head=0;head<queue.length;head++){const at=queue[head],x=at%width,y=Math.floor(at/width);pixels++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const key=(y+dy)*width+x+dx;if(x+dx>=left&&x+dx<right&&y+dy>=top&&y+dy<bottom&&mask.delete(key))queue.push(key);}}components.push({pixels,minX,minY,maxX,maxY});}
  // A 1px rounded outline can split at antialiased corners. Keep its nearby
  // segments together, while a neighboring title lies outside this contour.
  const nearby=components.filter(item=>Math.abs((item.minX+item.maxX+1)/2/scale-box.cx)<=10 && Math.abs((item.minY+item.maxY+1)/2/scale-box.cy)<=10);
  if(!nearby.length)return null;
  const pixels=nearby.reduce((sum,item)=>sum+item.pixels,0),minX=Math.min(...nearby.map(item=>item.minX)),minY=Math.min(...nearby.map(item=>item.minY)),maxX=Math.max(...nearby.map(item=>item.maxX)),maxY=Math.max(...nearby.map(item=>item.maxY));return {pixels,components:components.length,contourSegments:nearby.length,width:(maxX-minX+1)/scale,height:(maxY-minY+1)/scale,centerX:(minX+maxX+1)/2/scale,centerY:(minY+maxY+1)/2/scale};
}
module.exports={readCapturedPng,checkboxInk};
