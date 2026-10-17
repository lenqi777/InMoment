'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CAPABILITIES = Object.freeze({ cloudEnabled: 'cloudConsentVersion', aiSearchEnabled: 'aiSearchConsentVersion', duplicateAnalysisEnabled: 'duplicateAnalysisConsentVersion', screenshotAnalysisEnabled: 'screenshotAnalysisConsentVersion', directAIEnabled: 'directAIConsentVersion' });
const DEFAULTS = Object.freeze({ previewDelayMs: 0, thresholdMs: 550, captureDelayMs: 0, menuDelayMs: 0, keyboardTrigger: 'none', excludedApps: [], captureScreenshots: true, cloudEnabled: false, cloudConsentVersion: 0, aiSearchEnabled: false, aiSearchConsentVersion: 0, duplicateAnalysisEnabled: false, duplicateAnalysisConsentVersion: 0, screenshotAnalysisEnabled: false, screenshotAnalysisConsentVersion: 0, directAIEnabled: false, directAIConsentVersion: 0, autoTitleEnabled: false, autoTitleConsentVersion: 0, model: 'deepseek-flash', apiKeyEncrypted: '', inputEnabled: true });
class Settings {
  constructor(rootDir, secureStorage) {
    this.path = path.join(rootDir, 'settings.json'); this.secureStorage = secureStorage;
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch {}
    this.value = { ...DEFAULTS, ...existing };
  }
  public() { const { apiKeyEncrypted, ...safe } = this.value; return { ...safe, hasApiKey: Boolean(apiKeyEncrypted), networkDisabled: process.env.INMOMENT_DISABLE_NETWORK === '1' }; }
  key() {
    if (!this.value.apiKeyEncrypted) return '';
    try { return this.secureStorage.decryptString(Buffer.from(this.value.apiKeyEncrypted, 'base64')); } catch { throw new Error('密钥无法解密，请在设置中重新输入。'); }
  }
  persist(next) {
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
    }
  }
  resetToDefaults() {
    // The existing protected blob is carried unchanged; resetting never decrypts or clears it.
    return this.persist({ ...structuredClone(DEFAULTS), apiKeyEncrypted: this.value.apiKeyEncrypted });
  }
  save(fields = {}, { approvedAutoTitle = false, approvedCapabilities = [] } = {}) {
    const next = { ...this.value };
    if (fields.thresholdMs !== undefined) next.thresholdMs = Math.round(Math.max(250, Math.min(10000, Number(fields.thresholdMs) || 550)));
    for (const key of ['previewDelayMs', 'captureDelayMs', 'menuDelayMs']) if (fields[key] !== undefined) { const number = Number(fields[key]); if (!Number.isFinite(number)) throw new Error('时序参数必须为有限毫秒数。'); next[key] = Math.round(Math.max(0, Math.min(5000, number))); }
    if (fields.keyboardTrigger !== undefined) { if (!['none', 'F8', 'F9', 'F10'].includes(fields.keyboardTrigger)) throw new Error('请选择受支持的功能键。'); next.keyboardTrigger = fields.keyboardTrigger; }
    if (fields.excludedApps !== undefined) next.excludedApps = (Array.isArray(fields.excludedApps) ? fields.excludedApps : String(fields.excludedApps).split(/[,，\n]/u)).map(s => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 100);
    for (const key of ['captureScreenshots', 'inputEnabled']) if (fields[key] !== undefined) next[key] = Boolean(fields[key]);
    for (const [key, version] of Object.entries(CAPABILITIES)) if (fields[key] !== undefined) {
      const enabling = Boolean(fields[key]);
      // Existing cloud users retain their old per-request text consent. New scopes always need their own approval.
      const alreadyAllowed = Boolean(this.value[key]) && (key === 'cloudEnabled' || this.value[version] === 1);
      if (enabling && !alreadyAllowed && !approvedCapabilities.includes(key)) throw new Error('启用 AI 功能前，请先确认功能、发送范围和 API 费用。');
      next[key] = enabling;
      if (enabling && approvedCapabilities.includes(key)) next[version] = 1;
      if (!enabling) next[version] = 0;
    }
    if (fields.autoTitleEnabled !== undefined) {
      if (fields.autoTitleEnabled && !(this.value.autoTitleEnabled && this.value.autoTitleConsentVersion === 1) && !approvedAutoTitle) throw new Error('启用自动命名前，请先确认发送范围和逐条请求的费用。');
      next.autoTitleEnabled = Boolean(fields.autoTitleEnabled);
      if (next.autoTitleEnabled && approvedAutoTitle) next.autoTitleConsentVersion = 1;
    }
    if (fields.model !== undefined) next.model = String(fields.model).trim().slice(0, 100) || DEFAULTS.model;
    if (fields.clearApiKey === true) next.apiKeyEncrypted = '';
    else if (typeof fields.apiKey === 'string' && fields.apiKey.trim()) {
      if (!this.secureStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用，未保存密钥。');
      next.apiKeyEncrypted = this.secureStorage.encryptString(fields.apiKey.trim()).toString('base64');
    }
    return this.persist(next);
  }
}
module.exports = { Settings, DEFAULTS, CAPABILITIES };
