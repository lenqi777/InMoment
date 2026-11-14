'use strict';

// Interactive Windows verification. Synthetic mode uses audit-owned window
// images and generated PCM while exercising the real global shortcut and UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkButtonStates, checkButtonCorners, checkButtonRow } = require('./ui-audit-button-states.cjs');

const synthetic = process.env.INMOMENT_SYNTHETIC_CAPTURE_TEST === '1';
if (process.platform !== 'win32' || (!synthetic && process.env.INMOMENT_HARDWARE_CAPTURE_TEST !== '1')) {
  throw new Error('Set INMOMENT_SYNTHETIC_CAPTURE_TEST=1 in an interactive Windows session to run the shortcut and annotation audit.');
}
const { _electron } = require(process.env.INMOMENT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.local', 'region-hardware-qa');
fs.mkdirSync(output, { recursive: true });
const run = fs.mkdtempSync(path.join(output, 'hardware-'));
const dataDir = path.join(run, 'data');
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ inputEnabled: false, captureScreenshots: false, cloudEnabled: false, autoTitleEnabled: false }));
const env = { ...process.env, INMOMENT_DATA_DIR: dataDir, INMOMENT_DISABLE_NETWORK: '1', INMOMENT_ASR_DIR: path.join(run, 'no-asr') };
delete env.INMOMENT_SMOKE;
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const packaged = process.env.INMOMENT_SMOKE_EXECUTABLE;
const report = { executable: packaged || require('electron'), displays: [], checks: [], errors: [], screenshots: [], noModelOrApi: true, synthetic };
let app, main;

// This helper verifies the physical cursor target and foreground HWND before
// injecting the global shortcut. It sends no input to any unrelated window.
const sendHotkey = String.raw`
import ctypes as c, ctypes.wintypes as w, json, sys, time
u=c.WinDLL('user32',use_last_error=True)
u.SetProcessDpiAwarenessContext(c.c_void_p(-4))
u.GetForegroundWindow.restype=w.HWND
u.WindowFromPoint.argtypes=[w.POINT]
u.WindowFromPoint.restype=w.HWND
u.GetAncestor.argtypes=[w.HWND,w.UINT]
u.GetAncestor.restype=w.HWND
u.GetWindowRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
targets=json.loads(sys.argv[1]); target=int(sys.argv[2]); function_key=int(sys.argv[3]); full_coverage=sys.argv[4]=='1'
for item in targets:
    hwnd=int(item['handle']); r=w.RECT()
    # Real capture needs every edge covered; synthetic capture reads the fixture window only.
    samples=item['samples'] if full_coverage else item['samples'][-1:]
    def covered():
        if not u.GetWindowRect(hwnd,c.byref(r)): return False
        return all(r.left<=x<r.right and r.top<=y<r.bottom and u.GetAncestor(u.WindowFromPoint(w.POINT(x,y)),2)==hwnd for x,y in samples)
    for i in range(40):
        if covered(): break
        time.sleep(.025)
    else: raise RuntimeError('Audit fixture no longer covers a display')
    if hwnd==target: cursor=((r.left+r.right)//2,(r.top+r.bottom)//2)
if not u.SetCursorPos(*cursor) or u.GetAncestor(u.WindowFromPoint(w.POINT(*cursor)),2)!=target:
    raise RuntimeError('Audit cursor target is unavailable')
class KEYBDINPUT(c.Structure):
    _fields_=[('vk',w.WORD),('scan',w.WORD),('flags',w.DWORD),('time',w.DWORD),('extra',c.c_size_t)]
class MOUSEINPUT(c.Structure):
    _fields_=[('dx',w.LONG),('dy',w.LONG),('data',w.DWORD),('flags',w.DWORD),('time',w.DWORD),('extra',c.c_size_t)]
class DATA(c.Union):
    _fields_=[('key',KEYBDINPUT),('mouse',MOUSEINPUT)]
class INPUT(c.Structure):
    _fields_=[('kind',w.DWORD),('data',DATA)]
if u.GetForegroundWindow()!=target:
    click=(INPUT*2)(*(INPUT(0,DATA(mouse=MOUSEINPUT(0,0,0,flags,0,0))) for flags in [2,4]))
    if u.SendInput(len(click),click,c.sizeof(INPUT))!=len(click): raise RuntimeError('Windows rejected focus click in the audit window')
    for i in range(50):
        if u.GetForegroundWindow()==target: break
        time.sleep(.01)
if u.GetForegroundWindow()!=target or u.GetAncestor(u.WindowFromPoint(w.POINT(*cursor)),2)!=target:
    raise RuntimeError('Audit fixture lost foreground ownership')
events=(INPUT*6)(*(INPUT(1,DATA(key=KEYBDINPUT(key,0,flags,0,0))) for key,flags in [(0x11,0),(0x10,0),(function_key,0),(function_key,2),(0x10,2),(0x11,2)]))
if u.SendInput(len(events),events,c.sizeof(INPUT))!=len(events): raise RuntimeError('Windows rejected the audit shortcut')
`;

function bootstrap() { return main.evaluate(() => window.inmoment.invoke('app:bootstrap')); }
function uiCall(method, params = {}) { return main.evaluate(([method, params]) => window.inmoment.invoke(method, params), [method, params]); }
function waitSession(state) { return main.waitForFunction(state => globalThis.auditCaptureSession?.state === state, state, { timeout: 8000, polling: 40 }); }

async function installSyntheticDevices() {
  await app.evaluate(({ app, screen, clipboard, nativeImage }) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path');
    const { ScreenshotCoordinator } = require(path.join(app.getAppPath(), 'src/main/screenshot-coordinator.cjs'));
    const { CaptureController } = require(path.join(app.getAppPath(), 'src/main/capture-controller.cjs'));
    globalThis.auditClipboard = [];
    clipboard.write = async ([item]) => {
      const png = await item.getType('image/png');
      const bytes = Buffer.from(await png.arrayBuffer());
      const image = nativeImage.createFromBuffer(bytes);
      globalThis.auditClipboard.push({ size: image.getSize(), pixels: image.toBitmap().toString('base64'), base64: bytes.toString('base64') });
    };
    const open = ScreenshotCoordinator.prototype._open;
    ScreenshotCoordinator.prototype._open = function (job) {
      this.capture = async ({ options }) => {
        const target = options.display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const fixture = globalThis.auditFixtures.find(({ display }) => display.id === target.id);
        if (!fixture) throw new Error('Generated screen fixture unavailable.');
        const picture = await fixture.window.webContents.capturePage();
        return { image: { dataUrl: picture.toDataURL(), ...picture.getSize() }, display: { bounds: fixture.display.bounds, scaleFactor: fixture.display.scaleFactor } };
      };
      return open.call(this, job);
    };

    const prepare = CaptureController.prototype.prepare;
    const wired = new WeakSet();
    globalThis.auditRecorderPrepares = 0;
    CaptureController.prototype.prepare = function (token, mode) {
      globalThis.auditRecorderPrepares++;
      if (!wired.has(this)) {
        wired.add(this);
        this.sendRecorder = message => setImmediate(() => {
          if (message.command === 'prepare') {
            if (globalThis.auditMicDenied) {
              this.microphoneFailed({ token: message.token, code: 'NotAllowedError' });
              return;
            }
            if (!this.microphoneReady({ token: message.token, sampleRate: 16000 }).allowed) return;
            const pcm = Int16Array.from({ length: 6400 }, (_, index) => Math.round(2000 * Math.sin(index * 2 * Math.PI * 180 / 16000)));
            this.audioChunk({ token: message.token, pcm: pcm.buffer });
          } else if (message.command === 'stop') this.segmentStopped({ token: message.token, reason: message.reason });
          else if (message.command === 'stopAll') {
            for (const stop of this.stops.values()) this.segmentStopped({ token: stop.token, reason: 'test-end' });
          }
        });
      }
      return prepare.call(this, token, mode);
    };
  });
}

async function coverDisplays() {
  const displays = await app.evaluate(async ({ BrowserWindow, screen }) => {
    for (const fixture of globalThis.auditFixtures || []) fixture.window.destroy();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) window.hide();
    const colors = ['#315d8c', '#8e563d', '#784695', '#3e724e'];
    globalThis.auditFixtures = await Promise.all(screen.getAllDisplays().map(async (display, index) => {
      const color = colors[index % colors.length];
      const window = new BrowserWindow({ ...display.bounds, show: false, frame: false, fullscreen: true, fullscreenable: true, roundedCorners: false, autoHideMenuBar: true, backgroundColor: color, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true } });
      const html = `<meta charset="utf-8"><title>InMoment 显示器测试 ${index + 1}</title><body style="margin:0;background:${color};color:white;font:30px Segoe UI"><p style="margin:32px">InMoment 测试画面 ${index + 1}</p>`;
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      window.show();
      return { window, display, color };
    }));
    return globalThis.auditFixtures.map(({ window, display, color }) => {
      const { x, y, width, height } = display.bounds;
      const samples = [[x+5,y+5],[x+width-6,y+5],[x+5,y+height-6],[x+width-6,y+height-6],[x+Math.floor(width/2),y+Math.floor(height/2)]]
        .map(([x,y]) => { const point = screen.dipToScreenPoint({ x, y }); return [point.x, point.y]; });
      return { id:display.id, bounds:display.bounds, scaleFactor:display.scaleFactor, color, handle:window.getNativeWindowHandle().readBigUInt64LE().toString(), samples };
    });
  });
  report.displays = displays.map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor }));
  return displays;
}

async function locateEditor() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const editor = app.windows().find(page => !page.isClosed() && page.url().includes('/screenshot/'));
    if (editor) return editor;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

async function openEditor(displays, index, functionKey = 0x78) {
  const target = displays[index];
  await app.evaluate(({ BrowserWindow }, index) => {
    const fixture = globalThis.auditFixtures[index].window;
    for (const window of BrowserWindow.getAllWindows()) if (!globalThis.auditFixtures.some(item => item.window === window)) window.hide();
    for (const item of globalThis.auditFixtures) item.window.showInactive();
    fixture.show(); fixture.focus();
  }, index);
  try {
    execFileSync('python', ['-c', sendHotkey, JSON.stringify(displays.map(({ handle, samples }) => ({ handle, samples }))), target.handle, String(functionKey), synthetic ? '0' : '1'], { windowsHide: true, timeout: 6000, stdio: 'pipe' });
  } catch (error) { throw new Error(error.stderr?.toString().trim().split('\n').at(-1) || 'Windows did not send the audit shortcut.'); }
  const editor = await locateEditor();
  if (!editor) {
    const feedback = await main.evaluate(() => globalThis.auditErrors.slice(-4));
    const binding = await app.evaluate(({ globalShortcut }, shortcut) => globalShortcut.isRegistered(shortcut), `Ctrl+Shift+F${functionKey - 0x6f}`);
    throw new Error('系统快捷键没有打开截图编辑器。' + JSON.stringify({ binding, feedback }));
  }
  await editor.waitForFunction(() => window.InMomentScreenshotEditor?.state);
  const frame = await editor.evaluate(async () => {
    const { purpose, display } = await window.InMomentScreenshotEditor.ready;
    const image = document.querySelector('#screen-image');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, Math.floor(image.naturalWidth / 2), Math.floor(image.naturalHeight / 2), 1, 1, 0, 0, 1, 1);
    return { purpose, display, width:image.naturalWidth, height:image.naturalHeight, rgb:[...context.getImageData(0, 0, 1, 1).data].slice(0,3), viewport:[innerWidth,innerHeight] };
  });
  assert.equal(frame.purpose, 'region');
  assert.deepEqual(frame.display.bounds, target.bounds);
  assert.equal(frame.display.scaleFactor, target.scaleFactor);
  const expected = target.color.slice(1).match(/../gu).map(value => parseInt(value, 16));
  assert.ok(frame.rgb.every((value,i) => Math.abs(value - expected[i]) <= 5), 'Captured monitor must show the owned test pattern');
  assert.ok(Math.abs(frame.viewport[0] - target.bounds.width) <= 1 && Math.abs(frame.viewport[1] - target.bounds.height) <= 1, 'Fullscreen editor must cover the selected display');
  return { editor, frame };
}

async function selectAndStart(editor, frame) {
  await editor.mouse.move(96, 120);
  await editor.mouse.down();
  await editor.mouse.move(312, 272, { steps: 8 });
  const selection = await editor.locator('#selection-size').evaluate(label => {
    const [width, height] = label.textContent.split(' × ').map(Number);
    return { width, height };
  });
  assert.ok(Math.abs(selection.width - 216 * frame.width / frame.viewport[0]) <= 2 && Math.abs(selection.height - 152 * frame.height / frame.viewport[1]) <= 2, 'Drag must map to captured pixels');
  assert.equal((await bootstrap()).drafts.length, 0, 'Holding a selection must not open the microphone');
  assert.equal(await editor.locator('#toolbar').isVisible(), false);
  await editor.mouse.up().catch(error => { if (!editor.isClosed()) throw error; });
  return selection;
}

async function escapeEditor(editor) {
  await editor.keyboard.press('Escape').catch(error => { if (!editor.isClosed()) throw error; });
  if (!editor.isClosed()) await editor.waitForEvent('close');
}

async function verifyDraftCrop(id, selection, expected) {
  const draft = await uiCall('records:get', { id });
  assert.equal(draft.screenshots.length, 1);
  assert.equal(draft.screenshot.role, 'region');
  const dimensions = await main.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode(); return [image.naturalWidth, image.naturalHeight];
  }, draft.screenshot.url);
  assert.deepEqual(dimensions, [selection.width, selection.height]);
  const stored = fs.readFileSync(path.join(dataDir, 'drafts', id, `screenshot-${draft.screenshot.id}.png`));
  assert.deepEqual(stored, Buffer.from(expected.slice(22), 'base64'), 'The draft retains the rendered selection and annotation pixels');
}

async function verifyClipboard(dataUrl, count) {
  if (!synthetic) return;
  for (let attempt = 0; attempt < 30 && await clipboardCount() < count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  const result = await app.evaluate(({ nativeImage }, url) => {
    const image = nativeImage.createFromDataURL(url);
    const actual = globalThis.auditClipboard.at(-1);
    return { count: globalThis.auditClipboard.length, size: actual?.size, expected: image.getSize(), pixelsEqual: actual?.pixels === image.toBitmap().toString('base64'), bytesEqual: actual?.base64 === url.slice(22) };
  }, dataUrl);
  assert.equal(result.count, count);
  assert.deepEqual(result.size, result.expected);
  assert.equal(result.pixelsEqual, true);
  assert.equal(result.bytesEqual, true);
}

const clipboardCount = () => synthetic ? app.evaluate(() => globalThis.auditClipboard.length) : 0;

const dragOwnedOverlay = String.raw`
import ctypes as c, ctypes.wintypes as w, json, sys, time
u=c.WinDLL('user32',use_last_error=True)
u.SetProcessDpiAwarenessContext(c.c_void_p(-4))
u.WindowFromPoint.argtypes=[w.POINT]; u.WindowFromPoint.restype=w.HWND
u.GetAncestor.argtypes=[w.HWND,w.UINT]; u.GetAncestor.restype=w.HWND
u.GetWindowRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
u.mouse_event.argtypes=[w.DWORD,w.DWORD,w.DWORD,w.DWORD,c.c_size_t]
p=json.loads(sys.argv[1]); hwnd=int(p['target']); start=p['start']; end=p['end']
def owner(xy): return u.GetAncestor(u.WindowFromPoint(w.POINT(*xy)),2)
if p.get('editor') and owner(p['behind'])!=int(p['editor']):
    raise RuntimeError('The editor cannot receive clicks at '+str(p['behind'])+', owner '+str(owner(p['behind']))+', overlay '+str(hwnd)+', editor '+p['editor'])
if owner(start)!=hwnd:
    rect=w.RECT(); u.GetWindowRect(hwnd,c.byref(rect))
    actual=owner(start)
    classname=c.create_unicode_buffer(128)
    if actual: u.GetClassNameW(w.HWND(actual),classname,len(classname))
    raise RuntimeError('Drag start is not owned by the audit window: '+json.dumps({'point':start,'expected':str(hwnd),'actual':str(actual),'class':classname.value,'visible':bool(u.IsWindowVisible(w.HWND(hwnd))),'rect':[rect.left,rect.top,rect.right,rect.bottom],'windows':p.get('windows')}))
if not p['moveWindow'] and owner(end)!=hwnd: raise RuntimeError('The screenshot editor does not own the draw end point')
r=w.RECT(); u.GetWindowRect(hwnd,c.byref(r)); old=(r.left,r.top)
if not u.SetCursorPos(*start) or owner(start)!=hwnd: raise RuntimeError('The audit cannot target the recording overlay')
u.mouse_event(2,0,0,0,0)
try:
    for i in range(1,13):
        u.SetCursorPos(*(round(a+(b-a)*i/12) for a,b in zip(start,end)))
        time.sleep(.018)
finally: u.mouse_event(4,0,0,0,0)
if p['moveWindow']:
    for i in range(40):
        u.GetWindowRect(hwnd,c.byref(r))
        if abs(r.left-old[0])>20 or abs(r.top-old[1])>20: break
        time.sleep(.025)
    else: raise RuntimeError('The real Windows drag did not move the recording overlay')
print(json.dumps({'before':old,'after':[r.left,r.top]}))
`;

function dragWindow(points) {
  try {
    return JSON.parse(execFileSync('python', ['-c', dragOwnedOverlay, JSON.stringify(points)], { windowsHide: true, timeout: 6000, encoding: 'utf8' }));
  } catch (error) { throw new Error(error.stderr?.toString().trim().split('\n').at(-1) || 'Windows did not deliver the audit drag.'); }
}

async function verifyOverlayDrag(overlay, duringEditor) {
  await overlay.waitForFunction(() => document.querySelector('.capture-panel').getAnimations().every(animation => animation.playState !== 'running'));
  const target = await overlay.locator('.capture-panel').evaluate(element => element.getBoundingClientRect().toJSON());
  const points = await app.evaluate(({ BrowserWindow, screen }, { target, duringEditor }) => {
    const locate = part => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(part));
    const overlay = locate('/overlay/');
    const handle = window => window.getNativeWindowHandle().readBigUInt64LE().toString();
    const bounds = overlay.getBounds();
    const zoom = overlay.webContents.getZoomFactor();
    const physical = (x, y) => {
      const point = screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
      return [point.x, point.y];
    };
    const x = bounds.x + (target.left + Math.min(145, target.width - 24)) * zoom;
    const y = bounds.y + (target.top + 24) * zoom;
    const windows = BrowserWindow.getAllWindows().map(window => {
      const role = ['/screenshot/', '/overlay/', '/renderer/', '/chat/', '/recorder/'].find(part => window.webContents.getURL().includes(part)) || 'fixture';
      return { role, handle: handle(window), bounds: window.getBounds(), visible: window.isVisible(), topmost: window.isAlwaysOnTop() };
    });
    return { target: handle(overlay), editor: duringEditor ? handle(locate('/screenshot/')) : null, moveWindow: true, start: physical(x, y), end: physical(x - 84, y + 64), behind: physical(x, bounds.y + (target.bottom + 24) * zoom), windows };
  }, { target, duringEditor });
  const dragged = dragWindow(points);
  assert.equal(points.windows.find(window => window.handle === points.target).topmost, true, 'The recording overlay keeps native topmost status');
  return dragged;
}

async function drawOwnedEditorStroke() {
  const points = await app.evaluate(({ BrowserWindow, screen }) => {
    const editor = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/screenshot/'));
    const bounds = editor.getContentBounds();
    const physical = (x, y) => { const point = screen.dipToScreenPoint({ x: bounds.x + x, y: bounds.y + y }); return [point.x, point.y]; };
    return { target: editor.getNativeWindowHandle().readBigUInt64LE().toString(), moveWindow: false, start: physical(115, 143), end: physical(170, 196) };
  });
  dragWindow(points);
}

async function verifyEditorGeometry(editor, overlay, index) {
  const geometry = await editor.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { selection: box('#selection'), toolbar: box('#toolbar'), viewport: { width: innerWidth, height: innerHeight } };
  });
  const { toolbar, viewport } = geometry;
  assert.ok(toolbar.left >= 0 && toolbar.top >= 0 && toolbar.right <= viewport.width && toolbar.bottom <= viewport.height);
  geometry.recording = await overlay.locator('.capture-panel').boundingBox();
  const screenshot = `recording-annotation-display-${index + 1}.png`;
  await editor.screenshot({ path: path.join(run, screenshot) });
  report.screenshots.push({ screenshot, geometry });
  await overlay.screenshot({ path: path.join(run, `shared-recording-capsule-display-${index + 1}.png`) });
}

async function verifyInitialCapsuleAnchor(editor, overlay, index) {
  const boxes = {
    toolbar: await editor.locator('#toolbar').boundingBox(),
    confirm: await editor.getByRole('button', { name:'确认截图并保存到草稿', exact:true }).boundingBox(),
    capsule: await overlay.locator('.capture-panel').boundingBox(),
  };
  const geometry = await app.evaluate(({ BrowserWindow }, boxes) => {
    const windows = BrowserWindow.getAllWindows();
    const dip = (path, box) => {
      const window = windows.find(win => win.webContents.getURL().includes(path));
      const bounds = window.getContentBounds(), zoom = window.webContents.getZoomFactor();
      return { right: bounds.x + (box.x + box.width) * zoom, top: bounds.y + box.y * zoom, bottom: bounds.y + (box.y + box.height) * zoom };
    };
    return { toolbar: dip('/screenshot/', boxes.toolbar), confirm: dip('/screenshot/', boxes.confirm), capsule: dip('/overlay/', boxes.capsule) };
  }, boxes);
  const { toolbar, confirm, capsule } = geometry;
  assert.ok(Math.abs(toolbar.right - capsule.right) <= 3, JSON.stringify(geometry));
  assert.ok(Math.abs(confirm.right - capsule.right) <= 12, JSON.stringify(geometry));
  assert.ok(capsule.top - toolbar.bottom >= 8 && capsule.top - toolbar.bottom <= 12, JSON.stringify(geometry));
  report.screenshots.push({ screenshot: `initial-recording-anchor-display-${index + 1}.png`, geometry });
  await overlay.screenshot({ path: path.join(run, `initial-recording-anchor-display-${index + 1}.png`) });
  return geometry;
}

async function verifyChatScreenshot() {
  const mainVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')).isVisible());
  const recorderPrepares = () => app.evaluate(() => globalThis.auditRecorderPrepares);
  await app.evaluate(({ BrowserWindow }) => {
    for (const fixture of globalThis.auditFixtures) fixture.window.setAlwaysOnTop(false);
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/'));
    window.show(); window.focus();
  });
  await main.locator('#open-chat').click();
  await main.waitForFunction(() => window.chatView?.currentId);
  const id = await main.evaluate(() => window.chatView.currentId);
  const input = main.locator('#chat-view .chat-input');
  const draftText = '合成聊天草稿，截图后继续输入。';
  await input.fill(draftText);
  await main.evaluate(() => window.chatView.flush());
  const before = await uiCall('chat:get', { id });
  assert.equal(before.context.images.length, 0);
  const started = await recorderPrepares();
  const beforeClipboard = await clipboardCount();
  const open = async () => {
    await main.getByRole('button', { name:'截取图片', exact:true }).click();
    const editor = await locateEditor();
    assert.ok(editor, 'Chat capture must open the real screenshot editor');
    await editor.waitForFunction(() => window.InMomentScreenshotEditor?.state);
    assert.equal(await editor.evaluate(async () => (await window.InMomentScreenshotEditor.ready).purpose), 'chat');
    assert.equal((await bootstrap()).session.active, false);
    assert.equal(await mainVisible(), false);
    return editor;
  };
  const editor = await open();
  await editor.mouse.move(96, 120);
  await editor.mouse.down();
  await editor.mouse.move(312, 272, { steps:4 });
  await editor.mouse.up();
  assert.equal((await bootstrap()).session.active, false);
  await editor.mouse.click(146, 178);
  assert.equal(await editor.evaluate(() => window.InMomentScreenshotEditor.state.items.length), 1);
  const rendered = await editor.evaluate(() => window.InMomentScreenshotEditor.flatten());
  const close = editor.waitForEvent('close');
  await editor.getByRole('button', { name:'完成截图并添加到聊天', exact:true }).click().catch(error => { if (!editor.isClosed()) throw error; });
  await close;
  await main.waitForFunction(() => !window.chatView.screenshotBusy && window.chatView.chat.context.images.length === 1);
  const added = await uiCall('chat:get', { id });
  assert.equal(added.input, draftText);
  assert.equal(added.context.images.length, 1);
  assert.equal(added.context.images[0].base64, rendered.slice(22));
  await verifyClipboard(rendered, beforeClipboard + 1);
  assert.equal(await mainVisible(), true);
  assert.equal(await input.inputValue(), draftText);
  const cancelled = await open();
  await escapeEditor(cancelled);
  await main.waitForFunction(() => !window.chatView.screenshotBusy);
  assert.equal(await main.evaluate(() => window.chatView.currentId), id);
  assert.equal(await mainVisible(), true);
  assert.equal(await input.inputValue(), draftText);
  assert.deepEqual((await uiCall('chat:get', { id })).context.images, added.context.images);
  assert.equal(await clipboardCount(), beforeClipboard + 1);
  assert.equal(added.context.audioDraftId, null);
  assert.deepEqual(added.messages, []);
  assert.equal(added.pending, false);
  assert.equal(await recorderPrepares(), started);
  assert.equal((await bootstrap()).drafts.length, 0);
  report.checks.push({ scenario:'Chat screenshot confirms one annotated image, and cancel restores the same chat and input with no recording or send' });
}

function launch() {
  return _electron.launch({ executablePath: report.executable, args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
}

async function mainAudit() {
  app = await launch();
  await app.firstWindow();
  const locate = part => app.windows().find(page => page.url().includes(part)) || app.waitForEvent('window', { predicate: page => page.url().includes(part) });
  main = await locate('/renderer/');
  const recorder = await locate('/recorder/');
  const overlay = await locate('/overlay/');
  await main.waitForFunction(() => typeof state !== 'undefined' && state.capabilities?.regionScreenshot?.available === true);
  assert.equal((await bootstrap()).capabilities.regionScreenshot.shortcut, 'Ctrl+Shift+F9');
  await main.evaluate(() => {
    globalThis.auditErrors = [];
    window.inmoment.subscribe(event => {
      if (event.type === 'session') globalThis.auditCaptureSession = event.session;
      if (event.type === 'error') globalThis.auditErrors.push(event.message);
    });
  });
  if (synthetic) await installSyntheticDevices();
  else report.microphone = await app.evaluate(({systemPreferences}) => systemPreferences.getMediaAccessStatus('microphone'));
  const displays = await coverDisplays();
  const cancelled = await openEditor(displays, 0);
  await cancelled.editor.mouse.click(96, 120);
  assert.equal(await cancelled.editor.locator('#toolbar').isVisible(), false);
  assert.equal((await bootstrap()).drafts.length, 0);
  await escapeEditor(cancelled.editor);
  assert.equal((await bootstrap()).drafts.length, 0);
  report.checks.push({ scenario:'OS shortcut, single click and Escape cancellation', monitor:displays[0].id });

  for (const [index, display] of displays.entries()) {
    const { editor, frame } = await openEditor(displays, index);
    const selection = await selectAndStart(editor, frame);
    await waitSession('recording');
    const active = (await bootstrap()).session;
    assert.equal(active.mode, 'manual');
    await uiCall('draft:retention', { keepAudio: true, keepText: false });
    assert.equal((await uiCall('records:get', { id: active.id })).screenshots.length, 0);
    const toolbar = editor.locator('#toolbar');
    const toggle = overlay.locator('#capsule-logo');
    await toolbar.waitFor();
    await overlay.waitForFunction(() => document.body.dataset.mode === 'capsule' && document.querySelector('.capture-panel').getBoundingClientRect().height === 48);
    const initialAnchor = await verifyInitialCapsuleAnchor(editor, overlay, index);
    assert.equal(await overlay.locator('#capsule-hint').getAttribute('aria-hidden'), 'true');
    await overlay.evaluate(() => document.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true })));
    assert.equal((await bootstrap()).session.id, active.id);
    const compactDrag = await verifyOverlayDrag(overlay, true);
    for (const name of ['自由画笔', '矩形', '椭圆', '箭头', '文字', '画笔颜色', '重新选区']) assert.equal(await toolbar.getByRole('button', { name, exact:true }).isVisible(), true);
    const rectangle = toolbar.getByRole('button', { name:'矩形', exact:true });
    const idleColor = await rectangle.evaluate(element => getComputedStyle(element).color);
    await rectangle.hover();
    assert.equal(await rectangle.evaluate(element => getComputedStyle(element).color), idleColor);
    await rectangle.click();
    assert.equal(await rectangle.getAttribute('aria-pressed'), 'true');
    assert.equal(await rectangle.evaluate(element => getComputedStyle(element).color), idleColor);
    await editor.mouse.move(1, 1);
    const toolStates = await checkButtonStates(editor, '#toolbar [data-ui-icon=rectangle]', { current: true });
    await drawOwnedEditorStroke();
    await editor.waitForFunction(() => window.InMomentScreenshotEditor.state.items.length === 1);
    const strokes = () => editor.evaluate(() => window.InMomentScreenshotEditor.state.items.map(item => item.type));
    assert.deepEqual(await strokes(), ['rectangle']);
    await toolbar.getByRole('button', { name:'撤销 · Ctrl+Z', exact:true }).click();
    assert.deepEqual(await strokes(), []);
    await toolbar.getByRole('button', { name:'重做 · Ctrl+Shift+Z', exact:true }).click();
    assert.deepEqual(await strokes(), ['rectangle']);
    await verifyEditorGeometry(editor, overlay, index);
    if (!synthetic) {
      const tracks = await recorder.evaluate(() => current?.stream?.getAudioTracks().map(track => ({ readyState:track.readyState, enabled:track.enabled })));
      assert.ok(tracks.some(track => track.readyState === 'live' && track.enabled));
      await new Promise(resolve => setTimeout(resolve, 380));
    }
    await toggle.click();
    await waitSession('paused');
    await overlay.waitForFunction(() => document.body.dataset.mode === 'card' && document.querySelector('.capture-panel').getBoundingClientRect().height > 110);
    const expandedDrag = await verifyOverlayDrag(overlay, true);
    const discardStates = await checkButtonStates(overlay, '#discard', { tone: 'red', icon: true, foreground: 'rgb(180, 35, 24)' });
    const askAIStates = await checkButtonStates(overlay, '#ask-ai', { tone: 'green', icon: true, foreground: 'rgb(16, 39, 25)' });
    (report.buttonStates ||= []).push(toolStates, discardStates, askAIStates);
    (report.buttonRows ||= []).push(await checkButtonRow(overlay, '.actions', ['#ask-ai', '#discard', '#finish'], { minInlinePadding: 8, radius: 12 }));
    (report.buttonCorners ||= []).push(await checkButtonCorners(editor, 'annotation tools'), await checkButtonCorners(overlay, 'recording card'));
    await overlay.screenshot({ path: path.join(run, `shared-recording-card-display-${index + 1}.png`) });
    assert.equal(await toolbar.isVisible(), true);
    assert.deepEqual(await strokes(), ['rectangle']);
    assert.equal((await uiCall('records:get', { id: active.id })).screenshots.length, 0);
    assert.equal(await toggle.getAttribute('aria-label'), '继续录音');
    await toggle.click();
    await waitSession('recording');
    const flattened = await editor.evaluate(() => window.InMomentScreenshotEditor.flatten());
    const beforeClipboard = await clipboardCount();
    const confirm = toolbar.getByRole('button', { name:'确认截图并保存到草稿', exact:true });
    const editorClosed = editor.waitForEvent('close');
    await confirm.click().catch(error => { if (!editor.isClosed()) throw error; });
    await editorClosed;
    const afterConfirm = (await bootstrap()).session;
    assert.equal(afterConfirm.id, active.id);
    assert.equal(afterConfirm.state, 'recording');
    await verifyDraftCrop(active.id, selection, flattened);
    await verifyClipboard(flattened, beforeClipboard + 1);
    await overlay.getByRole('button', { name: '暂停录音', exact: true }).click();
    await waitSession('paused');
    await main.waitForFunction(async id => (await window.inmoment.invoke('records:get', { id }))?.audioSegments.some(segment => segment.durationMs > 0), active.id, { timeout: 5000, polling: 40 });
    const draft = await uiCall('records:get', { id: active.id });
    if (!synthetic) await recorder.waitForFunction(() => !current || current.stream.getTracks().every(track => track.readyState === 'ended'));
    await uiCall('draft:discard');
    assert.equal(await uiCall('records:get', { id: active.id }), null);
    report.checks.push({ scenario:'OS shortcut, shared capsule starts below screenshot confirmation, capsule and card drag, annotated clipboard crop, pause and resume before confirmation, discard', monitor:display.id, image:[frame.width,frame.height], selection, initialAnchor, compactDrag, expandedDrag, durationMs:draft.audioSegments[0].durationMs });
  }

  const cancelImage = await openEditor(displays, 0);
  await selectAndStart(cancelImage.editor, cancelImage.frame);
  await waitSession('recording');
  const beforeReselect = (await bootstrap()).session;
  const cancelId = beforeReselect.id;
  const originalSelection = await cancelImage.editor.locator('#selection-size').textContent();
  const beforeCancelClipboard = await clipboardCount();
  await cancelImage.editor.getByRole('button', { name:'重新选区', exact:true }).click();
  await cancelImage.editor.mouse.move(116, 125);
  await cancelImage.editor.mouse.down();
  await cancelImage.editor.mouse.move(361, 289, { steps:4 });
  await cancelImage.editor.mouse.up();
  assert.notEqual(await cancelImage.editor.locator('#selection-size').textContent(), originalSelection);
  const reselected = (await bootstrap()).session;
  assert.equal(reselected.state, 'recording');
  assert.equal(reselected.segmentId, beforeReselect.segmentId);
  await escapeEditor(cancelImage.editor);
  assert.equal((await bootstrap()).session.state, 'recording');
  assert.equal((await uiCall('records:get', { id: cancelId })).screenshots.length, 0);
  assert.equal(await clipboardCount(), beforeCancelClipboard);
  await uiCall('draft:discard');
  report.checks.push({ scenario:'Reselection keeps the same audio segment, and Escape cancels only the screenshot', monitor:displays[0].id });

  const denied = await openEditor(displays, 0);
  // Opening the editor installs production permission policy on its session.
  // Deny after that setup so the test changes only this permission request.
  if (synthetic) await app.evaluate(() => { globalThis.auditMicDenied = true; });
  else await app.evaluate(({session}) => {
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_window, _permission, callback) => callback(false));
  });
  await selectAndStart(denied.editor, denied.frame);
  await waitSession('paused');
  const inactive = (await bootstrap()).session;
  assert.match(inactive.error, /麦克风未获授权/u);
  await overlay.locator('#error-message').waitFor();
  assert.match(await overlay.locator('#error-message').textContent(), /麦克风未获授权/u);
  assert.equal((await uiCall('records:get', { id: inactive.id })).audioSegments.length, 0);
  const deniedClosed = denied.editor.waitForEvent('close');
  await uiCall('draft:discard');
  await deniedClosed;
  report.checks.push({ scenario:'Visible microphone permission error and discard closes annotation', monitor:displays[0].id });

  if (synthetic) {
    await verifyChatScreenshot();
    await app.evaluate(() => { globalThis.auditMicDenied = false; });
    await uiCall('draft:startManual');
    await waitSession('recording');
    await overlay.waitForFunction(() => document.body.dataset.mode === 'card');
    const normalDrag = await verifyOverlayDrag(overlay, false);
    await uiCall('draft:discard');
    report.checks.push({ scenario:'Normal expanded recording overlay uses the same native drag region', normalDrag });
  }

  const alternate = 'Ctrl+Shift+F7';
  const occupied = 'Ctrl+Shift+F8';
  await app.evaluate(({BrowserWindow}) => {
    for (const fixture of globalThis.auditFixtures) fixture.window.hide();
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/'));
    window.show(); window.focus();
  });
  assert.equal(await app.evaluate(({globalShortcut}, shortcut) => globalShortcut.register(shortcut, () => {}), occupied), true);
  try {
    await main.locator('[data-view="settings"]').click();
    const input = main.locator('#region-shortcut-input');
    await input.click();
    await main.keyboard.press('Control+Shift+F8');
    await main.waitForFunction(() => document.querySelector('#region-shortcut-input').getAttribute('aria-invalid') === 'true');
    assert.equal((await bootstrap()).settings.regionScreenshotShortcut, 'Ctrl+Shift+F9');
    assert.equal(await app.evaluate(({globalShortcut}) => globalShortcut.isRegistered('Ctrl+Shift+F9')), true);
    await main.keyboard.press('Control+Shift+F7');
    await main.waitForFunction(shortcut => state.settings.regionScreenshotShortcut === shortcut, alternate);
  } finally { await app.evaluate(({globalShortcut}, shortcut) => globalShortcut.unregister(shortcut), occupied); }
  assert.equal(await app.evaluate(({globalShortcut}) => globalShortcut.isRegistered('Ctrl+Shift+F9')), false);
  assert.equal(await app.evaluate(({globalShortcut}, shortcut) => globalShortcut.isRegistered(shortcut), alternate), true);
  const reboundDisplays = await coverDisplays();
  const rebound = await openEditor(reboundDisplays, 0, 0x76);
  await escapeEditor(rebound.editor);
  report.checks.push({ scenario:'Settings keeps prior binding on OS conflict, then rebinds and dispatches a real alternate shortcut', alternate });

  await app.close();
  main = null;
  app = await launch();
  await app.firstWindow();
  main = await locate('/renderer/');
  await main.waitForFunction(shortcut => typeof state !== 'undefined' && state.capabilities?.regionScreenshot?.available && state.capabilities.regionScreenshot.shortcut === shortcut, alternate);
  assert.equal(await app.evaluate(({globalShortcut}, shortcut) => globalShortcut.isRegistered(shortcut), alternate), true);
  report.checks.push({ scenario:'Changed shortcut persists and registers after process restart', alternate });
}

mainAudit().catch(error => { report.errors.push(error.message); console.error(error); process.exitCode = 1; }).finally(async () => {
  if (main) {
    try {
      if ((await bootstrap()).session.active) await uiCall('draft:discard');
      await uiCall('app:setDirty', { recordDirty: false, settingsDirty: false, noteDirty: false });
    } catch (error) { report.errors.push('Discard: ' + error.message); process.exitCode = 1; }
  }
  if (app) await app.close().catch(error => { report.errors.push('Close: ' + error.message); process.exitCode = 1; });
  try {
    const resolved = fs.realpathSync(dataDir);
    assert.equal(path.dirname(resolved), fs.realpathSync(run));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4 });
    report.isolatedDataRemoved = true;
  } catch (error) { report.errors.push('Cleanup: ' + error.message); process.exitCode = 1; }
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, ...report }));
});
