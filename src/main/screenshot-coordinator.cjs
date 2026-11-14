'use strict';

const { randomUUID } = require('node:crypto');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);

function pngImage(dataUrl, bounds = {}, maxBytes = MAX_BYTES) {
  if(typeof dataUrl==='string' && dataUrl.length > Math.ceil(maxBytes / 3) * 4 + 22)throw new Error(maxBytes===MAX_BYTES?'截图较大，请缩小选区后再添加。':'当前显示器截图过大，请降低分辨率后重试。');
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(dataUrl)) throw new Error('截图格式无效，请重新截取。');
  const base64 = dataUrl.slice(22);
  if (base64.length % 4) throw new Error('截图格式无效，请重新截取。');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 33 || bytes.length > maxBytes || !bytes.subarray(0,8).equals(PNG) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('截图格式无效，请重新截取。');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64000000 || width > (bounds.width || 16384) || height > (bounds.height || 16384)) throw new Error('截图尺寸无效。');
  return { id:randomUUID(), mimeType:'image/png', base64, width, height };
}

function recordingAnchor(job, selection, toolbar) {
  const { x, y, width, height } = toolbar || {};
  const bounds = job.display.bounds;
  const zoom = job.editor.webContents.getZoomFactor?.() ?? 1;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      (x + width) * zoom > bounds.width + 1 || (y + height) * zoom > bounds.height + 1) return null;
  const scaleX = bounds.width / job.image.width;
  const scaleY = bounds.height / job.image.height;
  return {
    toolbar: { x: bounds.x + x * zoom, y: bounds.y + y * zoom, width: width * zoom, height: height * zoom },
    selection: {
      x: bounds.x + selection.x * scaleX, y: bounds.y + selection.y * scaleY,
      width: selection.width * scaleX, height: selection.height * scaleY,
    },
  };
}

// A request owns its memory image, editor and restore permission until cleanup.
// Cancelling first invalidates the token so late editor/capture results stay inert.
class ScreenshotCoordinator {
  constructor({ chats, capture, createEditor, loadEditor, setBusy, prepare, restore, startRecording, getRecording, saveRecordingImage, decode = () => {}, copyImage = () => {}, isClosing = () => false }) {
    Object.assign(this,{chats,capture,createEditor,loadEditor,setBusy,prepare,restore,startRecording,getRecording,saveRecordingImage,decode,copyImage,isClosing});
    this.job = null; this.closed = false;
  }
  get busy() { return Boolean(this.job); }
  start(id, options = {}) {
    return this._start('chat', id, options);
  }
  startRegion(options = {}) {
    return this._start('region', null, options);
  }
  _start(purpose, id, options) {
    if (this.closed || this.isClosing()) return Promise.reject(new Error('应用正在退出。'));
    if (this.job) return Promise.reject(new Error('请先完成或取消当前截图。'));
    if (purpose === 'chat') {
      const chat = this.chats.get(id);
      if (!chat) return Promise.reject(new Error('聊天已关闭。'));
      if (chat.context.images.length >= 4) return Promise.reject(new Error('最多添加 4 张图片，请先移除一张。'));
    }
    let resolve, reject;
    const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
    const job = {id,purpose,token:randomUUID(),valid:true,restoreAllowed:true,options,promise,resolve,reject,editor:null,image:null,display:null,finishing:false};
    this.job = job;
    this._open(job).catch(error=>this._finish(job,null,error));
    return promise;
  }
  _live(job) { return this.job===job && job.valid && !this.closed && !this.isClosing() && (job.purpose==='region' || Boolean(this.chats.get(job.id))); }
  async _open(job) {
    await this.setBusy(true,job);
    if (!this._live(job)) return this._finish(job,{cancelled:true});
    await this.prepare(job);
    if (!this._live(job)) return this._finish(job,{cancelled:true});
    const captured = await this.capture(job);
    if (!this._live(job)) return this._finish(job,{cancelled:true});
    const image = pngImage(captured?.image?.dataUrl,{},MAX_CAPTURE_BYTES);
    this.decode(captured.image.dataUrl,image);
    if (captured.image.width!==image.width || captured.image.height!==image.height || !captured.display?.bounds || !Number.isFinite(captured.display.scaleFactor) || captured.display.scaleFactor<=0) throw new Error('截图尺寸未能读取，请重试。');
    job.image = {dataUrl:captured.image.dataUrl,width:image.width,height:image.height};
    job.capturedAt = Date.now();
    job.display = structuredClone(captured.display);
    const editor = this.createEditor(job);
    job.editor = editor;
    editor.once('closed',()=>{if(job.valid)this._finish(job,{cancelled:true});});
    editor.webContents?.once('render-process-gone',()=>{if(job.valid)this._finish(job,null,new Error('截图编辑器已退出，请重新截取。'));});
    await this.loadEditor(editor,job);
    if (!this._live(job)) return this._finish(job,{cancelled:true});
    editor.show(); editor.focus();
  }
  _authorized(event, token, init = false) {
    const job = this.job, editor = job?.editor;
    if (!job?.valid || !editor || editor.isDestroyed() || event?.sender!==editor.webContents || !event.senderFrame || event.senderFrame!==editor.webContents.mainFrame || (!init && token!==job.token)) throw new Error('截图请求已失效。');
    return job;
  }
  _recordingState(job, session = this.getRecording()) {
    if (!job.recordingId || session?.id !== job.recordingId || !session.active) throw new Error('本次录音已结束。');
    return { id: session.id };
  }
  _startRecording(job, rect, toolbar) {
    if (job.recording) return job.recording;
    const { x, y, width, height } = rect || {};
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 2 || height < 2 ||
        x + width > job.image.width || y + height > job.image.height) throw new Error('请选择有效的截图范围。');
    job.recordingAnchor = recordingAnchor(job, rect, toolbar);
    job.recording = Promise.resolve(this.startRecording(job)).then(started => {
      job.recordingId = started.id;
      return this._recordingState(job);
    }, error => {
      job.recording = null;
      throw error;
    });
    return job.recording;
  }
  async invoke(event, method, params = {}) {
    if (!['screenshot:init','screenshot:confirm','screenshot:cancel','screenshot:record'].includes(method)) throw new Error('不支持的截图操作。');
    const job = this._authorized(event,params?.token,method==='screenshot:init');
    if (method==='screenshot:init') return {token:job.token,purpose:job.purpose,image:structuredClone(job.image),display:structuredClone(job.display)};
    if (method==='screenshot:cancel') { await this._finish(job,{cancelled:true}); return true; }
    if (method==='screenshot:record') {
      if (job.purpose !== 'region' || !this._live(job)) throw new Error('本次截图无法控制录音。');
      return this._startRecording(job, params.rect, params.toolbar);
    }
    // Invalid output keeps the editor open so the user can correct or cancel.
    const image = pngImage(params.dataUrl,job.image);
    this.decode(params.dataUrl,image);
    if (!this._live(job)) { await this._finish(job,{cancelled:true}); return true; }
    let result;
    if (job.purpose==='region') {
      this._recordingState(job);
      this.saveRecordingImage(job, image);
      result = { id: job.recordingId };
    } else {
      const chat = this.chats.get(job.id);
      result = { chat: this.chats.update(job.id,{images:[...chat.context.images,{id:image.id,mimeType:image.mimeType,base64:image.base64}]}) };
    }
    await this._finish(job, result, null, image);
    return true;
  }
  async _finish(job, result, error, imageToCopy) {
    if (job.finishing) return job.finished;
    job.valid=false; job.finishing=true;
    job.finished=(async()=>{
      try { if(job.editor && !job.editor.isDestroyed()) job.editor.destroy(); }
      catch { error ||= new Error('截图编辑器未能关闭，请重试。'); }
      job.image=null; job.display=null; job.token=null;
      if (imageToCopy) {
        try { await this.copyImage(imageToCopy); }
        catch (cause) { error ||= new Error('截图已保存，复制到剪贴板失败。', { cause }); }
      }
      const canContinue = () => job.restoreAllowed && !this.closed && !this.isClosing();
      try { if(job.purpose==='chat' && canContinue() && this.chats.get(job.id)) await this.restore(job); }
      catch { error ||= new Error('截图已结束，聊天窗口未能恢复，请从主窗口返回聊天。'); }
      if (job.recording) await job.recording.catch(() => {});
      try { await this.setBusy(false,job); } catch { error ||= new Error('截图结束后未能恢复快捷操作，请重试。'); }
      if(this.job===job)this.job=null;
      if(error)job.reject(error);else job.resolve(result||{cancelled:true});
    })();
    return job.finished;
  }
  cancelChat(id) {
    const job=this.job;
    if(job?.purpose!=='chat' || job.id!==id)return Promise.resolve();
    job.restoreAllowed=false;
    return this._finish(job,{cancelled:true});
  }
  cancelRegion() {
    const job=this.job;
    if(job?.purpose!=='region')return Promise.resolve();
    job.restoreAllowed=false;
    return this._finish(job,{cancelled:true});
  }
  shutdown() {
    this.closed=true;
    if(!this.job)return Promise.resolve();
    this.job.restoreAllowed=false;
    return this._finish(this.job,{cancelled:true});
  }
}
module.exports={ScreenshotCoordinator,pngImage,MAX_BYTES,MAX_CAPTURE_BYTES};
