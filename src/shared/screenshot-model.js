'use strict';
((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.InMomentScreenshotModel = api;
})(typeof window === 'object' ? window : globalThis, () => {
  const copy = value => structuredClone(value);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));
  function rectangle(a, b, width, height) {
    const left = Math.floor(clamp(Math.min(a.x, b.x), 0, width)), top = Math.floor(clamp(Math.min(a.y, b.y), 0, height));
    return { x:left, y:top, width:Math.max(0, Math.ceil(clamp(Math.max(a.x,b.x),0,width))-left), height:Math.max(0, Math.ceil(clamp(Math.max(a.y,b.y),0,height))-top) };
  }
  function boundedPoint(point, rect) { return { x:clamp(point.x,rect.x,rect.x+rect.width),y:clamp(point.y,rect.y,rect.y+rect.height) }; }
  class EditorModel {
    constructor(width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || width*height>120000000) throw new Error('截图尺寸无效。');
      this.width=width;this.height=height;this.selection=null;this.items=[];this.history=[];this.future=[];
    }
    snapshot() { return { selection:copy(this.selection),items:copy(this.items) }; }
    save() { this.history.push(this.snapshot());if(this.history.length>100)this.history.shift();this.future=[]; }
    select(rect) {
      const next=rectangle({x:rect.x,y:rect.y},{x:rect.x+rect.width,y:rect.y+rect.height},this.width,this.height);
      if(next.width<2||next.height<2)return false;
      if(JSON.stringify(next)===JSON.stringify(this.selection))return false;
      this.save();this.selection=next;return true;
    }
    add(item) {
      if(!this.selection||!['pen','highlighter','rectangle','ellipse','arrow','text'].includes(item?.type))return false;
      if(this.items.length>=500)throw new Error('标注较多，请先完成这张截图。');
      const next=copy(item);next.color=/^#[0-9a-f]{6}$/iu.test(next.color)?next.color:'#256d49';next.width=clamp(next.width,.5,100);
      if(next.type==='text'){next.text=String(next.text||'').slice(0,4000);if(!next.text.trim())return false;next.fontSize=clamp(next.fontSize,8,160);Object.assign(next,boundedPoint(next,this.selection));}
      else if(next.type==='pen'||next.type==='highlighter'){if(!Array.isArray(next.points)||!next.points.length)return false;next.points=next.points.slice(0,20000).map(point=>boundedPoint(point,this.selection));}
      else {next.start=boundedPoint(next.start||{},this.selection);next.end=boundedPoint(next.end||{},this.selection);if(Math.hypot(next.end.x-next.start.x,next.end.y-next.start.y)<1)return false;}
      this.save();this.items.push(next);return true;
    }
    undo() { if(!this.history.length)return false;this.future.push(this.snapshot());Object.assign(this,this.history.pop());return true; }
    redo() { if(!this.future.length)return false;this.history.push(this.snapshot());Object.assign(this,this.future.pop());return true; }
  }
  function paint(context, item, offsetX=0, offsetY=0) {
    context.save();context.translate(-offsetX,-offsetY);context.strokeStyle=item.color;context.fillStyle=item.color;context.lineWidth=item.width;context.lineCap='round';context.lineJoin='round';
    if(item.type==='text'){context.font=`${item.fontSize}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;context.textBaseline='top';String(item.text).split('\n').forEach((line,index)=>context.fillText(line,item.x,item.y+index*item.fontSize*1.4));}
    else if(item.type==='pen'||item.type==='highlighter') {if(item.type==='highlighter')context.globalAlpha*=.32;const points=item.points;if(points.length===1){context.beginPath();context.arc(points[0].x,points[0].y,item.width/2,0,Math.PI*2);context.fill();}else{context.beginPath();context.moveTo(points[0].x,points[0].y);for(const point of points.slice(1))context.lineTo(point.x,point.y);context.stroke();}}
    else {const a=item.start,b=item.end,x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);context.beginPath();if(item.type==='rectangle')context.rect(x,y,w,h);else if(item.type==='ellipse')context.ellipse(x+w/2,y+h/2,Math.max(.1,w/2),Math.max(.1,h/2),0,0,Math.PI*2);else{context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);const angle=Math.atan2(b.y-a.y,b.x-a.x),head=Math.max(8,item.width*3);context.moveTo(b.x-head*Math.cos(angle-.55),b.y-head*Math.sin(angle-.55));context.lineTo(b.x,b.y);context.lineTo(b.x-head*Math.cos(angle+.55),b.y-head*Math.sin(angle+.55));}context.stroke();}
    context.restore();
  }
  return { EditorModel,rectangle,boundedPoint,paint };
});
