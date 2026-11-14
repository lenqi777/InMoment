'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROVIDERS, DEFAULT_PROVIDER, getProvider, validateModel } = require('../core/ai-providers.cjs');
const { DEFAULT_REGION_SHORTCUT, normalizeRegionShortcut } = require('./region-shortcut.cjs');

const CAPABILITIES = Object.freeze({ cloudEnabled: 'cloudConsentVersion', aiSearchEnabled: 'aiSearchConsentVersion', duplicateAnalysisEnabled: 'duplicateAnalysisConsentVersion', screenshotAnalysisEnabled: 'screenshotAnalysisConsentVersion', noteSelectionContextEnabled: 'noteSelectionContextConsentVersion', directAIEnabled: 'directAIConsentVersion' });
const PROVIDER_IDS = Object.keys(PROVIDERS);
const DEFAULT_PROFILES = Object.freeze(Object.fromEntries(PROVIDER_IDS.map(id => [id, Object.freeze({ model: getProvider(id).defaultModel, apiKeyEncrypted: '' })])));
const DEFAULTS = Object.freeze({ previewDelayMs: 0, thresholdMs: 550, captureDelayMs: 0, menuDelayMs: 0, keyboardTrigger: 'none', regionScreenshotShortcut: DEFAULT_REGION_SHORTCUT, excludedApps: [], captureScreenshots: true, screenshotKeepChatVisible: false, cloudEnabled: false, cloudConsentVersion: 0, aiSearchEnabled: false, aiSearchConsentVersion: 0, duplicateAnalysisEnabled: false, duplicateAnalysisConsentVersion: 0, screenshotAnalysisEnabled: false, screenshotAnalysisConsentVersion: 0, noteSelectionContextEnabled: false, noteSelectionContextConsentVersion: 0, directAIEnabled: false, directAIConsentVersion: 0, autoTitleEnabled: false, autoTitleConsentVersion: 0, aiProvider: DEFAULT_PROVIDER, aiProfiles: DEFAULT_PROFILES, model: getProvider(DEFAULT_PROVIDER).defaultModel, preferFreeModel: true, apiKeyEncrypted: '', inputEnabled: true });
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function providerId(value) { if (typeof value !== 'string' || !Object.hasOwn(PROVIDERS, value)) throw new Error('请选择支持的 AI 服务。'); return value; }
function profilesOf(value) {
  const profiles = {};
  for (const id of PROVIDER_IDS) {
    const stored = object(value.aiProfiles?.[id]) ? value.aiProfiles[id] : {};
    profiles[id] = { model: typeof stored.model === 'string' && stored.model.trim() ? stored.model : getProvider(id).defaultModel, apiKeyEncrypted: typeof stored.apiKeyEncrypted === 'string' ? stored.apiKeyEncrypted : '' };
  }
  // Only DeepSeek inherits the single-provider legacy fields. No other profile
  // can receive that key, even when the selected provider changes.
  if (!object(value.aiProfiles)) {
    if (typeof value.model === 'string' && value.model.trim()) profiles.deepseek.model = value.model;
  }
  if (typeof value.apiKeyEncrypted === 'string' && value.apiKeyEncrypted) profiles.deepseek.apiKeyEncrypted = value.apiKeyEncrypted;
  return profiles;
}
function withProfileAliases(value) {
  const aiProvider = Object.hasOwn(PROVIDERS, value.aiProvider) ? value.aiProvider : DEFAULT_PROVIDER;
  const aiProfiles = profilesOf(value);
  return { ...value, aiProvider, aiProfiles, model: aiProfiles[aiProvider].model, apiKeyEncrypted: aiProfiles.deepseek.apiKeyEncrypted };
}
class Settings {
  constructor(rootDir, secureStorage) {
    this.path = path.join(rootDir, 'settings.json'); this.secureStorage = secureStorage;
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch {}
    if (!object(existing)) existing = {};
    // Migration is in memory only. Existing protected blobs remain untouched.
    const migrated = withProfileAliases(existing);
    this.value = { ...structuredClone(DEFAULTS), ...existing, ...migrated };
    try { this.value.regionScreenshotShortcut = normalizeRegionShortcut(this.value.regionScreenshotShortcut); }
    catch { this.value.regionScreenshotShortcut = DEFAULT_REGION_SHORTCUT; }
    if(typeof this.value.screenshotKeepChatVisible!=='boolean')this.value.screenshotKeepChatVisible=false;
    if (typeof this.value.noteSelectionContextEnabled !== 'boolean') this.value.noteSelectionContextEnabled = false;
    if (typeof this.value.preferFreeModel !== 'boolean') this.value.preferFreeModel = true;
  }
  public() {
    const safe = {};
    for (const key of Object.keys(DEFAULTS)) if (!['apiKeyEncrypted', 'aiProfiles', 'aiProvider', 'model'].includes(key)) safe[key] = structuredClone(this.value[key]);
    const active = providerId(this.value.aiProvider); const protectedProfiles = profilesOf(this.value);
    const aiProfiles = Object.fromEntries(PROVIDER_IDS.map(id => [id, { model: protectedProfiles[id].model, hasApiKey: Boolean(protectedProfiles[id].apiKeyEncrypted) }]));
    const aiProviders = PROVIDER_IDS.map(id => { const provider = getProvider(id); return { id, label: provider.label, defaultModel: provider.defaultModel, models: [...provider.models] }; });
    return { ...safe, modelMode: this.value.modelMode === 'manual' ? 'manual' : 'auto', aiProvider: active, aiProfiles, aiProviders, model: aiProfiles[active].model, hasApiKey: aiProfiles[active].hasApiKey, networkDisabled: process.env.INMOMENT_DISABLE_NETWORK === '1' };
  }
  key(provider = this.value.aiProvider) {
    const id = providerId(provider); const encrypted = profilesOf(this.value)[id].apiKeyEncrypted;
    if (!encrypted) return '';
    try { return this.secureStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { throw new Error('密钥无法解密，请在设置中重新输入。'); }
  }
  persist(next) {
    if (this.writing) throw new Error('设置正在保存，请稍后重试。');
    this.writing = true;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(next, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temp, this.path);
      this.value = next;
      return this.public();
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    } finally {
      this.writing = false;
    }
  }
  resetToDefaults() {
    // Resetting restores models and consent while carrying every protected blob
    // unchanged. It never decrypts a key or requires available key protection.
    const protectedProfiles = profilesOf(this.value); const next = structuredClone(DEFAULTS);
    for (const id of PROVIDER_IDS) next.aiProfiles[id].apiKeyEncrypted = protectedProfiles[id].apiKeyEncrypted;
    next.apiKeyEncrypted = next.aiProfiles.deepseek.apiKeyEncrypted;
    return this.persist(next);
  }
  save(fields = {}, { approvedAutoTitle = false, approvedCapabilities = [] } = {}) {
    if (!object(fields)) throw new Error('设置内容格式不正确。');
    const selected = fields.aiProvider === undefined ? providerId(this.value.aiProvider) : providerId(fields.aiProvider);
    const providerChanged = selected !== this.value.aiProvider;
    const next = { ...this.value, aiProvider: selected, aiProfiles: profilesOf(this.value) };
    if (fields.modelMode !== undefined) {
      if (!['auto', 'manual'].includes(fields.modelMode)) throw new Error('请选择自动或手动模型模式。');
      next.modelMode = fields.modelMode;
    }
    if (fields.preferFreeModel !== undefined) {
      if (typeof fields.preferFreeModel !== 'boolean') throw new Error('优先使用免费模型的设置无效。');
      next.preferFreeModel = fields.preferFreeModel;
    }
    const patches = {};
    if (fields.aiProfiles !== undefined) {
      if (!object(fields.aiProfiles)) throw new Error('AI 服务设置格式不正确。');
      for (const [id, patch] of Object.entries(fields.aiProfiles)) {
        providerId(id); if (!object(patch)) throw new Error('AI 服务设置格式不正确。');
        if (Object.hasOwn(patch, 'apiKeyEncrypted')) throw new Error('请通过密钥输入框更新服务密钥。');
        patches[id] = { ...patch };
      }
    }
    const legacy = ['model', 'apiKey', 'clearApiKey'];
    for (const key of legacy) if (fields[key] !== undefined) {
      const patch = patches[selected] ||= {};
      if (patch[key] !== undefined && patch[key] !== fields[key]) throw new Error('同一服务的设置重复，请重新保存。');
      patch[key] = fields[key];
    }
    // Validate every profile before encryption or persistence. A rejected patch
    // cannot leave an unrelated provider partially updated.
    for (const patch of Object.values(patches)) {
      if (patch.model !== undefined) patch.model = validateModel(patch.model);
      if (patch.apiKey !== undefined && typeof patch.apiKey !== 'string') throw new Error('密钥格式不正确。');
      if (typeof patch.apiKey === 'string' && (patch.apiKey.length > 4096 || /[\u0000-\u001F\u007F]/u.test(patch.apiKey.trim()))) throw new Error('密钥格式不正确。');
      if (patch.clearApiKey !== undefined && typeof patch.clearApiKey !== 'boolean') throw new Error('清除密钥选项格式不正确。');
    }
    if (fields.thresholdMs !== undefined) next.thresholdMs = Math.round(Math.max(250, Math.min(10000, Number(fields.thresholdMs) || 550)));
    for (const key of ['previewDelayMs', 'captureDelayMs', 'menuDelayMs']) if (fields[key] !== undefined) { const number = Number(fields[key]); if (!Number.isFinite(number)) throw new Error('时序参数必须为有限毫秒数。'); next[key] = Math.round(Math.max(0, Math.min(5000, number))); }
    if (fields.keyboardTrigger !== undefined) { if (!['none', 'F8', 'F9', 'F10'].includes(fields.keyboardTrigger)) throw new Error('请选择受支持的功能键。'); next.keyboardTrigger = fields.keyboardTrigger; }
    if (fields.regionScreenshotShortcut !== undefined) next.regionScreenshotShortcut = normalizeRegionShortcut(fields.regionScreenshotShortcut);
    if (fields.excludedApps !== undefined) next.excludedApps = (Array.isArray(fields.excludedApps) ? fields.excludedApps : String(fields.excludedApps).split(/[,，\n]/u)).map(s => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 100);
    for (const key of ['captureScreenshots', 'inputEnabled']) if (fields[key] !== undefined) next[key] = Boolean(fields[key]);
    if(fields.screenshotKeepChatVisible!==undefined){if(typeof fields.screenshotKeepChatVisible!=='boolean')throw new Error('截图窗口选项格式不正确。');next.screenshotKeepChatVisible=fields.screenshotKeepChatVisible;}
    if (fields.noteSelectionContextEnabled !== undefined && typeof fields.noteSelectionContextEnabled !== 'boolean') throw new Error('选段 AI 上下文选项格式不正确。');
    for (const [key, version] of Object.entries(CAPABILITIES)) if (fields[key] !== undefined || providerChanged) {
      const enabling = fields[key] === undefined ? Boolean(this.value[key]) : Boolean(fields[key]);
      // Existing cloud users retain their old per-request text consent. New scopes always need their own approval.
      const alreadyAllowed = !providerChanged && Boolean(this.value[key]) && (key === 'cloudEnabled' || this.value[version] === 1);
      if (enabling && !alreadyAllowed && !approvedCapabilities.includes(key)) throw new Error('启用 AI 功能前，请先确认功能、发送范围和 API 费用。');
      next[key] = enabling;
      if (enabling && approvedCapabilities.includes(key)) next[version] = 1;
      if (!enabling) next[version] = 0;
    }
    if (fields.autoTitleEnabled !== undefined || providerChanged) {
      const enabling = fields.autoTitleEnabled === undefined ? Boolean(this.value.autoTitleEnabled) : Boolean(fields.autoTitleEnabled);
      if (enabling && !(!providerChanged && this.value.autoTitleEnabled && this.value.autoTitleConsentVersion === 1) && !approvedAutoTitle) throw new Error('启用自动命名前，请先确认发送范围和逐条请求的费用。');
      next.autoTitleEnabled = enabling;
      if (next.autoTitleEnabled && approvedAutoTitle) next.autoTitleConsentVersion = 1;
      if (!next.autoTitleEnabled) next.autoTitleConsentVersion = 0;
    }
    for (const [id, patch] of Object.entries(patches)) {
      const profile = next.aiProfiles[id];
      if (patch.model !== undefined) profile.model = patch.model;
      if (patch.clearApiKey === true) profile.apiKeyEncrypted = '';
      else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
        try {
          if (!this.secureStorage.isEncryptionAvailable()) throw new Error('Unavailable key protection');
          profile.apiKeyEncrypted = this.secureStorage.encryptString(patch.apiKey.trim()).toString('base64');
        } catch { throw new Error('系统密钥保护暂不可用，未保存密钥。'); }
      }
    }
    next.model = next.aiProfiles[selected].model;
    next.apiKeyEncrypted = next.aiProfiles.deepseek.apiKeyEncrypted;
    return this.persist(next);
  }
}
module.exports = { Settings, DEFAULTS, CAPABILITIES };
