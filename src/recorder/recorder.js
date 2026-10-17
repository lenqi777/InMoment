'use strict';
let current = null;
const same = (a, b) => a?.sessionId === b?.sessionId && a?.segmentId === b?.segmentId && a?.generation === b?.generation && a?.epoch === b?.epoch;

async function stop(reason = 'pause') {
  const recording = current; if (!recording) return;
  if (recording.stopping) return recording.done;
  recording.stopping = true;
  recording.done = (async () => {
    recording.stream?.getTracks().forEach(track => track.stop());
    if (recording.node) {
      await Promise.race([new Promise(resolve => { recording.flushDone = resolve; recording.node.port.postMessage('flush'); }), new Promise(resolve => setTimeout(resolve, 500))]);
    }
    try { recording.source?.disconnect(); recording.node?.disconnect(); if (recording.context) await recording.context.close(); } catch {}
    try { await recording.writes; } catch {}
    await window.recorderBridge.stopped({ token: recording.token, reason });
    if (current === recording) current = null;
  })();
  return recording.done;
}

async function prepare(command) {
  if (current) await stop('replace');
  const recording = { token: command.token, stream: null, writes: Promise.resolve(), stopping: false };
  current = recording;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    recording.stream = stream;
    if (recording.stopping || current !== recording) { stream.getTracks().forEach(track => track.stop()); return; }
    const context = new AudioContext({ sampleRate: 16000 }); recording.context = context;
    await context.audioWorklet.addModule('pcm-worklet.js');
    if (recording.stopping || current !== recording) { await context.close(); stream.getTracks().forEach(track => track.stop()); return; }
    const ready = await window.recorderBridge.ready({ token: command.token, sampleRate: context.sampleRate });
    if (!ready.allowed || recording.stopping || current !== recording) {
      stream.getTracks().forEach(track => track.stop()); if (context.state !== 'closed') await context.close();
      await window.recorderBridge.stopped({ token: recording.token, reason: 'start-cancelled' });
      if (current === recording) current = null;
      return;
    }
    const node = new AudioWorkletNode(context, 'inmoment-pcm'); recording.node = node;
    node.port.onmessage = event => {
      if (event.data.flushed) { recording.flushDone?.(); return; }
      const floats = event.data.samples; if (!floats) return;
      const pcm = new Int16Array(floats.length);
      for (let i = 0; i < floats.length; i++) { const sample = Math.max(-1, Math.min(1, floats[i])); pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff; }
      recording.writes = recording.writes.then(async () => {
        const result = await window.recorderBridge.chunk({ token: recording.token, pcm: pcm.buffer });
        if (!result.accepted && !recording.stopping) throw new Error('AudioWriteError');
      }).catch(() => {
        recording.stream?.getTracks().forEach(track => track.stop());
        if (!recording.writeFailed) { recording.writeFailed = true; window.recorderBridge.failed({ token: recording.token, code: 'AudioWriteError' }).catch(() => {}); }
      });
    };
    recording.source = context.createMediaStreamSource(stream); recording.source.connect(node);
    const mute = context.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(context.destination);
    stream.getAudioTracks().forEach(track => { track.onended = () => { if (!recording.stopping) stop('device-ended'); }; });
    await context.resume();
  } catch (error) {
    recording.stream?.getTracks().forEach(track => track.stop());
    try { await recording.context?.close(); } catch {}
    if (current === recording) current = null;
    await window.recorderBridge.failed({ token: command.token, code: error?.name || 'AudioError' });
  }
}

window.recorderBridge.onCommand(command => {
  if (command.command === 'prepare') prepare(command);
  else if (command.command === 'stop' && (!command.token || same(command.token, current?.token))) stop(command.reason);
  else if (command.command === 'stopAll') stop('discard');
});
