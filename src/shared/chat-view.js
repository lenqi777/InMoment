'use strict';
((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.InMomentChatView = api.ChatView;
})(typeof window === 'object' ? window : globalThis, () => {
  const PLACEHOLDER = '你有什么想法～';
  const quoteCleaner=typeof module==='object'&&module.exports?require('./chat-quote-text.js'):window.InMomentQuoteText;
  const messageText=typeof module==='object'&&module.exports?require('./chat-message-text.js'):window.InMomentChatMessageText;
  const navigation=typeof module==='object'&&module.exports?require('./chat-navigation.js'):window.InMomentChatNavigation;
  const KIB = 1024;
  const MIB = KIB * KIB;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const FILE_LABELS = new Map([['application/pdf', 'PDF'], ['text/plain', 'TXT'], ['text/markdown', 'MD'], ['video/mp4', 'MP4']]);
  const FILE_SEND_HELP = new Map([
    ['application/pdf', '发送时，Gemini 和 OpenAI 接收 PDF 原件。DeepSeek 接收提取的内容。'],
    ['video/mp4', '发送时，Gemini 接收 MP4 原件。OpenAI 和 DeepSeek 接收提取的内容。']
  ]);
  const EXTENSION_TYPES = new Map([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
    ['pdf', 'application/pdf'], ['txt', 'text/plain'], ['md', 'text/markdown'], ['mp4', 'video/mp4']
  ]);
  const FILE_ACCEPT = [...IMAGE_TYPES, '.pdf', '.txt', '.md', '.mp4'].join(',');
  const EFFORT_LABELS = new Map([['auto', '自动'], ['fast', '快速'], ['standard', '标准'], ['deep', '深入']]);
  function modelCatalog(settings) {
    const provider = settings.aiProvider || 'deepseek';
    const local = typeof window === 'object' ? window.InMomentAIProviders?.[provider] : require('./ai-providers.js').PROVIDERS[provider];
    const supplied = settings.aiProviders?.find?.(item => item.id === provider);
    const presets = supplied?.models || local?.models || [];
    const configured = settings.modelMode === 'manual' ? settings.aiProfiles?.[provider]?.model || settings.model || '' : '';
    return { provider, label: supplied?.label || local?.label || provider, presets, configured, models: [...new Set([...presets, ...(configured ? [configured] : [])])] };
  }
  function supportsEffort(catalog, override) {
    const model = override === undefined ? catalog.configured : override;
    return !model || catalog.presets.includes(model);
  }
  function clipboardImages(data) {const items=[...(data?.items||[])].filter(item=>item.kind==='file'&&String(item.type).startsWith('image/')).map(item=>item.getAsFile?.()).filter(Boolean);return [...new Set(items.length?items:[...(data?.files||[])].filter(file=>String(file.type).startsWith('image/')))];}
  function imageBytes(image) {const data=String(image?.base64||image?.data||'');return Math.max(0,Math.floor(data.length*3/4)-(data.endsWith('==')?2:data.endsWith('=')?1:0));}
  function attachmentSelection(files) {
    const selection = { images: [], attachments: [] };
    for (const file of files) {
      const extension = /\.([^.]+)$/u.exec(file.name)?.[1]?.toLowerCase();
      const mimeType = file.type.trim().toLowerCase() || EXTENSION_TYPES.get(extension);
      const isImage = IMAGE_TYPES.has(mimeType);
      if (!isImage && !FILE_LABELS.has(mimeType)) throw new Error('可添加 PNG、JPEG、WebP、GIF 图片和 PDF、TXT、MD、MP4 文件。');
      if (!file.size) throw new Error('无法添加空文件。');
      if (isImage && file.size > 8 * MIB) throw new Error('每张图片请控制在 8 MiB 以内。');
      if ((mimeType === 'text/plain' || mimeType === 'text/markdown') && file.size > 256 * KIB) throw new Error('每个 TXT 或 MD 文件请控制在 256 KiB 以内。');
      selection[isImage ? 'images' : 'attachments'].push({ file, mimeType });
    }
    return selection;
  }
  function validateAttachmentLimits(context, selection) {
    const images = context.images || [];
    const attachments = context.attachments || [];
    const pickedSize = entries => entries.reduce((total, { file }) => total + file.size, 0);
    if (images.length + selection.images.length > 4) throw new Error('每次最多附加 4 张图片。');
    if (attachments.length + selection.attachments.length > 4) throw new Error('每次最多附加 4 个文件。');
    if (images.reduce((total, image) => total + imageBytes(image), 0) + pickedSize(selection.images) > 24 * MIB) throw new Error('图片总大小请控制在 24 MiB 以内。');
    if (attachments.reduce((total, file) => total + file.size, 0) + pickedSize(selection.attachments) > 12 * MIB) throw new Error('文件总大小请控制在 12 MiB 以内。');
  }
  function formatFileSize(bytes) {
    if (bytes < KIB) return `${bytes} B`;
    const [unit, divisor] = bytes < MIB ? ['KiB', KIB] : ['MiB', MIB];
    return `${Number((bytes / divisor).toFixed(1))} ${unit}`;
  }
  const BRAND_ICON=typeof document==='object'&&document.currentScript?.src?new URL('../assets/icon-circle.svg',document.currentScript.src).href:'../assets/icon-circle.svg';
  function meaningfulCandidate(candidate) { const text=String(candidate||'');return /[\p{L}\p{N}]/u.test(text)?text:''; }
  function candidateState({ input = '', candidate = '', composing = false } = {}) {
    const text=meaningfulCandidate(candidate);return { visible: !input && Boolean(text) && !composing, text: text || PLACEHOLDER };
  }
  function acceptsCandidate(event, state) { return event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && candidateState(state).visible; }
  function element(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
  function button(text, className = 'button quiet compact', icon = '') { const item = element('button', className, text); item.type = 'button'; if (icon) item.dataset.uiIcon = icon; return item; }
  function noteSaveMenuItems(disabled) {
    return [
      { id: 'whole', label: '存为笔记', icon: 'transcript', disabled },
      { id: 'summarize', label: '整理为笔记', icon: 'sparkle', disabled },
    ];
  }
  function historyChatVisible(chat,floating=false) {return Boolean((chat?.saved===true||Number(chat?.messageCount??chat?.messages?.length)>0)&&(floating||chat?.saved||chat?.autoSave));}
  function limitedLabel(text, length = 32) { const line = String(text || '').replace(/\s+/gu, ' ').trim(); return [...line].length > length ? [...line].slice(0, length - 1).join('') + '…' : line; }
  function referenceText(record) { return record?.hasTranscriptOverride ? String(record.transcript || '') : record?.transcript || record?.notes || record?.organization?.summary || ''; }
  function sameReference(left, right) {
    return left === right || left === 'record:' + right || right === 'record:' + left;
  }
  function renderText(parent, text) {
    if(messageText?.render)messageText.render(parent,text);else parent.textContent=String(text||'');
  }
  class ChatView {
    constructor({ root, invoke, floating = false, onStatus = () => {}, onOpenRecord = () => {}, onSettings = () => {}, onDirtyChange = () => {} }) {
      Object.assign(this, { root, invoke, floating, onStatus, onOpenRecord, onSettings, onDirtyChange });
      this.chat = null; this.chats = []; this.currentId = null; this.request = 0; this.selected = new Set(); this.editRevision = 0; this.syncedRevision = 0; this.dismissed = false; this.composing = false; this.busy = false; this.voiceStatus = ''; this.writeQueue = Promise.resolve();
      this.voiceIntent='';this.voiceToken=null;this.voiceAttempt=null;this.appliedVoiceTokens=new Set();this.voiceLevels=Array(41).fill(0);
      this.root.classList.add('chat-shell'); this.root.classList.toggle('chat-floating', floating);
      this.build();
    }
    build() {
      this.history = element('aside', 'chat-history'); this.history.setAttribute('aria-label', '聊天历史');
      const historyHead = element('div', 'chat-history-heading'); historyHead.append(element('h1', '', '聊天')); this.newButton = button('新聊天', 'chat-history-new', 'edit'); this.history.append(historyHead,this.newButton);
      this.historySearch = element('input', 'chat-history-search'); this.historySearch.type = 'search'; this.historySearch.placeholder = '搜索聊天…'; this.historySearch.setAttribute('aria-label', '搜索聊天'); this.history.append(this.historySearch);
      this.historyList = element('nav', 'chat-history-list'); this.historyList.setAttribute('aria-label', '聊天历史'); this.history.append(this.historyList);
      this.conversation = element('section', 'chat-conversation'); this.conversation.setAttribute('aria-label', 'AI 聊天');
      this.header = element('header', 'chat-header'); const titles = element('div', 'chat-heading'); this.title = element('h2', '', '新聊天'); this.subtitle = element('p', '', '临时聊天'); titles.append(this.title);if(this.floating)titles.append(this.subtitle); this.header.append(titles);
      this.headerActions = element('div', 'chat-header-actions'); this.saveButton = this.floating?button('', 'icon-button chat-save ui-confirm', 'check'):null;if(this.saveButton){this.saveButton.setAttribute('aria-label','保存聊天');this.saveButton.title='保存聊天';this.saveButton.setAttribute('aria-pressed','false');}
      if (this.floating) { this.mainButton = button('', 'icon-button', 'expand'); this.mainButton.title = '在主窗口打开'; this.mainButton.setAttribute('aria-label', '在主窗口打开'); this.closeButton = button('', 'icon-button', 'close'); this.closeButton.title = '关闭聊天'; this.closeButton.setAttribute('aria-label', '关闭聊天'); this.headerActions.append(this.mainButton,this.saveButton,this.closeButton); }
      if(this.floating)this.header.append(this.headerActions); this.conversation.append(this.header);
      this.selectionBar = element('div', 'chat-selection-bar hidden');this.selectionBar.setAttribute('aria-label','所选对话操作'); this.selectionLabel = element('span');this.selectionQuote=button('引用','button quiet compact','link'); this.selectionSave = button('存为笔记', 'button quiet compact','transcript'); this.selectionDone = button('完成', 'button quiet compact','check'); this.summaryWrap=element('div','chat-summary-wrap');this.summaryOptions=element('div','inmoment-popover chat-summary-options');this.summaryOptions.hidden=true;this.summaryOptions.setAttribute('popover','manual');this.summaryOptions.setAttribute('role','dialog');this.summaryOptions.setAttribute('aria-label','AI 总结后存为笔记');this.summaryButton=button('AI 总结','button quiet compact','sparkle');this.summaryButton.setAttribute('aria-label','AI 总结后存为笔记');this.summaryOptions.append(this.summaryButton);this.summaryWrap.append(this.selectionSave,this.summaryOptions);this.selectionSave.setAttribute('aria-haspopup','dialog');this.selectionSave.setAttribute('aria-expanded','false');this.selectionBar.append(this.selectionLabel,this.selectionQuote,this.summaryWrap,this.selectionDone);
      this.messages = element('div', 'chat-messages'); this.messages.setAttribute('role', 'log'); this.messages.setAttribute('aria-label', '对话内容'); this.messages.setAttribute('aria-live', 'off'); this.conversation.append(this.messages);
      this.feedback = element('div', 'chat-feedback'); this.feedback.setAttribute('role', 'status');this.feedback.setAttribute('aria-live','polite'); this.status = element('span'); this.feedback.append(this.status); this.conversation.append(this.feedback);
      this.errorToast=element('aside','chat-error-toast');this.errorToast.hidden=true;this.errorToast.setAttribute('role','alert');this.errorText=element('p');this.retryButton=button('重新生成','button quiet compact','sparkle');this.retryButton.hidden=true;this.settingsButton=button('打开设置','button quiet compact','settings');this.settingsButton.hidden=true;const errorClose=button('','icon-button','close');errorClose.setAttribute('aria-label','关闭错误提示');errorClose.addEventListener('click',()=>{this.dismissedError=this.errorText.textContent;this.errorToast.hidden=true;});const errorActions=element('div','chat-error-actions');errorActions.append(this.retryButton,this.settingsButton,errorClose);this.errorToast.append(this.errorText,errorActions);this.conversation.append(this.errorToast);
      this.composer = element('form', 'chat-composer'); this.composer.setAttribute('aria-label', '发送消息');
      this.composer.append(this.selectionBar);
      this.attachments = element('div', 'chat-attachments'); this.composer.append(this.attachments);
      this.textAreaWrap = element('div', 'chat-input-wrap'); this.input = element('textarea', 'chat-input'); this.input.rows = 2; this.input.maxLength = 50000; this.input.placeholder = PLACEHOLDER; this.input.setAttribute('aria-label', '消息'); this.ghost = element('div', 'chat-ghost'); this.ghost.setAttribute('aria-hidden', 'true'); this.ghostText=element('span','chat-ghost-text');this.ghostKey=element('kbd','chat-ghost-key','Tab');this.ghostKey.setAttribute('aria-hidden','true');this.ghost.append(this.ghostText,this.ghostKey); this.inputMeasure = element('textarea', 'chat-input-measure'); this.inputMeasure.rows = 1; this.inputMeasure.readOnly = true; this.inputMeasure.tabIndex = -1; this.inputMeasure.setAttribute('aria-hidden','true'); this.textAreaWrap.append(this.ghost, this.input, this.inputMeasure); this.composer.append(this.textAreaWrap);
      const tools = element('div', 'chat-composer-tools'), toolsLeft = element('div', 'chat-composer-left'), toolsRight = element('div', 'chat-composer-right'); this.addButton = button('', 'icon-button chat-add-button', 'add'); this.addButton.title = '添加内容与聊天操作'; this.addButton.setAttribute('aria-label', '添加内容'); this.addButton.setAttribute('aria-haspopup', 'menu'); this.addButton.setAttribute('aria-expanded', 'false'); this.voiceButton = button('', 'icon-button chat-voice-button'); this.voiceButton.title = '语音输入'; this.voiceButton.setAttribute('aria-label', '语音输入');
      if(window.InMomentBrandMorph?.mount)this.voiceMorph=window.InMomentBrandMorph.mount(this.voiceButton,{background:false,colors:['#D9B57A','currentColor']});else{const logo=element('img','chat-voice-fallback');logo.src=BRAND_ICON;logo.alt='';this.voiceButton.append(logo);}
      this.screenshotWrap=element('div','chat-screenshot-wrap');this.screenshotButton=button('','icon-button chat-screenshot-button');this.screenshotButton.title='截取图片';this.screenshotButton.setAttribute('aria-label','截取图片');this.screenshotButton.setAttribute('aria-haspopup','dialog');this.screenshotButton.setAttribute('aria-expanded','false');this.scissors=window.InMomentScissors?.mount(this.screenshotButton);this.screenshotOptions=element('div','inmoment-popover chat-screenshot-options');this.screenshotOptions.hidden=true;this.screenshotOptions.setAttribute('popover','manual');this.screenshotOptions.setAttribute('role','dialog');this.screenshotOptions.setAttribute('aria-label','截图选项');const keepLabel=element('label');this.screenshotKeepInput=element('input');this.screenshotKeepInput.type='checkbox';keepLabel.append(this.screenshotKeepInput,element('span','','不隐藏当前页面'));this.screenshotOptions.append(keepLabel);this.screenshotWrap.append(this.screenshotButton,this.screenshotOptions);
      this.voiceWave=element('div','chat-voice-wave');this.voiceWave.hidden=true;this.voiceWave.setAttribute('role','img');this.voiceWave.setAttribute('aria-label','录音音量');this.voiceBars=Array.from({length:41},()=>{const bar=element('span');bar.setAttribute('aria-hidden','true');this.voiceWave.append(bar);return bar;});
      this.composerLeft = toolsLeft;
      this.modelButton = button('', 'button quiet chat-model-button', 'chevron');
      this.modelButton.setAttribute('aria-haspopup', 'menu');
      this.modelButton.setAttribute('aria-expanded', 'false');
      this.modelLabel = element('span', 'chat-model-label', '自动');
      this.modelShortLabel = element('span', 'chat-model-short-label', '自动');
      this.modelButton.append(this.modelLabel, this.modelShortLabel);
      this.modelButton.addEventListener('click', () => this.run(() => this.chooseChatModel()));
      this.modelButton.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        this.run(() => this.chooseChatModel());
      });
      this.fileInput = element('input', 'hidden'); this.fileInput.type = 'file'; this.fileInput.accept = FILE_ACCEPT; this.fileInput.multiple = true; this.fileInput.tabIndex = -1;
      this.sendButton = button('', 'icon-button chat-submit chat-send', 'sparkle');
      this.sendButton.type = 'submit';
      this.sendButton.title = '发送';
      this.sendButton.setAttribute('aria-label', this.sendButton.title);
      this.stopButton = button('', 'icon-button chat-submit chat-stop', 'pause');
      this.stopButton.title = '停止回复';
      this.stopButton.setAttribute('aria-label', this.stopButton.title);
      this.stopButton.hidden = true;
      toolsLeft.append(this.addButton, this.modelButton);
      toolsRight.append(this.voiceButton, this.screenshotWrap, this.stopButton, this.sendButton);
      tools.append(toolsLeft, this.voiceWave, toolsRight);
      this.composer.append(tools, this.fileInput);
      this.conversation.append(this.composer);
      this.buildReferenceMenu();
      this.root.append(...(this.floating ? [] : [this.history]), this.conversation);
      this.navigation=navigation?.mount({conversation:this.conversation,messages:this.messages,composer:this.composer,header:this.header,getMessages:()=>this.chat?.messages||[],getId:()=>this.currentId});
      this.setupSummaryPopover();this.buildCloseDialog();
      this.newButton.addEventListener('click', () => this.run(() => this.startNewChat())); this.historySearch.addEventListener('input', () => this.renderHistory());
      this.saveButton?.addEventListener('click',()=>this.run(()=>this.saveCurrentChat()));
      this.selectionSave.addEventListener('click', () => this.run(() => {this.closeSummaryOptions(true);return this.makeInspiration(false,[...this.selected]);}));this.selectionQuote.addEventListener('click',()=>this.run(()=>this.quoteSelectedMessages())); this.selectionDone.addEventListener('click', () => this.endSelection());
      this.messages.addEventListener('contextmenu',event=>{const message=event.target.closest?.('[data-message-id]');if(!message||event.target.closest?.('.chat-image-open'))return;event.preventDefault();this.run(()=>this.openMessageMenu(event,message));});
      this.messages.addEventListener('copy',event=>this.copyMessageSelection(event));
      this.messages.addEventListener('keydown',event=>{if(event.key!=='ContextMenu'&&!(event.key==='F10'&&event.shiftKey))return;const message=event.target.closest?.('[data-message-id]');if(!message)return;event.preventDefault();this.run(()=>this.openMessageMenu(event,message));});
      this.mainButton?.addEventListener('click', () => this.run(() => this.transferChat('chat:showMain'))); this.closeButton?.addEventListener('click', () => this.run(() => this.invoke('chat:close',{id:this.currentId})));
      this.input.addEventListener('input', () => { this.editRevision++; this.dismissed = false; this.updateGhost(); this.updateSend(); this.queueComposer(); this.resizeInput(); });
      this.input.addEventListener('compositionstart', () => { this.composing = true; this.updateGhost(); }); this.input.addEventListener('compositionend', () => { this.composing = false; this.updateGhost(); });
      this.tabHandler=event=>this.adoptCandidate(event);document.addEventListener('keydown',this.tabHandler,true);
      this.ghost.addEventListener('pointerdown', event => { const box=this.ghost.getBoundingClientRect(),bar=this.ghost.offsetWidth-this.ghost.clientWidth; if(this.ghost.scrollHeight>this.ghost.clientHeight+1&&bar>0&&event.clientX>=box.right-bar)return;event.preventDefault();this.input.focus({preventScroll:true}); });
      this.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this.composing) { event.preventDefault(); if (!this.sendButton.disabled) this.run(() => this.send()); } });
      this.input.addEventListener('keyup',event=>{if(!['Home','End'].includes(event.key)||!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing||this.composing)return;this.scheduleCaretReveal(event.key==='End'?'end':'start');});
      this.composer.addEventListener('submit', event => { event.preventDefault(); this.run(() => this.send()); }); this.stopButton.addEventListener('click', () => this.run(async () => { await this.invoke('chat:cancel', { id: this.currentId }); })); this.retryButton.addEventListener('click', () => this.run(async () => { await this.invoke('chat:retry', { id: this.currentId }); })); this.settingsButton.addEventListener('click', () => this.onSettings());
      this.addButton.addEventListener('click', () => this.run(() => this.activateAddButton())); this.fileInput.addEventListener('change', () => this.run(() => this.addFiles()));
      this.screenshotButton.addEventListener('click',()=>this.run(()=>this.captureScreenshot()));for(const [target,key]of[[this.screenshotButton,'screenshotPointerButton'],[this.screenshotOptions,'screenshotPointerOptions']]){target.addEventListener('mouseenter',()=>{this[key]=true;this.screenshotDismissed=false;clearTimeout(this.screenshotHideTimer);if(this.screenshotOptions.dataset.popoverState==='closing')this.openScreenshotOptions();else this.scheduleScreenshotOptions();});target.addEventListener('mouseleave',()=>{this[key]=false;this.scheduleScreenshotHide();});}this.screenshotWrap.addEventListener('focusin',event=>{clearTimeout(this.screenshotHideTimer);if(!this.screenshotWrap.contains(event.relatedTarget))this.screenshotDismissed=false;this.scheduleScreenshotOptions();});this.screenshotWrap.addEventListener('focusout',event=>{if(!this.screenshotWrap.contains(event.relatedTarget))this.scheduleScreenshotHide();});this.screenshotKeepInput.addEventListener('change',()=>this.run(()=>this.saveScreenshotPreference()));
      this.voiceButton.addEventListener('click', () => this.run(() => this.isVoiceMode()?this.stopVoice():this.startVoice()));
      this.escapeHandler = event => { if(event.key!=='Escape'||window.InMomentNoteImageViewer?.isOpen())return;if(!this.root.contains(document.activeElement)&&this.screenshotOptions.hidden&&this.summaryOptions.hidden)return;if(!this.summaryOptions.hidden){this.closeSummaryOptions(true);this.selectionSave.focus();return;}if(!this.screenshotOptions.hidden){this.closeScreenshotOptions(true);this.screenshotButton.focus();} };
      this.outsideHandler = event => {if(!this.summaryWrap.contains(event.target))this.closeSummaryOptions();if(!this.screenshotWrap.contains(event.target))this.closeScreenshotOptions();};
      document.addEventListener('keydown', this.escapeHandler); document.addEventListener('pointerdown', this.outsideHandler);
      this.composerResizeHandler=()=>this.scheduleInputLayout();this.composerFocusHandler=()=>{this.lastNativeResizeKey='';this.scheduleInputLayout();};window.addEventListener('resize',this.composerResizeHandler);window.addEventListener('focus',this.composerFocusHandler);
      this.pasteHandler=event=>this.handleImagePaste(event);this.root.addEventListener('paste',this.pasteHandler);
      if(typeof ResizeObserver==='function'){this.layoutObserver=new ResizeObserver(this.composerResizeHandler);for(const region of[this.conversation,this.textAreaWrap,this.header,this.feedback,this.attachments,this.composer,this.selectionBar,this.messages])this.layoutObserver.observe(region);}
      this.input.addEventListener('focus',this.composerResizeHandler);
      this.renderEmpty();
      this.readModelCatalog().catch(() => {});
    }
    adoptCandidate(event) {
      if(event.key!=='Tab'||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||this.composing||!this.currentId||!this.root.getClientRects().length||getComputedStyle(this.root).visibility==='hidden')return;
      if(this.isVoiceMode()||this.selecting||this.history?.contains(event.target)||event.target.closest?.('.chat-question-navigation,.chat-bottom-button'))return;
      if(this.closeDialog?.open||this.addMenuOpen||this.modelMenuOpen||document.querySelector('dialog[open],.inmoment-popover[data-popover-state="open"]')||event.target!==this.input&&event.target.matches?.('input,textarea,select'))return;
      const candidate=['preparing','recording','paused','transcribing'].includes(this.voiceStatus)?'':meaningfulCandidate(this.chat?.candidate);
      const eligible=!this.input.value&&Boolean(candidate);
      event.preventDefault();event.stopPropagation();this.transcriptionEntry=true;
      if(eligible){this.adoptedTranscription=true;this.input.value=candidate;this.editRevision++;this.dismissed=false;this.input.focus({preventScroll:true});this.input.setSelectionRange(this.input.value.length,this.input.value.length);this.updateGhost();this.updateSend();this.resizeInput();this.input.scrollTop=this.input.scrollHeight;this.report('');this.run(()=>this.flush());}
      else if(document.activeElement!==this.input)this.input.focus({preventScroll:true});
    }
    activateAddButton() { return this.hasCancellableVoice()?this.cancelVoice():this.openAddMenu(); }
    async openAddMenu() {
      if (this.addButton.disabled) return;
      this.closeScreenshotOptions?.(true);
      if (this.addMenuOpen) { this.closeAddMenu(true); return; }
      if (!window.InMomentMenus?.open) throw new Error('添加菜单暂时不可用，请重试。');
      const target = { id: this.currentId, request: this.request };
      this.addMenuOpen = true;
      this.addButton.setAttribute('aria-expanded','true');
      let action;
      const blocked = Boolean(this.busy || this.chat?.pending || this.savingInspiration);
      const empty = !this.chat?.messages?.length;
      const noteSaveDisabled = blocked || empty || Boolean(this.inspirationJobs?.has(target.id));
      const submenu = {
        panel: this.referencePanel, focus: this.referenceSearch,
        onOpen: () => this.openReferenceMenu(target), onClose: () => this.closeReferenceMenu(),
      };
      try {
        action = await window.InMomentMenus.open({ anchor: this.addButton, title: '添加内容与聊天操作', items: [
          { id: 'image', label: '添加文件或图片', icon: 'transcript', disabled: blocked },
          { id: 'inspiration', label: '引用笔记', icon: 'link', disabled: blocked, submenu },
          ...noteSaveMenuItems(noteSaveDisabled),
          ...(this.canRetry() ? [{ id: 'retry', label: '重新生成', icon: 'sparkle', disabled: blocked }] : []),
          ...(/设置|密钥|API Key|云端/u.test(this.chat?.error || this.lastErrorText || '') ? [{ id: 'settings', label: '打开设置', icon: 'settings' }] : []),
          ...(!this.floating ? [{ id: 'floating', label: '在浮窗中打开', icon: 'expand' }] : []),
        ] });
      }
      finally { this.addMenuOpen = false; this.addButton.setAttribute('aria-expanded','false'); }
      if (!target.id || target.id !== this.currentId || target.request !== this.request || this.addButton.disabled) return;
      if (action === 'image') { this.fileTarget = target; this.fileInput.click(); }
      else if (action === 'whole') await this.makeInspiration(false);
      else if (action === 'summarize') await this.makeInspiration(true);
      else if (action === 'retry') await this.invoke('chat:retry', { id: target.id });
      else if (action === 'settings') this.onSettings();
      else if (action === 'floating') await this.transferChat('chat:openFloating');
    }
    closeAddMenu(restore = false) {
      if (this.addMenuOpen) window.InMomentMenus?.close?.(restore, this.addButton);
    }
    async loadScreenshotPreference() { if(this.screenshotPreferenceLoaded)return this.keepChatVisible===true;if(this.screenshotPreferencePromise)return this.screenshotPreferencePromise;this.screenshotPreferencePromise=this.invoke('settings:get').then(value=>{this.keepChatVisible=value?.screenshotKeepChatVisible===true;this.screenshotPreferenceLoaded=true;if(this.screenshotKeepInput)this.screenshotKeepInput.checked=this.keepChatVisible;return this.keepChatVisible;}).finally(()=>{this.screenshotPreferencePromise=null;});return this.screenshotPreferencePromise; }
    async saveScreenshotPreference() { const previous=this.keepChatVisible===true,next=this.screenshotKeepInput.checked,version=this.screenshotPreferenceVersion=(this.screenshotPreferenceVersion||0)+1;this.keepChatVisible=next;this.screenshotPreferenceLoaded=true;try{const result=await this.invoke('settings:save',{screenshotKeepChatVisible:next});if(result?.cancelled)throw new Error('截图选项未保存，请重试。');}catch(error){if(version===this.screenshotPreferenceVersion){this.keepChatVisible=previous;this.screenshotKeepInput.checked=previous;}throw error;} }
    screenshotFocusInside() { return this.screenshotOptions.contains(document.activeElement)||document.activeElement===this.screenshotButton&&this.screenshotButton.matches(':focus-visible'); }
    scheduleScreenshotOptions() { clearTimeout(this.screenshotHoverTimer);if(this.screenshotDismissed||!this.screenshotOptions.hidden)return;this.screenshotHoverTimer=setTimeout(()=>this.run(async()=>{await this.loadScreenshotPreference();if(!this.screenshotPointerButton&&!this.screenshotPointerOptions&&!this.screenshotFocusInside()||this.screenshotDismissed)return;this.openScreenshotOptions();}),1000); }
    scheduleScreenshotHide() { clearTimeout(this.screenshotHoverTimer);clearTimeout(this.screenshotHideTimer);if(this.screenshotPointerButton||this.screenshotPointerOptions||this.screenshotFocusInside())return;this.screenshotHideTimer=setTimeout(()=>{if(!this.screenshotPointerButton&&!this.screenshotPointerOptions&&!this.screenshotFocusInside())this.closeScreenshotOptions();},1000); }
    openScreenshotOptions() { this.screenshotPopoverVersion=(this.screenshotPopoverVersion||0)+1;this.screenshotOptions.hidden=false;this.screenshotOptions.dataset.popoverState='open';try{this.screenshotOptions.showPopover?.();}catch{}const rect=this.screenshotButton.getBoundingClientRect(),size=this.screenshotOptions.getBoundingClientRect();this.screenshotOptions.style.left=Math.max(10,Math.min(rect.right-size.width,innerWidth-size.width-10))+'px';this.screenshotOptions.style.top=Math.max(10,rect.top-size.height-8)+'px';this.screenshotButton.setAttribute('aria-expanded','true');window.InMomentMotion?.enter(this.screenshotOptions,{kind:'popover'}); }
    closeScreenshotOptions(dismiss=false) { clearTimeout(this.screenshotHoverTimer);clearTimeout(this.screenshotHideTimer);if(dismiss)this.screenshotDismissed=true;if(!this.screenshotOptions||this.screenshotOptions.hidden||this.screenshotOptions.dataset.popoverState==='closing')return;const version=this.screenshotPopoverVersion=(this.screenshotPopoverVersion||0)+1;this.screenshotOptions.dataset.popoverState='closing';this.screenshotButton.setAttribute('aria-expanded','false');const finish=()=>{if(version!==this.screenshotPopoverVersion)return;try{this.screenshotOptions.hidePopover?.();}catch{}this.screenshotOptions.hidden=true;};const motion=window.InMomentMotion?.exit(this.screenshotOptions,{kind:'popover'});if(motion?.then)motion.then(finish,finish);else finish(); }
    async captureScreenshot() { if(this.screenshotBusy)return;if(!this.currentId)await this.open();if(!this.currentId)return;const id=this.currentId;this.closeScreenshotOptions(true);this.screenshotBusy=true;this.updateSend();try{const keepChatVisible=await this.loadScreenshotPreference();await this.flush();if(this.currentId!==id)return;const result=await this.invoke('chat:screenshot',{id,keepChatVisible});if(this.currentId===id&&result?.chat)this.setChat(result.chat);if(result?.chat&&!result.cancelled)this.report('截图已添加');return result;}finally{this.screenshotBusy=false;this.updateSend();} }
    selectionContextKey() {return this.currentId+'|'+[...this.selected].sort().join('|');}
    setupSummaryPopover() {for(const[target,key]of[[this.selectionSave,'summaryPointerButton'],[this.summaryOptions,'summaryPointerOptions']]){target.addEventListener('mouseenter',()=>{this[key]=true;this.summaryDismissed=false;clearTimeout(this.summaryHideTimer);if(this.summaryOptions.dataset.popoverState==='closing')this.openSummaryOptions();else this.scheduleSummaryOptions();});target.addEventListener('mouseleave',()=>{this[key]=false;this.scheduleSummaryHide();});}this.summaryWrap.addEventListener('focusin',event=>{clearTimeout(this.summaryHideTimer);if(!this.summaryWrap.contains(event.relatedTarget))this.summaryDismissed=false;this.scheduleSummaryOptions();});this.summaryWrap.addEventListener('focusout',event=>{if(!this.summaryWrap.contains(event.relatedTarget))this.scheduleSummaryHide();});this.summaryButton.addEventListener('click',()=>this.run(()=>this.summarizeSelected()));}
    summaryFocusInside() {return this.summaryOptions.contains(document.activeElement)||document.activeElement===this.selectionSave&&this.selectionSave.matches(':focus-visible');}
    scheduleSummaryOptions() {clearTimeout(this.summaryOpenTimer);if(this.summaryDismissed||!this.selecting||this.selectionSave.disabled||!this.summaryOptions.hidden)return;this.summaryOpenTimer=setTimeout(()=>{if(!this.summaryDismissed&&(this.summaryPointerButton||this.summaryPointerOptions||this.summaryFocusInside()))this.openSummaryOptions();},1000);}
    scheduleSummaryHide() {clearTimeout(this.summaryOpenTimer);clearTimeout(this.summaryHideTimer);if(this.summaryPointerButton||this.summaryPointerOptions||this.summaryFocusInside())return;this.summaryHideTimer=setTimeout(()=>{if(!this.summaryPointerButton&&!this.summaryPointerOptions&&!this.summaryFocusInside())this.closeSummaryOptions();},1000);}
    openSummaryOptions() {if(!this.selecting||this.selectionSave.disabled||!this.selected.size)return;this.summaryVersion=(this.summaryVersion||0)+1;this.summaryContext={id:this.currentId,ids:[...this.selected],key:this.selectionContextKey()};this.summaryOptions.hidden=false;this.summaryOptions.dataset.popoverState='open';try{this.summaryOptions.showPopover?.();}catch{}const rect=this.selectionSave.getBoundingClientRect(),size=this.summaryOptions.getBoundingClientRect();this.summaryOptions.style.left=Math.max(10,Math.min(rect.left+(rect.width-size.width)/2,innerWidth-size.width-10))+'px';this.summaryOptions.style.top=Math.max(10,rect.top-size.height-8)+'px';this.selectionSave.setAttribute('aria-expanded','true');window.InMomentMotion?.enter(this.summaryOptions,{kind:'popover'});}
    closeSummaryOptions(dismiss=false) {clearTimeout(this.summaryOpenTimer);clearTimeout(this.summaryHideTimer);this.summaryContext=null;if(dismiss)this.summaryDismissed=true;if(!this.summaryOptions||this.summaryOptions.hidden||this.summaryOptions.dataset.popoverState==='closing')return;const version=this.summaryVersion=(this.summaryVersion||0)+1;this.summaryOptions.dataset.popoverState='closing';this.selectionSave.setAttribute('aria-expanded','false');const finish=()=>{if(version!==this.summaryVersion)return;try{this.summaryOptions.hidePopover?.();}catch{}this.summaryOptions.hidden=true;};const motion=window.InMomentMotion?.exit(this.summaryOptions,{kind:'popover'});if(motion?.then)motion.then(finish,finish);else finish();}
    summarizeSelected() {const scope=this.summaryContext;this.closeSummaryOptions(true);if(!scope||scope.id!==this.currentId||scope.key!==this.selectionContextKey()||!this.selecting||this.selectionSave.disabled)return;return this.makeInspiration(true,scope.ids);}
    canRetry() { const message=this.chat?.messages?.at(-1);return message?.role==='assistant'&&['error','cancelled','stopped','interrupted'].includes(message.status); }
    selectedMessageText() { return (this.chat?.messages||[]).filter(message=>this.selected.has(message.id)).map(message=>(message.role==='assistant'?'Moment':'你')+'：\n'+(message.text||'')).join('\n\n'); }
    async quoteSelectedMessages() {const id=this.currentId,request=this.request,key=this.selectionContextKey(),changed=await this.quoteText(this.selectedMessageText());if(changed&&id===this.currentId&&request===this.request&&this.selecting&&key===this.selectionContextKey())this.endSelection();return changed;}
    quoteText(text) {const clean=quoteCleaner.clean(text);if(!clean)return Promise.resolve(false);if(clean.length>10000)throw new Error('每条引用最多 10000 个字符，请减少所选文字。');return this.queueAttachmentUpdate(async(id,current)=>{const quotes=[...(this.chat.context?.quotes||[]),{id:crypto.randomUUID(),text:clean}];if(quotes.length>8||quotes.reduce((size,item)=>size+item.text.length,0)>40000)throw new Error('每次最多引用 8 条、合计 40000 个字符。');const value=await this.invoke('chat:update',{id,quotes});if(current()){this.setChat(value);return true;}return false;});}
    endSelection() {this.closeSummaryOptions?.(true); this.selecting=false;this.selected.clear();this.renderMessages();this.renderSelection();this.resizeInput();this.input.focus({preventScroll:true}); }
    async openMessageMenu(event,article) {
      if(!window.InMomentMenus?.open)return;const id=this.currentId,messageId=article.dataset.messageId,message=this.chat?.messages.find(item=>item.id===messageId);if(!message)return;
      const selection=window.getSelection(),selected=selection&&!selection.isCollapsed&&this.messages.contains(selection.anchorNode)&&this.messages.contains(selection.focusNode)?(messageText?.selectionText?.(selection,this.messages)??selection.toString()):'';
      const text=selected.trim()?selected:(message.role==='assistant'?'Moment':'你')+'：\n'+(message.text||''),rect=article.getBoundingClientRect(),mouse=event.type==='contextmenu'&&event.clientX>0;
      const point={x:mouse?event.clientX:rect.left+24,y:mouse?event.clientY:rect.top+Math.min(24,rect.height)},view=this;
      const anchor={get isConnected(){return view.root.isConnected&&view.currentId===id;},getBoundingClientRect:()=>({left:point.x,right:point.x,top:point.y,bottom:point.y,width:0,height:0}),closest:()=>null,contains:target=>article.contains(target),focus:()=>{if(article.isConnected)article.focus({preventScroll:true});else view.input.focus({preventScroll:true});}};
      this.messageMenuOpen=true;let action;try{action=await window.InMomentMenus.open({anchor,title:'对话操作',items:[{id:'multi',label:'多选',icon:'checklist',disabled:this.isVoiceMode()},{id:'quote',label:'引用',icon:'link',disabled:!text.trim()||this.isVoiceMode()}]});}finally{this.messageMenuOpen=false;}
      if(this.currentId!==id)return;if(action==='multi'){this.selecting=true;this.selected=new Set([messageId]);this.renderMessages();this.renderSelection();this.messages.querySelector('[data-chat-message="'+CSS.escape(messageId)+'"]')?.focus({preventScroll:true});}else if(action==='quote')await this.quoteText(text);
    }
    copyMessageSelection(event) {const selection=window.getSelection();if(event.defaultPrevented||!event.clipboardData?.setData||!selection||selection.isCollapsed||!this.messages.contains(selection.anchorNode)||!this.messages.contains(selection.focusNode))return;const text=messageText?.selectionText?.(selection,this.messages)??selection.toString();if(text===selection.toString())return;event.preventDefault();event.clipboardData.setData('text/plain',text);}
    hasCancellableVoice() {return this.isVoiceMode()||this.voiceStatus==='error'&&Boolean(this.voiceAttempt||this.chat?.context?.audioDraftId);}
    isVoiceMode() { return this.voiceIntent==='input'&&['preparing','recording','paused','transcribing'].includes(this.voiceStatus); }
    clearVoiceWave() { clearTimeout(this.voiceLevelTimer);this.voiceLevels=Array(41).fill(0);for(const bar of this.voiceBars||[])bar.style.height='3px'; }
    renderVoiceMode() {
      if(!this.voiceWave)return;const active=this.isVoiceMode(),cancellable=this.hasCancellableVoice();this.composer.classList.toggle('chat-voice-cancellable',cancellable);if(active)this.closeSummaryOptions?.(true);this.composer.classList.toggle('chat-voice-mode',active);this.voiceWave.hidden=!active;
      this.addButton.classList?.toggle('ui-cancel',cancellable);const addLabel=cancellable?'取消本次录音':'添加内容';this.addButton.setAttribute('aria-label',addLabel);this.addButton.title=cancellable?addLabel:'添加内容与聊天操作';if(cancellable){this.addButton.removeAttribute?.('aria-haspopup');this.addButton.setAttribute('aria-expanded','false');}else this.addButton.setAttribute('aria-haspopup','menu');
      const label=active?'结束录音并转成文字':'语音输入';this.voiceButton.setAttribute('aria-label',label);this.voiceButton.title=label;this.voiceButton.dataset.buttonSelected=String(active);this.voiceMorph?.setState(active?'pause':'play');
      if(this.voiceStatus!=='recording')this.clearVoiceWave();this.positionVoiceWave();this.scheduleInputLayout();
    }
    positionVoiceWave() { if(!this.voiceWave?.parentElement||!this.addButton?.getBoundingClientRect)return;const toolbar=this.voiceWave.parentElement.getBoundingClientRect(),left=(this.composerLeft||this.addButton).getBoundingClientRect().right,right=this.voiceButton.getBoundingClientRect().left,gap=Math.max(0,right-left);this.voiceWave.style.left=(left-toolbar.left+gap*.1)+'px';this.voiceWave.style.width=gap*.8+'px'; }
    receiveAudioLevel(event) {
      if(event.id!==this.currentId||this.voiceIntent!=='input'||this.voiceStatus!=='recording'||event.token!==this.voiceToken||event.draftId!==this.voiceDraftId||event.segmentId!==this.voiceSegmentId||!Number.isFinite(event.level)||!Number.isFinite(event.peak))return;
      const value=Math.max(0,Math.min(1,event.level));if(value<.008)this.voiceLevels=Array(41).fill(0);else{this.voiceLevels||=Array(41).fill(0);this.voiceLevels.shift();this.voiceLevels.push(value);}
      (this.voiceBars||[]).forEach((bar,index)=>{bar.style.height=(3+Math.min(25,25*this.voiceLevels[index])).toFixed(2)+'px';});clearTimeout(this.voiceLevelTimer);this.voiceLevelTimer=setTimeout(()=>this.clearVoiceWave(),320);
    }
    async startVoice() {
      if(!this.currentId)await this.open();
      if(!this.currentId||this.busy||this.chat?.pending||this.voiceCancelling||this.isVoiceMode())return;
      if(this.selecting){this.selecting=false;this.selected.clear();this.closeSummaryOptions?.(true);this.renderMessages();this.renderSelection();this.resizeInput();}
      const attempt={id:this.currentId,value:this.input.value,revision:this.editRevision,start:this.input.selectionStart||0,end:this.input.selectionEnd||0,token:null};attempt.done=new Promise(resolve=>{attempt.resolve=resolve;});this.voiceAttempt=attempt;this.voiceToken=null;this.voiceDraftId=null;this.voiceSegmentId=null;this.voiceIntent='input';this.voiceStatus='preparing';this.clearVoiceWave();this.updateSend();this.renderVoiceMode();
      const pending=this.invoke('chat:record',{id:attempt.id});this.voiceStartPromise=pending;
      try{const result=await pending;if(this.voiceAttempt!==attempt||this.currentId!==attempt.id)return result;if(result?.token){attempt.token||=result.token;this.voiceToken=result.token;}if(result?.chat)this.setChat(result.chat);return result;}
      catch(error){attempt.resolve();if(this.voiceAttempt===attempt){this.voiceAttempt=null;this.voiceStatus='error';this.clearVoiceWave();this.updateSend();this.renderVoiceMode();}throw error;}
      finally{if(this.voiceStartPromise===pending)this.voiceStartPromise=null;}
    }
    async stopVoice() {
      const id=this.currentId;if(this.voiceStartPromise)await this.voiceStartPromise;if(id!==this.currentId||!this.isVoiceMode()||this.voiceStatus==='transcribing')return;
      return this.invoke('chat:voiceStop',{id,token:this.voiceToken});
    }
    async cancelVoice() {
      const id=this.currentId,token=this.voiceToken;this.voiceCancelling=true;this.voiceAttempt?.resolve?.();this.voiceAttempt=null;this.voiceStatus='cancelled';this.clearVoiceWave();this.updateSend();this.renderVoiceMode();this.report('');try{return await this.invoke('chat:voiceCancel',{id,token});}finally{this.voiceCancelling=false;this.updateSend();}
    }
    async prepareToLeave({waitForTranscription=true}={}) {
      this.closeAddMenu();
      this.closeSummaryOptions?.(true);
      this.closeScreenshotOptions?.(true);
      this.closeModelMenu();
      const attempt = this.voiceAttempt;
      if (this.isVoiceMode() && this.voiceStatus !== 'transcribing') await this.stopVoice();
      if (waitForTranscription && attempt?.done && !['ready','empty','error','cancelled'].includes(this.voiceStatus)) await attempt.done;
      if (this.attachmentPending) await this.attachmentQueue.catch(() => {});
      await this.flush();
    }
    renderModelChoice() {
      if (!this.modelButton) return;
      const choice = this.modelChoices?.get(this.currentId);
      const effort = EFFORT_LABELS.get(choice?.reasoningEffort) || '自动';
      const selected = choice?.modelOverride === undefined ? this.currentModelCatalog?.configured : choice.modelOverride;
      const model = selected || '自动';
      const label = effort === '自动' ? model : `${model} · ${effort}`;
      const shortLabel = selected ? '手动' : effort;
      if (this.modelLabel.textContent !== label) this.modelLabel.textContent = label;
      if (this.modelShortLabel.textContent !== shortLabel) this.modelShortLabel.textContent = shortLabel;
      this.modelButton.title = `模型 ${model}，推理强度 ${effort}`;
      this.modelButton.setAttribute('aria-label', this.modelButton.title);
    }
    async readModelCatalog() {
      const revision = this.modelSettingsRevision;
      const response = await this.invoke('settings:get');
      const catalog = modelCatalog(response?.settings || response || {});
      if (revision === this.modelSettingsRevision && !this.destroyed) {
        this.currentModelCatalog = catalog;
        this.renderModelChoice();
      }
      return catalog;
    }
    closeModelMenu() {
      if (!this.modelMenuOpen) return;
      this.modelMenuCancelled = true;
      window.InMomentMenus?.close?.();
    }
    async chooseChatModel() {
      if (this.modelMenuOpen) return this.closeModelMenu();
      const { currentId: id, request, modelSettingsRevision } = this;
      const anchor = this.modelButton;
      if (!id || anchor.disabled || !window.InMomentMenus?.open) return;
      const isCurrent = () => !this.modelMenuCancelled && id === this.currentId && request === this.request && modelSettingsRevision === this.modelSettingsRevision && !anchor.disabled && anchor.isConnected && (anchor.getClientRects?.().length ?? 1) > 0;
      this.modelMenuCancelled = false;
      this.modelMenuOpen = true;
      anchor.setAttribute('aria-expanded', 'true');
      try {
        const catalog = await this.readModelCatalog();
        if (!isCurrent()) return;
        this.modelChoices ||= new Map();
        const saved = this.modelChoices.get(id);
        const choice = saved?.provider === catalog.provider ? { ...saved } : { provider: catalog.provider, modelOverride: undefined, reasoningEffort: 'auto' };
        const selectedModel = choice.modelOverride === undefined ? catalog.configured : choice.modelOverride;
        const open = (title, items, selection = false) => window.InMomentMenus.open({ anchor, title, items, selection });
        const section = await open(catalog.label, [
          { id: 'model', label: `模型 · ${selectedModel || '自动'}` },
          { id: 'effort', label: `推理强度 · ${EFFORT_LABELS.get(choice.reasoningEffort)}` }
        ]);
        if (!isCurrent()) return;
        if (section === 'model') {
          const items = [{ id: 'auto', label: '自动', selected: !selectedModel }, ...catalog.models.map(model => ({ id: model, label: model, selected: model === selectedModel }))];
          const model = await open('选择聊天模型', items, true);
          if (!isCurrent() || !items.some(item => item.id === model)) return;
          choice.modelOverride = model === 'auto' ? null : model;
          if (!supportsEffort(catalog, choice.modelOverride)) choice.reasoningEffort = 'auto';
        } else if (section === 'effort') {
          const items = [...EFFORT_LABELS].filter(([key]) => key === 'auto' || supportsEffort(catalog, choice.modelOverride)).map(([key, label]) => ({ id: key, label, selected: key === choice.reasoningEffort }));
          const effort = await open('选择推理强度', items, true);
          if (!isCurrent() || !items.some(item => item.id === effort)) return;
          choice.reasoningEffort = effort;
        } else return;
        this.modelChoices.set(id, choice);
        this.renderModelChoice();
        this.scheduleInputLayout();
      } finally {
        this.modelMenuOpen = false;
        anchor.setAttribute('aria-expanded', 'false');
      }
    }
    async modelOptionsForSend(id) {
      const choice = this.modelChoices?.get(id);
      if (!choice || choice.modelOverride === undefined && choice.reasoningEffort === 'auto') return {};
      const catalog = await this.readModelCatalog();
      if (choice.provider !== catalog.provider || choice.modelOverride && !catalog.models.includes(choice.modelOverride) || choice.reasoningEffort !== 'auto' && !supportsEffort(catalog, choice.modelOverride)) {
        this.modelChoices.delete(id);
        this.renderModelChoice();
        throw new Error('AI 服务设置已更改，请重新选择聊天模型或推理强度。');
      }
      return { ...(choice.modelOverride !== undefined ? { modelOverride: choice.modelOverride } : {}), ...(choice.reasoningEffort !== 'auto' ? { reasoningEffort: choice.reasoningEffort } : {}) };
    }
    async transferChat(method) {
      const { currentId: id, request } = this;
      if (this.attachmentPending) await this.attachmentQueue;
      if (this.currentId !== id || this.request !== request || this.destroyed) return;
      await this.flush();
      if (this.currentId === id && this.request === request && !this.destroyed) await this.invoke(method, { id });
    }
    applyVoiceText(event) {
      const attempt=this.voiceAttempt,text=meaningfulCandidate(event.text);if(!attempt||attempt.id!==this.currentId||attempt.token!==event.token||!text||this.appliedVoiceTokens?.has(event.token))return;
      this.appliedVoiceTokens||=new Set();this.appliedVoiceTokens.add(event.token);if(this.appliedVoiceTokens.size>100)this.appliedVoiceTokens.delete(this.appliedVoiceTokens.values().next().value);
      const unchanged=this.editRevision===attempt.revision&&this.input.value===attempt.value,start=Math.min(this.input.value.length,unchanged?attempt.start:this.input.selectionStart||0),end=Math.max(start,Math.min(this.input.value.length,unchanged?attempt.end:this.input.selectionEnd||start));
      this.input.value=this.input.value.slice(0,start)+text+this.input.value.slice(end);this.input.setSelectionRange(start+text.length,start+text.length);this.editRevision++;this.dismissed=false;this.updateGhost();this.resizeInput();this.updateSend();this.run(()=>this.flush());
    }
    hasCloseContent() {return Boolean(this.chat?.messages?.length||this.input.value.trim()||meaningfulCandidate(this.chat?.candidate)||this.chat?.context?.images?.length||this.chat?.context?.attachments?.length||this.chat?.context?.quotes?.length||this.chat?.context?.selectedText?.trim()||this.chat?.recordIds?.length||this.chat?.context?.audioDraftId||this.voiceAttempt||this.isVoiceMode()||this.attachmentPending);}
    resolveVoiceCompletion(id) {for(const waiter of this.voiceCompletionWaiters||[])if(!id||waiter.id===id){this.voiceCompletionWaiters.delete(waiter);waiter.resolve();}}
    waitForVoiceCompletion(id) {if(id!==this.currentId||!['preparing','recording','paused','transcribing'].includes(this.voiceStatus))return Promise.resolve();return new Promise(resolve=>{this.voiceCompletionWaiters||=new Set();this.voiceCompletionWaiters.add({id,resolve});});}
    updateSave() {if(this.saveButton)this.saveButton.disabled=Boolean(this.headerSaving||this.chat?.saved||!this.currentId||!this.hasCloseContent());}
    async saveCurrentChat() {if(this.headerSaving||!this.currentId||this.chat?.saved||!this.hasCloseContent())return;const id=this.currentId;this.headerSaving=true;this.updateSave();try{if(!await this.prepareForClose(id))return;const chat=await this.invoke('chat:save',{id});if(this.currentId===id&&!this.deletedChatIds?.has(id)){this.setChat(chat);this.report('聊天已保存');}return chat;}finally{this.headerSaving=false;this.updateSave();}}
    async prepareForClose(id) {const request=this.request;if(id!==this.currentId)return false;if(this.imagePreviewKey&&await this.closeImage({restoreFocus:false})===false)return false;if(this.attachmentPending)await this.attachmentQueue;await this.prepareToLeave();await this.waitForVoiceCompletion(id);if(id!==this.currentId||request!==this.request||this.destroyed)return false;await this.flush();if(id!==this.currentId||request!==this.request||this.destroyed)return false;if(this.voiceStatus==='error'&&(this.voiceAttempt||this.chat?.context?.audioDraftId))throw new Error('录音转写尚未完成，请重试转写或取消本次录音后保存。');return true;}
    buildCloseDialog() {this.closeDialog=element('dialog','chat-close-dialog');this.closeDialog.setAttribute('aria-labelledby','chat-close-title');const title=element('h2','','保存这次聊天？');title.id='chat-close-title';this.closeDialog.append(title,element('p','','保存后可在主窗口继续查看。'));this.closeStatus=element('p','chat-close-status');this.closeStatus.setAttribute('role','alert');const actions=element('div','chat-close-actions');this.closeSave=button('保存并关闭','button primary ui-confirm','check');this.closeDiscard=button('不保存并关闭','button quiet ui-cancel','trash');this.closeContinue=button('继续聊天','button quiet');for(const[control,choice]of[[this.closeSave,'save'],[this.closeDiscard,'discard'],[this.closeContinue,'cancel']]){control.addEventListener('click',()=>this.chooseClose(choice));actions.append(control);}this.closeDialog.append(this.closeStatus,actions);this.root.append(this.closeDialog);this.closeDialog.addEventListener('cancel',event=>{event.preventDefault();this.resolveClose?.('cancel');});this.closeDialog.addEventListener('close',()=>{if(this.closeConfirmation)this.resolveClose?.('cancel');});}
    async confirmClose(id) {if(id!==this.currentId)return 'cancel';if(this.closeConfirmation)return this.closeConfirmation.promise;if(this.imagePreviewKey&&await this.closeImage({restoreFocus:false})===false)return 'cancel';if(this.chat?.saved||this.chat?.autoSave)return await this.prepareForClose(id)?'save':'cancel';if(!this.hasCloseContent())return 'discard';this.closeSummaryOptions?.(true);this.closeScreenshotOptions?.(true);const opener=document.activeElement;let finish;const promise=new Promise(resolve=>{finish=resolve;});this.closeConfirmation={id,promise};this.closeChoiceBusy=false;this.closeStatus.className='chat-close-status';this.closeStatus.textContent='';for(const control of[this.closeSave,this.closeDiscard,this.closeContinue])control.disabled=false;this.resolveClose=choice=>{if(!this.closeConfirmation)return;this.closeConfirmation=null;this.closeChoiceBusy=false;this.closeDialog.close();this.resolveClose=null;if(opener?.isConnected)opener.focus?.({preventScroll:true});finish(choice);};this.closeDialog.showModal();this.closeContinue.focus({preventScroll:true});return promise;}
    async chooseClose(choice) {const pending=this.closeConfirmation;if(!pending||this.closeChoiceBusy&&choice!=='cancel')return;if(choice!=='save'){this.resolveClose?.(choice);return;}this.closeChoiceBusy=true;this.closeSave.disabled=this.closeDiscard.disabled=true;this.closeContinue.disabled=false;this.closeStatus.className='chat-close-status';this.closeStatus.textContent='正在整理当前输入…';try{const ready=await this.prepareForClose(pending.id);if(this.closeConfirmation===pending)this.resolveClose?.(ready?'save':'cancel');}catch(error){if(this.closeConfirmation===pending){this.closeStatus.className='chat-close-status chat-close-error';this.closeStatus.textContent=error.message||'保存准备未完成，请重试。';}}finally{if(this.closeConfirmation===pending){this.closeChoiceBusy=false;for(const control of[this.closeSave,this.closeDiscard,this.closeContinue])control.disabled=false;}}}

    openImage(image, opener) {
      const viewer = window.InMomentNoteImageViewer;
      const src = this.imageSource(image);
      if (!src || !viewer) return;
      const opened = viewer.open({
        owner: this, invoke: this.invoke, url: src, name: image.name || '聊天图片',
        animated: image.mimeType === 'image/gif', opener, fallbackFocus: this.input,
        onClose: () => { this.imagePreviewKey = null; },
        onDirtyChange: () => this.onDirtyChange?.(),
      });
      if (opened) this.imagePreviewKey = src;
    }
    closeImage({ immediate = false, restoreFocus = true } = {}) {
      return globalThis.window?.InMomentNoteImageViewer?.close({ owner: this, force: immediate, restoreFocus }) ?? true;
    }
    imageSource(image) {const data=image?.base64||image?.data;return ['image/png','image/jpeg','image/webp','image/gif'].includes(image?.mimeType)&&typeof data==='string'&&/^[A-Za-z0-9+/]+=*$/u.test(data)?'data:'+image.mimeType+';base64,'+data:'';}
    report(text, error = false) { this.status.textContent = text; this.feedback.classList.toggle('chat-error', error);const toast=window.InMomentToast;if(error&&text){if(this.lastErrorText!==text)toast?.show(text,{tone:'error'});this.lastErrorText=text;}else if(/^(聊天已保存|已存为笔记|截图已添加)$/u.test(text))toast?.show(text,{tone:'success'});if(this.errorToast){if(error&&text){this.errorText.textContent=text;this.errorToast.hidden=Boolean(toast)||this.dismissedError===text;this.errorToast.style.top=((this.header?.offsetHeight||64)+8)+'px';this.settingsButton.hidden=!/设置|密钥|API Key|云端/u.test(text);}else{this.errorToast.hidden=true;this.dismissedError=null;if(!text)this.lastErrorText='';}} this.onStatus(text, error); if(this.inputMeasure)this.scheduleInputLayout(); }
    async run(action) { try { return await action(); } catch (error) { this.report(error.message || '操作未完成，请重试。', true); this.settingsButton.hidden = !/设置|密钥|API Key|云端/u.test(error.message || ''); return null; } }
    canReuseWelcome() {return Boolean(this.currentId&&this.chat&&!this.chat.saved&&!this.chat.messages?.length&&!this.input.value&&!this.chat.candidate&&!this.chat.context?.images?.length&&!this.chat.context?.attachments?.length&&!this.chat.context?.quotes?.length&&!this.chat.context?.selectedText&&!this.chat.context?.audioDraftId&&!this.chat.recordIds?.length&&!this.voiceAttempt&&!this.isVoiceMode()&&!this.attachmentPending);}
    async startNewChat() {if(this.newChatPromise)return this.newChatPromise;const task=(async()=>{if(this.canReuseWelcome())return this.chat;const id=this.currentId;if(id&&this.chat&&!this.chat.saved&&!this.chat.messages?.length){await this.prepareToLeave();if(this.currentId!==id)return;if(!this.chat.saved&&!this.chat.messages?.length){await this.invoke('chat:delete',{id});this.removeHistoryChat(id);}}return this.open();})();this.newChatPromise=task;try{return await task;}finally{if(this.newChatPromise===task)this.newChatPromise=null;}}
    async open(id) {
      if (this.imagePreviewKey && await this.closeImage({ restoreFocus: false }) === false) return;
      this.resolveClose?.('cancel');this.resolveVoiceCompletion();this.closeSummaryOptions?.(true);
      if(!id&&this.canReuseWelcome())return this.chat;
      const request=++this.request;this.openingChatId=id||null; await this.prepareToLeave();if(request!==this.request||id&&this.deletedChatIds?.has(id))return;const chat = await this.invoke(id ? 'chat:get' : 'chat:create', id ? { id } : {}); if (request !== this.request||this.deletedChatIds?.has((chat?.chat||chat)?.id)) return;this.openingChatId=null; if (!(chat?.chat || chat)?.id) throw new Error('这次聊天已关闭，请发起新聊天。');
      this.clearVoiceWave();this.voiceAttempt=null;this.voiceIntent='';this.voiceToken=null;this.currentId = (chat?.chat || chat)?.id;this.savingInspiration=false;this.inspirationJob=null; this.selected.clear(); this.selecting = false; this.editRevision = 0; this.syncedRevision = 0; this.remoteRevision = 0; this.remoteUpdatedAt = 0; this.dismissed = false; this.voiceStatus = ''; this.transcriptionEntry = false; this.adoptedTranscription = false; this.setChat(chat); if(this.floating&&document.activeElement===this.input)this.input.blur();
      const list = await this.invoke('chat:list'); if(request===this.request)this.setList(list?.chats || list || []); return this.chat;
    }
    setList(chats) { this.chats = Array.isArray(chats) ? chats.filter(chat=>!this.deletedChatIds?.has(chat.id)) : []; this.renderHistory(); }
    setChat(value) {
      const chat = value?.chat || value; if (!chat?.id ||this.deletedChatIds?.has(chat.id)|| this.currentId && chat.id !== this.currentId) return;
      const revision = Number.isSafeInteger(chat.revision) && chat.revision >= 0 ? chat.revision : null;
      if (revision !== null && revision < (this.remoteRevision || 0) || revision === null && Number(chat.updatedAt || 0) < (this.remoteUpdatedAt || 0)) return;
      this.remoteRevision = revision ?? this.remoteRevision ?? 0; this.remoteUpdatedAt = Math.max(this.remoteUpdatedAt || 0, Number(chat.updatedAt || 0));
      this.currentId = chat.id; const oldCandidate = this.chat?.candidate; this.chat = chat; if(chat.candidate){this.transcriptionEntry=true;if(chat.input)this.adoptedTranscription=true;} if (this.syncedRevision >= this.editRevision && this.input.value !== (chat.input || '')) this.input.value = chat.input || ''; if (oldCandidate !== chat.candidate) this.dismissed = false; this.render(); if (chat.voice) this.handleEvent({type:'chatVoice',id:chat.id,...chat.voice});
    }
    handleEvent(event) {
      if(event?.type==='error'&&this.floating&&this.root.getClientRects().length&&event.message){this.report(event.message,true);return;}
      if(event?.type==='chatDeleted'){this.removeHistoryChat(event.id);return;}
      if (event?.type === 'settingsChanged') {
        this.screenshotPreferenceLoaded = false;
        this.modelSettingsRevision = (this.modelSettingsRevision || 0) + 1;
        this.closeModelMenu();
        if (this.modelButton) this.readModelCatalog().catch(() => {});
        return;
      }
      if(event?.type==='chatAudioLevel'){this.receiveAudioLevel(event);return;}
      if (event?.type === 'chatChanged' && event.chat?.id === this.currentId) {
        if (event.chat.deleted) this.removeHistoryChat(event.chat.id);
        else this.setChat(event.chat);
      } else if (event?.type === 'chatList') this.setList(event.chats);
      else if (event?.type === 'chatVoice' && event.id === this.currentId) {
        if(event.intent==='input'&&this.voiceAttempt?.token&&event.token!==this.voiceAttempt.token)return;
        if(event.intent==='input'&&this.voiceAttempt&&!this.voiceAttempt.token&&['preparing','recording','paused','transcribing'].includes(event.status))this.voiceAttempt.token=event.token;
        this.voiceIntent=event.intent||this.voiceIntent||'candidate';if(event.token)this.voiceToken=event.token;if(event.draftId)this.voiceDraftId=event.draftId;if(event.segmentId)this.voiceSegmentId=event.segmentId;
        const previous = this.voiceStatus; this.voiceStatus = event.status; if(['preparing','recording','transcribing','ready'].includes(event.status))this.transcriptionEntry=true;else if(event.status==='empty'&&!this.adoptedTranscription&&!this.chat?.candidate)this.transcriptionEntry=false;
        if (event.status === 'recording' || event.status === 'ready' && previous !== 'ready') this.dismissed = false;
        if(event.intent==='input'&&event.status==='ready')this.applyVoiceText(event);
        if(['ready','empty','error','cancelled'].includes(event.status))this.resolveVoiceCompletion(event.id);if(event.intent==='input'&&['ready','empty','error','cancelled'].includes(event.status)){this.voiceAttempt?.resolve?.();if(event.status!=='error')this.voiceAttempt=null;}
        this.updateSend();this.renderVoiceMode();this.updateGhost();
        this.report(event.status === 'ready' ? '' : event.message || ({ recording: '正在录音，点击暂停后转成文字', transcribing: '正在本地转写…', empty: '未检测到语音，临时录音已清理' }[event.status] || ''), event.status === 'error');
      }
    }
    renderEmpty() {this.closeSummaryOptions?.(true);this.closeScreenshotOptions?.(true);this.title.textContent = '新聊天'; this.subtitle.textContent = '临时聊天'; this.report(''); this.renderMessages(); if(this.saveButton)this.saveButton.disabled = true; this.updateSend();this.renderVoiceMode(); }
    render() {
      if (!this.chat) return this.renderEmpty(); this.title.textContent = this.chat.title || '新聊天'; this.subtitle.textContent = this.chat.saved ? '已保存的聊天' : '临时聊天 · 关闭后清理';const saveLabel=this.chat.saved?'聊天已保存':'保存聊天';if(this.saveButton){this.saveButton.setAttribute('aria-label',saveLabel);this.saveButton.title=saveLabel;this.saveButton.setAttribute('aria-pressed',String(Boolean(this.chat.saved)));this.updateSave();}
      const lastReply = this.chat.messages?.at(-1); this.retryButton.hidden = lastReply?.role !== 'assistant' || !['error', 'cancelled', 'stopped', 'interrupted'].includes(lastReply.status); this.settingsButton.hidden = !/设置|密钥|API Key|云端/u.test(this.chat.error || '');
      if (this.chat.error) this.report(this.chat.error, !/^已停止/u.test(this.chat.error));
      else if (this.chat.pending) {
        this.replyStatusText = this.chat.progress?.steps?.at(-1)?.label || '正在回复…';
        if (this.status.textContent !== this.replyStatusText) this.report(this.replyStatusText);
      } else if (this.replyStatusText && this.status.textContent === this.replyStatusText) {
        this.replyStatusText = '';
        this.report('');
      }
      if (this.imagePreviewKey && ![...(this.chat.context?.images || []), ...this.chat.messages.flatMap(message => message.images || [])].some(image => this.imageSource(image) === this.imagePreviewKey)) this.closeImage({immediate:true});
      this.renderMessages(); this.renderAttachments(); this.renderSelection(); this.updateGhost(); this.resizeInput(); this.updateSend();this.renderVoiceMode(); this.renderHistory();
    }
    renderMessages() {
      const key=navigation.messageKey(this.chat,this.selecting,this.selected);if(key===this.messageRenderKey){this.navigation?.schedule();return;}const changedChat=this.renderedChatId!==this.currentId,reading=changedChat?{bottom:true,left:0}:this.navigation?.capture()||navigation.capture(this.messages);this.messageRenderKey=key;this.renderedChatId=this.currentId;
      const messages = this.chat?.messages || [];this.conversation.classList.toggle('chat-welcome',!this.floating&&!messages.length);if(messages.length){this.messages.style.marginTop='';this.messages.style.maxHeight='';this.messages.style.overflowY='';this.messages.removeAttribute('aria-hidden');}
      if (!messages.length) { const empty = element('div', 'chat-empty'),heading=element('div','chat-empty-heading'),mark=element('img','chat-empty-mark');mark.src=BRAND_ICON;mark.alt='Moment';heading.append(mark,element('h2','','从一个问题开始'));empty.append(heading,element('p', '', '聊聊正在看的内容，或引用几条笔记一起想。')); this.messages.replaceChildren(empty);this.navigation?.refresh(); return; }
      const keepFocus = document.activeElement?.dataset?.chatMessage,keepArticle=document.activeElement?.dataset?.messageId;
      const keepProgress = document.activeElement?.dataset?.chatProgressMessage;
      this.messages.replaceChildren();
      for (const message of messages) {
        const activeProgress = this.chat?.pending && this.chat.progress?.assistantId === message.id ? this.chat.progress : null;
        const progress = activeProgress || message.progress;
        const article = element('article', 'chat-message chat-message-' + message.role); article.dataset.messageId = message.id;article.tabIndex=0;article.setAttribute('aria-haspopup','menu');article.setAttribute('aria-keyshortcuts','Shift+F10');article.setAttribute('aria-label',message.role==='assistant'?'Moment':'你'); const heading = element('div', 'chat-message-heading');if(message.role==='assistant'){const avatar=element('img','chat-message-avatar');avatar.src=BRAND_ICON;avatar.alt='';avatar.width=avatar.height=24;heading.append(avatar,element('strong','','Moment'));}
        if (this.selecting) { const choice = element('input', 'chat-message-choice'); choice.type = 'checkbox'; choice.checked = this.selected.has(message.id); choice.dataset.chatMessage = message.id; choice.setAttribute('aria-label', '选择' + (message.role === 'assistant' ? ' Moment ' : '我的') + '这条对话'); choice.addEventListener('change', () => { choice.checked ? this.selected.add(message.id) : this.selected.delete(message.id); this.renderSelection(); }); heading.prepend(choice); }
        if (message.status && !['complete', 'completed', 'sent'].includes(message.status) && !activeProgress?.steps?.length) heading.append(element('span', 'chat-message-state', ({ streaming: '正在回复', pending: '正在回复', cancelled: '已停止', stopped: '已停止', error: '回复未完成', interrupted: '已中断' })[message.status] || ''));
        article.append(heading);const body=element('div','chat-message-body');article.append(body);
        if (message.images?.length) { const images = element('div', 'chat-message-images'); for (const image of message.images) images.append(this.imagePreview(image)); body.append(images); }
        if (message.attachments?.length) {
          const files = element('div', 'chat-message-files');
          for (const file of message.attachments) files.append(this.fileCard(file));
          body.append(files);
        }
        if (message.selectedText) body.append(this.quoteCard(quoteCleaner.clean(message.selectedText),'所选文字'));for(const quote of message.quotes||[])body.append(this.quoteCard(quote.text));
        if (message.references?.length) { const refs = element('div', 'chat-message-references'); for (const reference of message.references) { const ref = button(reference.title || '引用的笔记', 'chat-reference-link', 'transcript'); ref.addEventListener('click', () => this.onOpenRecord(reference.recordId || reference.id, reference.noteId)); refs.append(ref); } body.append(refs); }
        if (progress?.steps?.length) {
          const view = this.progressView(message.id, progress, Boolean(activeProgress));
          if (view) body.append(view);
        }
        const content = element('div', 'chat-message-content'); renderText(content, message.text || (this.chat?.pending && message.role === 'assistant' && !activeProgress?.steps?.length ? '正在思考…' : '')); body.append(content); this.messages.append(article);
      }
      if (keepFocus) this.messages.querySelector('[data-chat-message="' + CSS.escape(keepFocus) + '"]')?.focus({ preventScroll: true });else if(keepArticle)this.messages.querySelector('[data-message-id="'+CSS.escape(keepArticle)+'"]')?.focus({preventScroll:true});else if(keepProgress)this.messages.querySelector('[data-chat-progress-message="'+CSS.escape(keepProgress)+'"]')?.focus({preventScroll:true});this.navigation?.refresh();if(this.navigation)this.navigation.restore(reading);else navigation.restore(this.messages,reading);
    }
    progressView(messageId, progress, active) {
      const current = progress.steps.at(-1);
      if (this.floating) return active ? element('p', 'chat-progress-current', current.label) : null;
      const details = element('details', 'chat-progress');
      const summary = element('summary', 'chat-progress-summary', active ? current.label : '查看处理过程');
      summary.dataset.chatProgressMessage = messageId;
      this.progressChoices ||= new Map();
      details.open = this.progressChoices.get(messageId) ?? active;
      summary.addEventListener('click', event => {
        event.preventDefault();
        details.open = !details.open;
        this.progressChoices.set(messageId, details.open);
      });
      const steps = element('ol', 'chat-progress-steps');
      for (const step of progress.steps) {
        const item = element('li', 'chat-progress-step');
        item.append(element('span', '', step.label));
        if (step.model) item.append(element('small', 'chat-progress-model', step.model));
        if (Number.isFinite(step.endedAt) && step.endedAt >= step.startedAt) {
          const milliseconds = step.endedAt - step.startedAt;
          const elapsed = milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} 秒`;
          item.append(element('small', 'chat-progress-duration', elapsed));
        }
        steps.append(item);
      }
      details.append(summary, steps);
      return details;
    }
    imagePreview(image) {
      const open = button('', 'chat-image-open'); const img = element('img', 'chat-image-preview'); const src = this.imageSource(image); if (src) img.src = src; img.alt = image.name || '附加图片'; open.append(img); open.title = '查看图片'; open.setAttribute('aria-label', '查看图片：' + (image.name || '附加图片')); open.disabled = !src; open.addEventListener('click', () => this.openImage(image, open)); return open;
    }
    fileCard(file) {
      const card = element('div', 'chat-attachment-file');
      const icon = element('span', 'chat-file-icon');
      icon.dataset.uiIcon = 'transcript';
      icon.setAttribute('aria-hidden', 'true');
      const labels = element('div', 'chat-file-labels');
      const filename = element('strong', 'chat-file-name', file.name || '附加文件');
      card.title = filename.textContent;
      const type = FILE_LABELS.get(file.mimeType) || '文件';
      const detail = Number.isFinite(file.size) ? `${type} · ${formatFileSize(file.size)}` : type;
      labels.append(filename, element('span', 'chat-file-meta', detail));
      card.append(icon, labels);
      return card;
    }
    renderAttachments() {
      this.attachments.replaceChildren(); const context = this.chat?.context || {};
      for (const [index,image] of (context.images||[]).entries()){const item=element('div','chat-attachment-image'),remove=button('','icon-button danger','close');remove.setAttribute('aria-label','移除图片 '+(index+1));remove.addEventListener('click',()=>{remove.disabled=true;this.run(()=>this.queueAttachmentUpdate(async(id,current)=>{const images=[...(this.chat.context?.images||[])],key=this.imageSource(image),at=this.imageSource(images[index])===key?index:images.findIndex(value=>this.imageSource(value)===key);if(at<0)return;images.splice(at,1);const value=await this.invoke('chat:update',{id,images});if(current())this.setChat(value);}));});item.append(this.imagePreview(image),remove);this.attachments.append(item);}
      for (const [index, file] of (context.attachments || []).entries()) {
        const card = this.fileCard(file);
        const sendHelp = FILE_SEND_HELP.get(file.mimeType);
        if (sendHelp) card.title += `\n${sendHelp}`;
        const remove = button('', 'icon-button danger chat-file-remove', 'close');
        remove.title = `移除 ${file.name || '附件'}`;
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => this.run(async () => {
          const focused = document.activeElement === remove;
          remove.disabled = true;
          try {
            const removed = await this.removeFileAttachment(file.id);
            if (removed && focused && document.activeElement === document.body) {
              const remaining = this.attachments.querySelectorAll('.chat-file-remove');
              (remaining[Math.min(index, remaining.length - 1)] || this.addButton).focus({ preventScroll: true });
            }
          } finally {
            if (remove.isConnected) remove.disabled = false;
          }
        }));
        card.append(remove);
        this.attachments.append(card);
      }
      if(context.selectedText){const item=this.quoteCard(quoteCleaner.clean(context.selectedText),'所选文字'),remove=button('','icon-button danger','close');remove.setAttribute('aria-label','移除所选文字');remove.addEventListener('click',()=>this.run(()=>this.queueAttachmentUpdate(async(id,current)=>{if(this.chat.context?.selectedText!==context.selectedText)return;const value=await this.invoke('chat:update',{id,selectedText:''});if(current())this.setChat(value);})));item.append(remove);this.attachments.append(item);}
      for(const quote of context.quotes||[]){const item=this.quoteCard(quote.text),remove=button('','icon-button danger','close');item.dataset.quoteId=quote.id;remove.setAttribute('aria-label','移除引用');remove.addEventListener('click',()=>this.run(()=>this.queueAttachmentUpdate(async(id,current)=>{const quotes=(this.chat.context?.quotes||[]).filter(value=>value.id!==quote.id),value=await this.invoke('chat:update',{id,quotes});if(current())this.setChat(value);})));item.append(remove);this.attachments.append(item);}

      const references = this.chat?.references || this.chat?.context?.references || [];
      for (const id of this.chat?.recordIds || []) {
        const reference = references.find(item => sameReference(item.recordId || item.id, id));
        const chip = element('div', 'chat-reference-chip');
        chip.append(element('span', '', reference?.title || this.referenceCache?.get(id) || this.referenceCache?.get('record:' + id) || '已引用的笔记'));
        const remove = button('', 'icon-button danger', 'close');
        remove.setAttribute('aria-label', '移除笔记引用');
        remove.addEventListener('click', () => this.run(() => this.queueAttachmentUpdate(async (chatId, current) => {
          const recordIds = (this.chat?.recordIds || []).filter(value => !sameReference(value, id));
          const chat = await this.invoke('chat:update', { id: chatId, recordIds });
          if (current()) this.setChat(chat);
        })));
        chip.append(remove);
        this.attachments.append(chip);
      }
      this.attachments.hidden = !this.attachments.childElementCount;
    }
    quoteCard(text,label='引用') {const item=element('div','chat-attachment-text chat-quote-card');item.append(element('small','',label),element('p','',text));return item;}
    renderSelection() { this.composer.classList.toggle('chat-select-mode',Boolean(this.selecting));if (window.InMomentMotion?.show) window.InMomentMotion.show(this.selectionBar, Boolean(this.selecting)); else this.selectionBar.classList.toggle('hidden', !this.selecting); this.selectionLabel.textContent = '已选 ' + this.selected.size + ' 条';const disabled=!this.selected.size || this.busy || this.chat?.pending || this.savingInspiration;this.selectionSave.disabled=disabled;this.selectionQuote.disabled=disabled;if(this.summaryButton){this.summaryButton.disabled=disabled;const key=this.selectionContextKey();if(key!==this.summarySelectionKey||disabled||!this.selecting)this.closeSummaryOptions(true);this.summarySelectionKey=key;}this.scheduleInputLayout(); }
    renderHistory() {
      const query = this.historySearch.value.trim().toLocaleLowerCase(),nodes=[];this.historyRows||=new Map();this.historyHeadings||=new Map();let count = 0;
      for (const saved of [null]) {
        const chats = this.chats.filter(chat => historyChatVisible(chat,this.floating) && (!query || String(chat.title).toLocaleLowerCase().includes(query))); if(!chats.length)continue;
        for (const chat of chats) {
          let item=this.historyRows.get(chat.id);if(!item){const row=element('div','chat-history-row'),entry=button('','chat-history-item'),label=element('span'),more=button('','icon-button chat-history-more','more');entry.append(label);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');entry.addEventListener('click',()=>this.run(()=>this.open(chat.id)));more.addEventListener('click',()=>this.run(()=>this.openHistoryMenu(chat.id,more)));entry.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();this.run(()=>this.openHistoryMenu(chat.id,more));}});item={row,entry,label,more};this.historyRows.set(chat.id,item);}
          const {row,entry,label,more}=item,title=chat.title||'新聊天';row.dataset.chatId=chat.id;row.classList.toggle('active',chat.id===this.currentId);entry.classList.toggle('active',chat.id===this.currentId);entry.setAttribute('aria-current',chat.id===this.currentId?'page':'false');entry.title=title;label.textContent=title;more.title='聊天操作：'+title;more.setAttribute('aria-label','聊天操作：'+title);
          const editing=this.historyEditing?.id===chat.id?this.historyEditing:null;
          if(editing){if(item.editing!==editing){const input=element('input','chat-history-rename');input.type='text';input.maxLength=200;input.value=editing.value;input.setAttribute('aria-label','聊天名称');input.addEventListener('input',()=>{editing.value=input.value;});const actions=element('div','chat-history-rename-actions'),save=button('','icon-button ui-confirm','check'),cancel=button('','icon-button ui-cancel','close');save.title='保存名称';save.setAttribute('aria-label','保存名称');cancel.title='取消重命名';cancel.setAttribute('aria-label','取消重命名');save.addEventListener('click',()=>this.run(()=>this.saveHistoryRename()));cancel.addEventListener('click',()=>this.cancelHistoryRename());input.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();this.run(()=>this.saveHistoryRename());}else if(event.key==='Escape'){event.preventDefault();this.cancelHistoryRename();}});actions.append(save,cancel);row.replaceChildren(input,actions);Object.assign(editing,{input,save,cancel,row});item.editing=editing;}editing.input.disabled=editing.save.disabled=editing.cancel.disabled=Boolean(editing.saving);}
          else if(row.firstChild!==entry){row.replaceChildren(entry,more);item.editing=null;}
          nodes.push(row);count++;
        }
      }
      if (!count&&query) nodes.push(element('p', 'chat-history-empty', '没有找到聊天'));
      const focused=document.activeElement,selection=focused?.matches?.('.chat-history-rename')?{start:focused.selectionStart,end:focused.selectionEnd}:null,wanted=new Set(nodes);for(const child of [...this.historyList.children])if(!wanted.has(child))child.remove();nodes.forEach((node,index)=>{if(this.historyList.children[index]!==node)this.historyList.insertBefore(node,this.historyList.children[index]||null);});if(selection&&focused.isConnected&&document.activeElement!==focused){focused.focus({preventScroll:true});focused.setSelectionRange(selection.start,selection.end);}for(const id of this.historyRows.keys())if(!this.chats.some(chat=>chat.id===id))this.historyRows.delete(id);
    }
    async openHistoryMenu(id, anchor) {
      const chat = this.chats.find(item => item.id === id);
      if (!chat || !window.InMomentMenus?.open) return;
      const current = id === this.currentId;
      const noteSaveDisabled = (!chat.messageCount && !chat.messages?.length) || chat.pending ||
        this.inspirationJobs?.has(id) || (current && (this.busy || this.chat?.pending || this.savingInspiration));
      anchor.setAttribute('aria-expanded', 'true');
      let action;
      try {
        action = await window.InMomentMenus.open({ anchor, title: '聊天操作', items: [
          { id: 'rename', label: '重命名', icon: 'edit' },
          ...noteSaveMenuItems(Boolean(noteSaveDisabled)),
          { id: 'delete', label: '删除', icon: 'trash', danger: true },
        ] });
      } finally { anchor.setAttribute('aria-expanded', 'false'); }
      if (this.destroyed || this.deletedChatIds?.has(id)) return;
      if (action === 'rename') this.beginHistoryRename(id);
      else if (action === 'delete') await this.deleteHistoryChat(id, anchor);
      else if (action === 'whole' || action === 'summarize') await this.makeInspiration(action === 'summarize', undefined, id);
    }
    beginHistoryRename(id) {const chat=this.chats.find(item=>item.id===id);if(!chat)return;this.historyEditing={id,value:chat.title||'新聊天',saving:false};this.renderHistory();const input=this.historyEditing.input;input?.focus({preventScroll:true});input?.select();}
    cancelHistoryRename() {const editing=this.historyEditing;if(!editing||editing.saving)return;this.historyEditing=null;this.renderHistory();this.historyRows?.get(editing.id)?.more.focus({preventScroll:true});}
    async saveHistoryRename() {const editing=this.historyEditing;if(!editing||editing.saving)return;const title=editing.value.trim();if(!title||title.length>200||/[\u0000-\u001F\u007F-\u009F]/u.test(title))throw new Error('请输入 1–200 个字符的单行聊天名称。');const hadFocus=editing.row?.contains(document.activeElement);editing.saving=true;this.renderHistory();try{const value=await this.invoke('chat:rename',{id:editing.id,title}),chat=value?.chat||value;if(this.deletedChatIds?.has(editing.id)||this.historyEditing!==editing)return;const restore=editing.row?.contains(document.activeElement)||hadFocus&&document.activeElement===document.body;this.chats=this.chats.map(item=>item.id===editing.id?{...item,...chat}:item);this.historyEditing=null;if(this.currentId===editing.id)this.setChat(chat);else this.renderHistory();if(restore)this.historyRows?.get(editing.id)?.more.focus({preventScroll:true});}finally{if(this.historyEditing===editing){editing.saving=false;this.renderHistory();if(hadFocus&&document.activeElement===document.body)editing.input?.focus({preventScroll:true});}}}
    async deleteHistoryChat(id,anchor) {const chat=this.chats.find(item=>item.id===id);if(!chat)return;const accepted=window.InMomentConfirm?.open?await window.InMomentConfirm.open({anchor,title:'删除聊天？',message:'“'+(chat.title||'新聊天')+'”',detail:'删除此聊天及其中的附件。',confirmLabel:'删除聊天',danger:true}):false;if(!accepted||this.deletedChatIds?.has(id))return;await this.invoke('chat:delete',{id});this.removeHistoryChat(id);}
    removeHistoryChat(id) {if(!id)return;this.modelChoices?.delete(id);this.resolveVoiceCompletion(id);if(this.closeConfirmation?.id===id)this.resolveClose?.('cancel');this.deletedChatIds||=new Set();this.deletedChatIds.add(id);this.chats=(this.chats||[]).filter(chat=>chat.id!==id);if(this.historyEditing?.id===id)this.historyEditing=null;if(this.openingChatId===id){this.request++;this.openingChatId=null;}if(this.currentId===id){this.request++;clearTimeout(this.composerTimer);this.voiceAttempt?.resolve?.();this.voiceAttempt=null;this.voiceIntent='';this.voiceStatus='';this.voiceToken=null;this.clearVoiceWave();this.closeImage({immediate:true,restoreFocus:false});this.currentId=null;this.chat=null;this.transcriptionEntry=false;this.adoptedTranscription=false;this.input.value='';this.editRevision=this.syncedRevision=this.remoteRevision=this.remoteUpdatedAt=0;this.selected?.clear();this.selecting=false;this.attachments.replaceChildren();this.closeAddMenu();this.updateGhost();this.renderSelection();this.renderEmpty();}this.renderHistory();}
    updateGhost() {
      const value=candidateState({input:this.input.value,candidate:['preparing','recording','paused','transcribing'].includes(this.voiceStatus)?'':this.chat?.candidate,dismissed:this.dismissed,composing:this.composing});
      this.ghost.hidden=!value.visible;const text=value.visible?value.text:'';if(this.ghostText.textContent!==text){this.ghostText.textContent=text;this.ghost.scrollTop=0;}this.input.placeholder=value.visible?'':PLACEHOLDER;if(this.inputMeasure)this.resizeInput();
    }
    hasSendContent() {return Boolean(this.input.value.trim()||this.chat?.context?.images?.length||this.chat?.context?.attachments?.length||this.chat?.context?.quotes?.length||this.chat?.context?.selectedText?.trim());}
    updateSend() {
      this.updateSave();
      const pending = Boolean(this.chat?.pending || this.savingInspiration);
      const voice = this.isVoiceMode();
      const hasContent = Boolean(this.currentId) && this.hasSendContent();
      this.sendButton.hidden = pending;
      this.stopButton.hidden = !pending;
      this.sendButton.dataset.hasSendContent = String(hasContent);
      this.sendButton.disabled = !hasContent || this.busy || this.attachmentPending || ['preparing', 'recording', 'paused', 'transcribing'].includes(this.voiceStatus);
      this.addButton.disabled = Boolean(!this.currentId || this.voiceCancelling || (!voice && (pending || this.busy)));
      this.voiceButton.disabled = !this.currentId || this.voiceCancelling || ['paused', 'transcribing'].includes(this.voiceStatus) || pending;
      if (this.screenshotButton) this.screenshotButton.disabled = Boolean(!this.currentId || this.screenshotBusy);
      if (this.addButton.disabled || voice) this.closeAddMenu();
      this.updateReferenceChoices();
      if(this.modelButton){this.modelButton.disabled=Boolean(!this.currentId||pending||this.busy||voice);this.renderModelChoice();}
    }
    scheduleInputLayout() {
      if(this.layoutFrame||!this.inputMeasure)return;this.layoutFrame=requestAnimationFrame(()=>{this.layoutFrame=null;this.resizeInput();});
    }
    scheduleCaretReveal(edge) {
      if(this.caretRevealFrame)cancelAnimationFrame(this.caretRevealFrame);const id=this.currentId,input=this.input.value;this.caretRevealFrame=requestAnimationFrame(()=>{this.caretRevealFrame=null;if(this.currentId!==id||this.input.value!==input||document.activeElement!==this.input)return;this.resizeInput();if(edge==='end'&&this.input.selectionEnd===this.input.value.length)this.input.scrollTop=this.input.scrollHeight;else if(edge==='start'&&this.input.selectionStart===0)this.input.scrollTop=0;});
    }
    welcomeReserve(viewport,outside,extras,oneLine) {if(this.floating||!this.conversation.classList.contains('chat-welcome'))return 0;const empty=this.messages.querySelector('.chat-empty'),heading=empty?.querySelector('.chat-empty-heading'),description=empty?.querySelector('p');if(!empty||!heading)return 0;if(description)description.hidden=false;const full=empty.getBoundingClientRect().height,row=heading.getBoundingClientRect().height,room=Math.max(0,viewport-outside-extras-oneLine-20);let shown=full;if(room<full){if(description)description.hidden=true;shown=room>=row?row:0;}this.messages.style.maxHeight=shown+'px';this.messages.style.overflowY='hidden';this.messages.setAttribute('aria-hidden',String(shown===0));return shown+20;}
    positionWelcome() {if(this.floating||!this.conversation.classList.contains('chat-welcome'))return;const box=this.conversation.getBoundingClientRect(),header=this.header.getBoundingClientRect(),group=this.messages.getBoundingClientRect().height+24+this.composer.getBoundingClientRect().height,available=box.bottom-header.bottom,offset=Math.max(8,Math.min(available*.382-group/2,available-group-12));this.messages.style.marginTop=offset+'px';this.welcomeLayout={available,group,offset,targetRatio:.382};}
    resizeInput() {
      this.positionVoiceWave();if(this.selecting)return;if(!this.inputMeasure||!this.input?.isConnected||!this.conversation.getClientRects().length||this.input.clientWidth<1)return;
      const style=getComputedStyle(this.input),line=parseFloat(style.lineHeight)||27,padding=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0),oneLine=Math.ceil(line+padding),minimum=Math.ceil(line*2+padding);
      const visibleCandidate=!this.ghost.hidden?this.chat?.candidate||'':'';this.inputMeasure.value=this.input.value||visibleCandidate;const natural=Math.max(minimum,this.inputMeasure.scrollHeight);
      const margin=e=>{const s=getComputedStyle(e);return(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0);};const viewport=this.conversation.clientHeight;
      let outside=0;for(const child of this.conversation.children){if(child===this.messages||child===this.composer||!child.getClientRects().length||['absolute','fixed'].includes(getComputedStyle(child).position))continue;outside+=child.getBoundingClientRect().height+margin(child);}
      const extras=Math.max(0,this.composer.getBoundingClientRect().height-this.input.getBoundingClientRect().height)+margin(this.composer);let reserve=Math.min(160,Math.max(40,viewport*.2));reserve=Math.max(reserve,this.welcomeReserve(viewport,outside,extras,oneLine));
      const maximum=Math.max(oneLine,Math.floor(Math.min(viewport*.6,viewport-outside-extras-reserve))),height=Math.min(natural,maximum);
      const oldHeight=this.input.getBoundingClientRect().height,oldScroll=this.input.scrollTop,atEnd=oldScroll+this.input.clientHeight>=this.input.scrollHeight-2,atStart=oldScroll<line/2+padding;
      const changedHeight=Math.abs(oldHeight-height)>.25,reading=changedHeight&&this.chat?.messages?.length&&this.messages?.getBoundingClientRect?navigation.capture(this.messages):null;this.input.style.minHeight=Math.min(minimum,maximum)+'px';if(changedHeight){this.input.style.height=height+'px';if(document.activeElement===this.input&&this.input.selectionStart===this.input.selectionEnd){if(this.input.selectionEnd===this.input.value.length&&atEnd)this.input.scrollTop=this.input.scrollHeight;else if(this.input.selectionStart===0&&atStart)this.input.scrollTop=0;}}
      this.input.style.overflowY=this.input.scrollHeight>this.input.clientHeight+1?'auto':'hidden';this.ghost.style.overflowY=this.ghost.scrollHeight>this.ghost.clientHeight+1?'auto':'hidden';
      if(changedHeight&&this.composer.contains(document.activeElement)){const beyond=this.composer.getBoundingClientRect().bottom-this.conversation.getBoundingClientRect().bottom;if(beyond>1)this.conversation.scrollTop=Math.min(Math.max(0,this.conversation.scrollHeight-this.conversation.clientHeight),Math.max(0,this.conversation.scrollTop+beyond));}
      this.positionWelcome();if(reading){if(this.navigation)this.navigation.restore(reading,{followBottom:false});else navigation.restore(this.messages,reading,{followBottom:false});}this.inputLayout={natural,height,maximum,viewport,outside,extras,ghost:!this.ghost.hidden};
      if(this.floating&&this.currentId){const desired=Math.min(12000,Math.ceil(outside+extras+natural+220+Math.max(0,innerHeight-viewport))),key=this.currentId+':'+desired+':'+innerWidth+':'+innerHeight;if((desired>innerHeight+2||innerWidth<280)&&key!==this.lastNativeResizeKey&&!this.nativeResizePending){this.lastNativeResizeKey=key;this.nativeResizePending=this.invoke('chat:resize',{id:this.currentId,height:desired}).then(result=>{this.lastNativeResizeResult=result;return result;}).catch(()=>{if(this.currentId&&document.hasFocus())this.report('浮窗未能展开，仍可在输入框内滚动查看。',true);return null;}).finally(()=>{this.nativeResizePending=null;this.scheduleInputLayout();});}}
    }
    queueComposer() { clearTimeout(this.composerTimer); this.composerTimer = setTimeout(() => this.run(() => this.flush()), 180); }
    async flush() {
      clearTimeout(this.composerTimer); if (!this.currentId || this.editRevision <= this.syncedRevision) return this.writeQueue;
      const id = this.currentId, revision = this.editRevision, input = this.input.value;
      this.writeQueue = this.writeQueue.catch(() => {}).then(async () => { const chat = await this.invoke('chat:update', { id, input }); if (this.currentId === id) { this.syncedRevision = Math.max(this.syncedRevision, revision); if (revision === this.editRevision) this.setChat(chat); } }); return this.writeQueue;
    }
    async send() {
      if (this.busy || this.attachmentPending || !this.currentId || !this.hasSendContent() || this.chat?.pending || ['preparing','recording','paused','transcribing'].includes(this.voiceStatus)) return;
      const id = this.currentId, text = this.input.value, revision = this.editRevision, recordIds = [...(this.chat.recordIds || [])]; let clearedRevision = null; this.busy = true; this.updateSend();
      try {
        await this.flush();
        const options = await this.modelOptionsForSend(id);
        const pending = this.invoke('chat:send', { id, text, recordIds, ...options });
        if (this.currentId === id) {
          if (this.editRevision === revision && this.input.value === text) { this.input.value = ''; this.editRevision++; this.syncedRevision = this.editRevision; clearedRevision = this.editRevision; }
          this.chat.candidate = ''; this.transcriptionEntry = false; this.adoptedTranscription = false; this.dismissed = false; this.updateGhost(); this.updateSend(); this.resizeInput();
        }
        const result = await pending; if (this.currentId === id && result?.id) this.setChat(result);
      } catch (error) {
        if (this.currentId === id && !this.input.value && this.editRevision === clearedRevision) { this.input.value = text; this.editRevision++; this.queueComposer(); this.updateGhost(); }
        throw error;
      } finally { this.busy = false; this.updateSend(); }
    }
    queueAttachmentUpdate(operation,target={id:this.currentId,request:this.request}) {const current=()=>Boolean(target.id&&this.currentId===target.id&&this.request===target.request&&!this.deletedChatIds?.has(target.id)&&!this.destroyed);this.attachmentPending=(this.attachmentPending||0)+1;this.updateSend?.();const task=(this.attachmentQueue||Promise.resolve()).catch(()=>{}).then(()=>current()?operation(target.id,current):false).finally(()=>{this.attachmentPending=Math.max(0,(this.attachmentPending||1)-1);if(!this.destroyed)this.updateSend?.();});this.attachmentQueue=task;return task;}
    handleImagePaste(event) {if(event.defaultPrevented||!this.currentId||!this.root.getClientRects().length||getComputedStyle(this.root).visibility==='hidden'||!this.composer.contains(event.target)||this.closeDialog?.open||this.addMenuOpen||document.querySelector('.inmoment-popover[data-popover-state="open"]'))return;const files=clipboardImages(event.clipboardData);if(!files.length)return;event.preventDefault();this.run(()=>this.attachFiles(files));}
    readAttachmentFile({ file, mimeType }) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reader.onabort = () => reject(new Error(`无法读取“${file.name}”。`));
        reader.onload = () => {
          const result = String(reader.result);
          resolve({ mimeType, name: file.name, base64: result.slice(result.indexOf(',') + 1) });
        };
        reader.readAsDataURL(file);
      });
    }
    async attachFiles(files, target = { id: this.currentId, request: this.request }) {
      if (this.busy || this.chat?.pending) throw new Error('正在发送，请稍后添加文件或图片。');
      const selection = attachmentSelection(files);
      if (!selection.images.length && !selection.attachments.length) return false;
      validateAttachmentLimits({}, selection);
      return this.queueAttachmentUpdate(async (id, current) => {
        validateAttachmentLimits(this.chat.context || {}, selection);
        const [images, attachments] = await Promise.all([
          Promise.all(selection.images.map(entry => this.readAttachmentFile(entry))),
          Promise.all(selection.attachments.map(entry => this.readAttachmentFile(entry)))
        ]);
        if (!current()) return false;
        const context = this.chat.context || {};
        validateAttachmentLimits(context, selection);
        const update = { id };
        if (images.length) update.images = [...(context.images || []), ...images];
        if (attachments.length) update.attachments = [...(context.attachments || []).map(file => ({ id: file.id })), ...attachments];
        const value = await this.invoke('chat:update', update);
        if (!current()) return false;
        this.setChat(value);
        return true;
      }, target);
    }
    async removeFileAttachment(fileId) {
      if (!fileId) return false;
      return this.queueAttachmentUpdate(async (id, current) => {
        const attachments = this.chat.context?.attachments || [];
        const remaining = attachments.filter(file => file.id !== fileId);
        if (remaining.length === attachments.length) return false;
        const value = await this.invoke('chat:update', { id, attachments: remaining.map(file => ({ id: file.id })) });
        if (!current()) return false;
        this.setChat(value);
        return true;
      });
    }
    async addFiles() {const files=[...this.fileInput.files],target=this.fileTarget||{id:this.currentId,request:this.request};this.fileInput.value='';this.fileTarget=null;return this.attachFiles(files,target);}

    buildReferenceMenu() {
      this.referencePanel = element('section', 'inmoment-popover chat-reference-panel');
      this.referencePanel.id = 'chat-reference-menu';
      this.referencePanel.setAttribute('popover', 'manual');
      this.referencePanel.setAttribute('role', 'dialog');
      this.referencePanel.setAttribute('aria-label', '引用笔记');
      const tools = element('div', 'chat-reference-tools');
      this.referenceSearch = element('input');
      this.referenceSearch.type = 'search';
      this.referenceSearch.placeholder = '搜索笔记…';
      this.referenceSearch.maxLength = 200;
      this.referenceSearch.autocomplete = 'off';
      this.referenceSearch.setAttribute('aria-label', '搜索可引用笔记');
      this.referenceClear = button('', 'icon-button chat-reference-clear', 'close');
      this.referenceClear.setAttribute('aria-label', '清空搜索');
      this.referenceClear.title = '清空搜索';
      this.referenceClear.hidden = true;
      this.referenceClear.addEventListener('click', () => {
        this.referenceSearch.value = '';
        this.referenceSearch.focus({ preventScroll: true });
        this.searchReferences(true);
      });
      tools.append(this.referenceSearch, this.referenceClear);
      this.referenceResults = element('div', 'chat-reference-results');
      this.referenceStatus = element('p', 'chat-reference-status');
      this.referenceStatus.setAttribute('role', 'status');
      this.referenceMore = button('加载更多', 'button quiet compact chat-reference-more');
      this.referenceMore.hidden = true;
      this.referenceMore.addEventListener('click', () => this.loadReferences(this.referenceState, true));
      this.referencePanel.append(tools, this.referenceResults, this.referenceStatus);
      this.referenceSearch.addEventListener('input', event => {
        if (!event.isComposing) this.searchReferences();
      });
      this.referenceSearch.addEventListener('compositionend', () => this.searchReferences());
      this.referencePanel.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        const rows = [...this.referenceResults.querySelectorAll('.chat-reference-option:not(:disabled)')];
        const at = rows.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' && (at >= 0 || event.target === this.referenceSearch)) {
          event.preventDefault();
          (rows[at + 1] || (!this.referenceMore.hidden && this.referenceMore))?.focus?.();
        } else if (event.key === 'ArrowUp' && at >= 0) {
          event.preventDefault();
          (rows[at - 1] || this.referenceSearch).focus();
        }
      });
      this.referenceResults.addEventListener('scroll', () => {
        const list = this.referenceResults;
        if (list.scrollHeight - list.scrollTop - list.clientHeight <= 48 && this.referenceState?.hasMore) {
          this.loadReferences(this.referenceState, true);
        }
      });
    }
    openReferenceMenu(target) {
      this.referenceSearch.value = '';
      this.referenceState = { target };
      this.searchReferences(true);
    }
    closeReferenceMenu() {
      clearTimeout(this.referenceTimer);
      this.referenceState = null;
    }
    searchReferences(immediate = false) {
      if (!this.referenceState) return;
      this.referenceClear.hidden = !this.referenceSearch.value;
      clearTimeout(this.referenceTimer);
      const state = { target: this.referenceState.target, query: this.referenceSearch.value.trim(), offset: 0 };
      this.referenceState = state;
      this.referenceResults.replaceChildren();
      this.referenceStatus.textContent = '正在读取笔记…';
      if (immediate) this.loadReferences(state);
      else this.referenceTimer = setTimeout(() => this.loadReferences(state), 160);
    }
    async loadReferences(state, append = false) {
      if (!state || this.referenceState !== state || state.loading) return;
      const isCurrent = () => this.referenceState === state && this.currentId === state.target.id &&
        this.request === state.target.request && !this.destroyed;
      if (!isCurrent()) return;
      state.loading = true;
      this.referenceMore.disabled = true;
      try {
        const result = await this.invoke('chat:referenceNotes', { query: state.query, offset: state.offset });
        if (!isCurrent()) return;
        const notes = result.notes || [];
        const hadMoreFocus = document.activeElement === this.referenceMore;
        if (!append) this.referenceResults.replaceChildren();
        this.referenceMore.remove();
        const rows = notes.map(note => this.referenceRow(note, state.target));
        this.referenceResults.append(...rows, this.referenceMore);
        state.offset += notes.length;
        state.hasMore = Boolean(result.hasMore && notes.length);
        this.referenceMore.hidden = !state.hasMore;
        this.referenceStatus.textContent = state.offset ? '' : '没有找到可引用的笔记';
        this.updateReferenceChoices();
        if (hadMoreFocus) (rows[0] || this.referenceSearch).focus();
      } catch (error) {
        if (isCurrent()) this.referenceStatus.textContent = error.message || '读取笔记失败，请重试。';
      } finally {
        state.loading = false;
        if (isCurrent()) this.referenceMore.disabled = false;
      }
    }
    referenceRow(note, target) {
      const entry = button('', 'chat-reference-option');
      const preview = note.preview ?? referenceText(note);
      const title = note.title || limitedLabel(preview) || '无标题笔记';
      this.referenceCache ||= new Map();
      this.referenceCache.set(note.id, title);
      entry.dataset.noteId = note.id;
      entry.title = title;
      entry.setAttribute('aria-label', title);
      const heading = element('strong', '', title);
      const mark = element('span', 'chat-reference-selected');
      mark.dataset.uiIcon = 'check';
      mark.setAttribute('aria-hidden', 'true');
      entry.append(heading, mark);
      if (preview && preview !== title) entry.append(element('span', 'chat-reference-preview', limitedLabel(preview, 64)));
      entry.addEventListener('click', () => this.run(() => this.changeNoteReference(note.id, target)));
      return entry;
    }
    updateReferenceChoices() {
      if (!this.referenceState) return;
      const ids = this.chat?.recordIds || [];
      for (const row of this.referenceResults.querySelectorAll('.chat-reference-option')) {
        const selected = ids.some(id => sameReference(id, row.dataset.noteId));
        row.setAttribute('aria-pressed', String(selected));
        row.disabled = Boolean(this.chat?.pending || this.busy || this.savingInspiration);
      }
    }
    changeNoteReference(noteId, target) {
      return this.queueAttachmentUpdate(async (id, current) => {
        const ids = this.chat?.recordIds || [];
        const selected = ids.some(value => sameReference(value, noteId));
        if (!selected && ids.length >= 5) throw new Error('每次最多引用 5 条笔记。');
        const recordIds = selected ? ids.filter(value => !sameReference(value, noteId)) : [...ids, noteId];
        const chat = await this.invoke('chat:update', { id, recordIds });
        if (current()) this.setChat(chat);
      }, target);
    }
    async makeInspiration(summarize, messageIds, historyId) {
      const id = historyId ?? this.currentId;
      const active = id === this.currentId;
      const target = active ? this.chat : this.chats.find(chat => chat.id === id);
      const jobs = this.inspirationJobs ||= new Set();
      if (!target || (!target.messages?.length && !target.messageCount) || target.pending ||
          jobs.has(id) || (active && (this.busy || this.savingInspiration)) || (messageIds && !messageIds.length)) return;
      const job = { id, request: this.request, key: active ? this.selectionContextKey() : null };
      const isCurrent = () => !this.destroyed && this.currentId === id && this.request === job.request;
      const backgroundToast = (text, tone) => {
        if (historyId && !this.destroyed && !this.deletedChatIds?.has(id)) window.InMomentToast?.show(text, { tone });
      };
      jobs.add(id);
      if (active) {
        this.inspirationJob = job;
        this.savingInspiration = true;
        this.updateSend();
        this.renderSelection();
        if (summarize) this.report('正在整理聊天…');
      } else if (summarize) backgroundToast('正在整理聊天…', 'info');
      try {
        const result = await this.invoke('chat:inspiration', { id, ...(messageIds ? { messageIds } : {}), summarize });
        if (active && isCurrent()) {
          this.report('已存为笔记');
          if (!historyId && this.selectionContextKey() === job.key) {
            this.selected.clear();
            this.selecting = false;
            this.renderMessages();
          }
        } else backgroundToast('已存为笔记', 'success');
        return result;
      } catch (error) {
        if (/已取消|已停止/u.test(error.message || '')) {
          if (active && isCurrent()) this.report('已停止整理');
          return null;
        }
        if (!historyId || (active && isCurrent())) throw error;
        backgroundToast(error.message || '操作未完成，请重试。', 'error');
        return null;
      } finally {
        jobs.delete(id);
        if (this.inspirationJob === job) {
          this.inspirationJob = null;
          this.savingInspiration = false;
          this.updateSend();
          this.renderSelection();
        }
      }
    }


    destroy() { this.destroyed=true;this.navigation?.destroy();this.resolveClose?.('cancel');this.resolveVoiceCompletion();clearTimeout(this.summaryOpenTimer);clearTimeout(this.summaryHideTimer);this.summaryVersion=(this.summaryVersion||0)+1;try{this.summaryOptions?.hidePopover?.();}catch{}this.root.removeEventListener('paste',this.pasteHandler);clearTimeout(this.screenshotHoverTimer);clearTimeout(this.screenshotHideTimer);this.scissors?.destroy();this.screenshotPopoverVersion=(this.screenshotPopoverVersion||0)+1;try{this.screenshotOptions?.hidePopover?.();}catch{}this.voiceMorph?.destroy();this.voiceAttempt?.resolve?.();this.voiceAttempt=null;this.clearVoiceWave();document.removeEventListener('keydown',this.tabHandler,true);if(this.layoutFrame)cancelAnimationFrame(this.layoutFrame);if(this.caretRevealFrame)cancelAnimationFrame(this.caretRevealFrame);this.layoutObserver?.disconnect();window.removeEventListener('resize',this.composerResizeHandler);window.removeEventListener('focus',this.composerFocusHandler); this.closeImage({immediate:true,restoreFocus:false}); clearTimeout(this.composerTimer); this.closeAddMenu(); this.closeReferenceMenu(); document.removeEventListener('keydown', this.escapeHandler); document.removeEventListener('pointerdown', this.outsideHandler); this.request++; this.root.replaceChildren(); }
  }
  return { ChatView, historyChatVisible, clipboardImages, imageBytes, PLACEHOLDER, candidateState, acceptsCandidate, meaningfulCandidate, limitedLabel, referenceText };
});
