'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');

class NativeBridge extends EventEmitter {
  constructor(executable) { super(); this.executable = executable; this.pending = new Map(); this.lateCaptures = new Map(); this.sequence = 0; this.available = false; this.child = null; this.closing = false; }
  start() {
    this.child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.on('error', () => this.fail('Windows 辅助模块无法启动。'));
    this.child.on('exit', () => this.fail('Windows 辅助模块已停止，录音已暂停。'));
    this.child.stderr.on('data', () => {}); // Never forward application/window content to logs.
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(String(message.id));
        if (!pending) {
          const abandoned = this.lateCaptures.get(String(message.id));
          if (abandoned) { try { fs.rmSync(abandoned, { force: true }); this.lateCaptures.delete(String(message.id)); } catch {} }
          return;
        }
        clearTimeout(pending.timer); this.pending.delete(String(message.id));
        if (message.ok) pending.resolve(message.result);
        else { const error = new Error(typeof message.error === 'string' ? message.error : message.error?.message || '原生操作未完成。'); error.code = message.error?.code; pending.reject(error); }
      } else if (message.event) {
        if (this.closing) return;
        if (/ready/i.test(message.event)) this.available = true;
        this.emit(message.event, message.data || {});
      }
    });
    return this;
  }
  request(method, params = {}, timeoutMs = 15000) {
    if (this.closing && method !== 'shutdown') return Promise.reject(new Error('本地模块正在退出。'));
    if (!this.child || this.child.killed || !this.child.stdin.writable) return Promise.reject(new Error('Windows 辅助模块未就绪。'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); if (method === 'captureWindow' && typeof params.outputPath === 'string') this.lateCaptures.set(id, params.outputPath); reject(new Error('本地操作超时。')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('本地进程通信失败。')); }
      });
    });
  }
  fail(message) {
    this.available = false;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    this.pending.clear(); if (!this.closing) this.emit('bridgeFault', { message });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.available = false;
    this.closePromise = (async () => {
      try { await this.request('shutdown', {}, 1000); } catch {}
      if (this.child && this.child.exitCode === null) await new Promise(resolve => {
        const timer = setTimeout(() => { if (!this.child.killed) this.child.kill(); resolve(); }, 1500);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      this.fail('本地模块已退出。');
      for (const filename of this.lateCaptures.values()) { try { fs.rmSync(filename, { force: true }); } catch {} }
      this.lateCaptures.clear();
    })();
    return this.closePromise;
  }
}
module.exports = { NativeBridge };
