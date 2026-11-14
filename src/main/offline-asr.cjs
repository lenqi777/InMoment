'use strict';

// Offline-only adapter. Installation is an explicit script; this module never downloads.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { prepareAudioSegments } = require('./asr-audio.cjs');

const PROVIDER = 'sherpa-onnx';
const MODEL = 'SenseVoiceSmall';
const MAX_BATCH_PARTS = 4;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function aborted() { return Object.assign(new Error('本地转写已取消。'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function checkSignal(signal) { if (signal?.aborted) throw aborted(); }

class OfflineASR {
  constructor(rootDir, { spawnImpl = spawn, now = () => performance.now(), jobsDir } = {}) {
    if (typeof rootDir !== 'string' || !rootDir) throw new Error('A local offline recognizer directory is required.');
    this.rootDir = path.resolve(rootDir);
    this.spawn = spawnImpl;
    this.now = now;
    this.jobsDir = jobsDir ? path.resolve(jobsDir) : path.join(this.rootDir, 'jobs');
    this.activeJobs = new Set();
  }

  assertSafeJobsDirectory({ create = false } = {}) {
    const absolute = path.resolve(this.jobsDir);
    if (absolute === path.parse(absolute).root || path.relative(this.rootDir, absolute) === '') throw failure('ASR_UNSAFE_JOBS_DIR', '转写临时目录配置不安全，未进行清理。');
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw failure('ASR_UNSAFE_JOBS_DIR', '无法验证转写临时目录，未进行清理。'); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('ASR_UNSAFE_JOBS_DIR', '转写临时目录不能使用符号链接或目录联接，未进行清理。');
    }
    if (create) fs.mkdirSync(absolute, { recursive: true });
    return absolute;
  }

  assertSafeJobTree(directory) {
    const jobsDir = this.assertSafeJobsDirectory();
    const absolute = path.resolve(directory);
    const relative = path.relative(jobsDir, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) || !/^transcribe-[a-zA-Z0-9_-]+$/u.test(relative)) throw failure('ASR_UNSAFE_JOB_PATH', '转写清理路径无效，未进行清理。');
    const inspect = candidate => {
      const nested = path.relative(absolute, candidate);
      if (nested.startsWith('..') || path.isAbsolute(nested)) throw failure('ASR_UNSAFE_JOB_PATH', '转写清理路径越界，未进行清理。');
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw failure('ASR_UNSAFE_JOB_PATH', '转写临时材料包含符号链接或目录联接，未进行清理。');
      if (stat.isDirectory()) for (const name of fs.readdirSync(candidate)) inspect(path.join(candidate, name));
    };
    inspect(absolute);
    return absolute;
  }

  removeJobDirectory(directory) {
    const absolute = this.assertSafeJobTree(directory);
    // Both the resolved target and every descendant are checked before recursive deletion.
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  /** Call once at single-instance startup, before accepting any transcription jobs; safe to retry. */
  cleanupStaleJobs() {
    if (this.activeJobs.size) throw failure('ASR_JOBS_BUSY', '仍有本地转写任务，完成后才能清理残留材料。');
    return this.cleanupJobs();
  }

  recordJobPrefix(recordId) {
    if (typeof recordId !== 'string' || !recordId || recordId.length > 1000) throw failure('ASR_INVALID_RECORD', '转写记录标识无效。');
    return `transcribe-${createHash('sha256').update(recordId).digest('hex').slice(0, 24)}-`;
  }

  /** Retry only this record's cleanup after its worker has settled, even if other jobs run. */
  cleanupRecordJobs(recordId) {
    const prefix = this.recordJobPrefix(recordId);
    if ([...this.activeJobs].some(directory => path.basename(directory).startsWith(prefix))) throw failure('ASR_JOBS_BUSY', '这条记录仍在本地转写，停止后才能清理材料。');
    return this.cleanupJobs(prefix);
  }

  cleanupJobs(prefix = null) {
    const jobsDir = this.assertSafeJobsDirectory();
    if (!fs.existsSync(jobsDir)) return { ok: true, cleaned: 0, remaining: [], skipped: 0 };
    const result = { ok: true, cleaned: 0, remaining: [], skipped: 0 };
    for (const jobId of fs.readdirSync(jobsDir)) {
      if (!/^transcribe-[a-zA-Z0-9_-]+$/u.test(jobId) || (prefix && !jobId.startsWith(prefix))) { result.skipped += 1; continue; }
      const directory = path.resolve(jobsDir, jobId);
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) { result.skipped += 1; continue; }
        this.removeJobDirectory(directory);
        result.cleaned += 1;
      } catch (error) {
        result.remaining.push({ jobId, code: error.code === 'ASR_UNSAFE_JOB_PATH' ? error.code : 'ASR_CLEANUP_FAILED' });
      }
    }
    result.ok = result.remaining.length === 0;
    return result;
  }

  configuration() {
    let manifest = {};
    const file = path.join(this.rootDir, 'asr.json');
    if (fs.existsSync(file)) {
      try { manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
      catch { throw failure('ASR_CONFIG_INVALID', '离线转写配置无法读取，请重新运行安装脚本。'); }
    }
    if (manifest.provider === 'whisper.cpp' || manifest.model === 'base') throw failure('ASR_UPGRADE_REQUIRED', '本地转写已改用 SenseVoiceSmall，请重新运行离线语音安装脚本。');
    if ((manifest.provider && manifest.provider !== PROVIDER) || (manifest.model && manifest.model !== MODEL)) throw failure('ASR_CONFIG_INVALID', '离线转写组件与 SenseVoiceSmall 不匹配，请重新运行安装脚本。');
    const inside = relative => {
      if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw failure('ASR_CONFIG_INVALID', '离线转写路径配置无效。');
      const absolute = path.resolve(this.rootDir, relative);
      const remaining = path.relative(this.rootDir, absolute);
      if (remaining.startsWith('..') || path.isAbsolute(remaining)) throw failure('ASR_CONFIG_INVALID', '离线转写路径配置无效。');
      return absolute;
    };
    return {
      binaryPath: inside(manifest.binaryPath || 'bin/sherpa-onnx-offline.exe'),
      modelPath: inside(manifest.modelPath || 'models/sensevoice.int8.onnx'),
      tokensPath: inside(manifest.tokensPath || 'models/tokens.txt'),
      model: MODEL, version: manifest.version || '2.0.1', modelVersion: manifest.modelRevision || manifest.modelVersion || '2024-07-17',
    };
  }

  capabilities() {
    try {
      const configuration = this.configuration();
      const present = file => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; } };
      const binaryAvailable = present(configuration.binaryPath);
      const modelAvailable = present(configuration.modelPath) && present(configuration.tokensPath);
      return { available: binaryAvailable && modelAvailable, provider: PROVIDER, model: MODEL, language: 'zh',
        version: configuration.version, modelVersion: configuration.modelVersion, binaryAvailable, modelAvailable,
        rootDir: this.rootDir, offline: true, reason: binaryAvailable && modelAvailable ? null : 'not-installed' };
    } catch (error) { return { available: false, provider: PROVIDER, model: MODEL, offline: true, reason: error.code === 'ASR_UPGRADE_REQUIRED' ? 'upgrade-required' : 'invalid-configuration' }; }
  }

  async transcribe(record, { signal } = {}) {
    checkSignal(signal);
    if (!this.capabilities().available) throw failure('CAPABILITY_UNAVAILABLE', 'SenseVoiceSmall 本地转写尚未就绪，请先运行离线语音安装脚本。');
    if (!Array.isArray(record?.segments) || !record.segments.length) throw failure('NO_AUDIO', '这条记录没有可转写的音频。');
    if (new Set(record.segments.map(segment => segment?.id)).size !== record.segments.length) throw failure('ASR_INVALID_RECORD', '录音片段标识重复，未开始转写。');
    const configuration = this.configuration();
    const started = this.now();
    const jobsDir = this.assertSafeJobsDirectory({ create: true });
    const tempDir = fs.mkdtempSync(path.join(jobsDir, this.recordJobPrefix(record.id)));
    this.activeJobs.add(tempDir);
    const transcripts = [];
    const timings = [];
    let audioDurationMs = 0;
    try {
      const { parts, originals } = await prepareAudioSegments(record.segments, tempDir, { checkCancelled: () => checkSignal(signal) });
      const words = new Map(originals.map(segment => [segment.id, []]));
      audioDurationMs = originals.reduce((sum, segment) => sum + segment.durationMs, 0);
      // The native CLI pads a whole batch into one tensor; bound both memory and command size.
      for (let index = 0; index < parts.length; index += MAX_BATCH_PARTS) {
        checkSignal(signal);
        const batch = parts.slice(index, index + MAX_BATCH_PARTS);
        const args = [`--sense-voice-model=${configuration.modelPath}`, `--tokens=${configuration.tokensPath}`,
          '--sense-voice-language=zh', '--sense-voice-use-itn=true', '--provider=cpu', '--debug=false',
          `--num-threads=${Math.min(8, Math.max(1, os.availableParallelism?.() || os.cpus().length || 1))}`, ...batch.map(part => part.name)];
        const stdout = await this.run(configuration.binaryPath, args, {
          signal, cwd: tempDir, timeoutMs: Math.min(30 * 60 * 1000, Math.max(60000, batch.reduce((sum, part) => sum + part.endMs - part.startMs, 0) * 8 + 30000)),
        });
        checkSignal(signal);
        let output;
        try {
          output = stdout.replace(/^\uFEFF/, '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
          if (output.length !== batch.length || output.some(item => typeof item?.text !== 'string')) throw new Error('invalid-format');
        } catch { throw failure('ASR_OUTPUT_INVALID', '离线转写结果无法读取，可重试或手动补充文字。'); }
        for (let offset = 0; offset < batch.length; offset++) {
          const part = batch[offset], text = output[offset].text.trim();
          if (text) { words.get(part.segmentId).push(text); timings.push({ segmentId: part.segmentId, text, startMs: part.startMs, endMs: part.endMs }); }
        }
      }
      transcripts.push(...originals.map(segment => ({ id: segment.id, text: words.get(segment.id).join(' ') })));
      checkSignal(signal);
      const durationMs = Math.max(0, Math.round(this.now() - started));
      return { provider: PROVIDER, model: MODEL, language: 'zh', segments: transcripts, timings, timingGranularity: 'audio-chunk',
        text: transcripts.map(segment => segment.text).filter(Boolean).join('\n'),
        durationMs, audioDurationMs, rtf: audioDurationMs > 0 ? durationMs / audioDurationMs : null,
        status: transcripts.some(segment => segment.text) ? 'recognized' : 'no-speech-recognized' };
    } finally {
      // run() settles after the child has closed, so deletion cannot race a late JSON write.
      try { this.removeJobDirectory(tempDir); }
      catch { throw failure('ASR_CLEANUP_FAILED', '转写临时文件清理未完成，请关闭应用后重试。'); }
      finally { this.activeJobs.delete(tempDir); }
    }
  }

  run(binaryPath, args, { signal, timeoutMs, cwd }) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawn(binaryPath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: cwd || path.dirname(binaryPath) }); }
      catch { reject(failure('ASR_START_FAILED', '离线转写程序无法启动。')); return; }
      let wasAborted = false;
      let timedOut = false;
      let spawnFailed = false;
      let stdout = '', outputBytes = 0, oversized = false;
      let runtimeFailed = false, diagnosticTail = '';
      // Only structured stdout is retained for the caller; diagnostics never enter logs/errors.
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', data => {
        if (oversized || wasAborted || timedOut) return;
        outputBytes += Buffer.byteLength(data);
        if (outputBytes > 8 * 1024 * 1024) { oversized = true; stdout = ''; child.kill(); }
        else stdout += data;
      });
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on('data', data => {
        // sherpa can catch an ONNX exception, print this marker, and still exit 0 with empty text.
        const diagnostic = diagnosticTail + data;
        if (/Caught\s+(?:Ort::)?exception\b|Return an empty result|\bbad_alloc\b|out of memory/iu.test(diagnostic)) runtimeFailed = true;
        diagnosticTail = diagnostic.slice(-256);
      });
      const abort = () => { wasAborted = true; child.kill(); };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.once('error', () => { spawnFailed = true; });
      child.once('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        diagnosticTail = '';
        if (wasAborted || signal?.aborted) reject(aborted());
        else if (timedOut) reject(failure('ASR_TIMEOUT', '离线转写用时过长，请缩短录音后重试。'));
        else if (spawnFailed) reject(failure('ASR_START_FAILED', '离线转写程序无法启动，请确认安装完整。'));
        else if (oversized) reject(failure('ASR_OUTPUT_INVALID', '离线转写结果超过本地处理上限。'));
        else if (code !== 0 || runtimeFailed) reject(failure('ASR_FAILED', '离线转写未完成，可重试或手动补充文字。'));
        else resolve(stdout);
      });
      if (signal?.aborted) abort();
    });
  }
}

module.exports = { OfflineASR };
