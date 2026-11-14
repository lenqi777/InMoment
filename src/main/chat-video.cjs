'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_VIDEO_SECONDS = 300;
const MAX_FRAME_BYTES = 768 * 1024;
const MAX_AUDIO_BYTES = (MAX_VIDEO_SECONDS + 1) * 32000;
const JOB_PREFIX = 'inmoment-chat-video-';
const INPUT = ['-f', 'mov', '-protocol_whitelist', 'file', '-enable_drefs', '0', '-use_absolute_path', '0', '-probesize', '5000000', '-analyzeduration', '5000000'];

function issue(message, code = 'CHAT_INVALID') { return Object.assign(new Error(message), { code }); }
function cancelled() { return Object.assign(issue('已停止处理附件。', 'CHAT_CANCELLED'), { name: 'AbortError' }); }
function check(signal) { if (signal?.aborted) throw cancelled(); }

function locateMediaTools({ env = process.env, executablePath = process.execPath } = {}) {
  const explicit = env.INMOMENT_CHAT_FFMPEG_DIR;
  const portable = path.join(path.dirname(executablePath), 'chat-media', 'bin');
  const directories = explicit ? [explicit] : [portable, ...(env.Path || env.PATH || '').split(path.delimiter)];
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const entry of directories) {
    const directory = entry.trim().replace(/^"(.*)"$/u, '$1');
    if (!path.isAbsolute(directory)) continue;
    const ffmpeg = path.join(directory, `ffmpeg${suffix}`), ffprobe = path.join(directory, `ffprobe${suffix}`);
    try {
      if (fs.statSync(ffmpeg).isFile() && fs.statSync(ffprobe).isFile()) return { ffmpeg: fs.realpathSync(ffmpeg), ffprobe: fs.realpathSync(ffprobe) };
    } catch { /* An unavailable location does not prevent checking the next configured location. */ }
  }
  throw issue('本地视频处理组件不可用。请安装包含 FFmpeg 和 ffprobe 的组件，或改用 Gemini 发送原视频。', 'CHAT_CAPABILITY');
}

function run(binary, args, { signal, cwd, timeout = 30000, maxOutput = 64 * 1024, failure }) {
  check(signal);
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { reject(issue('本地视频处理组件无法启动。', 'CHAT_CAPABILITY')); return; }
    let failed = false, reason = null, bytes = 0;
    const chunks = [];
    const stop = error => { reason ||= error; child.kill(); };
    const abort = () => stop(cancelled());
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutput) stop(issue('视频处理结果超过上限，请缩短视频后重试。'));
      else if (!reason) chunks.push(chunk);
    });
    child.once('error', () => { failed = true; });
    const timer = setTimeout(() => stop(issue('视频处理超时，请缩短视频后重试。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(cancelled());
      else if (reason) reject(reason);
      else if (failed) reject(issue('本地视频处理组件无法启动。', 'CHAT_CAPABILITY'));
      else if (code !== 0) reject(issue(failure));
      else resolve(Buffer.concat(chunks));
    });
    if (signal?.aborted) abort();
  });
}

function validDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const whole = Math.floor(ms / 1000);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function cleanupVideoJobs(root) {
  let entries;
  try {
    if (!fs.lstatSync(root).isDirectory()) return false;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) { return error?.code === 'ENOENT'; }
  let ok = true;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^inmoment-chat-video-[A-Za-z0-9]{6}$/u.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      for (const filename of ['source.mp4', 'audio.wav']) {
        try { fs.unlinkSync(path.join(directory, filename)); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      fs.rmdirSync(directory);
    } catch { ok = false; }
  }
  return ok;
}

async function extractVideo(bytes, { signal, transcribe, tempRoot = os.tmpdir(), frameLimit, tools, onStage }) {
  check(signal);
  if (!Number.isInteger(frameLimit) || frameLimit < 1) throw issue('这条聊天已达到图像数量上限，请减少附件后再分析视频。');
  const { ffmpeg, ffprobe } = tools || locateMediaTools();
  let parent, directory;
  try {
    await fsp.mkdir(tempRoot, { recursive: true });
    parent = await fsp.realpath(tempRoot);
    directory = await fsp.mkdtemp(path.join(parent, JOB_PREFIX));
  } catch { throw issue('无法建立本地视频临时目录，请检查磁盘空间和权限。', 'CHAT_CAPABILITY'); }
  try {
    onStage?.({ id: 'extracting-frames', label: '正在提取视频画面' });
    check(signal);
    const input = path.join(directory, 'source.mp4');
    await fsp.writeFile(input, bytes, { flag: 'wx', signal });
    const common = { cwd: directory, signal };
    const probe = await run(ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...INPUT, '-show_entries', 'format=duration:stream=index,codec_type,duration,width,height:stream_disposition=attached_pic', '-of', 'json', '-i', input], { ...common, timeout: 15000, failure: '无法读取这个 MP4 文件，请确认视频可以播放。' });
    let metadata;
    try { metadata = JSON.parse(probe.toString('utf8')); } catch { throw issue('无法读取这个 MP4 文件的视频信息。'); }
    const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
    const video = streams.find(stream => stream?.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = streams.filter(stream => stream?.codec_type === 'audio');
    const videoDuration = validDuration(video?.duration) || validDuration(metadata?.format?.duration);
    const duration = Math.max(videoDuration || 0, validDuration(metadata?.format?.duration) || 0, ...audio.map(stream => validDuration(stream.duration) || 0));
    if (!Number.isSafeInteger(video?.index) || video.index < 0 || !videoDuration) throw issue('没有找到可解码的 MP4 视频轨。');
    if (!video.width || !video.height || video.width * video.height > 16000000) throw issue('视频分辨率超过本地分析上限，请降低分辨率后再试。');
    if (duration > MAX_VIDEO_SECONDS) throw issue(`本地视频分析支持 ${MAX_VIDEO_SECONDS / 60} 分钟以内的视频，请截取片段或使用 Gemini。`);
    if (audio.length && typeof transcribe !== 'function') throw issue('视频含音轨。请启用本地语音转写，或改用 Gemini 发送原视频。', 'CHAT_CAPABILITY');

    const frameCount = Math.min(frameLimit, 6, Math.max(2, Math.ceil(videoDuration / 10)));
    const frames = [];
    for (let index = 0; index < frameCount; index++) {
      const time = frameCount === 1 ? 0 : videoDuration * 0.88 * index / (frameCount - 1);
      const frame = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-max_alloc', '67108864', '-filter_threads', '1', '-ss', time.toFixed(3), '-threads', '2', ...INPUT, '-i', input, '-map', `0:${video.index}`, '-an', '-sn', '-dn', '-frames:v', '1', '-vf', "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], { ...common, maxOutput: MAX_FRAME_BYTES, failure: '无法从视频中提取画面，请尝试转换视频编码。' });
      if (frame.length) frames.push({ time, mimeType: 'image/jpeg', base64: frame.toString('base64') });
    }
    if (!frames.length) throw issue('未能从视频中提取可用画面。');

    let transcript = null;
    if (audio.length) {
      if (!Number.isSafeInteger(audio[0].index) || audio[0].index < 0) throw issue('无法读取视频音轨。');
      onStage?.({ id: 'extracting-audio', label: '正在提取视频音轨' });
      const wavPath = path.join(directory, 'audio.wav');
      await run(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-max_alloc', '67108864', '-threads', '2', ...INPUT, '-i', input, '-map', `0:${audio[0].index}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', String(MAX_VIDEO_SECONDS + 1), '-fs', String(MAX_AUDIO_BYTES + 1024), '-f', 'wav', wavPath], { ...common, timeout: 45000, failure: '无法解码视频音轨，请尝试转换音频编码。' });
      const stat = await fsp.stat(wavPath);
      if (stat.size <= 80 || stat.size > MAX_VIDEO_SECONDS * 32000 + 1024) throw issue('视频音轨为空或超过本地处理上限。');
      onStage?.({ id: 'transcribing-audio', label: '正在转写视频音轨' });
      check(signal);
      try { transcript = await transcribe({ wavPath, signal }); }
      catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
        if (['CAPABILITY_UNAVAILABLE', 'ASR_UPGRADE_REQUIRED', 'ASR_START_FAILED'].includes(error?.code)) throw issue('视频含音轨。请启用本地语音转写，或改用 Gemini 发送原视频。', 'CHAT_CAPABILITY');
        throw issue('视频音轨转写失败，请重试或改用 Gemini。');
      }
      check(signal);
      if (typeof transcript === 'string') transcript = { text: transcript };
      if (typeof transcript?.text !== 'string' || (!transcript.text.trim() && transcript.status !== 'no-speech-recognized')) throw issue('视频音轨转写未返回可用结果，请重试。');
    }
    return { duration, frames, frameCount, audioTracks: audio.length, transcript };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
    if (error?.code?.startsWith('CHAT_')) throw error;
    throw issue('本地视频处理未完成，请检查文件、磁盘空间和权限。');
  } finally {
    if (path.dirname(directory) === parent && /^inmoment-chat-video-[\w-]+$/u.test(path.basename(directory))) {
      try { await fsp.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { throw issue('本地视频临时文件未能清理，请检查应用数据目录权限。', 'CHAT_CAPABILITY'); }
    }
  }
}

module.exports = { extractVideo, formatTime, locateMediaTools, cleanupVideoJobs, MAX_VIDEO_SECONDS };
