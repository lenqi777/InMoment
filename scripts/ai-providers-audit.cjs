'use strict';

// Isolated settings UI with the real Settings class and injected AES storage.
// No user settings, model, API, microphone or desktop capture is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { LocalStore } = require('../src/core/store.cjs');
const { Settings } = require('../src/main/settings.cjs');
function playwright() { for (const name of [process.env.INMOMENT_PLAYWRIGHT,'playwright',path.join(path.dirname(process.execPath),'..','node_modules','playwright')].filter(Boolean)) { try { return require(name); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; } } throw new Error('Set INMOMENT_PLAYWRIGHT to the installed Playwright package.'); }
const { _electron } = playwright();
const root = path.resolve(__dirname,'..'), output = path.resolve(root,process.env.INMOMENT_AI_PROVIDER_AUDIT_OUTPUT || '.local/ai-providers-review-20261108');
assert(output.startsWith(root + path.sep)); fs.mkdirSync(output,{recursive:true});
const dataDir = fs.mkdtempSync(path.join(output,'synthetic-library-')), mockDir = fs.mkdtempSync(path.join(output,'mock-profiles-'));
const encryptionKey = randomBytes(32);
const secureStorage = {
  isEncryptionAvailable:() => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',encryptionKey,iv); const data = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),data]); },
  decryptString(value) { const decipher = createDecipheriv('aes-256-gcm',encryptionKey,value.subarray(0,12)); decipher.setAuthTag(value.subarray(12,28)); return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8'); },
};
let mockSettings = new Settings(mockDir,secureStorage), application, page;
const fakeKeys = Object.freeze({deepseek:'fixture-only-deepseek-not-auth',openai:'fixture-only-openai-not-auth',gemini:'fixture-only-gemini-not-auth'});
const models = Object.fromEntries(Object.keys(fakeKeys).map(id => [id,'audit-custom-' + id]));
const saveCalls = [], unexpectedRequests = [], errors = [], measurements = [], screenshots = [];
function wav() { const value = Buffer.alloc(32044); value.write('RIFF'); value.writeUInt32LE(value.length-8,4); value.write('WAVEfmt ',8); value.writeUInt32LE(16,16); value.writeUInt16LE(1,20); value.writeUInt16LE(1,22); value.writeUInt32LE(16000,24); value.writeUInt32LE(32000,28); value.writeUInt16LE(2,32); value.writeUInt16LE(16,34); value.write('data',36); value.writeUInt32LE(32000,40); return value; }
function seed() { const store = new LocalStore(dataDir); try { const topics = ['产品想法','回顾记录'].map(name => store.createTopic(name)); for (let i=0;i<6;i++) { const id='provider-audit-'+i; store.createDraft({id,title:'合成记录 '+(i+1),topicIds:i%2 ? [topics[0].id] : []}); store.addSegment(id,{bytes:wav(),durationMs:1000,transcript:'切换服务设置时保留这条合成记录。'}); store.complete(id); store.setJob(id,'title','done'); } } finally { store.close(); } }
function librarySnapshot() { const store = new LocalStore(dataDir); try { return JSON.stringify({records:store.listRecords(),topics:store.listTopics(),drafts:store.listDrafts()}); } finally { store.close(); } }
function attachmentHashes(directory = dataDir) { const hashes = {}; const visit = current => { for (const item of fs.readdirSync(current,{withFileTypes:true})) { const file=path.join(current,item.name); if (item.isDirectory()) visit(file); else if (/\.(wav|png)$/u.test(item.name)) hashes[path.relative(directory,file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } }; visit(directory); return hashes; }
const syntheticSettings = JSON.stringify({inputEnabled:false,captureScreenshots:false,cloudEnabled:false,autoTitleEnabled:false,aiSearchEnabled:false,directAIEnabled:false,keyboardTrigger:'none',apiKeyEncrypted:''},null,2);
function publicMock() { return {...mockSettings.public(),networkDisabled:true}; }
async function open() {
  const env = {...process.env,INMOMENT_DATA_DIR:dataDir,INMOMENT_ASR_DIR:path.join(dataDir,'disabled-asr'),INMOMENT_DISABLE_NETWORK:'1',INMOMENT_SMOKE:'1'}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  application = await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:30000}); await application.firstWindow();
  page = application.windows().find(item => item.url().includes('/renderer/')) || await application.waitForEvent('window',{predicate:item => item.url().includes('/renderer/')});
  page.setDefaultTimeout(12000);
  page.on('pageerror',error => errors.push(error.message)); await page.route(/^https?:\/\//u,route => { unexpectedRequests.push(route.request().url()); route.abort(); });
  await application.evaluate(({BrowserWindow,session}) => { globalThis.__aiProviderAuditRequests=[]; session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback) => { globalThis.__aiProviderAuditRequests.push(details.url); callback({cancel:true}); }); BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')).show(); });
  await page.locator('[data-view="settings"]').waitFor();
  await page.waitForFunction(() => typeof state !== 'undefined' && state.settings.networkDisabled === true);
  await page.exposeFunction('__providerAuditMock',async (method,params={}) => {
    if (method === 'settings:get') return publicMock();
    assert.equal(method,'settings:save');
    saveCalls.push({aiProvider:params.aiProvider,profiles:Object.fromEntries(Object.entries(params.aiProfiles || {}).map(([id,value]) => [id,{model:value.model,keyUpdated:Boolean(value.apiKey),clearKey:value.clearApiKey === true}]))});
    assert(!params.cloudEnabled && !params.autoTitleEnabled && !params.directAIEnabled && !params.aiSearchEnabled && !params.screenshotAnalysisEnabled,'UI audit never enables a cloud feature');
    mockSettings.save(params); return publicMock();
  });
  await page.evaluate(async () => {
    window.__providerAuditOriginalInvoke=invoke;
    invoke=async function(method,params) {
      if (method === 'settings:save' || method === 'settings:get') return window.__providerAuditMock(method,params);
      if (/^(records:(organize|aiSearch)|library:(batchOrganize|duplicates)|semantic:)/u.test(method)) throw new Error('Model calls are forbidden in the provider UI audit.');
      const result=await window.__providerAuditOriginalInvoke(method,params);
      if (method === 'app:bootstrap') return {...result,settings:await window.__providerAuditMock('settings:get')};
      return result;
    };
    state.settings=await invoke('settings:get'); renderSettings(); showView('settings', { settingsSection:'ai' });
  });
  await page.locator('#ai-provider-trigger').waitFor({state:'visible'});
  await page.locator('.manual-model-details>summary').click();
  if (!await page.locator('#model-manual-enabled').isChecked()) await page.locator('label:has(#model-manual-enabled)').click();
  await settle();
}
async function settle() { await page.evaluate(async () => { await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)); await window.InMomentMotion?.activeTransition?.finished?.catch(() => {}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
async function close() { if (!application) return; try { await page.evaluate(() => { if (typeof state !== 'undefined') { state.settingsDirty=false; state.detailDirty=false; notifyDirty(); } }); unexpectedRequests.push(...await application.evaluate(() => globalThis.__aiProviderAuditRequests || [])); } finally { await application.close(); application=null; } }
async function resize(size) {
  await application.evaluate(async ({BrowserWindow},size) => { const window=BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')); if (window.isMaximized()) await new Promise(resolve => { const timeout=setTimeout(resolve,1500); window.once('unmaximize',()=>{clearTimeout(timeout);resolve();}); window.unmaximize(); }); window.setMinimumSize(640,480); window.setContentSize(size.width,size.height); window.webContents.setZoomFactor(size.zoom || 1); },size);
  await page.waitForFunction(size => Math.abs(innerWidth-size.width/(size.zoom || 1))<=1 && Math.abs(innerHeight-size.height/(size.zoom || 1))<=1,size); await settle();
}
async function chooseProvider(id) {
  await page.locator('#ai-provider-trigger').scrollIntoViewIfNeeded(); await settle();
  await page.locator('#ai-provider-trigger').click(); await page.locator('.select-popover [data-menu-id="'+id+'"]').click(); await page.locator('.select-popover').waitFor({state:'detached'}); await page.waitForFunction(id=>document.querySelector('#ai-provider').value===id,id); await settle();
}
async function capture(filename,title) { const png=await application.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/')).capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(output,filename),Buffer.from(png,'base64'));screenshots.push({filename,title}); }
async function menuMotion(phase,name,size) {
  const result=await page.evaluate(async()=>{const panel=document.querySelector('.select-popover'), animation=panel?.getAnimations().find(item=>item.effect?.getTiming().iterations!==Infinity && item.playState!=='finished');if(!animation)return null;animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)/2;window.__providerAuditMenuAnimation=animation;await new Promise(resolve=>requestAnimationFrame(resolve));return {marker:panel.dataset.uiMotion,duration:animation.effect.getTiming().duration,progress:animation.effect.getComputedTiming().progress,opacity:getComputedStyle(panel).opacity};});
  assert(result && result.marker.endsWith('-'+phase) && result.progress>0 && result.progress<1,'The settings menu has a real '+phase+' animation');measurements.push({label:name+' '+phase+' motion',size,...result});
  await capture(name+'-'+phase+'-'+size.width+'-'+size.zoom+'.png',name+' '+phase+' midpoint / '+size.width+' / '+size.zoom);
  await page.evaluate(async()=>{const animation=window.__providerAuditMenuAnimation;delete window.__providerAuditMenuAnimation;animation.play();await animation.finished.catch(()=>{});});
}
async function auditMenus(size) {
  const active=await page.locator('#ai-provider').inputValue();
  for(const [name,trigger] of [['provider','#ai-provider-trigger'],['model','#ai-model-presets']]) {
    await page.locator(trigger).scrollIntoViewIfNeeded();await page.locator(trigger).click();await page.locator('.select-popover').waitFor({state:'visible'});await menuMotion('enter',name,size);
    const geometry=await page.locator('.select-popover').evaluate(panel=>{const rect=panel.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,viewport:{width:innerWidth,height:innerHeight},options:[...panel.querySelectorAll('[role=menuitemradio]')].map(item=>({id:item.getAttribute('data-menu-id'),checked:item.getAttribute('aria-checked')}))};});
    assert(geometry.left>=0 && geometry.right<=geometry.viewport.width+1 && geometry.top>=0 && geometry.bottom<=geometry.viewport.height+1);assert(geometry.options.length>=2);if(name==='model'&&active==='openai')assert(geometry.options.some(option=>option.id==='gpt-6.1-terra'));measurements.push({label:name+' menu bounds',size,...geometry});await capture(name+'-'+active+'-menu-'+size.width+'-'+size.zoom+'.png',name+' menu / '+active+' / '+size.width+' / '+size.zoom);
    if(name==='provider') {await page.keyboard.press('Home');await page.keyboard.press('Escape');}
    else {
      await page.keyboard.press('End');
      assert(await page.locator('.select-popover').evaluate(panel=>{const item=panel.lastElementChild,rect=item.getBoundingClientRect(),bounds=panel.getBoundingClientRect();return document.activeElement===item && rect.top>=bounds.top && rect.bottom<=bounds.bottom;}));
      await page.keyboard.press('Escape');
    }
    await menuMotion('exit',name,size);await page.locator('.select-popover').waitFor({state:'detached'});assert.equal(await page.locator('#ai-provider').inputValue(),active);assert.equal(await page.locator('#model-input').inputValue(),models[active]);
  }
  await page.locator('#ai-provider-trigger').click();await page.locator('.select-popover').waitFor({state:'visible'});await page.locator('#ai-provider-trigger').click();await page.locator('.select-popover').waitFor({state:'detached'});assert.equal(await page.locator('#ai-provider').inputValue(),active);
}
async function inspect(provider,size) {
  await page.locator('#api-key').scrollIntoViewIfNeeded(); await settle();
  const result=await page.evaluate(() => {
    const visible=element => element.getClientRects().length && !element.closest('.hidden');
    const controls=[...document.querySelectorAll('#settings-view button,#settings-view input,#settings-view select')].filter(visible).filter(element=>{const rect=element.getBoundingClientRect();return rect.top>=0 && rect.bottom<=innerHeight;}).map(element => { const rect=element.getBoundingClientRect(); const range=document.createRange(); range.selectNodeContents(element); const text=range.getBoundingClientRect(); return {id:element.id,tag:element.tagName,width:rect.width,height:rect.height,left:rect.left,right:rect.right,clipped:element.tagName==='BUTTON' && (text.left<rect.left-1 || text.right>rect.right+1 || text.top<rect.top-1 || text.bottom>rect.bottom+1)}; });
    const provider=document.querySelector('#ai-provider'); return {provider:provider.value,providerCount:provider.options.length,viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,model:document.querySelector('#model-input').value,presets:[...document.querySelectorAll('#ai-model-options option')].map(item=>item.value),keyType:document.querySelector('#api-key').type,keyStatus:document.querySelector('#key-status').textContent,keyLabel:document.querySelector('#api-key-label-text').textContent,controls};
  });
  assert.equal(result.provider,provider); assert.equal(result.providerCount,3); assert.equal(result.keyType,'password'); assert.equal(result.model,models[provider]); assert(result.presets.length>=1); assert(result.documentWidth<=result.viewport.width+1); assert(result.controls.every(item=>item.left>=0 && item.right<=result.viewport.width+1 && !item.clipped));
  measurements.push({size,...result});
  const filename=provider+'-'+size.width+'-'+(size.zoom || 1)+'.png';await capture(filename,provider+' settings / '+size.width+' / '+(size.zoom || 1));
}
function writeReport(extra={}) { const report={syntheticOnly:true,realAPICalls:0,modelRuns:0,microphoneActivations:0,desktopCaptures:0,storage:'Injected ephemeral AES storage using real Settings',dataDir,mockDir,saveCalls,measurements,screenshots,rendererErrors:errors,unexpectedRequests,...extra}; fs.writeFileSync(path.join(output,'audit.json'),JSON.stringify(report,null,2)); const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AI 服务设置检查</title><style>body{max-width:1280px;margin:40px auto;font:16px/1.7 sans-serif;color:#171a1d}img{width:100%;height:auto;border:1px solid #dee2e6;border-radius:12px}section{margin:30px 0}</style><h1>AI 服务设置检查</h1><p>合成资料与加密模拟存储；真实 API、模型、录音、桌面截图均为 0。</p><a href="audit.json">测量结果</a>'+screenshots.map(item=>'<section><h2>'+item.title+'</h2><img src="'+item.filename+'" alt="'+item.title+'"></section>').join('')+'</html>'; fs.writeFileSync(path.join(output,'index.html'),html); }
(async () => {
  seed(); fs.writeFileSync(path.join(dataDir,'settings.json'),syntheticSettings); const before=librarySnapshot(), attachments=attachmentHashes();
  mockSettings.save({inputEnabled:false,captureScreenshots:false,keyboardTrigger:'none',previewDelayMs:150,excludedApps:['SyntheticExcludedApp'],aiProfiles:{deepseek:{apiKey:'fixture-before-audit-not-auth'}}});
  await open(); assert.equal(mockSettings.public().aiProvider,'deepseek'); const initial=fs.readFileSync(mockSettings.path);
  for (const id of ['deepseek','openai','gemini']) { await chooseProvider(id); await page.locator('#model-input').fill(models[id]); await page.locator('#api-key').fill(fakeKeys[id]); }
  await page.locator('#settings-nav-capture').click(); await page.locator('#region-shortcut-input').waitFor({state:'visible'}); await settle(); await capture('capture-settings.png','录音与截图');
  await page.locator('#settings-nav-local').click(); await page.locator('#capability-status').waitFor({state:'visible'}); await settle(); await capture('local-settings.png','本地组件');
  await page.locator('#settings-nav-maintenance').click(); await page.locator('#reset-settings').waitFor({state:'visible'}); await settle(); await capture('maintenance-settings.png','维护');
  await page.locator('#settings-nav-ai').click(); await page.locator('#ai-provider-trigger').waitFor({state:'visible'}); await settle();
  for (const id of ['deepseek','openai','gemini']) { await chooseProvider(id); assert.equal(await page.locator('#model-input').inputValue(),models[id]); assert((await page.locator('#api-key').inputValue())===fakeKeys[id],'Unsaved key draft stays with '+id); }
  assert.equal(saveCalls.length,0); assert.deepEqual(fs.readFileSync(mockSettings.path),initial,'Switching and typing does not persist settings');
  const sizes=[{width:1440,height:900,zoom:1},{width:1024,height:768,zoom:1},{width:800,height:720,zoom:1},{width:1440,height:900,zoom:1.5}];
  for (const size of sizes) { await resize(size); for (const id of ['deepseek','openai','gemini']) { await chooseProvider(id); await inspect(id,size); if(id==='openai'&&size.width!==1024)await auditMenus(size); } }
  await page.locator('.settings-footer button[form="settings-form"]').click(); await page.waitForFunction(()=>!settingsSaving && !state.settingsDirty); await settle();
  assert.equal(saveCalls.length,1); assert.deepEqual(Object.keys(saveCalls[0].profiles).sort(),['deepseek','gemini','openai']); assert.equal(mockSettings.public().aiProvider,'gemini');
  for (const id of Object.keys(fakeKeys)) { assert(mockSettings.key(id)===fakeKeys[id],'Only the saved provider key is decrypted for '+id); assert.equal(mockSettings.public().aiProfiles[id].model,models[id]); assert.equal(mockSettings.public().aiProfiles[id].hasApiKey,true); }
  assert.equal(await page.locator('#api-key').inputValue(),''); const protectedText=fs.readFileSync(mockSettings.path,'utf8'); Object.values(fakeKeys).forEach(key=>assert(!protectedText.includes(key),'No plaintext fixture keys on disk'));
  await chooseProvider('openai'); assert.equal(await page.locator('#api-key').inputValue(),''); await page.locator('.settings-footer button[form="settings-form"]').click(); await page.waitForFunction(()=>!settingsSaving && !state.settingsDirty); assert.equal(saveCalls.length,2); assert.equal(mockSettings.public().aiProvider,'openai');
  await close(); mockSettings=new Settings(mockDir,secureStorage); assert.equal(mockSettings.public().aiProvider,'openai'); await open(); await resize(sizes[0]);
  for (const id of ['deepseek','openai','gemini']) { await chooseProvider(id); assert.equal(await page.locator('#api-key').inputValue(),''); assert.equal(await page.locator('#model-input').inputValue(),models[id]); assert.match(await page.locator('#key-status').textContent(),/已.*保存/u); assert(mockSettings.key(id)===fakeKeys[id],'Restart keeps each provider key'); }
  assert.equal(saveCalls.length,2,'Restart and viewing do not save or test a connection'); await close();
  assert.equal(librarySnapshot(),before); assert.deepEqual(attachmentHashes(),attachments); assert.equal(fs.readFileSync(path.join(dataDir,'settings.json'),'utf8'),syntheticSettings); assert.equal(errors.length,0); assert.equal(unexpectedRequests.length,0);
  const invariant={records:6,groups:2,sourceAttachments:Object.keys(attachments).length,recordsUnchanged:true,sourceHashesUnchanged:true,syntheticAppSettingsUnchanged:true,profilesSurviveRestart:true,plaintextKeysOnDisk:false}; writeReport({passed:true,invariant}); console.log(JSON.stringify({output,measurements:measurements.length,screenshots:screenshots.length,saveCalls:saveCalls.length,invariant}));
})().catch(async error => { console.error(error.message); writeReport({passed:false,error:error.message}); process.exitCode=1; }).finally(async()=>{try{await close();}catch{}});
