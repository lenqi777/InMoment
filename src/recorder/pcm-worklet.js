class InMomentPCM extends AudioWorkletProcessor {
  constructor() {
    // 64 ms at the requested 16 kHz keeps the sound-driven capsule responsive.
    // Buffer size changes delivery cadence only; flush retains every sample.
    super(); this.buffer = new Float32Array(1024); this.offset = 0; this.stopped = false;
    this.port.onmessage = event => { if (event.data === 'flush') { this.flush(); this.stopped = true; this.port.postMessage({ flushed: true }); } };
  }
  flush() { if (this.offset) { const values = this.buffer.slice(0, this.offset); this.port.postMessage({ samples: values }, [values.buffer]); this.offset = 0; } }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0]; if (!channel) return true;
    for (const value of channel) { this.buffer[this.offset++] = value; if (this.offset === this.buffer.length) this.flush(); }
    return true;
  }
}
registerProcessor('inmoment-pcm', InMomentPCM);
