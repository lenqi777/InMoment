'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL_MANIFEST = Object.freeze({
  id: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  license: 'MIT',
  totalBytes: 135392183,
  files: Object.freeze([
    Object.freeze({ path: 'config.json', size: 658, gitSha1: '4104f38273cc595fd9500fd243124e9f6cf383dc' }),
    Object.freeze({ path: 'tokenizer_config.json', size: 443, gitSha1: '059214673d9d6d2ee319411e2ffec8c024b816d5' }),
    Object.freeze({ path: 'special_tokens_map.json', size: 167, gitSha1: 'e0b1d18ecd0ae4ff1d47bd297d910c0cf83e504b' }),
    Object.freeze({ path: 'tokenizer.json', size: 17082730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' }),
    Object.freeze({ path: 'onnx/model_quantized.onnx', size: 118308185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' }),
  ]),
});
const MARKER = '.inmoment-semantic-model.json';
const EXTRA_FILES = Object.freeze([MARKER, 'MODEL-LICENSE.txt', 'PROVENANCE.json']);
const CDN_HOSTS = new Set(['cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'cdn-lfs-eu-1.huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co', 'eu.aws.cdn.hf.co']);
const MODEL_LICENSE_TEXT = `Model: intfloat/multilingual-e5-small (base model, published as MIT)
Base card: https://huggingface.co/intfloat/multilingual-e5-small
ONNX conversion: https://huggingface.co/Xenova/multilingual-e5-small
Pinned ONNX revision: ${MODEL_MANIFEST.revision}
The ONNX model card links to the base model; it does not contain a separate license file.
E5 project: https://github.com/microsoft/unilm/tree/master/e5
License source: https://github.com/microsoft/unilm/blob/master/LICENSE

The MIT License (MIT)

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
function manifestDigest(manifest) { return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'); }
function errorWithCode(message, code) { return Object.assign(new Error(message), { code }); }
function abortError() { return errorWithCode('模型安装已取消。', 'SEMANTIC_CANCELLED'); }
function retryableNetworkError(error) {
  if (['EACCES', 'EPERM', 'SEMANTIC_CANCELLED', 'SEMANTIC_TIMEOUT'].includes(error?.code)) return error;
  const wrapped = errorWithCode(error?.message || '模型下载连接中断。', 'SEMANTIC_CONNECTION'); wrapped.retryable = true; return wrapped;
}
function throwIfAborted(signal) { if (signal.aborted) throw signal.reason || abortError(); }
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || abortError()); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function allowedURL(value, manifest) {
  let url; try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (CDN_HOSTS.has(url.hostname)) return true;
  if (url.hostname !== 'huggingface.co') return false;
  const prefixes = [`/${manifest.id}/resolve/${manifest.revision}/`, `/api/resolve-cache/models/${manifest.id}/${manifest.revision}/`];
  return prefixes.some(prefix => manifest.files.some(file => url.pathname === prefix + file.path));
}
function assertManifest(manifest) {
  if (manifest.id !== MODEL_MANIFEST.id || manifest.revision !== MODEL_MANIFEST.revision) throw new Error('模型来源或版本不受支持。');
  const names = new Set(MODEL_MANIFEST.files.map(file => file.path));
  if (!Array.isArray(manifest.files) || manifest.files.length !== names.size || new Set(manifest.files.map(file => file.path)).size !== names.size) throw new Error('模型清单无效。');
  for (const file of manifest.files) if (!names.has(file.path) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 150 * 1024 * 1024 || !(file.sha256 && /^[a-f0-9]{64}$/u.test(file.sha256)) && !(file.gitSha1 && /^[a-f0-9]{40}$/u.test(file.gitSha1))) throw new Error('模型文件清单无效。');
  if (manifest.files.reduce((sum, file) => sum + file.size, 0) !== manifest.totalBytes) throw new Error('模型总大小不匹配。');
}
function regularFileWithin(directory, name) {
  const root = path.resolve(directory); let current = root;
  try {
    if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) return null;
    for (const component of name.split('/')) { current = path.join(current, component); if (fs.lstatSync(current).isSymbolicLink()) return null; }
    const stat = fs.statSync(current); return stat.isFile() ? stat : null;
  } catch { return null; }
}
function validModelDirectory(directory, manifest = MODEL_MANIFEST) {
  if (!directory) return false;
  try {
    const markerStat = regularFileWithin(directory, MARKER); if (!markerStat || markerStat.size > 16384) return false;
    const marker = JSON.parse(fs.readFileSync(path.join(directory, MARKER), 'utf8'));
    if (marker.schemaVersion !== 1 || marker.manifestSha256 !== manifestDigest(manifest)) return false;
    return manifest.files.every(file => regularFileWithin(directory, file.path)?.size === file.size) && EXTRA_FILES.slice(1).every(name => regularFileWithin(directory, name)?.size > 0);
  } catch { return false; }
}
// Never recursively remove the destination itself. These names are allocated by
// this installer immediately beside the configured model directory.
function removeManagedSibling(candidate, directory) {
  const resolved = path.resolve(candidate); const parent = path.dirname(path.resolve(directory)); const base = path.basename(directory);
  if (path.dirname(resolved) !== parent || !(path.basename(resolved).startsWith(base + '.install-') || path.basename(resolved).startsWith(base + '.previous-'))) throw new Error('拒绝清理不属于模型安装的路径。');
  fs.rmSync(resolved, { recursive: true, force: true });
}

class ModelInstaller {
  constructor({ directory, bundledDirectory, fetchImpl = globalThis.fetch, onProgress = () => {}, networkDisabled = false, manifest = MODEL_MANIFEST, timeoutMs = 45 * 60 * 1000, idleTimeoutMs = 90000 } = {}) {
    if (!directory || path.resolve(directory) === path.parse(path.resolve(directory)).root) throw new Error('请提供独立的模型目录。');
    assertManifest(manifest);
    this.directory = path.resolve(directory); this.bundledDirectory = bundledDirectory && path.resolve(bundledDirectory);
    this.manifest = manifest; this.fetchImpl = fetchImpl; this.onProgress = onProgress; this.networkDisabled = networkDisabled;
    this.timeoutMs = timeoutMs; this.idleTimeoutMs = idleTimeoutMs; this.phase = 'idle'; this.downloaded = 0; this.error = null; this.job = null;
  }
  modelDirectory() { return validModelDirectory(this.directory, this.manifest) ? this.directory : validModelDirectory(this.bundledDirectory, this.manifest) ? this.bundledDirectory : null; }
  status() { const directory = this.modelDirectory(); return { installed: Boolean(directory), ...(directory ? { modelDirectory: directory } : {}), phase: this.phase === 'idle' && directory ? 'installed' : this.phase, downloaded: this.downloaded, totalBytes: this.manifest.totalBytes, ...(this.file ? { file: this.file, attempt: this.attempt, retryCount: this.retryCount } : {}), ...(this.error ? { error: this.error } : {}) }; }
  emit(job, phase) {
    if (this.job !== job || job.cancelled && !['cancelled', 'cancelling'].includes(phase)) return;
    this.phase = phase; try { this.onProgress({ type: 'semanticProgress', ...this.status() }); } catch { /* A closed UI must not break installation cleanup. */ }
  }
  cancel() { if (!this.job || this.job.cancelled || this.job.completed) return false; this.job.cancelled = true; this.job.controller.abort(abortError()); this.emit(this.job, 'cancelling'); return true; }
  install({ approved = false, signal } = {}) {
    if (approved !== true) return Promise.reject(new Error('需先明确同意下载本地模型。'));
    if (this.networkDisabled) return Promise.reject(new Error('当前已禁用网络，不能下载模型。'));
    if (this.job) return this.job.promise;
    const job = { controller: new AbortController(), cancelled: false, temp: null, promise: null };
    this.job = job; this.downloaded = 0; this.error = null; this.file = null; this.attempt = 0; this.retryCount = 0;
    const externalAbort = () => { job.cancelled = true; job.controller.abort(signal.reason || abortError()); };
    if (signal?.aborted) externalAbort(); else signal?.addEventListener('abort', externalAbort, { once: true });
    // Publish the shared promise before progress callbacks can re-enter install.
    job.promise = Promise.resolve().then(() => this.run(job)).finally(() => { signal?.removeEventListener('abort', externalAbort); if (this.job === job) this.job = null; });
    return job.promise;
  }
  async run(job) {
    const signal = job.controller.signal;
    try {
      throwIfAborted(signal); this.emit(job, 'preparing');
      fs.mkdirSync(path.dirname(this.directory), { recursive: true });
      job.temp = fs.mkdtempSync(path.join(path.dirname(this.directory), path.basename(this.directory) + '.install-'));
      for (const file of this.manifest.files) { throwIfAborted(signal); await this.downloadFile(job, file); }
      throwIfAborted(signal); this.emit(job, 'verifying');
      fs.writeFileSync(path.join(job.temp, 'MODEL-LICENSE.txt'), MODEL_LICENSE_TEXT);
      fs.writeFileSync(path.join(job.temp, 'PROVENANCE.json'), JSON.stringify({ id: this.manifest.id, revision: this.manifest.revision, source: `https://huggingface.co/${this.manifest.id}/tree/${this.manifest.revision}`, license: 'MIT', files: this.manifest.files }, null, 2));
      fs.writeFileSync(path.join(job.temp, MARKER), JSON.stringify({ schemaVersion: 1, manifestSha256: manifestDigest(this.manifest), id: this.manifest.id, revision: this.manifest.revision, verifiedAt: new Date().toISOString() }, null, 2));
      if (!validModelDirectory(job.temp, this.manifest)) throw new Error('模型安装文件校验未通过。');
      throwIfAborted(signal);
      // Synchronous swap: cancellation cannot interleave between moving the old
      // directory aside and promoting the fully verified new directory.
      let backup = null;
      if (fs.existsSync(this.directory)) { backup = path.join(path.dirname(this.directory), path.basename(this.directory) + '.previous-' + crypto.randomUUID()); fs.renameSync(this.directory, backup); }
      try { fs.renameSync(job.temp, this.directory); job.temp = null; }
      catch (error) { if (backup && !fs.existsSync(this.directory)) fs.renameSync(backup, this.directory); throw error; }
      if (backup) { try { removeManagedSibling(backup, this.directory); } catch { /* A locked old model may be cleaned after the next restart. */ } }
      job.completed = true; this.emit(job, 'installed'); return this.status();
    } catch (error) {
      this.error = job.cancelled || error.code === 'SEMANTIC_CANCELLED' ? null : error.message || '模型安装失败。';
      this.emit(job, job.cancelled || error.code === 'SEMANTIC_CANCELLED' ? 'cancelled' : 'failed'); throw error;
    } finally { if (job.temp) removeManagedSibling(job.temp, this.directory); }
  }
  async downloadFile(job, file) {
    const signal = job.controller.signal;
    const timeout = setTimeout(() => job.controller.abort(errorWithCode('模型下载超时，请重试。', 'SEMANTIC_TIMEOUT')), this.timeoutMs);
    let handle; let bytes = 0;
    const createHash = () => { const value = crypto.createHash(file.sha256 ? 'sha256' : 'sha1'); if (!file.sha256) value.update(`blob ${file.size}\0`); return value; };
    let hash = createHash(); this.file = file.path;
    try {
      const destination = path.join(job.temp, ...file.path.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); handle = await fs.promises.open(destination, 'wx');
      for (let attempt = 0; attempt <= 3; attempt += 1) {
        throwIfAborted(signal); this.attempt = attempt + 1; this.retryCount = attempt; this.emit(job, 'downloading');
        const connection = new AbortController(); const abortConnection = () => connection.abort(signal.reason || abortError()); signal.addEventListener('abort', abortConnection, { once: true });
        let idleTimer; let reader; let response;
        const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => connection.abort(errorWithCode('模型下载长时间没有进展，请重试。', 'SEMANTIC_IDLE_TIMEOUT')), this.idleTimeoutMs); };
        const network = async action => { try { return await abortable(action(), connection.signal); } catch (error) { throwIfAborted(signal); throw retryableNetworkError(error); } };
        try {
          let url = `https://huggingface.co/${this.manifest.id}/resolve/${this.manifest.revision}/${file.path}?download=true`;
          const requestedOffset = bytes; const headers = { Accept: 'application/octet-stream', ...(requestedOffset ? { Range: `bytes=${requestedOffset}-` } : {}) };
          for (let count = 0; count <= 6; count += 1) {
            if (!allowedURL(url, this.manifest)) throw new Error('模型下载地址不在允许的来源中。');
            throwIfAborted(signal); resetIdle();
            response = await network(() => this.fetchImpl(url, { redirect: 'manual', signal: connection.signal, credentials: 'omit', headers }));
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers?.get('location'); try { Promise.resolve(response.body?.cancel?.()).catch(() => {}); } catch {}
              if (!location || count === 6) throw new Error('模型下载重定向过多或不完整。'); url = new URL(location, url).href; continue;
            }
            break;
          }
          throwIfAborted(signal);
          if (!response.ok) {
            const error = errorWithCode(`模型下载失败（HTTP ${response.status}）。`, 'SEMANTIC_HTTP'); error.retryable = response.status === 429 || response.status >= 500; throw error;
          }
          if (requestedOffset && response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers?.get('content-range') || '');
            if (!range || Number(range[1]) !== requestedOffset || Number(range[2]) !== file.size - 1 || Number(range[3]) !== file.size) throw new Error('模型续传范围与已保存的内容不匹配。');
          } else if (response.status !== 200) throw new Error('模型下载返回了不支持的内容范围。');
          const expectedLength = response.status === 206 ? file.size - requestedOffset : file.size;
          const length = response.headers?.get('content-length'); if (length !== null && length !== undefined && Number(length) !== expectedLength) throw new Error('模型文件大小与清单不匹配。');
          if (!response.body?.getReader) throw new Error('模型下载未返回文件内容。');
          if (requestedOffset && response.status === 200) {
            // An origin may ignore Range. Restart that file from zero, including
            // its digest and progress, rather than appending a second full copy.
            await handle.truncate(0); this.downloaded -= bytes; bytes = 0; hash = createHash(); this.emit(job, 'downloading');
          }
          reader = response.body.getReader();
          while (true) {
            throwIfAborted(signal); resetIdle(); const chunk = await network(() => reader.read()); throwIfAborted(signal);
            if (chunk.done) break;
            if (!ArrayBuffer.isView(chunk.value)) throw new Error('模型下载格式不正确。');
            const buffer = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
            if (bytes + buffer.length > file.size) throw new Error('模型下载超出文件大小限制。');
            let offset = 0;
            while (offset < buffer.length) {
              const written = await handle.write(buffer, offset, buffer.length - offset, bytes); if (!written.bytesWritten) throw new Error('模型文件写入失败。');
              hash.update(buffer.subarray(offset, offset + written.bytesWritten)); offset += written.bytesWritten; bytes += written.bytesWritten; this.downloaded += written.bytesWritten;
            }
            throwIfAborted(signal); this.emit(job, 'downloading');
          }
          if (bytes !== file.size) { const error = errorWithCode('模型下载内容不完整，正在尝试续传。', 'SEMANTIC_INCOMPLETE'); error.retryable = true; throw error; }
          if (hash.digest('hex') !== (file.sha256 || file.gitSha1)) throw new Error('模型文件完整性校验失败，请重试。');
          await handle.sync(); return;
        } catch (error) {
          throwIfAborted(signal);
          // If the final framing was interrupted after every expected byte was
          // written, the pinned digest can establish completion without an
          // invalid Range request starting at EOF.
          if (error.retryable && bytes === file.size) {
            if (hash.digest('hex') !== (file.sha256 || file.gitSha1)) throw new Error('模型文件完整性校验失败，请重试。');
            await handle.sync(); return;
          }
          if (!error.retryable || attempt === 3) throw error;
          this.retryCount = attempt + 1; this.attempt = attempt + 2; this.emit(job, 'retrying');
        } finally {
          clearTimeout(idleTimer); signal.removeEventListener('abort', abortConnection);
          if (!connection.signal.aborted) connection.abort();
          try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel?.()).catch(() => {}); } catch {}
        }
      }
    } finally {
      clearTimeout(timeout);
      if (handle) await handle.close();
    }
  }
}

module.exports = { ModelInstaller, MODEL_MANIFEST, MODEL_LICENSE_TEXT, MARKER, EXTRA_FILES, validModelDirectory };
