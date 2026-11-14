'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{ChatView,clipboardImages}=require('../src/shared/chat-view.js');
const file=(name='a.png',size=1)=>({name,size,type:'image/png'});
function fixture() {
  const calls = [];
  let fileId = 0;
  const view = Object.assign(Object.create(ChatView.prototype), {
    currentId: 'chat', request: 1, chat: { id:'chat', context:{ images:[], quotes:[] } }, input: { value:'保留输入' },
    updateSend() {},
    readAttachmentFile: async ({ file, mimeType }) => ({ mimeType, base64:'AA==', name:file.name }),
    async invoke(method, params) {
      calls.push({ method, params });
      const context = { ...view.chat.context, ...params };
      if (params.attachments) context.attachments = params.attachments.map(file => {
        if (file.id) return view.chat.context.attachments.find(existing => existing.id === file.id);
        return { id:`file-${++fileId}`, mimeType:file.mimeType, name:file.name, size:Buffer.from(file.base64, 'base64').length };
      });
      return { ...view.chat, context };
    },
    setChat(value) { this.chat = value; }
  });
  return { view, calls };
}
test('clipboard item images take precedence over their mirrored files and plain text stays unhandled',()=>{const image=file();assert.deepEqual(clipboardImages({items:[{kind:'file',type:'image/png',getAsFile:()=>image}],files:[image]}),[image]);assert.deepEqual(clipboardImages({items:[],files:[image]}),[image]);assert.deepEqual(clipboardImages({items:[{kind:'string',type:'text/plain'}],files:[]}),[]);});
test('concurrent paste and file attachments merge in order with the latest images instead of replacing each other',async()=>{const h=fixture();let release;h.view.readAttachmentFile=async ({file,mimeType})=>{if(file.name==='first.png')await new Promise(resolve=>{release=resolve;});return{mimeType,base64:'AA==',name:file.name};};const first=h.view.attachFiles([file('first.png')]),second=h.view.attachFiles([file('second.png')]);await Promise.resolve();await Promise.resolve();release();await Promise.all([first,second]);assert.deepEqual(h.view.chat.context.images.map(image=>image.name),['first.png','second.png']);assert.equal(h.view.input.value,'保留输入');assert.ok(h.calls.every(call=>call.method==='chat:update'));assert.equal(h.view.attachmentPending,0);});
test('invalid batches are atomic and preserve existing images',async()=>{const h=fixture();h.view.chat.context.images=[{mimeType:'image/png',base64:'AA==',name:'kept.png'}];await assert.rejects(h.view.attachFiles(Array.from({length:5},()=>file())),/4 张/);await assert.rejects(h.view.attachFiles([file('big.png',8*1024*1024+1)]),/8 MiB/);await assert.rejects(h.view.attachFiles(Array.from({length:4},()=>file('sum.png',7*1024*1024))),/24 MiB/);assert.equal(h.calls.length,0);assert.equal(h.view.chat.context.images[0].name,'kept.png');});
test('aggregate size includes existing images and rejects the entire new batch',async()=>{const h=fixture(),eight='A'.repeat(11184811)+'=';h.view.chat.context.images=Array.from({length:3},()=>({mimeType:'image/png',base64:eight}));await assert.rejects(h.view.attachFiles([file()]),/24 MiB/);assert.equal(h.view.chat.context.images.length,3);assert.equal(h.calls.length,0);});
test('a switched or deleted target ignores late file reads without attaching to the next conversation',async()=>{for(const deleted of[false,true]){const h=fixture();let release;h.view.readAttachmentFile=()=>new Promise(resolve=>{release=resolve;});const task=h.view.attachFiles([file()]);await Promise.resolve();await Promise.resolve();if(deleted)h.view.deletedChatIds=new Set(['chat']);else{h.view.currentId='next';h.view.request++;h.view.chat={id:'next',context:{images:[]}};}release({mimeType:'image/png',base64:'AA=='});assert.equal(await task,false);assert.equal(h.calls.length,0);assert.equal(h.view.chat.context.images.length,0);}});
test('a stale native file-picker target is rejected before reading files',async()=>{const h=fixture();h.view.readAttachmentFile=()=>{throw new Error('A stale picker must not read');};assert.equal(await h.view.attachFiles([file()],{id:'old',request:0}),false);assert.equal(h.calls.length,0);});
test('quote appends use the same queue and quote-only send does not adopt transcription candidates',async()=>{const h=fixture();await Promise.all([h.view.quoteText('> **第一条**'),h.view.quoteText('第二条')]);assert.deepEqual(h.view.chat.context.quotes.map(quote=>quote.text),['第一条','第二条']);h.view.input.value='';h.view.chat.candidate='不能自动采用';assert.equal(h.view.hasSendContent(),true);});

test('mixed picker uses one atomic update with normalized MIME and forwards saved files by ID', async () => {
  const { view, calls } = fixture();
  await view.attachFiles([file(), { name:'notes.MD', type:'', size:1 }, { name:'reading.PDF', type:'', size:1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.images.length, 1);
  assert.deepEqual(calls[0].params.attachments.map(item => item.mimeType), ['text/markdown','application/pdf']);
  assert.deepEqual(view.chat.context.attachments.map(item => item.size), [1,1]);
  assert.ok(view.chat.context.attachments.every(item => !Object.hasOwn(item, 'base64')));
  await view.attachFiles([{ name:'video.MP4', type:'', size:1 }]);
  assert.deepEqual(calls[1].params, { id:'chat', attachments:[{id:'file-1'},{id:'file-2'},{name:'video.MP4',mimeType:'video/mp4',base64:'AA=='}] });
  await view.removeFileAttachment('file-2');
  assert.deepEqual(calls[2].params, { id:'chat', attachments:[{id:'file-1'},{id:'file-3'}] });
  assert.equal(view.chat.context.images.length, 1);
});

test('an oversized file blocks the full mixed selection before any file read', async () => {
  const { view, calls } = fixture();
  view.readAttachmentFile = () => { throw new Error('invalid batch must not read any file'); };
  await assert.rejects(view.attachFiles([file(), {name:'oversized.txt',type:'',size:256*1024+1}]), /256 KiB/u);
  view.chat.context.attachments = [{id:'existing',name:'movie.mp4',mimeType:'video/mp4',size:12*1024*1024}];
  await assert.rejects(view.attachFiles([file(), {name:'reading.pdf',type:'application/pdf',size:1}]), /12 MiB/u);
  assert.equal(calls.length, 0);
  assert.equal(view.chat.context.attachments.length, 1);
  assert.equal(view.chat.context.images.length, 0);
});

test('a file-only draft is sendable and qualifies for closing and saving', async () => {
  const { view } = fixture();
  view.input.value = '';
  assert.equal(view.canReuseWelcome(), true);
  await view.attachFiles([{name:'prompt.txt',type:'',size:1}]);
  assert.equal(view.hasSendContent(), true);
  assert.equal(view.hasCloseContent(), true);
  assert.equal(view.canReuseWelcome(), false);
  await view.removeFileAttachment('file-1');
  assert.equal(view.hasSendContent(), false);
  assert.equal(view.hasCloseContent(), false);
});
