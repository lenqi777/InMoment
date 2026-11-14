'use strict';
(() => {
  const { EditorModel,rectangle,boundedPoint,paint }=window.InMomentScreenshotModel;
  const bridge=window.inmomentScreenshot,stage=document.querySelector('#screenshot-stage'),image=document.querySelector('#screen-image'),canvas=document.querySelector('#annotation-canvas'),selection=document.querySelector('#selection'),size=document.querySelector('#selection-size'),toolbar=document.querySelector('#toolbar'),hint=document.querySelector('#selection-hint'),entry=document.querySelector('#text-entry'),error=document.querySelector('#error');
  let model,token,regionMode=false,tool='select',color='#256d49',width=3,fontSize=20,drag=null,draft=null,textAnchor=null,busy=false,errorTimer;
  let recordingStarted = false, recordingPending = false;
  const tools=new Map(),palette=document.createElement('div');palette.id='color-palette';palette.hidden=true;
  function makeButton(label,icon,action){const button=document.createElement('button');button.type='button';button.className='icon-button';button.setAttribute('aria-label',label);button.title=label;if(icon)button.dataset.uiIcon=icon==='select'?'crop':icon;button.addEventListener('click',action);return button;}
  function showError(message){error.textContent=message;error.hidden=false;clearTimeout(errorTimer);errorTimer=setTimeout(()=>error.hidden=true,4500);}
  function screenRect(){return canvas.getBoundingClientRect();}
  function scale(){return model.width/Math.max(1,screenRect().width);}
  function point(event){const rect=screenRect();return {x:(event.clientX-rect.x)*model.width/rect.width,y:(event.clientY-rect.y)*model.height/rect.height};}
  function cssRect(rect){const screen=screenRect();return {x:rect.x*screen.width/model.width,y:rect.y*screen.height/model.height,width:rect.width*screen.width/model.width,height:rect.height*screen.height/model.height};}
  function contains(point){const r=model.selection;return r&&point.x>=r.x&&point.x<=r.x+r.width&&point.y>=r.y&&point.y<=r.y+r.height;}
  function setPaletteOpen(open) {
    palette.hidden = !open;
    colorButton.setAttribute('aria-expanded', String(open));
  }
  function setTool(value){commitText();tool=value;setPaletteOpen(false);for(const[id,button]of tools)button.setAttribute('aria-pressed',String(id===tool));canvas.style.cursor=value==='text'?'text':'crosshair';}
  for (const [id, label] of [['select', '重新选区'], ['pen', '自由画笔'], ['rectangle', '矩形'], ['ellipse', '椭圆'], ['arrow', '箭头'], ['text', '文字']]) {
    const button = makeButton(label, id, () => setTool(id));
    tools.set(id, button);
    toolbar.append(button);
  }
  function setSwatchColor(button, value) {
    button.style.setProperty('--swatch-color', value);
    const isNeutral = value === '#171a1d' || value === '#ffffff';
    button.classList.toggle('color-swatch-neutral', isNeutral);
  }
  function renderColorSwatch(button, value) {
    const chip = document.createElement('span');
    chip.className = 'color-swatch-chip';
    chip.setAttribute('aria-hidden', 'true');
    button.classList.add('color-swatch');
    setSwatchColor(button, value);
    button.append(chip);
  }
  const colorControl = document.createElement('div');
  colorControl.className = 'color-control';
  const colorButton = makeButton('画笔颜色', '', () => { commitText(); setPaletteOpen(palette.hidden); });
  colorButton.setAttribute('aria-controls', 'color-palette');
  setPaletteOpen(false);
  renderColorSwatch(colorButton, color);
  colorControl.append(colorButton, palette);
  toolbar.append(colorControl);
  const colorOptions = new Map();
  for (const [value, label] of [['#256d49','绿色'],['#b42318','红色'],['#1768b4','蓝色'],['#d5a72c','黄色'],['#171a1d','黑色'],['#ffffff','白色']]) {
    const swatch = makeButton(label, '', () => {
      color = value;
      setSwatchColor(colorButton, value);
      for (const [option, button] of colorOptions) button.setAttribute('aria-pressed', String(option === value));
      setPaletteOpen(false);
      colorButton.focus({ preventScroll: true });
    });
    renderColorSwatch(swatch, value);
    swatch.setAttribute('aria-pressed', String(value === color));
    colorOptions.set(value, swatch);
    palette.append(swatch);
  }
  const widthChoice=document.createElement('select');widthChoice.id='width-choice';widthChoice.setAttribute('aria-label','画笔粗细');for(const[value,label]of [[2,'细'],[3,'中'],[6,'粗']]){const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=value===width;widthChoice.append(option);}widthChoice.addEventListener('change',()=>width=Number(widthChoice.value));toolbar.append(widthChoice);
  const fontChoice=document.createElement('select');fontChoice.id='font-choice';fontChoice.setAttribute('aria-label','文字字号');for(const value of[16,20,28]){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===fontSize;fontChoice.append(option);}fontChoice.addEventListener('change',()=>fontSize=Number(fontChoice.value));toolbar.append(fontChoice);
  const spacer=document.createElement('span');spacer.className='tool-space';toolbar.append(spacer);
  const undo=makeButton('撤销 · Ctrl+Z','undo',()=>{commitText();model.undo();redraw();}),redo=makeButton('重做 · Ctrl+Shift+Z','redo',()=>{commitText();model.redo();redraw();}),cancel=makeButton('取消截图 · Esc','close',()=>cancelCapture()),confirm=makeButton('完成截图并添加到聊天','check',()=>submitSelection());cancel.classList.add('cancel','ui-cancel');confirm.classList.add('confirm','primary','ui-confirm');toolbar.append(undo,redo,cancel,confirm);
  function positionToolbar(rect) {
    const r = cssRect(rect), gap = 12, margin = 8;
    toolbar.hidden = false;
    const box = toolbar.getBoundingClientRect();
    const left = Math.max(margin, Math.min(r.x + r.width - box.width, innerWidth - box.width - margin));
    let top = r.y + r.height + gap;
    if (top + box.height > innerHeight - margin) top = Math.max(margin, r.y - box.height - gap);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }
  function redraw() {
    if (!model) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (model.selection) {
      ctx.save();
      const r = model.selection;
      ctx.beginPath(); ctx.rect(r.x, r.y, r.width, r.height); ctx.clip();
      for (const item of model.items) paint(ctx, item);
      if (draft) paint(ctx, draft);
      ctx.restore();
    }
    const current = drag?.selection || model.selection;
    selection.hidden = !current;
    hint.hidden = Boolean(current);
    if (current) {
      const r = cssRect(current);
      Object.assign(selection.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
      size.textContent = `${current.width} × ${current.height}`;
      size.style.top = r.y < 28 ? '30px' : '6px';
      if (!drag?.selection) positionToolbar(current);
    } else toolbar.hidden = true;
    undo.disabled = !model.history.length;
    redo.disabled = !model.future.length;
    confirm.disabled = !model.selection || busy || recordingPending || (regionMode && !recordingStarted);
  }
  function beginText(point){commitText();textAnchor=boundedPoint(point,model.selection);const r=cssRect(model.selection),p=cssRect({x:textAnchor.x,y:textAnchor.y,width:0,height:0});entry.value='';entry.style.left=p.x+'px';entry.style.top=p.y+'px';entry.style.width=Math.max(40,Math.min(280,r.x+r.width-p.x))+'px';entry.style.maxHeight=Math.max(32,r.y+r.height-p.y)+'px';entry.style.color=color;entry.style.fontSize=fontSize+'px';entry.hidden=false;entry.focus();}
  function commitText(){if(!textAnchor)return;const anchor=textAnchor;textAnchor=null;const text=entry.value;entry.hidden=true;entry.value='';if(text.trim())model.add({type:'text',...anchor,text,color,width:width*scale(),fontSize:fontSize*scale()});redraw();}
  canvas.addEventListener('pointerdown',event=>{if(busy||drag||event.button!==0||!model)return;event.preventDefault();setPaletteOpen(false);commitText();canvas.focus({preventScroll:true});const p=point(event);if(tool==='select'||!model.selection){drag={pointer:event.pointerId,start:p,selection:rectangle(p,p,model.width,model.height)};toolbar.hidden=true;}else{if(!contains(p))return;if(tool==='text'){beginText(p);return;}drag={pointer:event.pointerId,start:p};draft={type:tool,color,width:width*scale(),...(tool==='pen'?{points:[p]}:{start:p,end:p})};}canvas.setPointerCapture(event.pointerId);redraw();});
  canvas.addEventListener('pointermove',event=>{if(!drag||drag.pointer!==event.pointerId)return;const p=point(event);if(drag.selection)drag.selection=rectangle(drag.start,p,model.width,model.height);else{const bounded=boundedPoint(p,model.selection);if(draft.type==='pen'){if(draft.points.length<20000)draft.points.push(bounded);}else draft.end=bounded;}redraw();});
  function endPointer(event){
    if(!drag||drag.pointer!==event.pointerId)return;
    const previous=drag;
    drag=null;
    const selected=previous.selection&&model.select(rectangle(previous.start,point(event),model.width,model.height));
    if(selected)setTool('pen');
    if(!previous.selection&&draft)model.add(draft);
    draft=null;
    if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    redraw();
    if (selected && regionMode && !recordingStarted && !recordingPending) startRecording();
  }
  function cancelPointer(event){if(drag?.pointer!==event.pointerId)return;drag=null;draft=null;redraw();}
  canvas.addEventListener('pointerup',endPointer);
  canvas.addEventListener('pointercancel',cancelPointer);
  canvas.addEventListener('lostpointercapture',cancelPointer);
  entry.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();textAnchor=null;entry.hidden=true;entry.value='';canvas.focus();}else if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();commitText();canvas.focus();}});
  entry.addEventListener('blur',()=>{if(textAnchor)commitText();});
  async function cancelCapture(){
    if(busy)return;
    busy=true;
    const pointer=drag?.pointer;
    drag=null;draft=null;
    if(pointer!==undefined&&canvas.hasPointerCapture(pointer))canvas.releasePointerCapture(pointer);
    redraw();
    await bridge.invoke('screenshot:cancel',{token}).catch(err=>{busy=false;redraw();showError(err.message);});
  }
  async function submitSelection(){
    if(busy||!model.selection||(regionMode&&!recordingStarted))return;
    commitText();busy=true;redraw();
    try { await bridge.invoke('screenshot:confirm',{token,dataUrl:flatten()}); }
    catch(err) {
      busy=false;
      redraw();showError(err.message||'截图未能提交，请重试。');
    }
  }
  async function startRecording() {
    recordingPending = true;
    redraw();
    try {
      const { x, y, width, height } = toolbar.getBoundingClientRect();
      await bridge.invoke('screenshot:record', { token, rect: model.selection, toolbar: { x, y, width, height } });
      recordingStarted = true;
    } catch (err) { showError(err.message || '录音未能启动，请重新框选。'); }
    finally { recordingPending = false; redraw(); }
  }
  function flatten(){if(!model.selection)throw new Error('请先选择截图范围。');const r=model.selection,output=document.createElement('canvas');output.width=r.width;output.height=r.height;const ctx=output.getContext('2d');ctx.drawImage(image,r.x,r.y,r.width,r.height,0,0,r.width,r.height);for(const item of model.items)paint(ctx,item,r.x,r.y);return output.toDataURL('image/png');}
  document.querySelector('#initial-cancel').classList.add('ui-cancel');
  document.querySelector('#select-all').addEventListener('click',()=>{if(regionMode||!model)return;model.select({x:0,y:0,width:model.width,height:model.height});setTool('pen');redraw();canvas.focus();});document.querySelector('#initial-cancel').addEventListener('click',()=>cancelCapture());
  document.addEventListener('keydown',event=>{if(event.target===entry)return;if(event.key==='Escape'){event.preventDefault();if(!palette.hidden){setPaletteOpen(false);colorButton.focus({preventScroll:true});return;}cancelCapture();return;}if(!model)return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?model.redo():model.undo();redraw();return;}if(event.ctrlKey||event.metaKey||event.altKey||event.target.matches('button,select,input,textarea'))return;if(event.key==='Enter'&&model.selection){event.preventDefault();submitSelection();return;}if(model.selection&&/^Arrow/.test(event.key)&&event.target===canvas){event.preventDefault();const r={...model.selection},step=event.shiftKey?10:1,dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;r.x=Math.max(0,Math.min(model.width-r.width,r.x+dx));r.y=Math.max(0,Math.min(model.height-r.height,r.y+dy));model.select(r);redraw();return;}const keys={s:'select',f:'pen',r:'rectangle',o:'ellipse',a:'arrow',t:'text'};if(keys[event.key.toLowerCase()])setTool(keys[event.key.toLowerCase()]);});
  window.addEventListener('resize',redraw);
  const ready=(async()=>{
    const data=await bridge.invoke('screenshot:init');
    token=data.token;
    regionMode=data.purpose==='region';
    if(regionMode){
      document.title='InMoment · 截图录音';
      stage.setAttribute('aria-label','截图录音');
      const instruction='拖动框选，松手即开始录音';
      canvas.setAttribute('aria-label',instruction);
      hint.querySelector('span').textContent=instruction;
      document.querySelector('#select-all').hidden=true;
      confirm.setAttribute('aria-label', '确认截图并保存到草稿');
      confirm.title = '确认截图并保存到草稿';
      cancel.setAttribute('aria-label', '取消截图，保留当前录音');
      cancel.title = '取消截图，保留当前录音';
    }
    const source=data.image;
    if(!source?.dataUrl?.startsWith('data:image/png;base64,'))throw new Error('截图未能读取，请取消后重试。');
    image.src=source.dataUrl;
    await image.decode();
    model=new EditorModel(image.naturalWidth,image.naturalHeight);
    canvas.width=model.width;canvas.height=model.height;canvas.focus();redraw();
    return data;
  })().catch(err=>{showError(err.message||'截图界面未能加载。');throw err;});
  window.InMomentScreenshotEditor={ready,get state(){return model?.snapshot();},flatten,setTool};
})();
