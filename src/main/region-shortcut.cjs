'use strict';

const DEFAULT_REGION_SHORTCUT = 'Ctrl+Shift+F9';
const REGION_SHORTCUT_ERROR = 'REGION_SHORTCUT';
const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];

function shortcutError(message) {
  return Object.assign(new Error(message), { code: REGION_SHORTCUT_ERROR });
}

function normalizeRegionShortcut(value) {
  const parts = typeof value === 'string' && value.length <= 40 ? value.split(/[+＋]/u).map(part => part.trim().toUpperCase()) : [];
  const key = parts.pop() || '';
  const modifiers = MODIFIERS.filter(modifier => parts.includes(modifier.toUpperCase()));
  const functionKey = /^F(?:[1-9]|1[0-2])$/u.test(key);
  const letterOrDigit = /^[A-Z0-9]$/u.test(key);
  if (modifiers.length !== parts.length || !(functionKey && modifiers.length >= 1 || letterOrDigit && modifiers.length >= 2)) {
    throw shortcutError('功能键请搭配至少一个修饰键，字母或数字请搭配至少两个。支持 Ctrl、Alt、Shift。');
  }
  const shortcut = [...modifiers, key].join('+');
  if (shortcut === 'Alt+F4') throw shortcutError('Alt+F4 用于关闭窗口，请选择其他组合键。');
  return shortcut;
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta']);
function shortcutFromInput(input) {
  if (input.isAutoRepeat || input.isComposing || MODIFIER_KEYS.has(input.key)) return null;
  if (input.meta || input.code?.startsWith('Numpad')) throw shortcutError('请选择 Ctrl、Alt、Shift 与功能键、字母或主键区数字组成的快捷键。');
  const key = /^Digit[0-9]$/u.test(input.code) ? input.code.slice(-1) : input.key;
  return normalizeRegionShortcut([input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', key].filter(Boolean).join('+'));
}

class RegionShortcut {
  constructor(registry, onCapture, enabled = true) {
    this.registry = registry;
    this.onCapture = onCapture;
    this.enabled = Boolean(registry) && enabled;
    this.registered = '';
  }

  status(shortcut) {
    const available = this.registered === shortcut;
    return {
      shortcut,
      available,
      error: this.enabled && !available ? '截图录音快捷键不可用，可能已被系统或其他应用占用。' : '',
    };
  }

  start(shortcut) {
    try { this.save(shortcut, () => {}); } catch { /* Report a startup collision in the capability status. */ }
    return this.status(shortcut);
  }

  save(shortcut, persist) {
    if (!this.enabled || this.registered === shortcut) return persist();
    let available;
    try {
      available = this.registry.register(shortcut, () => {
        if (this.registered === shortcut) this.onCapture();
      });
    } catch { available = false; }
    if (!available) throw shortcutError(`${shortcut} 无法注册，可能已被系统或其他应用占用。请选择其他组合键。`);

    let saved;
    try {
      saved = persist();
    } catch (error) {
      this.registry.unregister(shortcut);
      throw error;
    }
    const previous = this.registered;
    this.registered = shortcut;
    if (previous) this.registry.unregister(previous);
    return saved;
  }

  close() {
    const previous = this.registered;
    this.registered = '';
    if (previous) this.registry.unregister(previous);
  }
}

module.exports = { DEFAULT_REGION_SHORTCUT, REGION_SHORTCUT_ERROR, normalizeRegionShortcut, shortcutFromInput, RegionShortcut };
